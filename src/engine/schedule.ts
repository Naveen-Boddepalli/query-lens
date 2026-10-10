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
 * A statement outside `BEGIN … COMMIT` is its own transaction (autocommit). A statement that fails changes nothing and
 * leaves the transaction open, as MySQL does; PostgreSQL would instead refuse everything until `ROLLBACK`.
 */

import { passes } from './exec/evaluate.ts';
import { emptyTable, forget, holds, release, releaseAll, request } from './locks/lockTable.ts';
import type { LockMode, LockTableState } from './locks/lockTable.ts';
import { parseStatement, walkExpr } from './parser/index.ts';
import type { Expr } from './parser/index.ts';
import { exprToSql } from './planner/index.ts';
import { runQuery } from './runQuery.ts';
import { buildHeap } from './storage/index.ts';
import { ISOLATION_LABELS } from './isolation.ts';
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
}

/** What a write did to one row, in the terms needed to put it back. Rows are identified by reference, not by value. */
export type UndoEntry =
  | { kind: 'insert'; table: string; row: Row }
  | { kind: 'delete'; table: string; row: Row; index: number }
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
      rows.splice(Math.min(entry.index, rows.length), 0, entry.row);
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
function entriesOf(kind: 'insert' | 'delete' | 'update', table: string, before: Row[], after: Row[]): UndoEntry[] {
  const kept = new Set(after);
  const had = new Set(before);
  if (kind === 'insert') {
    return after.filter((row) => !had.has(row)).map((row) => ({ kind: 'insert', table, row }));
  }
  if (kind === 'delete') {
    const entries: UndoEntry[] = [];
    before.forEach((row, index) => {
      if (!kept.has(row)) entries.push({ kind: 'delete', table, row, index });
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
    parts: Partial<Pick<ScheduleStepResult, 'run' | 'rows' | 'error' | 'notes' | 'anomalies' | 'waitingOn'>>,
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
      after: current,
      sessions: snapshots(),
      locks: lockRows(),
    });
  }

  /** The locks a statement needs, in the order it will ask: what it reads is shared, what it changes is exclusive. */
  function footprint(sql: string, run: RunResult): Need[] {
    const target = targetOf(sql);
    if (!target) return [];
    const table = current.tables[target.table];
    if (!table) return [];
    const rowsPerPage = options.rowsPerPage;
    const heapPages = Math.ceil(table.rows.length / rowsPerPage);
    const multi = Object.keys(current.tables).length > 1;
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

    if (locking?.granularity !== 'row') {
      const all = opaque(target.where);
      for (const stone of tombstones) {
        // An insert looks for no existing row, so it has no use for a row's old image.
        if (target.kind === 'insert') break;
        if (!all && !passes(target.where, stone.row)) continue;
        if (pages.get(stone.page) !== 'exclusive') pages.set(stone.page, writes ? 'exclusive' : 'shared');
      }
      return [...pages.entries()].map(([pageId, mode]) => ({
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
  function matchedRows(sql: string): Row[] {
    const target = targetOf(sql);
    const table = target ? current.tables[target.table] : undefined;
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
    const images = entriesOf(run.write.kind, run.write.table, before, run.write.rows).flatMap((entry) =>
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
    const undone = undo(current, [...txn.log].sort((a, b) => b.step - a.step));
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
        transactions.set(session, { number, log: [], isolation: level, reads: new Map(), seen: new Map() });
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
        notes.push(
          `${session} commits T${String(txn.number)}: its ${plural(txn.log.length, 'change')} ${
            txn.log.length === 1 ? 'is' : 'are'
          } now permanent, and visible to everyone.`,
        );
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
      } else {
        const undone = undo(current, [...txn.log].sort((a, b) => b.step - a.step));
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

    // An ordinary statement. What it *sees* is the shared database exactly as it stands.
    const run = runQuery(sql, current, options);
    if (run.error) {
      record(step, 'statement', phase, {
        run,
        error: run.error.message,
        notes: [txn ? `No effect, and T${String(txn.number)} stays open.` : 'No effect.'],
      });
      return 'done';
    }

    // Under locking, take every lock the statement needs before it runs, holding each to the end of the transaction.
    const isolation = txn?.isolation ?? defaultIsolation;
    let needs: Need[] = [];
    const heldShared = new Set<string>();
    if (locking) {
      needs = footprint(sql, run);
      // READ UNCOMMITTED reads without asking anyone. Writes still take their exclusive locks.
      if (isolation === 'read-uncommitted') needs = needs.filter((n) => n.mode === 'exclusive');
      // Any write waits for a predicate another session is holding that it would change, whatever level the writer
      // runs at: a lock is not optional for the one it is taken against.
      needs = [...needs, ...predicateNeeds(session, sql, run)];
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
          runQueued(victim);

          // The abort may have granted the lock this statement was asking for.
          if (holds(locks, session, need.key, need.mode)) continue;
          blocked.set(session, { ...step, need });
          record(step, 'statement', 'blocked', { notes: [...notes], waitingOn: outcome.waitingOn ?? [] });
          return 'blocked';
        }
      }
    }

    // The statement runs. Anything below is the same with and without locking.
    const rows: Row[] = run.rows;
    if (run.write) {
      const { table, rows: written } = run.write;
      const before = current.tables[table]?.rows ?? [];
      const entries = entriesOf(run.write.kind, table, before, written);

      // Carry each updated row's identity across to the row that replaced it.
      for (const entry of entries) {
        if (entry.kind === 'update') rowIds.set(entry.after, ridOf(entry.before));
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

      current = withRows(current, table, written);
      // A row this statement just made is locked by it from the first moment, which no one else could have asked for.
      if (locking?.granularity === 'row' && txn) {
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
        for (const row of matchedRows(sql)) txn.seen.set(ridOf(row), row);
      }
    }

    // A read that would have returned something else without another session's uncommitted changes.
    const others = othersOpenLog(session);
    if (!run.write && !run.analyze && others.length > 0) {
      const committedView = undo(current, [...others].sort((a, b) => b.step - a.step)).db;
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
      } else if (isolation === 'serializable') {
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
    record(step, 'statement', phase, { run, rows, notes, anomalies });
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
  const committed = undo(current, allOpen).db;

  return {
    steps: results,
    final: current,
    committed,
    open: stillOpen,
    stuck: [...blocked.keys()],
    deadlocks,
    truncated: schedule.length > MAX_SCHEDULE_STEPS,
  };
}
