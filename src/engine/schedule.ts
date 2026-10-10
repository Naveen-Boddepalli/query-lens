/**
 * Schedules (plan.md §25.4 D1, D2): statements from several sessions, in an order the *caller* chose, run against one
 * shared database. The interleaving is an input, so the engine stays pure — the same schedule always produces the same
 * result, and a schedule is a value that can sit in a URL.
 *
 * **Without `locking`** (D1) there is no concurrency control at all: every statement runs at once against whatever the
 * database holds, including another session's uncommitted writes. `ROLLBACK` is real — each transaction keeps an undo
 * log of the rows it changed and puts them back, newest first — but nothing stops a second session reading a row the
 * first has changed and not committed (a dirty read), or changing it too (a dirty write). The result *names* those
 * when they happen rather than preventing them.
 *
 * **With `locking`** (D2) the same schedule runs under strict two-phase locking, enforced by the engine's lock table
 * (`locks/lockTable.ts`): a statement first takes a lock for what it touches — shared to read, exclusive to change —
 * and holds every lock until `COMMIT` or `ROLLBACK`. A statement that cannot get its lock *blocks*: nothing runs, the
 * session's later steps wait behind it, and it resumes the moment the holder lets go, seeing whatever the holder
 * committed. Two sessions each waiting on the other is a deadlock, and the youngest is rolled back. A session blocked
 * for good is reported as stuck.
 *
 * **Isolation levels** (D3) are lock-duration rules, as in the textbook definition. `READ UNCOMMITTED` takes no read
 * locks; `READ COMMITTED` takes them and gives them back when the statement ends; `REPEATABLE READ` holds them to the
 * end (D2's strict two-phase locking, and the default); `SERIALIZABLE` adds a predicate lock for each read's `WHERE`, so
 * an insert that would match it has to wait — the only level that stops a phantom. Write locks are held to the end at
 * every level. A level is the schedule's default, or one transaction's own through `BEGIN ISOLATION LEVEL …`.
 *
 * **With `mvcc`** (D4) a row is a chain of versions (`mvcc.ts`) and a reader takes no lock at all: it sees the versions
 * its snapshot can see. `READ COMMITTED` takes a fresh snapshot per statement, so a repeated read can change;
 * `REPEATABLE READ` takes one for the transaction, which is snapshot isolation — no dirty, non-repeatable or phantom
 * read, and a write to a row someone else committed since the snapshot fails (first committer wins), but write skew
 * gets through; `SERIALIZABLE` adds a check at `COMMIT` that nothing the transaction read has changed since its
 * snapshot, which stops write skew at the price of more aborts than PostgreSQL's own scheme. Writers still take an
 * exclusive lock on each row they change, so two writers to one row wait for each other, and a deadlock is still a
 * deadlock. `VACUUM` removes the versions no one can see again.
 *
 * A statement outside `BEGIN … COMMIT` is its own transaction (autocommit). A statement that fails changes nothing and
 * leaves the transaction open, as MySQL does; PostgreSQL would instead refuse everything until `ROLLBACK`.
 */

import { passes } from './exec/evaluate.ts';
import { indexNameOf, indexSpecsOf } from './index/spec.ts';
import { emptyTable, forget, holds, release, releaseAll, request } from './locks/lockTable.ts';
import type { LockMode, LockTableState } from './locks/lockTable.ts';
import { parseStatement, walkExpr } from './parser/index.ts';
import type { Expr } from './parser/index.ts';
import { exprToSql } from './planner/index.ts';
import { runQuery } from './runQuery.ts';
import { buildHeap } from './storage/index.ts';
import { ISOLATION_LABELS } from './isolation.ts';
import { isDead, viewOf } from './mvcc.ts';
import type { Version } from './mvcc.ts';
import { controlKindOf, isolationLevelOf } from './transactionControl.ts';
import type { ControlKind, IsolationLevel } from './transactionControl.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { Database, EngineOptions, Row, RunResult, Table } from './types.ts';

export interface ScheduleStep {
  session: string;
  sql: string;
}

export type StepKind = ControlKind | 'statement';

/**
 * What the locks cover. A `page` lock covers every row on a heap page, so two sessions touching different rows of one
 * page still collide; a `row` lock covers exactly the rows a statement returns or changes, so they do not.
 */
export interface LockingOptions {
  granularity: 'page' | 'row';
  /** The level a transaction runs at unless its own `BEGIN ISOLATION LEVEL …` says otherwise. Default `repeatable-read`. */
  isolation?: IsolationLevel;
  /**
   * Versions and snapshots instead of read locks (plan.md §25.4 D4). Locks are then taken only by writers, on rows,
   * whatever `granularity` says; `READ UNCOMMITTED` behaves as `READ COMMITTED`, as in PostgreSQL.
   */
  mvcc?: boolean;
  /**
   * A protocol that takes no locks at all (plan.md §25.4 D6), for comparing against the two above. `timestamp` is basic
   * timestamp ordering: each transaction gets a timestamp when it begins, each row remembers the newest timestamp
   * that read and wrote it, and an operation that arrives too late for the order the timestamps give is aborted on
   * the spot. `optimistic` is backward-validating optimistic concurrency control: a transaction reads what is
   * committed, writes into a private workspace, and is validated at `COMMIT` against everything that committed since
   * it began. Neither ever waits, so neither can deadlock.
   */
  protocol?: 'timestamp' | 'optimistic';
}

/** What a write did to one row, in the terms needed to put it back. Rows are identified by reference, not by value. */
export type UndoEntry =
  | { kind: 'insert'; table: string; row: Row }
  | { kind: 'delete'; table: string; row: Row; index: number; rid: number }
  | { kind: 'update'; table: string; before: Row; after: Row };

export type AnomalyKind = 'dirty-read' | 'dirty-write' | 'non-repeatable-read' | 'phantom' | 'lost-update';

export interface ScheduleAnomaly {
  kind: AnomalyKind;
  /** The session whose statement exposed it. */
  session: string;
  /** The sessions whose uncommitted changes it touched. */
  against: string[];
  message: string;
}

export interface SessionSnapshot {
  session: string;
  /** The open transaction's number, or null in autocommit. */
  transaction: number | null;
  /** Rows this session has changed and not yet committed. */
  uncommitted: number;
  /** True while a statement of this session is waiting for a lock. */
  waiting: boolean;
  /** Under MVCC, the id its changes are stamped with; null in autocommit. */
  xid: number | null;
}

/** One version of one row, as the version store holds it (MVCC only). */
export interface VersionRow {
  table: string;
  /** The logical row; every version of a row shares it. */
  rid: number;
  row: Row;
  xmin: number;
  xmax: number | null;
  /** `committed` or `in-progress` for the creator, `aborted` once it rolled back. */
  creator: 'committed' | 'in-progress' | 'aborted';
  /** True while it is the newest version of its row and nobody has removed it. */
  live: boolean;
}

/**
 * How a record relates to the step it came from. Under locking one input step can leave several records: it is
 * `queued` when it arrives behind a blocked statement, `blocked` when it cannot get a lock, and `resumed` when it
 * finally runs; `victim` is a statement a deadlock killed. Without locking every record is `ran`.
 */
export type StepPhase = 'ran' | 'queued' | 'blocked' | 'resumed' | 'victim';

export interface LockRow {
  /** The words for the resource, e.g. "page 0". */
  resource: string;
  holders: { session: string; mode: LockMode }[];
  waiters: { session: string; mode: LockMode }[];
}

export interface ScheduleStepResult {
  /** The step's position in the schedule that was given. */
  index: number;
  session: string;
  sql: string;
  kind: StepKind;
  phase: StepPhase;
  /** The engine's own run of a statement — its whole trace. Absent for BEGIN, COMMIT, ROLLBACK, queued and blocked. */
  run?: RunResult;
  /** What the statement returned (a `SELECT`) or wrote. */
  rows: Row[];
  error?: string;
  /** What this record did to the schedule, in words. */
  notes: string[];
  anomalies: ScheduleAnomaly[];
  /** For `blocked`: the sessions holding the lock this statement is waiting for. */
  waitingOn?: string[];
  /** The shared database after this record, uncommitted changes included. */
  after: Database;
  /** Every session's state after this record. */
  sessions: SessionSnapshot[];
  /** The lock table after this record. Empty without `locking`. */
  locks: LockRow[];
  /** Every version in the store after this record. Empty without `mvcc`. */
  versions: VersionRow[];
}

