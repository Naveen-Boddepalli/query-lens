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

export const DEFAULT_WAL_OPTIONS: WalOptions = { frames: 3, enforce: true, pages: DEFAULT_PAGES };

export interface FrameState {
  slot: number;
  page: PageId;
  cells: Record<string, Cell>;
  /** LSN of the last record applied to this copy. */
  pageLSN: number;
  /** LSN of the first record that dirtied it since it was last written; null while clean. */
  recLSN: number | null;
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
  | { kind: 'page-write'; page: PageId; pageLSN: number; reason: 'eviction' | 'background' }
  /** The rule is off and a page went to disk ahead of its log. */
  | { kind: 'rule-violated'; page: PageId; pageLSN: number; flushedLSN: number };

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
    pool: pool.map((f) => (f ? { ...f, cells: { ...f.cells } } : null)),
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

  function writePage(frame: FrameState, reason: 'eviction' | 'background'): void {
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

  function fetch(page: PageId): FrameState {
    clock += 1;
    const resident = pool.findIndex((f) => f?.page === page);
    if (resident >= 0) {
      lastUsed[resident] = clock;
      effects.push({ kind: 'page-fetch', page, hit: true, slot: resident });
      return pool[resident]!;
    }
    let slot = pool.findIndex((f) => f === null);
    if (slot < 0) {
      slot = lastUsed.indexOf(Math.min(...lastUsed));
      const victim = pool[slot]!;
      const dirty = victim.recLSN !== null;
      effects.push({ kind: 'page-evict', page: victim.page, dirty, slot });
      notes.push(
        `The pool is full, so page ${String(victim.page)} (the least recently used) is evicted${dirty ? ' — and it is dirty, so it must be written first' : ' — it is clean, so it is simply dropped'}.`,
      );
      if (dirty) writePage(victim, 'eviction');
    }
    const onDisk = disk.get(page)!;
    const frame: FrameState = { slot, page, cells: { ...onDisk.cells }, pageLSN: onDisk.pageLSN, recLSN: null };
    pool[slot] = frame;
    lastUsed[slot] = clock;
    effects.push({ kind: 'page-fetch', page, hit: false, slot });
    notes.push(`Page ${String(page)} is read from disk into frame ${String(slot)}.`);
    return frame;
  }

  /** Puts `after` into `key` on its page, as the change a log record describes. */
  function apply(frame: FrameState, key: string, after: Cell, lsn: number): void {
    frame.cells[key] = after;
    frame.pageLSN = lsn;
    if (frame.recLSN === null) frame.recLSN = lsn;
  }

  function release(txn: string): void {
    for (const [key, who] of [...holder]) if (who === txn) holder.delete(key);
  }

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
        const before = frame.cells[step.key]!;
        const record = append({ type: 'update', txn: step.txn, page, key: step.key, before, after: step.value });
        apply(frame, step.key, step.value, record.lsn);
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
          `The log is forced through LSN ${String(commit.lsn)} — that is what makes the commit durable. No data page is written: the log already holds everything needed to redo it.`,
        );
        append({ type: 'end', txn: step.txn });
        t.status = 'ended';
        t.outcome = 'committed';
        release(step.txn);
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
          const frame = fetch(u.page);
          const clr = append({ type: 'clr', txn: step.txn, page: u.page, key: u.key, after: u.before, undoNextLSN: u.prevLSN });
          apply(frame, u.key, u.before, clr.lsn);
          notes.push(
            `Undo LSN ${String(u.lsn)}: ${u.key} goes back to ${String(u.before)}, logged as a compensation record (LSN ${String(clr.lsn)}) so that the undo is itself redoable and is never done twice.`,
          );
        }
        append({ type: 'end', txn: step.txn });
        t.status = 'ended';
        t.outcome = 'rolled-back';
        release(step.txn);
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
        fetch(step.page);
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
    });
  });

  return { options, initial, steps: results, final: results.at(-1)?.state ?? initial, truncated };
}
