/**
 * Write-ahead logging (plan.md §25.4 E1): a database that keeps its pages on "disk", a buffer pool of frames in front
 * of them, and a log — and the one rule that makes the log worth keeping. **A page may not be written to disk until
 * the log records that describe its changes are durable.** Otherwise a crash leaves a change on disk with nothing
 * anywhere to say what it was, or to undo it.
 *
 * This is the whole mechanism, pure and total like the lock table: `runWal` folds a list of steps over a machine and
 * returns, for each step, what happened (as typed effects and as words) and the state it left. Nothing here knows
 * about SQL; a page is a few named cells, because the point is the log, not the data. E2 adds the steal/force policies
 * and E3 the crash and recovery on this same state; neither needs this file to change shape.
 *
 * The model is ARIES's, in the part that is logging:
 *  - every change appends a record with a **LSN** (log sequence number, strictly increasing) and a **prevLSN**, the
 *    transaction's previous record, so a transaction's records form a chain you can walk backwards;
 *  - a record is first in the **log buffer** and only **durable** once flushed, and `flushedLSN` is the last durable one;
 *  - a page remembers the LSN of the last record applied to it (**pageLSN**) and of the first one that dirtied it
 *    since it was last written (**recLSN**);
 *  - `COMMIT` forces the log through the commit record, and nothing else about a commit touches a data page;
 *  - rolling back writes a **compensation log record** (CLR) for every change it undoes, so undoing is itself logged.
 *
 * Two policies decide how pages and transactions interact (plan.md §25.4 E2), and each has a price you can see:
 *  - **steal**: the pool may write out a page that holds an *uncommitted* change. It frees the frame, and means that a
 *    crash can find a change on disk that nobody committed, which recovery must **undo**. **No-steal** never does: a
 *    page with an uncommitted change is pinned until its transaction ends, so a big transaction needs a big pool.
 *  - **force**: a commit writes every page the transaction changed. A crash then never finds a committed change
 *    missing from disk, so nothing has to be **redone** — at the price of random page writes inside every commit.
 *    **No-force** commits with one sequential log write, and owes the pages: recovery redoes them.
 * `crashImage` is the consequence, computed: what a crash at this very moment would find.
 *
 * And the crash itself (plan.md §25.4 E3). A **fuzzy checkpoint** copies the transaction table and the dirty page table
 * into the log without writing a page or stopping anyone. A **crash** drops the pool, the log buffer and every
 * transaction, and keeps the disk, the durable log and the master record that points at the last checkpoint.
 * **Recovery** is ARIES's three passes, each one visible in its report: *analysis* rebuilds the two tables from the
 * checkpoint forward and names the losers; *redo* repeats history, skipping a record the page already has; *undo*
 * rolls the losers back newest first, writing a compensation record for each, so a crash during recovery picks up
 * where it left off and never undoes a change twice.
 */

export type PageId = number;
export type Cell = number;

export type LogRecord =
  | { type: 'update'; lsn: number; prevLSN: number | null; txn: string; page: PageId; key: string; before: Cell; after: Cell }
  | { type: 'commit'; lsn: number; prevLSN: number | null; txn: string }
  | { type: 'abort'; lsn: number; prevLSN: number | null; txn: string }
  /** Redo-only: the undo of the update `undoNextLSN`'s successor, and where undoing continues from. */
  | { type: 'clr'; lsn: number; prevLSN: number | null; txn: string; page: PageId; key: string; after: Cell; undoNextLSN: number | null }
  | { type: 'end'; lsn: number; prevLSN: number | null; txn: string }
  /** A fuzzy checkpoint starts here: nothing is written and nothing waits. Recovery's analysis begins at this LSN. */
  | { type: 'begin-checkpoint'; lsn: number; prevLSN: null }
  /** The tables as they were when the checkpoint began, which is what makes it safe to take while work goes on. */
  | {
      type: 'end-checkpoint';
      lsn: number;
      prevLSN: null;
      beginLSN: number;
      dirtyPages: { page: PageId; recLSN: number }[];
      txns: { txn: string; lastLSN: number }[];
    };

/** A record that belongs to a transaction: every kind but the checkpoint's two. */
export type TxnRecord = Exclude<LogRecord, { type: 'begin-checkpoint' | 'end-checkpoint' }>;

export function isTxnRecord(r: LogRecord): r is TxnRecord {
  return r.type !== 'begin-checkpoint' && r.type !== 'end-checkpoint';
}

export type WalStep =
  | { op: 'begin'; txn: string }
  | { op: 'set'; txn: string; key: string; value: number }
  | { op: 'commit'; txn: string }
  | { op: 'abort'; txn: string }
  /** Force everything in the log buffer to the durable log. */
  | { op: 'flush-log' }
  /** The background writer: write one dirty page to disk. */
  | { op: 'write-page'; page: PageId }
  /** Bring a page into the pool, evicting the least recently used one if it is full. */
  | { op: 'read-page'; page: PageId }
  /** A whole fuzzy checkpoint at once: its begin record and its end record, back to back. */
  | { op: 'checkpoint' }
  /** Begin a checkpoint: the tables are copied now, and work may go on before the end record is written. */
  | { op: 'checkpoint-begin' }
  | { op: 'checkpoint-end' }
  /** The machine stops: the pool, the log buffer and every transaction are gone. */
  | { op: 'crash' }
  /** Restart: analysis, redo, undo. With `crashAfter`, the machine stops again after that many undo records. */
  | { op: 'recover'; crashAfter?: number };

export interface WalOptions {
  /** Frames in the buffer pool. */
  frames: number;
  /**
   * Whether the log-before-data rule is enforced. On, a page about to be written first has the log flushed through its
   * pageLSN. Off, the page is written anyway and the run says what that would have cost — the point of the rule.
   */
  enforce: boolean;
  /**
   * Whether the pool may write a page that holds an uncommitted change. Off (no-steal), such a page is pinned until its
   * transaction ends, and a step that would need its frame is refused. Default on, as ARIES assumes.
   */
  steal: boolean;
  /** Whether a commit writes every page its transaction changed. Default off (no-force), as ARIES assumes. */
  force: boolean;
  /** The pages on disk at the start, as cells by name. A key lives on exactly one page. */
  pages: Record<PageId, Record<string, Cell>>;
}