export interface ScheduleResult {
  /** In the order things *happened*, which under locking is not always the order the steps were given. */
  steps: ScheduleStepResult[];
  /** The database as the last step left it, uncommitted changes included. */
  final: Database;
  /** The database with every still-open transaction undone — what would survive a crash. */
  committed: Database;
  /** Sessions whose transaction was never committed or rolled back. */
  open: string[];
  /** Sessions still waiting for a lock at the end: they never got it, and their later steps never ran. */
  stuck: string[];
  /** Deadlocks the lock table found, and so transactions it rolled back. */
  deadlocks: number;
  /** True when the schedule was longer than `MAX_SCHEDULE_STEPS` and the rest was ignored. */
  truncated: boolean;
  /** Under MVCC, how many dead versions the store holds at the end, and how many pages the heap would need without them. */
  bloat: { dead: number; pages: number; pagesAfterVacuum: number } | null;
  /**
   * Under MVCC, what each session would see if it ran a statement now: the transactions its snapshot counts as
   * committed, and the id it would run as (null in autocommit, which sees only what is committed).
   */
  snapshots: { session: string; xid: number | null; committed: number[] }[];
}

/** A hostile or pasted schedule should not hang the tab. Not a security boundary — a size limit. */
export const MAX_SCHEDULE_STEPS = 40;

interface Logged {
  step: number;
  session: string;
  entry: UndoEntry;
}

interface Transaction {
  number: number;
  /** Under MVCC, the id its versions are stamped with (the same as its number). */
  xid: number;
  /** Under MVCC at REPEATABLE READ and above: the transactions that were committed when its first statement ran. */
  snapshot: Set<number> | null;
  /** Under MVCC at SERIALIZABLE: every read's predicate, re-checked at COMMIT. */
  readPredicates: { table: string; where: Expr | undefined }[];
  /** Under optimistic control: what the transaction has read and written, privately, until it commits. */
  workspace: {
    /** The committed transactions at the moment it began: anything committed after is what validation looks for. */
    start: Set<number>;
    pending: Version[];
    removed: Set<Version>;
    reads: Set<number>;
    writes: Set<number>;
  } | null;
  log: Logged[];
  isolation: IsolationLevel;
  /** What each distinct `SELECT` returned the last time this transaction ran it, to notice when it changes. */
  reads: Map<string, Row[]>;
  /** The version of each row this transaction last read or wrote, by row identity, to notice a lost update. */
  seen: Map<number, Row>;
}

/** A read's `WHERE`, held as a lock until its transaction ends (SERIALIZABLE only). */
interface PredicateLock {
  key: string;
  session: string;
  table: string;
  where: Expr | undefined;
  text: string;
}

interface Queued {
  index: number;
  session: string;
  sql: string;
}

/** One lock a statement needs, in the order it will ask for them. */
interface Need {
  key: string;
  label: string;
  mode: LockMode;
}

