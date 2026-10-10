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
 */

export type PageId = number;
export type Cell = number;

export type LogRecord =
  | { type: 'update'; lsn: number; prevLSN: number | null; txn: string; page: PageId; key: string; before: Cell; after: Cell }
  | { type: 'commit'; lsn: number; prevLSN: number | null; txn: string }
  | { type: 'abort'; lsn: number; prevLSN: number | null; txn: string }
  /** Redo-only: the undo of the update `undoNextLSN`'s successor, and where undoing continues from. */
  | { type: 'clr'; lsn: number; prevLSN: number | null; txn: string; page: PageId; key: string; after: Cell; undoNextLSN: number | null }
  | { type: 'end'; lsn: number; prevLSN: number | null; txn: string };

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
  | { op: 'read-page'; page: PageId };

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
}

export type WalEffect =
  | { kind: 'log-append'; record: LogRecord }
  | { kind: 'log-flush'; from: number; to: number; reason: 'commit' | 'log-before-data' | 'explicit' }
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
  const records = [...state.log, ...state.logBuffer];
  const committedTxns = new Set(state.log.filter((r) => r.type === 'commit').map((r) => r.txn));
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
      let explains: LogRecord | undefined;
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
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseWalStep(text: string): WalStep | null {
  const t = text.trim().replace(/\s+/g, ' ');
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

  function flushLog(through: number, reason: 'commit' | 'log-before-data' | 'explicit'): void {
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

  const results: WalStepResult[] = [];

  script.forEach((step, index) => {
    effects = [];
    notes = [];
    let error: string | undefined;

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
    });
  });

  return { options, initial, steps: results, final: results.at(-1)?.state ?? initial, truncated };
}