export const DEFAULT_PAGES: Record<PageId, Record<string, Cell>> = {
  1: { a: 10, b: 20 },
  2: { c: 30, d: 40 },
  3: { e: 50, f: 60 },
  4: { g: 70, h: 80 },
};

export const MAX_WAL_STEPS = 40;

export const DEFAULT_WAL_OPTIONS: WalOptions = { frames: 3, enforce: true, steal: true, force: false, pages: DEFAULT_PAGES };

export interface FrameState {
  slot: number;
  page: PageId;
  cells: Record<string, Cell>;
  /** LSN of the last record applied to this copy. */
  pageLSN: number;
  /** LSN of the first record that dirtied it since it was last written; null while clean. */
  recLSN: number | null;
  /** The transactions, still running, that have changed something on this page: its uncommitted changes are theirs. */
  holders: string[];
}

export interface DiskPageState {
  page: PageId;
  cells: Record<string, Cell>;
  pageLSN: number;
}

export interface TxnState {
  txn: string;
  status: 'active' | 'ended';
  /** How it ended, once it has. */
  outcome: 'committed' | 'rolled-back' | null;
  /** Its newest log record, or null while it has written none. */
  lastLSN: number | null;
}

export interface WalState {
  /** One entry per frame slot; null while the slot is empty. */
  pool: (FrameState | null)[];
  disk: DiskPageState[];
  /** Appended, not yet durable: lost if the machine stops now. */
  logBuffer: LogRecord[];
  /** Durable, in LSN order. */
  log: LogRecord[];
  flushedLSN: number;
  nextLSN: number;
  txns: TxnState[];
  /** The begin record of the last completed checkpoint: what a restart looks at first. Survives a crash. */
  masterLSN: number | null;
  /** True between a crash and the end of recovery. Nothing else runs. */
  crashed: boolean;
  /** The begin record of a checkpoint whose end record has not been written yet, if any. */
  checkpointOpen: number | null;
}

/** What recovery did, in the three passes ARIES names. */
export interface RecoveryReport {
  analysis: {
    /** Where the scan of the log began: the last checkpoint's begin record, or the start of the log. */
    from: number;
    checkpoint: number | null;
    /** The tables as analysis left them. */
    dirtyPages: { page: PageId; recLSN: number }[];
    txns: { txn: string; status: 'active' | 'aborting' | 'committed'; lastLSN: number }[];
    /** Transactions with no commit record: to be undone. */
    losers: string[];
    /** The oldest recLSN in the dirty page table: where redo starts. */
    redoFrom: number | null;
  };
  redo: { lsn: number; page: PageId; key: string; action: 'redo' | 'skip'; reason: string }[];
  undo: { lsn: number; txn: string; action: 'undo' | 'follow' | 'end'; detail: string; clr: number | null }[];
  /** Committed transactions whose end record had not been written, and so was written now. */
  ended: string[];
  /** True when the machine was stopped again before undo finished. */
  interrupted: boolean;
}

export type WalEffect =
  | { kind: 'log-append'; record: LogRecord }
  | { kind: 'log-flush'; from: number; to: number; reason: 'commit' | 'log-before-data' | 'explicit' | 'checkpoint' | 'recovery' }
  | { kind: 'page-fetch'; page: PageId; hit: boolean; slot: number }
  | { kind: 'page-evict'; page: PageId; dirty: boolean; slot: number }
  | { kind: 'page-write'; page: PageId; pageLSN: number; reason: 'eviction' | 'background' | 'force' }
  /** The rule is off and a page went to disk ahead of its log. */
  | { kind: 'rule-violated'; page: PageId; pageLSN: number; flushedLSN: number };

/** A cell whose value on disk is not the value a committed transaction left. */
export interface CrashCell {
  page: PageId;
  key: string;
  onDisk: Cell;
  /** What recovery has to make it: the newest committed value. */
  committed: Cell;
  /** The transaction whose change is on disk (to undo) or whose commit is missing from disk (to redo). */
  by: string;
  /** For an undo: whether the log record that would say how to undo it is durable. A page written ahead of its log has none. */
  logged: boolean;
}

/** What a crash at this moment would find: the consequence of the steal and force choices. */
export interface CrashImage {
  /** Values on disk that no committed transaction wrote — **steal** puts them there. Recovery must undo each. */
  undo: CrashCell[];
  /** Committed values that never reached disk — **no-force** leaves them in the pool. Recovery must redo each. */
  redo: CrashCell[];
  /** Records still in the log buffer: gone with the machine. */
  lostRecords: number;
}

export interface WalStepResult {
  index: number;
  step: WalStep;
  effects: WalEffect[];
  /** What happened, in words. */
  notes: string[];
  /** Set when the step was refused; it then changed nothing. */
  error?: string;
  state: WalState;
  /** Everything wrong with `state` as a log-before-data matter: empty whenever the rule is enforced. */
  violations: string[];
  /** What a crash right after this step would find. */
  crash: CrashImage;
  /** For a `recover` step that ran: the three passes. */
  recovery?: RecoveryReport;
}

export interface WalRun {
  options: WalOptions;
  initial: WalState;
  steps: WalStepResult[];
  final: WalState;
  truncated: boolean;
}

/** Why `state` breaks the rule, or nothing: each page on disk must have all its changes' log records durable. */
export function walViolations(state: WalState): string[] {
  return state.disk
    .filter((p) => p.pageLSN > state.flushedLSN)
    .map(
      (p) =>
        `Page ${String(p.page)} on disk carries a change from LSN ${String(p.pageLSN)}, but the log is durable only through LSN ${String(state.flushedLSN)}: after a crash nothing could say what that change was, or undo it.`,
    );
}

/**
 * What a crash at this moment would find (plan.md §25.4 E2). The database a recovery must produce is the initial one
 * with every *committed* transaction's changes applied in log order, and a transaction is committed when its commit
 * record is durable. Each cell on disk is then either right, or:
 *  - holding a value an uncommitted transaction wrote (it got there by **steal**): **undo**; or
 *  - behind a committed change that never reached the disk (**no-force**): **redo**.
 */