/** The lock a blocked statement is waiting for. */
interface Pending extends Queued {
  need: Need;
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

function rowText(row: Row): string {
  return JSON.stringify(row);
}

function withRows(db: Database, table: string, rows: Row[]): Database {
  const target = db.tables[table];
  if (!target) return db;
  const replaced: Table = { ...target, rows };
  return { tables: { ...db.tables, [table]: replaced } };
}

/** Puts `entries` back, in the order given (newest first). Returns what could not be restored, in words. */
function undo(
  db: Database,
  entries: readonly Logged[],
  ridOf: (row: Row) => number,
): { db: Database; notes: string[]; restored: number } {
  let next = db;
  const notes: string[] = [];
  let restored = 0;
  for (const { entry, session: owner } of entries) {
    const table = next.tables[entry.table];
    if (!table) continue;
    const rows = [...table.rows];
    if (entry.kind === 'insert') {
      const at = rows.indexOf(entry.row);
      if (at < 0) {
        notes.push(`${owner}'s inserted row ${rowText(entry.row)} is already gone from ${entry.table}.`);
        continue;
      }
      rows.splice(at, 1);
    } else if (entry.kind === 'delete') {
      // Back where it was. Row ids are handed out in table order and inserts only append, so the row goes in front
      // of the first row with a larger id; its old position alone is wrong once rows ahead of it have been removed.
      const at = rows.findIndex((r) => ridOf(r) > entry.rid);
      rows.splice(at < 0 ? rows.length : at, 0, entry.row);
    } else {
      const at = rows.indexOf(entry.after);
      if (at < 0) {
        notes.push(
          `${owner}'s change to ${rowText(entry.before)} could not be put back: the row has been changed again since, ` +
            `so there is no longer a row to restore.`,
        );
        continue;
      }
      rows[at] = entry.before;
    }
    next = withRows(next, entry.table, rows);
    restored += 1;
  }
  return { db: next, notes, restored };
}

/** Which of `entries` produced `row`, if it is a row some uncommitted write left behind. */
function producedBy(entries: readonly Logged[], row: Row): Logged | undefined {
  return entries.find(
    ({ entry }) => (entry.kind === 'insert' && entry.row === row) || (entry.kind === 'update' && entry.after === row),
  );
}

/** What a successful write did to `table`, as undo entries — found by comparing the rows before and after. */
function entriesOf(
  kind: 'insert' | 'delete' | 'update',
  table: string,
  before: Row[],
  after: Row[],
  ridOf: (row: Row) => number,
): UndoEntry[] {
  const kept = new Set(after);
  const had = new Set(before);
  if (kind === 'insert') {
    return after.filter((row) => !had.has(row)).map((row) => ({ kind: 'insert', table, row }));
  }
  if (kind === 'delete') {
    const entries: UndoEntry[] = [];
    before.forEach((row, index) => {
      if (kept.has(row)) return;
      entries.push({ kind: 'delete', table, row, index, rid: ridOf(row) });
    });
    return entries;
  }
  const entries: UndoEntry[] = [];
  before.forEach((row, index) => {
    const now = after[index];
    if (now !== undefined && now !== row) entries.push({ kind: 'update', table, before: row, after: now });
  });
  return entries;
}

/** The table a statement reads or changes and what it filters on — enough to decide what it must lock. */
function targetOf(
  sql: string,
): { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; where: Expr | undefined } | null {
  const parsed = parseStatement(sql);
  if (!parsed.ok) return null;
  const ast = parsed.ast;
  if (ast.kind === 'select') return { table: ast.from.name, kind: 'select', where: ast.where };
  if (ast.kind === 'insert') return { table: ast.into.name, kind: 'insert', where: undefined };
  if (ast.kind === 'update') return { table: ast.table.name, kind: 'update', where: ast.where };
  if (ast.kind === 'delete') return { table: ast.from.name, kind: 'delete', where: ast.where };
  return null;
}

export function runSchedule(
  schedule: readonly ScheduleStep[],
  db: Database,
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  locking?: LockingOptions,
): ScheduleResult {
  const steps = schedule.slice(0, MAX_SCHEDULE_STEPS);
  const transactions = new Map<string, Transaction>();
  const sessionOrder: string[] = [];
  let nextNumber = 1;
  let current = db;
  const results: ScheduleStepResult[] = [];

  // Locking state. Everything below is inert when `locking` is undefined.
  let locks: LockTableState = emptyTable();
  const labels = new Map<string, string>();
  const labelOf = (resource: string): string => labels.get(resource) ?? resource;
  const blocked = new Map<string, Pending>();
  const queued = new Map<string, Queued[]>();
  let deadlocks = 0;
  const defaultIsolation: IsolationLevel = locking?.isolation ?? 'repeatable-read';
  const predicates: PredicateLock[] = [];
  let nextPredicate = 1;
  // A row keeps one identity through every update, so a row lock outlives the object that was replaced under it.
  const rowIds = new WeakMap<Row, number>();
  let nextRowId = 1;
  const ridOf = (row: Row): number => {
    let id = rowIds.get(row);
    if (id === undefined) {
      id = nextRowId;
      nextRowId += 1;
      rowIds.set(row, id);
    }
    return id;
  };

  // Every row starts with an id in table order. Rows only ever leave or are appended, so id order stays table order.
  // A row also has a home page, the one it was made on: a slotted heap does not slide the rows behind a deleted one
  // forward, and a page lock has to follow the row, not whichever position a later delete pushes it into.
  const homePages = new Map<number, number>();
  for (const table of Object.values(db.tables)) {
    table.rows.forEach((row, at) => {
      homePages.set(ridOf(row), Math.floor(at / options.rowsPerPage));
    });
  }
  const homeOf = (row: Row): number => homePages.get(ridOf(row)) ?? 0;

  // MVCC state (plan.md §25.4 D4). Inert unless `locking.mvcc`.
  const optimistic = locking?.protocol === 'optimistic';
  const timestamped = locking?.protocol === 'timestamp';
  const mvcc = locking?.mvcc === true || optimistic;
  const rowLevel = mvcc || timestamped || locking?.granularity === 'row';
  // Timestamp ordering: the newest timestamp that read and that wrote each row, by row identity.
  const stamps = new Map<number, { read: number; write: number }>();
  // Timestamp ordering: what a row looked like before a transaction changed or removed it, and that transaction's
  // timestamp. A row that is gone cannot be stamp-checked, so an older transaction whose WHERE would have matched
  // the old image is refused against this instead.
  const graveyard: { table: string; image: Row; written: number }[] = [];
  // And what each timestamped statement asked of its table, so a row that did not exist then — a phantom — can be
  // refused too: an older transaction may not now add a row that a younger one's WHERE would have picked up.
  const predicateReads: { table: string; where: Expr | undefined; ts: number }[] = [];
  let template = db;
  const committedXids = new Set<number>([0]);
  const abortedXids = new Set<number>();
  const openXids = new Set<number>();
  const store: Version[] = [];
  let nextOrder = 1;
  if (mvcc) {
    for (const [name, table] of Object.entries(db.tables)) {
      for (const row of table.rows) {
        store.push({ rid: ridOf(row), table: name, row, xmin: 0, xmax: null, order: nextOrder });
        nextOrder += 1;
      }
    }
  }
  /** Everything committed or still open: the database as it stands, uncommitted changes included. */
  const latest = (): Database => viewOf(template, store, new Set([...committedXids, ...openXids]), -1);
  /** What a statement of `txn` sees: a fresh snapshot per statement, or the transaction's own from its first statement. */
  const snapshotFor = (txn: Transaction | undefined, level: IsolationLevel): Set<number> => {
    const now = new Set(committedXids);
    if (!txn || level === 'read-committed' || level === 'read-uncommitted') return now;
    txn.snapshot ??= now;
    return txn.snapshot;
  };
  const versionRows = (): VersionRow[] =>
    store.map((v) => ({
      table: v.table,
      rid: v.rid,
      row: v.row,
      xmin: v.xmin,
      xmax: v.xmax,
      creator: committedXids.has(v.xmin) ? 'committed' : abortedXids.has(v.xmin) ? 'aborted' : 'in-progress',
      live: !abortedXids.has(v.xmin) && (v.xmax === null || abortedXids.has(v.xmax)),
    }));
  const openSnapshots = (): Set<number>[] =>
    [...transactions.values()].filter((t) => t.xid > 0).map((t) => t.snapshot ?? new Set(committedXids));
  const deadVersions = (): Version[] =>
    store.filter((v) => isDead(v, committedXids, abortedXids, openSnapshots()));
  const pagesFor = (versions: readonly Version[]): number => {
    const perTable = new Map<string, number>();
    for (const v of versions) perTable.set(v.table, (perTable.get(v.table) ?? 0) + 1);
    let pages = 0;
    for (const count of perTable.values()) pages += Math.ceil(count / options.rowsPerPage);
    return pages;
  };

  const othersOpenLog = (session: string): Logged[] =>
    [...transactions.entries()].filter(([name]) => name !== session).flatMap(([, t]) => t.log);

  const snapshots = (): SessionSnapshot[] =>
    sessionOrder.map((session) => {
      const txn = transactions.get(session);
      return {
        session,
        transaction: txn?.number ?? null,
        uncommitted: txn?.log.length ?? 0,
        waiting: blocked.has(session),
        xid: mvcc ? (txn?.xid ?? null) : null,
      };
    });

  const lockRows = (): LockRow[] => {
    if (!locking) return [];
    const keys = new Set([...Object.keys(locks.holders), ...Object.keys(locks.waiters)]);
    return [...keys]
      .map((key) => ({
        resource: labelOf(key),
        holders: (locks.holders[key] ?? []).map((h) => ({ session: h.transaction, mode: h.mode })),
        waiters: (locks.waiters[key] ?? []).map((w) => ({ session: w.transaction, mode: w.mode })),
      }))
      .filter((row) => row.holders.length > 0 || row.waiters.length > 0);
  };

  function record(
    step: Queued,
    kind: StepKind,
    phase: StepPhase,
    parts: Partial<Pick<ScheduleStepResult, 'run' | 'rows' | 'error' | 'notes' | 'anomalies' | 'waitingOn'>> & {
      /** The table as the acting session saw it, when that is not simply the latest state (MVCC). */
      view?: Database;
    },
  ): void {
    results.push({
      index: step.index,
      session: step.session,
      sql: step.sql,
      kind,
      phase,
      ...(parts.run ? { run: parts.run } : {}),
      rows: parts.rows ?? [],
      ...(parts.error === undefined ? {} : { error: parts.error }),
      notes: parts.notes ?? [],
      anomalies: parts.anomalies ?? [],
      ...(parts.waitingOn ? { waitingOn: parts.waitingOn } : {}),
      after: parts.view ?? current,
      sessions: snapshots(),
      locks: lockRows(),
      versions: mvcc ? versionRows() : [],
    });
  }

  /** The locks a statement needs, in the order it will ask: what it reads is shared, what it changes is exclusive. */
  function footprint(sql: string, run: RunResult, db: Database): Need[] {
    const target = targetOf(sql);
    if (!target) return [];
    const table = db.tables[target.table];
    if (!table) return [];
    const rowsPerPage = options.rowsPerPage;
    const heapPages = Math.ceil(table.rows.length / rowsPerPage);
    const multi = Object.keys(db.tables).length > 1;
    const pageLabel = (n: number) => (multi ? `page ${String(n)} of ${target.table}` : `page ${String(n)}`);
    const writes = target.kind !== 'select';

    // The pages the statement touched, from the engine's own lock events — the same ones the Locks panel draws. Index
    // pages come after the heap and are latched, not locked; only the data pages are a transaction's to hold.
    const pages = new Map<number, LockMode>();
    for (const event of run.events) {
      if (event.stage !== 'lock' || event.action !== 'acquire') continue;
      if (event.pageId >= heapPages) continue;
      if (pages.get(event.pageId) !== 'exclusive') pages.set(event.pageId, event.mode);
    }
    if (target.kind === 'insert') {
      // The page the new row lands on: the last one, or a fresh one when that is full.
      pages.clear();
      pages.set(Math.floor(table.rows.length / rowsPerPage), 'exclusive');
    }

    // What other open transactions have deleted or re-keyed is gone from the table but not yet from the world: its old
    // image still counts, and still sits where it was, until that transaction ends. Without this a lookup for such a
    // row finds nothing, touches no page, takes no lock, and reads a deletion nobody has committed.
    const tombstones: { row: Row; page: number }[] = [];
    for (const open of transactions.values()) {
      for (const { entry } of open.log) {
        if (entry.table !== target.table) continue;
        if (entry.kind === 'delete') tombstones.push({ row: entry.row, page: Math.floor(entry.index / rowsPerPage) });
        if (entry.kind === 'update') {
          const at = table.rows.indexOf(entry.after);
          if (at >= 0) tombstones.push({ row: entry.before, page: Math.floor(at / rowsPerPage) });
        }
      }
    }

    if (!rowLevel) {
      const all = opaque(target.where);
      // The positions the engine touched, turned into the pages their rows were made on.
      const homes = new Map<number, LockMode>();
      const note = (page: number, mode: LockMode): void => {
        if (homes.get(page) !== 'exclusive') homes.set(page, mode);
      };
      if (target.kind === 'insert') {
        for (const [pageId, mode] of pages) note(pageId, mode);
      } else {
        const heap = buildHeap(table, rowsPerPage);
        for (const [pageId, mode] of pages) {
          const resident = heap.pages[pageId]?.rows ?? [];
          if (resident.length === 0) note(pageId, mode);
          for (const row of resident) note(homeOf(row), mode);
        }
        for (const stone of tombstones) {
          if (!all && !passes(target.where, stone.row)) continue;
          note(homeOf(stone.row), writes ? 'exclusive' : 'shared');
        }
      }
      return [...homes.entries()].map(([pageId, mode]) => ({
        key: `${target.table}/page/${String(pageId)}`,
        label: pageLabel(pageId),
        mode,
      }));
    }

    // Row granularity: the rows the statement *examines*. A scan reads every row on the pages it visits, so every one
    // of them is locked (shared, or exclusive for a row it then changes); an index lookup fetches only the rows that
    // match. An insert has no existing row to lock — it takes its own once it has one.
    if (target.kind === 'insert') return [];
    let unresolved = false;
    if (target.where) {
      walkExpr(target.where, (e) => {
        if (e.kind === 'in' && e.subquery) unresolved = true;
      });
    }
    const scanned = run.events.some((e) => e.stage === 'execute' && e.op === 'SeqScan');
    const first = table.columns[0];
    const needs = new Map<string, Need>();
    const consider = (row: Row): void => {
      // A subquery has no value until it has run; treating every row as matching is the safe reading.
      const matches = unresolved || passes(target.where, row);
      if (!scanned && !matches) return;
      const key = `${target.table}/row/${String(ridOf(row))}`;
      const mode: LockMode = matches && writes ? 'exclusive' : 'shared';
      const value = first === undefined ? '' : String(row[first] ?? 'NULL');
      const had = needs.get(key);
      if (had?.mode === 'exclusive') return;
      needs.set(key, { key, label: `the row of ${target.table} with ${first ?? 'id'} = ${value}`, mode });
    };
    const heap = buildHeap(table, rowsPerPage);
    for (const pageId of pages.keys()) {
      for (const row of heap.pages[pageId]?.rows ?? []) consider(row);
    }
    // The old image of a row another open transaction changed or deleted (above) is locked like any other it examines.
    for (const stone of tombstones) consider(stone.row);
    return [...needs.values()];
  }

  /** True when `where` holds a subquery, which has no value until it has run: treated as matching every row. */
  function opaque(where: Expr | undefined): boolean {
    let found = false;
    if (where) {
      walkExpr(where, (e) => {
        if (e.kind === 'in' && e.subquery) found = true;
      });
    }
    return found;
  }

  /** The rows of the statement's table that its `WHERE` picks out, as the table stands now. */
  function matchedRows(sql: string, db: Database): Row[] {
    const target = targetOf(sql);
    const table = target ? db.tables[target.table] : undefined;
    if (!target || !table || target.kind === 'insert') return [];
    const all = opaque(target.where);
    return table.rows.filter((row) => all || passes(target.where, row));
  }

  /**
   * A write that would add a row matching a read another session is holding a predicate lock on has to wait for it:
   * the predicate is a lock the reader holds exclusively and the writer asks for shared, so writers never wait on
   * each other, only on the readers whose answer they would change (plan.md §25.4 D3, the toy predicate lock).
   */
  function predicateNeeds(session: string, sql: string, run: RunResult): Need[] {
    const target = targetOf(sql);
    if (!target || !run.write || (target.kind !== 'insert' && target.kind !== 'update')) return [];
    const before = current.tables[run.write.table]?.rows ?? [];
    const images = entriesOf(run.write.kind, run.write.table, before, run.write.rows, ridOf).flatMap((entry) =>
      entry.kind === 'insert' ? [entry.row] : entry.kind === 'update' ? [entry.after] : [],
    );
    return predicates
      .filter((p) => p.session !== session && p.table === target.table)
      .filter((p) => images.some((image) => p.where === undefined || opaque(p.where) || passes(p.where, image)))
      .map((p) => ({ key: p.key, label: `the rows ${p.text} that ${p.session} read`, mode: 'shared' as const }));
  }

  /** Lets go of everything `session` holds, so whatever was waiting on it can be promoted. */
  function endLocks(session: string, notes: string[]): void {
    if (!locking) return;
    const released = releaseAll(locks, session, labelOf);
    locks = forget(released.state, session);
    notes.push(...released.narration);
    for (let at = predicates.length - 1; at >= 0; at -= 1) {
      if (predicates[at]!.session === session) predicates.splice(at, 1);
    }
  }

  /** The statements waiting for a lock that has since been granted, resumed in the order they blocked. */
  let draining = false;
  let drainAgain = false;
  function drain(): void {
    if (!locking) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        for (const [session, pending] of [...blocked.entries()]) {
          if (!holds(locks, session, pending.need.key, pending.need.mode)) continue;
          blocked.delete(session);
          const outcome = execute(pending, 'lock');
          if (outcome !== 'blocked') runQueued(session);
          drainAgain = true;
          break;
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
  }

  /** A session's steps that arrived while it was blocked, run in order until one blocks again. */
  function runQueued(session: string): void {
    const line = queued.get(session);
    while (line && line.length > 0 && !blocked.has(session)) {
      const next = line.shift()!;
      execute(next, 'queue');
    }
  }

  /** Ends `session`'s transaction by rolling it back, as a deadlock victim's is. Returns the notes. */
  function rollBackTransaction(session: string): string[] {
    const txn = transactions.get(session);
    if (!txn) return [];
    if (mvcc) {
      abortedXids.add(txn.xid);
      openXids.delete(txn.xid);
      transactions.delete(session);
      current = latest();
      return [`${session}'s transaction T${String(txn.number)} is rolled back: its versions are now invisible to everyone.`];
    }
    const undone = undo(current, [...txn.log].sort((a, b) => b.step - a.step), ridOf);
    current = undone.db;
    transactions.delete(session);
    return [
      `${session}'s transaction T${String(txn.number)} is rolled back: ${
        undone.restored === txn.log.length
          ? `${plural(txn.log.length, 'change')} undone`
          : `${String(undone.restored)} of ${plural(txn.log.length, 'change')} undone`
      }.`,
      ...undone.notes,
    ];
  }

  const ridOfKey = (key: string): number => Number(key.slice(key.lastIndexOf('/') + 1));

  /** Every unique key a row holds, as a lock resource and in words. A key with a NULL in it never conflicts. */
  function uniqueKeysOf(table: string, row: Row): { index: string; key: string; text: string }[] {
    const definition = template.tables[table];
    if (!definition) return [];
    return indexSpecsOf(definition)
      .filter((spec) => spec.unique)
      .flatMap((spec) => {
        const values = spec.columns.map((c) => row[c] ?? null);
        if (values.some((v) => v === null)) return [];
        const index = indexNameOf(spec.columns);
        return [
          {
            index,
            key: `${table}/unique/${index}/${JSON.stringify(values)}`,
            text: `${spec.columns.join(', ')} = ${values.map(String).join(', ')}`,
          },
        ];
      });
  }

  /** The row images a write would leave behind whose unique keys are new: what must be free for it to succeed. */
  function newKeysOf(run: RunResult, db: Database): { table: string; rid: number | null; index: string; key: string; text: string }[] {
    if (!run.write) return [];
    const table = run.write.table;
    const entries = entriesOf(run.write.kind, table, db.tables[table]?.rows ?? [], run.write.rows, ridOf);
    return entries.flatMap((entry) => {
      if (entry.kind === 'delete') return [];
      const image = entry.kind === 'insert' ? entry.row : entry.after;
      const had = entry.kind === 'update' ? new Set(uniqueKeysOf(table, entry.before).map((k) => k.key)) : new Set<string>();
      const rid = entry.kind === 'update' ? ridOf(entry.before) : null;
      return uniqueKeysOf(table, image).filter((k) => !had.has(k.key)).map((k) => ({ table, rid, ...k }));
    });
  }

  /** A committed, still-live row some other row of the store already holds `key` in — whatever snapshot is asking. */
  function committedHolder(table: string, key: string, self: number | null, ignore: ReadonlySet<Version>): Version | undefined {
    return store.find(
      (v) =>
        v.table === table &&
        !ignore.has(v) &&
        v.rid !== self &&
        committedXids.has(v.xmin) &&
        (v.xmax === null || !committedXids.has(v.xmax)) &&
        uniqueKeysOf(table, v.row).some((k) => k.key === key),
    );
  }

  /** An optimistic transaction's view: what is committed, minus what it has removed, plus what it has added. */
  function workspaceView(txn: Transaction): Database {
    const ws = txn.workspace!;
    const versions: Version[] = [...store.map((v) => (ws.removed.has(v) ? { ...v, xmax: txn.xid } : v)), ...ws.pending];
    return viewOf(template, versions, new Set(committedXids), txn.xid);
  }

  /**
   * Backward validation (plan.md §25.4 D6): did any transaction commit, since this one began, a change to a row it
   * read or wrote — or to what one of its reads' predicates matches? If so what it did rested on a state that is gone.
   */
  function optimisticConflict(txn: Transaction): string | null {
    const ws = txn.workspace!;
    for (const v of store) {
      const madeAfter = committedXids.has(v.xmin) && !ws.start.has(v.xmin);
      const removedAfter = v.xmax !== null && committedXids.has(v.xmax) && !ws.start.has(v.xmax);
      if (!madeAfter && !removedAfter) continue;
      if (!ws.reads.has(v.rid) && !ws.writes.has(v.rid)) continue;
      const by = madeAfter ? v.xmin : v.xmax;
      return `a row this transaction ${ws.writes.has(v.rid) ? 'wrote' : 'read'} was changed by T${String(by)}, which committed after it began`;
    }
    // A key it is about to add may have been taken by a transaction that committed in the meantime.
    for (const pending of ws.pending) {
      for (const k of uniqueKeysOf(pending.table, pending.row)) {
        if (committedHolder(pending.table, k.key, pending.rid, ws.removed)) {
          return `the unique key ${k.text} was taken by a transaction that committed after this one began`;
        }
      }
    }
    return readConflict(txn);
  }

  /**
   * Basic timestamp ordering: an operation that arrives after a younger transaction has already read or written the
   * row is too late for the order the timestamps give, and is refused. Rows that are not there to carry a stamp are
   * covered too (a row a younger transaction removed, a phantom one it would have read), by predicate. Returns why,
   * or null (and then records the operation, so the next one is checked against it).
   */
  function timestampCheck(ts: number, needs: Need[], sql: string, written: Row[]): string | null {
    for (const need of needs) {
      const rid = ridOfKey(need.key);
      const seen = stamps.get(rid) ?? { read: 0, write: 0 };
      if (ts < seen.write) {
        return `T${String(ts)} came too late for row ${String(rid)}: a younger transaction, T${String(seen.write)}, has already written it`;
      }
      if (need.mode === 'exclusive' && ts < seen.read) {
        return `T${String(ts)} came too late to write row ${String(rid)}: a younger transaction, T${String(seen.read)}, has already read it`;
      }
    }
    // Rows that are not there to carry a stamp: ones a younger transaction has changed or removed, and ones a younger
    // transaction's WHERE would have picked up had they existed then.
    const target = targetOf(sql);
    if (target) {
      if (target.kind !== 'insert') {
        const any = target.where === undefined || opaque(target.where);
        const gone = graveyard.find(
          (g) => g.table === target.table && g.written > ts && (any || passes(target.where, g.image)),
        );
        if (gone) {
          return `T${String(ts)} came too late: a younger transaction, T${String(gone.written)}, has already changed or removed a row this statement would have matched`;
        }
      }
      const phantom = predicateReads.find(
        (p) =>
          p.table === target.table &&
          p.ts > ts &&
          written.some((image) => p.where === undefined || opaque(p.where) || passes(p.where, image)),
      );
      if (phantom) {
        return `T${String(ts)} came too late to write: a younger transaction, T${String(phantom.ts)}, has already read rows like ${
          target.kind === 'insert' ? 'this one' : 'these'
        } and would have seen ${target.kind === 'insert' ? 'it' : 'them'}`;
      }
      if (target.kind !== 'insert') predicateReads.push({ table: target.table, where: target.where, ts });
    }
    for (const need of needs) {
      const rid = ridOfKey(need.key);
      const seen = stamps.get(rid) ?? { read: 0, write: 0 };
      stamps.set(rid, {
        read: Math.max(seen.read, ts),
        write: need.mode === 'exclusive' ? Math.max(seen.write, ts) : seen.write,
      });
    }
    return null;
  }

  /**
   * SERIALIZABLE under MVCC: has anything this transaction read been changed by a transaction that committed after its
   * snapshot was taken? Re-checks every read's predicate against the version store: a row matching it that appeared,
   * or one it could see that has since been removed, means the answer it acted on is no longer the answer.
   */
  function readConflict(txn: Transaction): string | null {
    const snapshot = txn.snapshot ?? new Set(committedXids);
    for (const read of txn.readPredicates) {
      const any = read.where === undefined || opaque(read.where);
      for (const v of store) {
        if (v.table !== read.table || v.xmin === txn.xid || v.xmax === txn.xid) continue;
        if (!any && !passes(read.where, v.row)) continue;
        const appeared = committedXids.has(v.xmin) && !snapshot.has(v.xmin);
        const vanished = snapshot.has(v.xmin) && v.xmax !== null && committedXids.has(v.xmax) && !snapshot.has(v.xmax);
        if (appeared) return `a row matching ${read.where ? exprToSql(read.where) : 'a read of the whole table'} has been committed by T${String(v.xmin)} since this transaction's snapshot`;
        if (vanished) return `a row this transaction read has been changed by T${String(v.xmax)} since its snapshot`;
      }
    }
    return null;
  }

  /**
   * Runs one step now. Returns what became of it: `done`, `blocked` (waiting for a lock — it has been recorded and
   * will resume) or `victim` (a deadlock rolled it back). `resumed` marks a step that did not run when it arrived.
   */
  function execute(step: Queued, resumed: false | 'lock' | 'queue'): 'done' | 'blocked' | 'victim' {
    const { index, session, sql } = step;
    const notes: string[] = [];
    const anomalies: ScheduleAnomaly[] = [];
    const phase: StepPhase = resumed === false ? 'ran' : 'resumed';
    const txn = transactions.get(session);
    const control = controlKindOf(sql);

    if (control === 'malformed') {
      record(step, 'statement', phase, {
        error: 'Transaction control here is BEGIN, COMMIT and ROLLBACK, with nothing after them.',
        notes: ['No effect.'],
      });
      return 'done';
    }

    if (control === 'begin') {
      if (txn) {
        notes.push(
          `${session} already has transaction T${String(txn.number)} open — BEGIN changes nothing (PostgreSQL warns the same).`,
        );
      } else {
        const number = nextNumber;
        nextNumber += 1;
        const asked = isolationLevelOf(sql);
        const level = asked ?? defaultIsolation;
        transactions.set(session, {
          number,
          xid: number,
          snapshot: optimistic ? new Set(committedXids) : null,
          readPredicates: [],
          workspace: optimistic
            ? { start: new Set(committedXids), pending: [], removed: new Set(), reads: new Set(), writes: new Set() }
            : null,
          log: [],
          isolation: level,
          reads: new Map(),
          seen: new Map(),
        });
        if (mvcc) openXids.add(number);
        notes.push(
          `${session} begins transaction T${String(number)}${
            locking ? ` at ${ISOLATION_LABELS[level]}` : ''
          }${asked && !locking ? ` (it asks for ${ISOLATION_LABELS[asked]}, but with no locking the level changes nothing)` : ''}.`,
        );
      }
      record(step, 'begin', phase, { notes });
      return 'done';
    }

    if (control === 'commit') {
      if (!txn) {
        notes.push(`${session} has no transaction open — COMMIT changes nothing.`);
      } else {
        const conflict = optimistic
          ? optimisticConflict(txn)
          : mvcc && txn.isolation === 'serializable'
            ? readConflict(txn)
            : null;
        if (conflict) {
          // The read the transaction acted on is stale, so it cannot commit: it is rolled back instead.
          const rolled = rollBackTransaction(session);
          endLocks(session, notes);
          record(step, 'commit', 'victim', {
            error: `Could not serialize access: ${conflict}. ${session} is rolled back.`,
            notes: [...rolled, ...notes],
          });
          drain();
          return 'victim';
        }
        notes.push(
          `${session} commits T${String(txn.number)}: its ${plural(txn.log.length, 'change')} ${
            txn.log.length === 1 ? 'is' : 'are'
          } now permanent, and visible to everyone.`,
        );
        if (optimistic && txn.workspace) {
          // Validated, so its private workspace becomes the database all at once.
          for (const v of txn.workspace.removed) v.xmax = txn.xid;
          store.push(...txn.workspace.pending);
        }
        if (mvcc) {
          committedXids.add(txn.xid);
          openXids.delete(txn.xid);
          if (optimistic) current = latest();
        }
        transactions.delete(session);
      }
      endLocks(session, notes);
      record(step, 'commit', phase, { notes });
      drain();
      return 'done';
    }

    if (control === 'rollback') {
      if (!txn) {
        notes.push(`${session} has no transaction open — ROLLBACK changes nothing.`);
      } else if (mvcc) {
        // Nothing is undone: the transaction's versions simply stop being visible to anyone, and stay in the heap
        // as dead tuples until a VACUUM.
        notes.push(...rollBackTransaction(session));
      } else {
        const undone = undo(current, [...txn.log].sort((a, b) => b.step - a.step), ridOf);
        current = undone.db;
        const whole = undone.restored === txn.log.length;
        notes.push(
          `${session} rolls back T${String(txn.number)}: ${
            whole
              ? `${plural(txn.log.length, 'change')} undone`
              : `${String(undone.restored)} of ${plural(txn.log.length, 'change')} could be undone`
          }, newest first.`,
          ...undone.notes,
        );
        transactions.delete(session);
      }
      endLocks(session, notes);
      record(step, 'rollback', phase, { notes });
      drain();
      return 'done';
    }

    // VACUUM reclaims the versions no snapshot can see again. Without versions there is nothing for it to do.
    if (/^VACUUM(\s+\w+)?\s*;?\s*$/i.test(sql.trim())) {
      if (!mvcc) {
        record(step, 'statement', phase, {
          error: 'VACUUM reclaims old row versions, and there are none without MVCC.',
          notes: ['No effect.'],
        });
        return 'done';
      }
      const dead = deadVersions();
      const pagesBefore = pagesFor(store);
      for (const v of dead) store.splice(store.indexOf(v), 1);
      notes.push(
        `VACUUM removed ${plural(dead.length, 'dead version')}; the heap needs ${plural(pagesFor(store), 'page')} instead of ${String(pagesBefore)}.`,
      );
      record(step, 'statement', phase, { notes });
      return 'done';
    }

    // An ordinary statement. What it *sees* is the shared database as it stands — or, under MVCC, the versions its
    // snapshot can see, whatever else is going on.
    const isolation = txn?.isolation ?? defaultIsolation;
    const viewNow = (): Database =>
      optimistic && txn?.workspace
        ? workspaceView(txn)
        : mvcc
          ? viewOf(template, store, snapshotFor(txn, isolation), txn?.xid ?? -1)
          : current;
    const view = viewNow();
    const run = runQuery(sql, view, options);
    if (run.error) {
      record(step, 'statement', phase, {
        run,
        error: run.error.message,
        notes: [txn ? `No effect, and T${String(txn.number)} stays open.` : 'No effect.'],
      });
      return 'done';
    }

    // Under locking, take every lock the statement needs before it runs, holding each to the end of the transaction.
    let needs: Need[] = [];
    const heldShared = new Set<string>();
    if (locking) {
      needs = footprint(sql, run, view);
      if (optimistic && txn?.workspace) {
        for (const n of needs) (n.mode === 'exclusive' ? txn.workspace.writes : txn.workspace.reads).add(ridOfKey(n.key));
      }
      if (timestamped) {
        // The operations are checked against the timestamps, in the order the statement makes them. An autocommit
        // statement is a transaction of its own, and the youngest so far.
        const ts = txn ? txn.number : nextNumber;
        const written = run.write
          ? [...(run.write.kind === 'insert' ? [] : matchedRows(sql, view)), ...(run.write.kind === 'delete' ? [] : run.rows)]
          : [];
        const violation = timestampCheck(ts, needs, sql, written);
        if (violation) {
          const rolled = txn ? rollBackTransaction(session) : [];
          record(step, 'statement', 'victim', {
            run,
            error: `Timestamp ordering violated: ${violation}.${txn ? ` ${session} is aborted.` : ''}`,
            notes: rolled,
          });
          return 'victim';
        }
      }
      // These two never wait: whatever they must refuse, they refuse (or defer to commit) instead.
      if (optimistic || timestamped) needs = [];
      // READ UNCOMMITTED reads without asking anyone, and so does every reader under MVCC. Writes still take their
      // exclusive locks.
      if (mvcc || isolation === 'read-uncommitted') needs = needs.filter((n) => n.mode === 'exclusive');
      // Under MVCC another transaction's uncommitted row is invisible, so a duplicate of its key would go unnoticed:
      // a write that adds a unique key waits for whoever else is adding it, as a real unique index makes it.
      if (mvcc && !optimistic) {
        for (const k of newKeysOf(run, view)) {
          needs.push({ key: k.key, label: `the unique key ${k.text} of ${k.table}`, mode: 'exclusive' });
        }
      }
      // Any write waits for a predicate another session is holding that it would change, whatever level the writer
      // runs at: a lock is not optional for the one it is taken against.
      if (!mvcc) needs = [...needs, ...predicateNeeds(session, sql, run)];
      for (const n of needs) {
        if (n.mode === 'shared' && holds(locks, session, n.key, 'shared')) heldShared.add(n.key);
      }
      for (const need of needs) {
        labels.set(need.key, need.label);
        const outcome = request(locks, session, need.key, need.mode, labelOf);
        locks = outcome.state;
        if (outcome.kind === 'granted') notes.push(...outcome.narration);
        if (outcome.kind === 'granted' || outcome.kind === 'already-held') continue;

        if (outcome.kind === 'blocked') {
          blocked.set(session, { ...step, need });
          record(step, 'statement', 'blocked', {
            notes: [...notes, ...outcome.narration],
            waitingOn: outcome.waitingOn ?? [],
          });
          return 'blocked';
        }

        if (outcome.kind === 'deadlock') {
          deadlocks += 1;
          const victim = outcome.victim!;
          const cycle = outcome.cycle?.join(' → ') ?? '';
          if (victim === session) {
            // The requester is the youngest in the cycle: it is the one rolled back.
            const rolled = rollBackTransaction(session);
            locks = forget(locks, session);
            record(step, 'statement', 'victim', {
              error: `Deadlock: ${cycle} — ${session} was rolled back to break it.`,
              notes: [...notes, ...outcome.narration, ...rolled],
            });
            drain();
            return 'victim';
          }

          // Another session was chosen: its blocked statement fails and its transaction is rolled back.
          const killed = blocked.get(victim);
          blocked.delete(victim);
          const rolled = rollBackTransaction(victim);
          locks = forget(locks, victim);
          if (killed) {
            record(killed, 'statement', 'victim', {
              error: `Deadlock: ${cycle} — ${victim} was rolled back to break it.`,
              notes: [...outcome.narration, ...rolled],
            });
          } else {
            notes.push(...outcome.narration, ...rolled);
          }
          // The victim's own waiting steps may now run, and they change the table. What this statement worked out
          // before that is stale, so it starts again against what is there now: the locks it has already taken are
          // still held, and any it still lacks are asked for afresh.
          runQueued(victim);
          return execute(step, resumed);
        }
      }
    }

    // Holding the key's lock, check the key against everything committed, whatever the snapshot — a unique index
    // does not look at a snapshot.
    if (mvcc && !optimistic && run.write) {
      const duplicate = newKeysOf(run, view)
        .map((k) => ({ k, holder: committedHolder(k.table, k.key, k.rid, new Set()) }))
        .find((x) => x.holder !== undefined);
      if (duplicate) {
        notes.push(txn ? `No effect, and T${String(txn.number)} stays open.` : 'No effect.');
        if (!txn) endLocks(session, notes);
        record(step, 'statement', phase, {
          run,
          error: `duplicate key value violates unique index ${duplicate.k.index}`,
          notes,
        });
        if (!txn) drain();
        return 'done';
      }
    }

    // The statement runs. Anything below is the same with and without locking.
    const rows: Row[] = run.rows;
    if (run.write) {
      const { table, rows: written } = run.write;
      const before = view.tables[table]?.rows ?? [];
      const entries = entriesOf(run.write.kind, table, before, written, ridOf);

      // Carry each updated row's identity across to the row that replaced it, and number a new row at once, so that
      // id order keeps meaning table order.
      for (const entry of entries) {
        if (entry.kind === 'update') rowIds.set(entry.after, ridOf(entry.before));
        else if (entry.kind === 'insert') {
          ridOf(entry.row);
          homePages.set(ridOf(entry.row), Math.floor(written.indexOf(entry.row) / options.rowsPerPage));
        }
      }

      // First committer wins: under a snapshot, a row this statement can still see may already have been replaced by a
      // transaction that committed after the snapshot was taken. Writing over it would lose that change.
      if (mvcc && !optimistic) {
        const stale = entries.find((entry) => {
          if (entry.kind === 'insert') return false;
          const was = entry.kind === 'delete' ? entry.row : entry.before;
          const version = store.find((v) => v.row === was);
          return version !== undefined && version.xmax !== null && version.xmax !== txn?.xid && committedXids.has(version.xmax);
        });
        if (stale) {
          const rolled = txn ? rollBackTransaction(session) : [];
          endLocks(session, notes);
          record(step, 'statement', 'victim', {
            run,
            error: `Could not serialize access due to a concurrent update: a row this ${
              txn ? 'transaction' : 'statement'
            } read was changed by a transaction that committed after its snapshot. ${txn ? `${session} is rolled back.` : ''}`.trim(),
            notes: [...rolled, ...notes],
          });
          drain();
          return 'victim';
        }
      }

      // A write on top of a row this transaction read, which someone else has changed since: the change is overwritten
      // by a value worked out from a stale read.
      if (txn) {
        // The transaction's own change is a legitimate reason for a repeated query to answer differently.
        txn.reads.clear();
        const lost: Row[] = [];
        for (const entry of entries) {
          if (entry.kind === 'insert') {
            txn.seen.set(ridOf(entry.row), entry.row);
            continue;
          }
          const was = entry.kind === 'delete' ? entry.row : entry.before;
          const rid = ridOf(was);
          const read = txn.seen.get(rid);
          if (read !== undefined && read !== was) lost.push(read);
          if (entry.kind === 'update') txn.seen.set(rid, entry.after);
        }
        if (lost.length > 0) {
          const against = sessionOrder.filter((name) => name !== session);
          anomalies.push({
            kind: 'lost-update',
            session,
            against,
            message: `Lost update: ${session} read ${lost.map(rowText).join(', ')} and then wrote over a row that has since been changed and committed by ${
              against.join(' or ') || 'someone else'
            }. That change is overwritten by a value worked out from the old read.`,
          });
        }
      }

      // A write to a row somebody else has changed and not committed.
      const others = othersOpenLog(session);
      const clobbered = new Set<string>();
      for (const entry of entries) {
        const touched = entry.kind === 'insert' ? undefined : entry.kind === 'delete' ? entry.row : entry.before;
        const owner = touched ? producedBy(others, touched) : undefined;
        if (owner) clobbered.add(owner.session);
      }
      if (clobbered.size > 0) {
        const against = [...clobbered];
        anomalies.push({
          kind: 'dirty-write',
          session,
          against,
          message: `Dirty write: ${session} changed a row that ${against.join(' and ')} has changed and not committed. Nothing stopped it, and if ${against.join(' or ')} rolls back, there may be nothing left to restore.`,
        });
      }

      if (optimistic && txn?.workspace) {
        // The changes stay in the transaction's workspace, which no one else can see, until it commits.
        const ws = txn.workspace;
        for (const entry of entries) {
          if (entry.kind === 'insert') {
            ws.pending.push({ rid: ridOf(entry.row), table, row: entry.row, xmin: txn.xid, xmax: null, order: nextOrder });
            nextOrder += 1;
            ws.writes.add(ridOf(entry.row));
            continue;
          }
          const was = entry.kind === 'delete' ? entry.row : entry.before;
          const own = ws.pending.findIndex((v) => v.row === was);
          const base = own >= 0 ? ws.pending[own] : store.find((v) => v.row === was);
          if (!base) continue;
          ws.writes.add(base.rid);
          if (own >= 0) ws.pending.splice(own, 1);
          else ws.removed.add(base);
          if (entry.kind === 'update') {
            ws.pending.push({ rid: base.rid, table, row: entry.after, xmin: txn.xid, xmax: null, order: base.order });
          }
        }
      } else if (mvcc) {
        // The statement's changes become versions: a deletion stamps the old one, an update stamps it and adds the
        // new one, an insert adds one. An autocommit statement is its own transaction and commits at once.
        const xid = txn ? txn.xid : nextNumber;
        if (!txn) nextNumber += 1;
        for (const entry of entries) {
          if (entry.kind === 'insert') {
            store.push({ rid: ridOf(entry.row), table, row: entry.row, xmin: xid, xmax: null, order: nextOrder });
            nextOrder += 1;
            continue;
          }
          const was = entry.kind === 'delete' ? entry.row : entry.before;
          const version = store.find((v) => v.row === was);
          if (!version) continue;
          version.xmax = xid;
          if (entry.kind === 'update') {
            store.push({ rid: version.rid, table, row: entry.after, xmin: xid, xmax: null, order: version.order });
          }
        }
        if (!txn) committedXids.add(xid);
        else openXids.add(xid);
        current = latest();
      } else {
        current = withRows(current, table, written);
      }
      // A row this statement just made is locked by it from the first moment, which no one else could have asked for.
      if (rowLevel && txn) {
        for (const entry of entries) {
          if (entry.kind !== 'insert') continue;
          const key = `${table}/row/${String(ridOf(entry.row))}`;
          const first = current.tables[table]?.columns[0];
          labels.set(key, `the row of ${table} with ${first ?? 'id'} = ${String(first === undefined ? '' : (entry.row[first] ?? 'NULL'))}`);
          locks = request(locks, session, key, 'exclusive', labelOf).state;
        }
      }
      const verb = run.write.kind === 'insert' ? 'inserted' : run.write.kind === 'delete' ? 'deleted' : 'updated';
      if (txn) {
        for (const entry of entries) txn.log.push({ step: index, session, entry });
        notes.push(
          `${plural(entries.length, 'row')} ${verb} in ${table}; ${session} has ${plural(txn.log.length, 'uncommitted change')}.`,
        );
      } else {
        notes.push(`${plural(entries.length, 'row')} ${verb} in ${table}, committed at once (autocommit).`);
      }
    } else if (run.analyze) {
      const target = current.tables[run.analyze.table];
      if (target) {
        current = { tables: { ...current.tables, [run.analyze.table]: { ...target, stats: run.analyze.stats } } };
        const base = template.tables[run.analyze.table];
        if (base) template = { tables: { ...template.tables, [run.analyze.table]: { ...base, stats: run.analyze.stats } } };
      }
      notes.push(`Statistics for ${run.analyze.table} recorded.`);
    } else {
      notes.push(`${plural(rows.length, 'row')} returned.`);
      if (txn) {
        // The same question asked twice in one transaction, answered differently.
        const asked = sql.trim().replace(/\s+/g, ' ');
        const previous = txn.reads.get(asked);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(rows)) {
          const against = sessionOrder.filter((name) => name !== session);
          const phantom = previous.length !== rows.length;
          anomalies.push({
            kind: phantom ? 'phantom' : 'non-repeatable-read',
            session,
            against,
            message: phantom
              ? `Phantom: ${session} ran this query twice in T${String(txn.number)} and the second answer has ${plural(rows.length, 'row')} where the first had ${String(previous.length)} — ${against.join(' or ') || 'another session'} committed a row that matches it in between.`
              : `Non-repeatable read: ${session} ran this query twice in T${String(txn.number)} and got different values — ${against.join(' or ') || 'another session'} committed a change to a row it had already read.`,
          });
        }
        txn.reads.set(asked, rows);
        for (const row of matchedRows(sql, view)) txn.seen.set(ridOf(row), row);
      }
    }

    // SERIALIZABLE under MVCC re-checks, at COMMIT, everything the transaction read.
    if (mvcc && txn && (optimistic || txn.isolation === 'serializable') && !run.analyze) {
      const target = targetOf(sql);
      if (target && target.kind !== 'insert') txn.readPredicates.push({ table: target.table, where: target.where });
    }

    // A read that would have returned something else without another session's uncommitted changes.
    const others = othersOpenLog(session);
    if (!mvcc && !run.write && !run.analyze && others.length > 0) {
      const committedView = undo(current, [...others].sort((a, b) => b.step - a.step), ridOf).db;
      const clean = runQuery(sql, committedView, options);
      if (!clean.error && JSON.stringify(clean.rows) !== JSON.stringify(rows)) {
        const against = [...new Set(others.map((l) => l.session))];
        anomalies.push({
          kind: 'dirty-read',
          session,
          against,
          message: `Dirty read: ${session} saw changes ${against.join(' and ')} has not committed. Without them this query returns ${
            clean.rows.length === 0 ? 'no rows' : clean.rows.map(rowText).join(', ')
          }; if ${against.join(' or ')} rolls back, ${session} has read data that never existed.`,
        });
      }
    }

    // The same for a write: its WHERE (or the values it computes) was answered from another session's uncommitted
    // change, so it changed what it would not have changed — or wrote what it would not have written — without it.
    if (!mvcc && run.write && others.length > 0) {
      const committedView = undo(view, [...others].sort((a, b) => b.step - a.step), ridOf).db;
      const clean = runQuery(sql, committedView, options);
      if (!clean.error && clean.write && JSON.stringify(clean.rows) !== JSON.stringify(run.rows)) {
        const against = [...new Set(others.map((l) => l.session))];
        anomalies.push({
          kind: 'dirty-read',
          session,
          against,
          message: `Dirty read: ${session}'s statement worked from changes ${against.join(' and ')} has not committed. Without them it ${
            clean.rows.length === 0 ? 'would have changed no rows' : `would have written ${clean.rows.map(rowText).join(', ')}`
          }; if ${against.join(' or ')} rolls back, ${session} has acted on data that never existed.`,
        });
      }
    }

    if (timestamped) {
      const ts = txn ? txn.number : nextNumber;
      if (run.write) {
        for (const entry of entriesOf(run.write.kind, run.write.table, view.tables[run.write.table]?.rows ?? [], run.write.rows, ridOf)) {
          if (entry.kind === 'insert') stamps.set(ridOf(entry.row), { read: ts, write: ts });
          else {
            const image = entry.kind === 'delete' ? entry.row : entry.before;
            graveyard.push({ table: run.write.table, image, written: ts });
          }
        }
      }
      if (!txn) nextNumber += 1;
    }
    if (resumed === 'lock') notes.unshift(`${session}'s statement had to wait for a lock, and now runs.`);
    if (resumed === 'queue') notes.unshift(`${session}'s step waited behind its blocked statement, and now runs.`);
    let gaveBack = false;
    if (locking && txn) {
      if (isolation === 'read-committed') {
        // READ COMMITTED reads under a lock held only as long as the statement, then gives it back.
        let released = 0;
        for (const need of needs) {
          if (need.mode !== 'shared' || heldShared.has(need.key) || !holds(locks, session, need.key, 'shared')) continue;
          locks = release(locks, session, need.key, 'shared', labelOf).state;
          released += 1;
        }
        if (released > 0) {
          gaveBack = true;
          notes.push(
            `${session} is at ${ISOLATION_LABELS[isolation]}, so it gives back the ${plural(released, 'shared lock')} this statement took.`,
          );
        }
      } else if (isolation === 'serializable' && !mvcc) {
        // SERIALIZABLE keeps the read's WHERE as a lock until the transaction ends, against inserts that would match.
        const target = targetOf(sql);
        if (target && target.kind !== 'insert') {
          const key = `${target.table}/predicate/${String(nextPredicate)}`;
          nextPredicate += 1;
          const text = target.where ? exprToSql(target.where) : 'of every row';
          labels.set(key, `the rows ${text} that ${session} read`);
          locks = request(locks, session, key, 'exclusive', labelOf).state;
          predicates.push({ key, session, table: target.table, where: target.where, text });
          notes.push(`${session} also holds a predicate lock on ${target.where ? `the rows where ${text}` : 'every row'}.`);
        }
      }
    }

    // An autocommit statement is its own transaction: its locks end with it.
    if (!txn && locking) endLocks(session, notes);
    record(step, 'statement', phase, { run, rows, notes, anomalies, ...(mvcc ? { view: viewNow() } : {}) });
    if ((!txn && locking) || gaveBack) drain();
    return 'done';
  }

  steps.forEach((step, index) => {
    if (!sessionOrder.includes(step.session)) sessionOrder.push(step.session);
    const item: Queued = { index, session: step.session, sql: step.sql };

    // Behind a statement that is waiting for a lock, a session's later steps wait too.
    if (locking && blocked.has(item.session)) {
      const line = queued.get(item.session) ?? [];
      line.push(item);
      queued.set(item.session, line);
      const control = controlKindOf(item.sql);
      record(item, control === 'begin' || control === 'commit' || control === 'rollback' ? control : 'statement', 'queued', {
        notes: [`${item.session} is waiting for a lock, so this step waits behind it.`],
      });
      return;
    }

    const outcome = execute(item, false);
    if (outcome !== 'blocked') runQueued(item.session);
    drain();
  });

  // What would survive a crash: the database with every still-open transaction undone.
  const stillOpen = [...transactions.keys()];
  const allOpen = [...transactions.values()].flatMap((t) => t.log).sort((a, b) => b.step - a.step);
  const committed = mvcc ? viewOf(template, store, committedXids, -1) : undo(current, allOpen, ridOf).db;
  const dead = mvcc ? deadVersions() : [];

  return {
    steps: results,
    final: current,
    committed,
    open: stillOpen,
    stuck: [...blocked.keys()],
    deadlocks,
    truncated: schedule.length > MAX_SCHEDULE_STEPS,
    snapshots: mvcc
      ? sessionOrder.map((session) => {
          const txn = transactions.get(session);
          const fresh = txn === undefined || txn.isolation === 'read-committed' || txn.isolation === 'read-uncommitted';
          return {
            session,
            xid: txn?.xid ?? null,
            committed: [...(fresh ? committedXids : (txn.snapshot ?? committedXids))].sort((a, b) => a - b),
          };
        })
      : [],
    bloat: mvcc
      ? {
          dead: dead.length,
          pages: pagesFor(store),
          pagesAfterVacuum: pagesFor(store.filter((v) => !dead.includes(v))),
        }
      : null,
  };
}