export function crashImage(state: WalState, initial: Record<PageId, Record<string, Cell>>): CrashImage {
  const records = [...state.log, ...state.logBuffer].filter(isTxnRecord);
  const committedTxns = new Set(state.log.filter(isTxnRecord).filter((r) => r.type === 'commit').map((r) => r.txn));
  const committedValue: Record<string, Cell> = {};
  const committedBy: Record<string, string> = {};
  for (const cells of Object.values(initial)) Object.assign(committedValue, cells);
  for (const r of state.log) {
    if (r.type === 'update' && committedTxns.has(r.txn)) {
      committedValue[r.key] = r.after;
      committedBy[r.key] = r.txn;
    }
  }
  const undo: CrashCell[] = [];
  const redo: CrashCell[] = [];
  for (const p of state.disk) {
    for (const [key, onDisk] of Object.entries(p.cells)) {
      const committed = committedValue[key]!;
      if (onDisk === committed) continue;
      // The record that explains what is on disk: the newest change to this cell that the page on disk includes.
      let explains: TxnRecord | undefined;
      for (const r of records) {
        if ((r.type === 'update' || r.type === 'clr') && r.key === key && r.page === p.page && r.lsn <= p.pageLSN) {
          explains = r;
        }
      }
      if (explains && !committedTxns.has(explains.txn)) {
        undo.push({ page: p.page, key, onDisk, committed, by: explains.txn, logged: explains.lsn <= state.flushedLSN });
      } else {
        redo.push({ page: p.page, key, onDisk, committed, by: committedBy[key] ?? '?', logged: true });
      }
    }
  }
  return { undo, redo, lostRecords: state.logBuffer.length };
}

/** What the database holds right now: the disk, with the pool's copy of each page over it. */
export function databaseCells(state: WalState): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const p of state.disk) Object.assign(out, p.cells);
  for (const f of state.pool) if (f) Object.assign(out, f.cells);
  return out;
}

/** What the database must hold after recovery: the initial data with every committed transaction's changes applied. */
export function committedCells(state: WalState, initial: Record<PageId, Record<string, Cell>>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const cells of Object.values(initial)) Object.assign(out, cells);
  const winners = new Set(state.log.filter(isTxnRecord).filter((r) => r.type === 'commit').map((r) => r.txn));
  for (const r of state.log) if (r.type === 'update' && winners.has(r.txn)) out[r.key] = r.after;
  return out;
}

/** One of the four steal/force combinations, run on a script, with what it cost and what it left owing. */
export interface PolicyOutcome {
  steal: boolean;
  force: boolean;
  run: WalRun;
  /** Data pages written inside commits — what force charges. */
  commitWrites: number;
  /** Data pages written otherwise: by the writer, or to make room. */
  otherWrites: number;
  /** Times the log was forced to disk. */
  logForces: number;
  /** Steps no-steal refused: a page it would not write out, or a frame it could not free. */
  refused: number;
  /** The most cells a crash at any single step would have left needing an undo, and a redo. */
  worstUndo: number;
  worstRedo: number;
  /** The same, for a crash after the last step. */
  endUndo: number;
  endRedo: number;
}

/** The same script under steal/no-steal × force/no-force, in that order: (steal, no-force) first. */
export function comparePolicies(steps: readonly WalStep[], given: Partial<WalOptions> = {}): PolicyOutcome[] {
  const combos: [boolean, boolean][] = [
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ];
  return combos.map(([steal, force]) => {
    const run = runWal(steps, { ...given, steal, force });
    let commitWrites = 0;
    let otherWrites = 0;
    let logForces = 0;
    for (const r of run.steps) {
      for (const e of r.effects) {
        if (e.kind === 'page-write') {
          if (e.reason === 'force') commitWrites += 1;
          else otherWrites += 1;
        } else if (e.kind === 'log-flush') logForces += 1;
      }
    }
    const crashes = [run.steps.at(-1)?.crash, ...run.steps.map((r) => r.crash)].filter((c) => c !== undefined);
    const end = run.steps.at(-1)?.crash;
    return {
      steal,
      force,
      run,
      commitWrites,
      otherWrites,
      logForces,
      refused: run.steps.filter((r) => r.error?.startsWith('No-steal')).length,
      worstUndo: Math.max(0, ...crashes.map((c) => c.undo.length)),
      worstRedo: Math.max(0, ...crashes.map((c) => c.redo.length)),
      endUndo: end?.undo.length ?? 0,
      endRedo: end?.redo.length ?? 0,
    };
  });
}

/** The cells as text, for a table cell or a note. */
export const cellsText = (cells: Record<string, Cell>): string =>
  Object.entries(cells)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');

/** The record in words, short enough for a log table. */
export function describeRecord(r: LogRecord): string {
  switch (r.type) {
    case 'update':
      return `update page ${String(r.page)}: ${r.key} ${String(r.before)} → ${String(r.after)}`;
    case 'clr':
      return `undo on page ${String(r.page)}: ${r.key} back to ${String(r.after)}; next to undo ${r.undoNextLSN === null ? 'nothing' : `LSN ${String(r.undoNextLSN)}`}`;
    case 'commit':
      return 'commit';
    case 'abort':
      return 'abort (rollback begins)';
    case 'end':
      return 'end';
    case 'begin-checkpoint':
      return 'begin checkpoint';
    case 'end-checkpoint':
      return `end checkpoint (of ${String(r.beginLSN)}): ${r.dirtyPages.length === 0 ? 'no dirty pages' : `dirty pages ${r.dirtyPages.map((d) => `${String(d.page)}@${String(d.recLSN)}`).join(', ')}`}; ${r.txns.length === 0 ? 'no active transactions' : `active ${r.txns.map((t) => `${t.txn}@${String(t.lastLSN)}`).join(', ')}`}`;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseWalStep(text: string): WalStep | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (/^begin checkpoint$/i.test(t)) return { op: 'checkpoint-begin' };
  if (/^end checkpoint$/i.test(t)) return { op: 'checkpoint-end' };
  let m = /^begin (\w+)$/i.exec(t);
  if (m) return { op: 'begin', txn: m[1]! };
  m = /^set (\w+) ([a-z]\w*) ?= ?(-?\d{1,9})$/i.exec(t);
  if (m) return { op: 'set', txn: m[1]!, key: m[2]!, value: Number(m[3]) };
  m = /^commit (\w+)$/i.exec(t);
  if (m) return { op: 'commit', txn: m[1]! };
  m = /^(?:abort|rollback) (\w+)$/i.exec(t);
  if (m) return { op: 'abort', txn: m[1]! };
  if (/^flush log$/i.test(t)) return { op: 'flush-log' };
  m = /^write page (\d{1,3})$/i.exec(t);
  if (m) return { op: 'write-page', page: Number(m[1]) };
  m = /^read page (\d{1,3})$/i.exec(t);
  if (m) return { op: 'read-page', page: Number(m[1]) };
  if (/^checkpoint$/i.test(t)) return { op: 'checkpoint' };
  if (/^crash$/i.test(t)) return { op: 'crash' };
  if (/^recover$/i.test(t)) return { op: 'recover' };
  m = /^recover(?:,| and)? crash after (\d{1,2})$/i.exec(t);
  if (m) return { op: 'recover', crashAfter: Number(m[1]) };
  return null;
}

export function formatWalStep(step: WalStep): string {
  switch (step.op) {
    case 'begin':
      return `begin ${step.txn}`;
    case 'set':
      return `set ${step.txn} ${step.key} = ${String(step.value)}`;
    case 'commit':
      return `commit ${step.txn}`;
    case 'abort':
      return `abort ${step.txn}`;
    case 'flush-log':
      return 'flush log';
    case 'write-page':
      return `write page ${String(step.page)}`;
    case 'read-page':
      return `read page ${String(step.page)}`;
    case 'checkpoint':
      return 'checkpoint';
    case 'checkpoint-begin':
      return 'begin checkpoint';
    case 'checkpoint-end':
      return 'end checkpoint';
    case 'crash':
      return 'crash';
    case 'recover':
      return step.crashAfter === undefined ? 'recover' : `recover, crash after ${String(step.crashAfter)}`;
  }
}

/** Runs `steps` on a fresh machine. A refused step changes nothing and says why. */
export function runWal(steps: readonly WalStep[], given: Partial<WalOptions> = {}): WalRun {
  const options: WalOptions = {
    ...DEFAULT_WAL_OPTIONS,
    ...given,
    frames: Math.max(1, Math.min(8, Math.floor(given.frames ?? DEFAULT_WAL_OPTIONS.frames))),
  };
  const truncated = steps.length > MAX_WAL_STEPS;
  const script = steps.slice(0, MAX_WAL_STEPS);

  const disk = new Map<PageId, { cells: Record<string, Cell>; pageLSN: number }>();
  const keyPage = new Map<string, PageId>();
  for (const [id, cells] of Object.entries(options.pages)) {
    disk.set(Number(id), { cells: { ...cells }, pageLSN: 0 });
    for (const key of Object.keys(cells)) keyPage.set(key, Number(id));
  }

  const pool: (FrameState | null)[] = Array.from({ length: options.frames }, () => null);
  const lastUsed: number[] = Array.from({ length: options.frames }, () => 0);
  let clock = 0;
  let logBuffer: LogRecord[] = [];
  const log: LogRecord[] = [];
  let flushedLSN = 0;
  let nextLSN = 1;
  const txns = new Map<string, TxnState>();
  // A key changed by a transaction that has not ended is its alone: strict two-phase locking, in one line, so that a
  // rollback never has to undo over someone else's change.
  const holder = new Map<string, string>();
  const everyRecord = new Map<number, LogRecord>();
  // The master record lives on disk, so it survives a crash; the rest of these do not.
  let masterLSN: number | null = null;
  let crashed = false;
  let checkpointOpen: {
    beginLSN: number;
    dirtyPages: { page: PageId; recLSN: number }[];
    txns: { txn: string; lastLSN: number }[];
  } | null = null;

  let effects: WalEffect[] = [];
  let notes: string[] = [];

  const snapshot = (): WalState => ({
    pool: pool.map((f) => (f ? { ...f, cells: { ...f.cells }, holders: [...f.holders] } : null)),
    disk: [...disk.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, p]) => ({ page, cells: { ...p.cells }, pageLSN: p.pageLSN })),
    logBuffer: clone(logBuffer),
    log: clone(log),
    flushedLSN,
    nextLSN,
    txns: [...txns.values()].map((t) => ({ ...t })),
    masterLSN,
    crashed,
    checkpointOpen: checkpointOpen?.beginLSN ?? null,
  });

  const initial = snapshot();

  type NewRecord =
    | { type: 'update'; txn: string; page: PageId; key: string; before: Cell; after: Cell }
    | { type: 'commit' | 'abort' | 'end'; txn: string }
    | { type: 'clr'; txn: string; page: PageId; key: string; after: Cell; undoNextLSN: number | null };

  function append(rec: NewRecord): LogRecord {
    const t = txns.get(rec.txn)!;
    const full: LogRecord = { ...rec, lsn: nextLSN, prevLSN: t.lastLSN };
    nextLSN += 1;
    t.lastLSN = full.lsn;
    logBuffer.push(full);
    everyRecord.set(full.lsn, full);
    effects.push({ kind: 'log-append', record: full });
    return full;
  }

  /** A record that belongs to no transaction: a checkpoint's. */
  function appendSystem(
    rec: { type: 'begin-checkpoint' } | Omit<Extract<LogRecord, { type: 'end-checkpoint' }>, 'lsn' | 'prevLSN'>,
  ): LogRecord {
    const full: LogRecord = { ...rec, lsn: nextLSN, prevLSN: null };
    nextLSN += 1;
    logBuffer.push(full);
    everyRecord.set(full.lsn, full);
    effects.push({ kind: 'log-append', record: full });
    return full;
  }

  function flushLog(through: number, reason: 'commit' | 'log-before-data' | 'explicit' | 'checkpoint' | 'recovery'): void {
    const going = logBuffer.filter((r) => r.lsn <= through);
    if (going.length === 0) return;
    const from = going[0]!.lsn;
    const to = going[going.length - 1]!.lsn;
    log.push(...going);
    logBuffer = logBuffer.filter((r) => r.lsn > through);
    flushedLSN = to;
    effects.push({ kind: 'log-flush', from, to, reason });
  }

  function writePage(frame: FrameState, reason: 'eviction' | 'background' | 'force'): void {
    const need = frame.pageLSN;
    if (need > flushedLSN) {
      if (options.enforce) {
        notes.push(
          `Page ${String(frame.page)} carries changes up to LSN ${String(need)}, and the log is durable only through ${String(flushedLSN)}. The rule: the log goes first, so it is flushed through LSN ${String(need)} before the page is written.`,
        );
        flushLog(need, 'log-before-data');
      } else {
        notes.push(
          `Page ${String(frame.page)} carries changes up to LSN ${String(need)}, and the log is durable only through ${String(flushedLSN)} — and the rule is off, so the page is written anyway.`,
        );
        effects.push({ kind: 'rule-violated', page: frame.page, pageLSN: need, flushedLSN });
      }
    }
    disk.set(frame.page, { cells: { ...frame.cells }, pageLSN: frame.pageLSN });
    frame.recLSN = null;
    effects.push({ kind: 'page-write', page: frame.page, pageLSN: frame.pageLSN, reason });
    notes.push(`Page ${String(frame.page)} is written to disk (pageLSN ${String(frame.pageLSN)}).`);
  }

  /**
   * The frame holding `page`, reading it in if need be. Null — with nothing done — when no-steal leaves no frame free:
   * every one holds an uncommitted change, and none of those may be written out to make room.
   */
  function fetch(page: PageId): FrameState | null {
    const resident = pool.findIndex((f) => f?.page === page);
    if (resident < 0 && !options.steal && pool.every((f) => f !== null && f.holders.length > 0)) {
      return null;
    }
    clock += 1;
    if (resident >= 0) {
      lastUsed[resident] = clock;
      effects.push({ kind: 'page-fetch', page, hit: true, slot: resident });
      return pool[resident]!;
    }
    let slot = pool.findIndex((f) => f === null);
    if (slot < 0) {
      // Least recently used — among the frames the policy allows to leave: all of them under steal, and under
      // no-steal only those with no uncommitted change.
      let best = -1;
      for (let i = 0; i < pool.length; i += 1) {
        if (!options.steal && pool[i]!.holders.length > 0) continue;
        if (best < 0 || lastUsed[i]! < lastUsed[best]!) best = i;
      }
      slot = best;
      const victim = pool[slot]!;
      const dirty = victim.recLSN !== null;
      effects.push({ kind: 'page-evict', page: victim.page, dirty, slot });
      notes.push(
        `The pool is full, so page ${String(victim.page)} (the least recently used) is evicted${dirty ? ' — and it is dirty, so it must be written first' : ' — it is clean, so it is simply dropped'}.`,
      );
      if (dirty) writePage(victim, 'eviction');
    }
    const onDisk = disk.get(page)!;
    const frame: FrameState = { slot, page, cells: { ...onDisk.cells }, pageLSN: onDisk.pageLSN, recLSN: null, holders: [] };
    pool[slot] = frame;
    lastUsed[slot] = clock;
    effects.push({ kind: 'page-fetch', page, hit: false, slot });
    notes.push(`Page ${String(page)} is read from disk into frame ${String(slot)}.`);
    return frame;
  }

  /** Puts `after` into `key` on its page, as the change a log record describes. */
  function apply(frame: FrameState, key: string, after: Cell, lsn: number, txn: string): void {
    frame.cells[key] = after;
    frame.pageLSN = lsn;
    if (frame.recLSN === null) frame.recLSN = lsn;
    if (!frame.holders.includes(txn)) frame.holders.push(txn);
  }

  /** Pages a committed transaction would have forced, but a transaction still running has changes on. */
  const deferred = new Set<PageId>();

  /**
   * A transaction has ended. Its cells are free, its changes are no longer uncommitted, and — under force — its pages
   * are written. A page that also holds a still-running transaction's change cannot be written under no-steal, so its
   * write waits for that transaction.
   */
  function finish(txn: string, committed: boolean): void {
    for (const [key, who] of [...holder]) if (who === txn) holder.delete(key);
    if (committed && options.force) {
      for (const frame of pool) {
        if (!frame || !frame.holders.includes(txn) || frame.recLSN === null) continue;
        const others = frame.holders.filter((h) => h !== txn);
        if (!options.steal && others.length > 0) {
          deferred.add(frame.page);
          notes.push(
            `Page ${String(frame.page)} also holds ${others.join(' and ')}'s uncommitted change, and no-steal will not write that out, so forcing it waits until ${others.length === 1 ? 'that transaction ends' : 'those transactions end'}.`,
          );
        } else {
          notes.push(`Force: ${txn}'s page ${String(frame.page)} is written as part of the commit.`);
          writePage(frame, 'force');
        }
      }
    }
    for (const frame of pool) {
      if (frame) frame.holders = frame.holders.filter((h) => h !== txn);
    }
    for (const page of [...deferred]) {
      const frame = pool.find((f) => f?.page === page) ?? null;
      if (frame === null) {
        deferred.delete(page);
      } else if (frame.holders.length === 0) {
        deferred.delete(page);
        if (frame.recLSN !== null) {
          notes.push(`Page ${String(page)} is free of uncommitted changes now, so the write the commit owed it is made.`);
          writePage(frame, 'force');
        }
      }
    }
  }

  const noFrame = (page: PageId): string =>
    `No-steal: every frame holds an uncommitted change (${[...new Set(pool.flatMap((f) => f?.holders ?? []))].join(', ')}), and none may be written out to make room, so page ${String(page)} cannot be brought in. The transaction would have to wait for a frame.`;

  /** The machine stops. What was only in memory goes with it; the disk, the durable log and the master record stay. */
  function stop(): { frames: number; dirty: number; records: number; txns: number } {
    const lost = {
      frames: pool.filter((f) => f !== null).length,
      dirty: pool.filter((f) => f !== null && f.recLSN !== null).length,
      records: logBuffer.length,
      txns: [...txns.values()].filter((t) => t.status === 'active').length,
    };
    for (let i = 0; i < pool.length; i += 1) {
      pool[i] = null;
      lastUsed[i] = 0;
    }
    logBuffer = [];
    txns.clear();
    holder.clear();
    deferred.clear();
    checkpointOpen = null;
    nextLSN = (log.at(-1)?.lsn ?? 0) + 1;
    everyRecord.clear();
    for (const r of log) everyRecord.set(r.lsn, r);
    crashed = true;
    return lost;
  }

  /**
   * ARIES restart (plan.md §25.4 E3), from the durable log alone: analysis, redo, undo. Returns what each pass found
   * and did. With `crashAfter`, the machine stops again once undo has written that many records — each is forced as it
   * is written, so what was done stays done.
   */
  function restart(crashAfter: number | undefined): RecoveryReport {
    const byLsn = new Map(log.map((r) => [r.lsn, r]));

    // ── Analysis: from the last checkpoint forward, rebuild the transaction table and the dirty page table.
    const from = masterLSN !== null && byLsn.has(masterLSN) ? masterLSN : (log[0]?.lsn ?? 1);
    const tt = new Map<string, { status: 'active' | 'aborting' | 'committed'; lastLSN: number }>();
    const dpt = new Map<PageId, number>();
    const checkpointEnd = log.find((r) => r.type === 'end-checkpoint' && r.beginLSN === masterLSN);
    if (checkpointEnd?.type === 'end-checkpoint') {
      for (const d of checkpointEnd.dirtyPages) dpt.set(d.page, d.recLSN);
      for (const t of checkpointEnd.txns) tt.set(t.txn, { status: 'active', lastLSN: t.lastLSN });
    }
    for (const r of log) {
      if (r.lsn < from || !isTxnRecord(r)) continue;
      if (r.type === 'end') {
        tt.delete(r.txn);
        continue;
      }
      const entry = tt.get(r.txn) ?? { status: 'active' as const, lastLSN: r.lsn };
      entry.lastLSN = r.lsn;
      if (r.type === 'commit') entry.status = 'committed';
      else if (r.type === 'abort') entry.status = 'aborting';
      tt.set(r.txn, entry);
      if ((r.type === 'update' || r.type === 'clr') && !dpt.has(r.page)) dpt.set(r.page, r.lsn);
    }
    const losers = [...tt].filter(([, e]) => e.status !== 'committed').map(([name]) => name);
    const redoFrom = dpt.size > 0 ? Math.min(...dpt.values()) : null;
    const report: RecoveryReport = {
      analysis: {
        from,
        checkpoint: masterLSN,
        dirtyPages: [...dpt].map(([page, recLSN]) => ({ page, recLSN })).sort((a, b) => a.page - b.page),
        txns: [...tt].map(([txn, e]) => ({ txn, status: e.status, lastLSN: e.lastLSN })),
        losers,
        redoFrom,
      },
      redo: [],
      undo: [],
      ended: [],
      interrupted: false,
    };
    notes.push(
      masterLSN === null
        ? 'Analysis: there is no checkpoint, so the scan starts at the beginning of the log.'
        : `Analysis: the master record points at the checkpoint that began at LSN ${String(masterLSN)}, so the scan starts there, with the tables that checkpoint saved.`,
    );
    notes.push(
      `Analysis finds ${String(dpt.size)} dirty ${dpt.size === 1 ? 'page' : 'pages'} and ${String(tt.size)} ${tt.size === 1 ? 'transaction' : 'transactions'} in flight; ${
        losers.length === 0 ? 'none of them is a loser' : `${losers.join(', ')} never committed, so ${losers.length === 1 ? 'it is a loser' : 'they are losers'}`
      }.`,
    );

    // The transaction table is rebuilt in memory, so the records recovery writes chain on from each one's last.
    for (const [name, e] of tt) txns.set(name, { txn: name, status: 'active', outcome: null, lastLSN: e.lastLSN });

    // ── Redo: repeat history from the oldest recLSN, skipping what the page already has.
    if (redoFrom !== null) {
      notes.push(`Redo starts at LSN ${String(redoFrom)}, the oldest recLSN in the dirty page table.`);
      for (const r of log) {
        if (r.lsn < redoFrom || (r.type !== 'update' && r.type !== 'clr')) continue;
        const recLSN = dpt.get(r.page);
        if (recLSN === undefined) {
          report.redo.push({ lsn: r.lsn, page: r.page, key: r.key, action: 'skip', reason: `page ${String(r.page)} is not in the dirty page table, so it was written after this change` });
          continue;
        }
        if (r.lsn < recLSN) {
          report.redo.push({ lsn: r.lsn, page: r.page, key: r.key, action: 'skip', reason: `page ${String(r.page)} was clean until LSN ${String(recLSN)}, so this change had already been written` });
          continue;
        }
        const frame = fetch(r.page)!;
        const had = frame.pageLSN;
        if (had >= r.lsn) {
          report.redo.push({ lsn: r.lsn, page: r.page, key: r.key, action: 'skip', reason: `the page on disk already has it (pageLSN ${String(had)} ≥ ${String(r.lsn)})` });
          continue;
        }
        frame.cells[r.key] = r.after;
        frame.pageLSN = r.lsn;
        if (frame.recLSN === null) frame.recLSN = r.lsn;
        report.redo.push({ lsn: r.lsn, page: r.page, key: r.key, action: 'redo', reason: `the page's pageLSN is ${String(had)}, older than this record, so ${r.key} is set to ${String(r.after)}` });
      }
    } else {
      notes.push('Redo has nothing to do: no page was dirty.');
    }
    // A transaction that committed but whose end record never got written has no more to do: write it.
    for (const [name, e] of tt) {
      if (e.status !== 'committed') continue;
      append({ type: 'end', txn: name });
      report.ended.push(name);
    }
    if (logBuffer.length > 0) flushLog(logBuffer[logBuffer.length - 1]!.lsn, 'recovery');

    // ── Undo: roll the losers back, newest record first across all of them, a compensation record for each.
    const toUndo = losers.map((name) => tt.get(name)!.lastLSN);
    let written = 0;
    while (toUndo.length > 0) {
      toUndo.sort((a, b) => a - b);
      const lsn = toUndo.pop()!;
      const r = everyRecord.get(lsn);
      if (r === undefined || !isTxnRecord(r)) continue;
      let next: number | null;
      if (r.type === 'update') {
        const frame = fetch(r.page)!;
        const record = append({ type: 'clr', txn: r.txn, page: r.page, key: r.key, after: r.before, undoNextLSN: r.prevLSN });
        frame.cells[r.key] = r.before;
        frame.pageLSN = record.lsn;
        if (frame.recLSN === null) frame.recLSN = record.lsn;
        flushLog(record.lsn, 'recovery');
        written += 1;
        next = r.prevLSN;
        report.undo.push({
          lsn,
          txn: r.txn,
          action: 'undo',
          detail: `${r.key} goes back from ${String(r.after)} to ${String(r.before)} on page ${String(r.page)}`,
          clr: record.lsn,
        });
      } else if (r.type === 'clr') {
        next = r.undoNextLSN;
        report.undo.push({
          lsn,
          txn: r.txn,
          action: 'follow',
          detail: `this is an undo already logged, so it is not undone again; undoing continues at ${next === null ? 'nothing' : `LSN ${String(next)}`}`,
          clr: null,
        });
      } else {
        next = r.prevLSN;
        report.undo.push({
          lsn,
          txn: r.txn,
          action: 'follow',
          detail: `${r.type} record, nothing to undo; continues at ${next === null ? 'nothing' : `LSN ${String(next)}`}`,
          clr: null,
        });
      }
      if (next === null) {
        const end = append({ type: 'end', txn: r.txn });
        flushLog(end.lsn, 'recovery');
        written += 1;
        report.undo.push({ lsn: end.lsn, txn: r.txn, action: 'end', detail: `${r.txn} is fully undone`, clr: null });
      } else {
        toUndo.push(next);
      }
      if (crashAfter !== undefined && written >= crashAfter) {
        report.interrupted = true;
        break;
      }
    }

    if (report.interrupted) {
      notes.push(
        `The machine stops again, after ${String(written)} undo ${written === 1 ? 'record' : 'records'}. Each was forced as it was written, so they are all durable; the pool is gone again.`,
      );
      stop();
      return report;
    }
    for (const [name, e] of tt) {
      const t = txns.get(name)!;
      t.status = 'ended';
      t.outcome = e.status === 'committed' ? 'committed' : 'rolled-back';
    }
    crashed = false;
    notes.push(
      `Recovery is complete: ${report.redo.filter((x) => x.action === 'redo').length} changes redone, ${report.undo.filter((x) => x.action === 'undo').length} undone. The pages it touched are dirty in the pool and will be written in the ordinary way.`,
    );
    return report;
  }

  const results: WalStepResult[] = [];

  script.forEach((step, index) => {
    effects = [];
    notes = [];
    let error: string | undefined;
    let recovery: RecoveryReport | undefined;

    const need = (name: string): TxnState | undefined => {
      const t = txns.get(name);
      if (!t) {
        error = `${name} has not begun.`;
        return undefined;
      }
      if (t.status === 'ended') {
        error = `${name} has already ${t.outcome === 'committed' ? 'committed' : 'rolled back'}.`;
        return undefined;
      }
      return t;
    };

    // Checked against the record of the step's own preconditions first, so a refusal leaves nothing half done.
    if (crashed && step.op !== 'recover' && step.op !== 'crash') {
      error = 'The machine is down: nothing runs until it has recovered.';
    } else
    switch (step.op) {
      case 'begin': {
        if (txns.has(step.txn)) {
          error = `${step.txn} already exists.`;
          break;
        }
        txns.set(step.txn, { txn: step.txn, status: 'active', outcome: null, lastLSN: null });
        notes.push(`${step.txn} begins. Nothing is logged until it changes something.`);
        break;
      }

      case 'set': {
        const t = need(step.txn);
        if (!t) break;
        const page = keyPage.get(step.key);
        if (page === undefined) {
          error = `There is no cell named ${step.key}.`;
          break;
        }
        const owner = holder.get(step.key);
        if (owner !== undefined && owner !== step.txn) {
          error = `${owner} has changed ${step.key} and has not ended, so it is ${owner}'s until it does.`;
          break;
        }
        const frame = fetch(page);
        if (!frame) {
          error = noFrame(page);
          break;
        }
        const before = frame.cells[step.key]!;
        const record = append({ type: 'update', txn: step.txn, page, key: step.key, before, after: step.value });
        apply(frame, step.key, step.value, record.lsn, step.txn);
        holder.set(step.key, step.txn);
        notes.push(
          `${step.txn} sets ${step.key} from ${String(before)} to ${String(step.value)}: log record LSN ${String(record.lsn)} goes to the log buffer, and page ${String(page)} (in the pool) takes pageLSN ${String(record.lsn)}. Neither is on disk yet.`,
        );
        break;
      }

      case 'commit': {
        const t = need(step.txn);
        if (!t) break;
        if (t.lastLSN === null) {
          t.status = 'ended';
          t.outcome = 'committed';
          notes.push(`${step.txn} changed nothing, so there is nothing to make durable.`);
          break;
        }
        const commit = append({ type: 'commit', txn: step.txn });
        notes.push(`${step.txn} commits: record LSN ${String(commit.lsn)}.`);
        flushLog(commit.lsn, 'commit');
        notes.push(
          options.force
            ? `The log is forced through LSN ${String(commit.lsn)} — that is what makes the commit durable.`
            : `The log is forced through LSN ${String(commit.lsn)} — that is what makes the commit durable. No data page is written: the log already holds everything needed to redo it.`,
        );
        append({ type: 'end', txn: step.txn });
        t.status = 'ended';
        t.outcome = 'committed';
        finish(step.txn, true);
        break;
      }

      case 'abort': {
        const t = need(step.txn);
        if (!t) break;
        if (t.lastLSN === null) {
          t.status = 'ended';
          t.outcome = 'rolled-back';
          notes.push(`${step.txn} changed nothing, so there is nothing to undo.`);
          break;
        }
        const abort = append({ type: 'abort', txn: step.txn });
        notes.push(`${step.txn} rolls back: record LSN ${String(abort.lsn)}, then its changes are undone newest first.`);
        // Walk the transaction's own updates newest first, undoing each and logging the undo.
        const updates: Extract<LogRecord, { type: 'update' }>[] = [];
        for (let lsn: number | null = t.lastLSN; lsn !== null; ) {
          const r: LogRecord = everyRecord.get(lsn)!;
          if (r.type === 'update') updates.push(r);
          lsn = r.prevLSN;
        }
        for (const u of updates) {
          // Under no-steal a page holding this transaction's change was never allowed to leave the pool, so this is a
          // hit; under steal there is always a frame to take.
          const frame = fetch(u.page)!;
          const clr = append({ type: 'clr', txn: step.txn, page: u.page, key: u.key, after: u.before, undoNextLSN: u.prevLSN });
          apply(frame, u.key, u.before, clr.lsn, step.txn);
          notes.push(
            `Undo LSN ${String(u.lsn)}: ${u.key} goes back to ${String(u.before)}, logged as a compensation record (LSN ${String(clr.lsn)}) so that the undo is itself redoable and is never done twice.`,
          );
        }
        append({ type: 'end', txn: step.txn });
        t.status = 'ended';
        t.outcome = 'rolled-back';
        finish(step.txn, false);
        break;
      }

      case 'flush-log': {
        if (logBuffer.length === 0) {
          notes.push('The log buffer is empty: everything is already durable.');
          break;
        }
        const through = logBuffer[logBuffer.length - 1]!.lsn;
        flushLog(through, 'explicit');
        notes.push(`The log buffer is flushed: durable through LSN ${String(through)}.`);
        break;
      }

      case 'write-page': {
        const frame = pool.find((f) => f?.page === step.page) ?? null;
        if (!disk.has(step.page)) {
          error = `There is no page ${String(step.page)}.`;
        } else if (!frame) {
          notes.push(`Page ${String(step.page)} is not in the pool, so there is nothing of it to write.`);
        } else if (frame.recLSN === null) {
          notes.push(`Page ${String(step.page)} is clean — the disk already has this copy.`);
        } else if (!options.steal && frame.holders.length > 0) {
          error = `No-steal: page ${String(step.page)} holds ${frame.holders.join(' and ')}'s uncommitted change, and an uncommitted change may not be written to disk.`;
        } else {
          writePage(frame, 'background');
        }
        break;
      }

      case 'read-page': {
        if (!disk.has(step.page)) {
          error = `There is no page ${String(step.page)}.`;
          break;
        }
        const wasResident = pool.some((f) => f?.page === step.page);
        if (fetch(step.page) === null) {
          error = noFrame(step.page);
          break;
        }
        if (wasResident) notes.push(`Page ${String(step.page)} is already in the pool.`);
        break;
      }

      case 'checkpoint':
      case 'checkpoint-begin':
      case 'checkpoint-end': {
        if (step.op !== 'checkpoint-end') {
          if (checkpointOpen !== null) {
            error = `A checkpoint is already in progress (it began at LSN ${String(checkpointOpen.beginLSN)}).`;
            break;
          }
          const begin = appendSystem({ type: 'begin-checkpoint' });
          checkpointOpen = {
            beginLSN: begin.lsn,
            dirtyPages: pool
              .filter((f) => f !== null && f.recLSN !== null)
              .map((f) => ({ page: f!.page, recLSN: f!.recLSN! }))
              .sort((a, b) => a.page - b.page),
            txns: [...txns.values()]
              .filter((t) => t.status === 'active' && t.lastLSN !== null)
              .map((t) => ({ txn: t.txn, lastLSN: t.lastLSN! })),
          };
          notes.push(
            `Checkpoint begins at LSN ${String(begin.lsn)}. The dirty page table (${String(checkpointOpen.dirtyPages.length)} ${checkpointOpen.dirtyPages.length === 1 ? 'page' : 'pages'}) and the transaction table (${String(checkpointOpen.txns.length)} active) are copied as they are now. No page is written and nobody waits — which is what makes it fuzzy.`,
          );
        } else if (checkpointOpen === null) {
          error = 'No checkpoint is in progress: begin one first.';
          break;
        }
        if (step.op === 'checkpoint-begin') break;
        const open = checkpointOpen;
        const end = appendSystem({
          type: 'end-checkpoint',
          beginLSN: open.beginLSN,
          dirtyPages: open.dirtyPages,
          txns: open.txns,
        });
        flushLog(end.lsn, 'checkpoint');
        masterLSN = open.beginLSN;
        checkpointOpen = null;
        notes.push(
          `The checkpoint ends at LSN ${String(end.lsn)} with the tables it copied at LSN ${String(open.beginLSN)}, and the log is forced through it. The master record now points at LSN ${String(open.beginLSN)}: that is where a restart will begin.`,
        );
        break;
      }

      case 'crash': {
        if (crashed) {
          notes.push('The machine is already down.');
          break;
        }
        const lost = stop();
        notes.push(
          `The machine stops. Gone: ${String(lost.frames)} ${lost.frames === 1 ? 'page' : 'pages'} in the pool (${String(lost.dirty)} dirty), ${String(lost.records)} unflushed log ${lost.records === 1 ? 'record' : 'records'}, and ${String(lost.txns)} running ${lost.txns === 1 ? 'transaction' : 'transactions'}. Kept: the disk, the durable log (through LSN ${String(flushedLSN)}) and the master record.`,
        );
        break;
      }

      case 'recover': {
        if (!crashed) {
          error = 'Nothing to recover: the machine has not crashed.';
          break;
        }
        recovery = restart(step.crashAfter);
        break;
      }
    }

    if (error !== undefined) {
      effects = [];
      notes = [];
    }
    const state = snapshot();
    results.push({
      index,
      step,
      effects,
      notes,
      ...(error === undefined ? {} : { error }),
      state,
      violations: walViolations(state),
      crash: crashImage(state, options.pages),
      ...(recovery === undefined || error !== undefined ? {} : { recovery }),
    });
  });

  return { options, initial, steps: results, final: results.at(-1)?.state ?? initial, truncated };
}
