/**
 * What the *Durability* dialog does to the engine's log between statements (plan.md §28.5 I2): open it, commit or roll
 * back a statement's transaction, flush the log, have the writer put a page on disk, take a fuzzy checkpoint (and
 * truncate the log behind it), crash, and recover with ARIES's three passes. Each operation works on a copy and runs
 * its page reads through the engine's own buffer pool, the one the statements ran on — so a rollback or a recovery
 * that needs a page the pool does not hold evicts one by the same policy, and a dirty victim waits for the log.
 *
 * The rules are `wal.ts`'s, record for record: the same records in the same order with the same LSNs, the same
 * three passes, the same reports. That is what lets the four-page model be this log's oracle (plan.md §28.6 rule 11).
 *
 * `BEGIN`, `COMMIT` and `ROLLBACK` typed in the SQL box (plan.md §28.5 I3) are the same commit and rollback, run by
 * `runQuery` through the kit at the end of this file: `BEGIN` opens the session's one transaction, every write until it
 * ends is that transaction's, and its `ROLLBACK` undoes them newest first, one compensation record each, as steps of the
 * statement's trace. Imported only by the dialog, which is fetched when it is opened — and which hands the kit over.
 */

import { createBufferPool } from '../storage/bufferPool.ts';
import type { BufferPool } from '../storage/bufferPool.ts';
import type { BufferState } from '../storage/policy.ts';
import type { Emit } from '../trace.ts';
import type { ControlKind } from '../transactionControl.ts';
import type { Database, EngineOptions, Row, StepEventBody } from '../types.ts';
import { cellText } from './wal.ts';
import type { Cell, CrashCell, CrashImage, FrameState, LogRecord, PageId, RecoveryReport, WalEffect, WalState } from './wal.ts';
import { LogMachine, StatementLog, cellKey, cellNow, inSync, isRefusal, loggedNote, parseCellKey, settingsRefusal } from './engineLog.ts';
import type { EngineLog, EngineTxn, PageImage } from './engineLog.ts';

export type LogOp =
  | { op: 'commit'; txn: string }
  | { op: 'abort'; txn: string }
  | { op: 'flush-log' }
  | { op: 'write-page'; page: PageId }
  | { op: 'checkpoint' }
  | { op: 'crash' }
  | { op: 'recover'; crashAfter?: number };

export interface LogOpResult {
  /** The log after the operation — the one passed in, unchanged, when it was refused. */
  log: EngineLog;
  op: LogOp;
  effects: WalEffect[];
  notes: string[];
  error?: string;
  recovery?: RecoveryReport;
  /** Records the checkpoint truncated from the durable log. */
  truncated?: number;
}

function emptyPool(frames: number): BufferState {
  return {
    frames: Array.from({ length: frames }, (_, frameId) => ({ frameId, pageId: null, usageCount: 0, pinCount: 0, lastUsedAt: -1, loadedAt: -1 })),
    now: 0,
    hand: 0,
    lookaheadCursor: 0,
  };
}

/**
 * Lays the database out as the log's heap and starts the log empty: every row on disk in its own slot, tables in name
 * order, page ids from 0, `rowsPerPage` rows to a page. An empty table has one empty page.
 */
export function openEngineLog(db: Database, options: Pick<EngineOptions, 'rowsPerPage' | 'bufferFrames'>, choice: { steal: boolean; force: boolean }): EngineLog {
  const per = Math.max(1, Math.floor(options.rowsPerPage));
  const tables: EngineLog['tables'] = {};
  const disk: EngineLog['disk'] = {};
  const committed: Record<string, Cell> = {};
  let next = 0;
  for (const name of Object.keys(db.tables).sort()) {
    const rows = db.tables[name]!.rows;
    const count = Math.max(1, Math.ceil(rows.length / per));
    const pages = Array.from({ length: count }, (_, i) => next + i);
    for (let i = 0; i < count; i += 1) {
      const cells: Record<string, Cell> = {};
      for (let rid = i * per; rid < (i + 1) * per; rid += 1) {
        const value = rid < rows.length ? JSON.stringify(rows[rid]) : null;
        cells[cellKey(name, rid)] = value;
        committed[cellKey(name, rid)] = value;
      }
      disk[next + i] = { cells, pageLSN: 0 };
    }
    tables[name] = { pages, rids: rows.map((_, i) => i), nextRid: rows.length };
    next += count;
  }
  return {
    rowsPerPage: per,
    frames: options.bufferFrames,
    steal: choice.steal,
    force: choice.force,
    tables,
    nextPageId: next,
    disk,
    resident: {},
    pool: emptyPool(options.bufferFrames),
    logBuffer: [],
    log: [],
    flushedLSN: 0,
    nextLSN: 1,
    logStart: 1,
    txns: [],
    owners: {},
    deferred: [],
    masterLSN: null,
    crashed: false,
    committed,
    statements: [],
    counter: 0,
    session: null,
    base: db,
    expected: db,
  };
}

/** The database a set of cells says: each table's filled slots, in slot order. */
function databaseFrom(log: EngineLog, cellOf: (page: PageId, key: string) => Cell): Database {
  const tables: Database['tables'] = {};
  for (const [name, table] of Object.entries(log.base.tables)) {
    const t = log.tables[name];
    if (!t) {
      tables[name] = table;
      continue;
    }
    const rows: Row[] = [];
    t.pages.forEach((page, i) => {
      for (let rid = i * log.rowsPerPage; rid < (i + 1) * log.rowsPerPage; rid += 1) {
        const cell = cellOf(page, cellKey(name, rid));
        if (typeof cell === 'string') rows.push(JSON.parse(cell) as Row);
      }
    });
    tables[name] = { ...table, rows };
  }
  return { tables };
}

/** What the database holds now: the pool's copy of each page over the disk's — what the Playground should show. */
export function databaseOfLog(log: EngineLog): Database {
  return databaseFrom(log, (page, key) => cellNow(log, page, key));
}

/** What the disk alone holds: the database a crash leaves, before recovery. */
export function diskDatabase(log: EngineLog): Database {
  return databaseFrom(log, (page, key) => log.disk[page]?.cells[key] ?? null);
}

/** Every cell as memory holds it: pool over disk. */
export function memoryCells(log: EngineLog): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const p of Object.values(log.disk)) Object.assign(out, p.cells);
  for (const r of Object.values(log.resident)) Object.assign(out, r.cells);
  return out;
}

/** The log as the four-page model's state, for the panels `/tools/wal` already draws. */
export function walStateOf(log: EngineLog): WalState {
  const pool: (FrameState | null)[] = log.pool.frames.map((f) => {
    const r = f.pageId === null ? undefined : log.resident[f.pageId];
    return f.pageId === null || r === undefined
      ? null
      : { slot: f.frameId, page: f.pageId, cells: { ...r.cells }, pageLSN: r.pageLSN, recLSN: r.recLSN, holders: [...r.holders] };
  });
  return {
    pool,
    disk: Object.entries(log.disk)
      .map(([page, p]) => ({ page: Number(page), cells: { ...p.cells }, pageLSN: p.pageLSN }))
      .sort((a, b) => a.page - b.page),
    logBuffer: [...log.logBuffer],
    log: [...log.log],
    flushedLSN: log.flushedLSN,
    nextLSN: log.nextLSN,
    txns: log.txns.map(({ firstLSN: _first, ...t }) => t),
    masterLSN: log.masterLSN,
    crashed: log.crashed,
    checkpointOpen: null,
  };
}

/**
 * What a crash at this moment would find, as `wal.ts`'s `crashImage` computes it: cells on disk that no committed
 * transaction wrote (steal put them there: undo) and committed values not on disk (no-force left them in the pool:
 * redo), and the log records that would be lost.
 */
export function crashImageOf(log: EngineLog): CrashImage {
  const records = [...log.log, ...log.logBuffer];
  const committedTxns = new Set(log.log.filter((r) => r.type === 'commit').map((r) => (r as { txn: string }).txn));
  for (const t of log.txns) if (t.outcome === 'committed') committedTxns.add(t.txn);
  const undo: CrashCell[] = [];
  const redo: CrashCell[] = [];
  for (const [pageText, p] of Object.entries(log.disk)) {
    const page = Number(pageText);
    for (const [key, onDisk] of Object.entries(p.cells)) {
      const committed = log.committed[key] ?? null;
      if (onDisk === committed) continue;
      let explains: LogRecord | undefined;
      for (const r of records) {
        if ((r.type === 'update' || r.type === 'clr') && r.key === key && r.page === page && r.lsn <= p.pageLSN) explains = r;
      }
      const by = explains && 'txn' in explains ? explains.txn : '?';
      if (explains && !committedTxns.has(by)) {
        undo.push({ page, key, onDisk, committed, by, logged: explains.lsn <= log.flushedLSN });
      } else {
        redo.push({ page, key, onDisk, committed, by: lastCommitterOf(log, key) ?? '?', logged: true });
      }
    }
  }
  return { undo, redo, lostRecords: log.logBuffer.length };
}

function lastCommitterOf(log: EngineLog, key: string): string | undefined {
  const committedTxns = new Set(log.log.filter((r) => r.type === 'commit').map((r) => (r as { txn: string }).txn));
  let by: string | undefined;
  for (const r of log.log) if (r.type === 'update' && r.key === key && committedTxns.has(r.txn)) by = r.txn;
  return by;
}

/**
 * An operation's working copy: the log machine, and the engine's pool over it, built when a page is first needed. Run
 * from the SQL box (`trace`), its page reads and compensation records are steps of the statement's trace; run from the
 * dialog, they are notes.
 */
class Operation {
  readonly machine: LogMachine;
  readonly effects: WalEffect[] = [];
  private pool: BufferPool | null = null;
  /** The durable log's end as the effects last said it, so each flush effect names the records it moved. */
  private flushedSeen: number;

  private readonly options: EngineOptions;
  private readonly trace: Emit | undefined;

  constructor(log: EngineLog, options: EngineOptions, trace?: Emit) {
    this.options = options;
    this.trace = trace;
    this.machine = new LogMachine(log, trace);
    this.flushedSeen = log.flushedLSN;
  }

  /** A sentence: a step of the trace when there is one and `body` says what step, a note otherwise. */
  say(label: string, body?: StepEventBody): void {
    if (this.trace && body) this.trace(label, body);
    else this.machine.notes.push(label);
  }

  private flushed(to: number, reason: Extract<WalEffect, { kind: 'log-flush' }>['reason']): void {
    if (to <= this.flushedSeen) return;
    this.effects.push({ kind: 'log-flush', from: this.flushedSeen + 1, to, reason });
    this.flushedSeen = to;
  }

  get state(): EngineLog {
    return this.machine.state;
  }

  /** Steps the pool takes, as the model's effects and as notes. */
  private onStep = (label: string, body: StepEventBody): void => {
    // In the SQL box every step the pool takes is the trace's, as a query's are.
    if (this.trace) this.trace(label, body);
    if (body.stage !== 'buffer') return;
    // A disk read, an eviction or a log flush is worth a sentence; a hit, or the miss before a read, is not.
    if (!this.trace && (body.action === 'load' || body.action === 'evict' || body.action === 'flush')) this.machine.notes.push(label);
    if (body.action === 'hit' || body.action === 'load') {
      this.effects.push({ kind: 'page-fetch', page: body.pageId, hit: body.action === 'hit', slot: body.frameId });
    } else if (body.action === 'evict') {
      this.effects.push({ kind: 'page-evict', page: body.victimPageId, dirty: body.writtenBack === true, slot: body.frameId });
      if (body.writtenBack) {
        const lsn = this.state.disk[body.victimPageId]?.pageLSN ?? 0;
        this.effects.push({ kind: 'page-write', page: body.victimPageId, pageLSN: lsn, reason: 'eviction' });
      }
    } else if (body.action === 'flush') {
      this.flushed(body.lsn, 'log-before-data');
    }
  };

  /** The page in a frame, read in through the engine's pool if it is not; null when no-steal leaves no frame to take. */
  fetch(page: PageId): boolean {
    if (!this.pool) {
      const options: EngineOptions = { ...this.options, bufferFrames: this.state.frames };
      const emit = (label: string, body: StepEventBody) => { this.onStep(label, body); };
      this.pool = createBufferPool(this.state.nextPageId, options, emit, undefined, 'query', this.machine.attachment());
    }
    const got = this.pool.fetch(page);
    if (!got) return false;
    this.pool.unpin(got.frameId);
    return true;
  }

  append(rec: Parameters<LogMachine['append']>[0]): LogRecord {
    const r = this.machine.append(rec);
    this.effects.push({ kind: 'log-append', record: r });
    return r;
  }

  appendSystem(rec: { type: 'begin-checkpoint' } | Omit<Extract<LogRecord, { type: 'end-checkpoint' }>, 'lsn' | 'prevLSN'>): LogRecord {
    const full = { ...rec, lsn: this.state.nextLSN, prevLSN: null } as LogRecord;
    this.state.nextLSN += 1;
    this.state.logBuffer.push(full);
    this.effects.push({ kind: 'log-append', record: full });
    return full;
  }

  flush(through: number, reason: 'commit' | 'explicit' | 'checkpoint' | 'recovery'): void {
    const span = this.machine.flushLog(through);
    if (span) this.flushed(span.to, reason);
  }

  write(page: PageId, reason: 'background' | 'force'): void {
    const lsn = this.state.resident[page]!.pageLSN;
    this.machine.notes.push(this.machine.writePage(page, reason));
    this.flushed(this.state.flushedLSN, 'log-before-data');
    this.effects.push({ kind: 'page-write', page, pageLSN: lsn, reason });
  }

  /** Every record still in the log, by LSN. */
  record(lsn: number): LogRecord | undefined {
    return this.state.logBuffer.find((r) => r.lsn === lsn) ?? this.state.log.find((r) => r.lsn === lsn);
  }

  /**
   * A transaction has ended. Under force a commit writes its pages — but under no-steal a page that also holds a
   * running transaction's change waits for it, as in `wal.ts`.
   */
  finish(txn: string, committed: boolean): void {
    const s = this.state;
    if (committed && s.force) {
      for (const f of s.pool.frames) {
        const frame = f.pageId === null ? undefined : s.resident[f.pageId];
        if (!frame || !frame.holders.includes(txn) || frame.recLSN === null) continue;
        const others = frame.holders.filter((h) => h !== txn);
        if (!s.steal && others.length > 0) {
          if (!s.deferred.includes(f.pageId!)) s.deferred.push(f.pageId!);
          this.machine.notes.push(
            `Page ${String(f.pageId)} also holds ${others.join(' and ')}'s uncommitted change, and no-steal will not write that out, so forcing it waits until ${others.length === 1 ? 'that transaction ends' : 'those transactions end'}.`,
          );
        } else {
          this.machine.notes.push(`Force: ${txn}'s page ${String(f.pageId)} is written as part of the commit.`);
          this.write(f.pageId!, 'force');
        }
      }
    }
    this.machine.release(txn);
    for (const page of [...s.deferred]) {
      const frame = s.resident[page];
      if (!frame) {
        s.deferred = s.deferred.filter((p) => p !== page);
      } else if (frame.holders.length === 0) {
        s.deferred = s.deferred.filter((p) => p !== page);
        if (frame.recLSN !== null) {
          this.machine.notes.push(`Page ${String(page)} is free of uncommitted changes now, so the write the commit owed it is made.`);
          this.write(page, 'force');
        }
      }
    }
  }

  /** The newest committed value of every cell `txn` changed, now that it has committed. */
  commitValues(txn: EngineTxn): void {
    const seen = new Set<string>();
    for (let lsn = txn.lastLSN; lsn !== null; ) {
      const r = this.record(lsn);
      if (!r || !('txn' in r)) break;
      if (r.type === 'update' && !seen.has(r.key)) {
        seen.add(r.key);
        this.state.committed[r.key] = r.after;
      }
      lsn = r.prevLSN;
    }
  }

  /** Commits `t`: its commit record, the log forced through it, its end record — and under force, its pages written. */
  commit(t: EngineTxn): void {
    const notes = this.machine.notes;
    const s = this.state;
    if (s.session === t.txn) s.session = null;
    if (t.lastLSN === null) {
      t.status = 'ended';
      t.outcome = 'committed';
      notes.push(`${t.txn} changed nothing, so there is nothing to make durable.`);
      return;
    }
    const commit = this.append({ type: 'commit', txn: t.txn });
    notes.push(`${t.txn} commits: record LSN ${String(commit.lsn)}.`);
    this.flush(commit.lsn, 'commit');
    notes.push(
      s.force
        ? `The log is forced through LSN ${String(commit.lsn)} — that is what makes the commit durable.`
        : `The log is forced through LSN ${String(commit.lsn)} — that is what makes the commit durable. No data page is written: the log already holds everything needed to redo it.`,
    );
    this.append({ type: 'end', txn: t.txn });
    t.status = 'ended';
    t.outcome = 'committed';
    this.commitValues(t);
    this.finish(t.txn, true);
  }

  /**
   * Rolls `t` back: its abort record, then each of its changes undone newest first, each as a compensation record
   * logged before the page changes back, then its end record. A refusal (no frame under no-steal) is returned.
   */
  abort(t: EngineTxn): string | undefined {
    const notes = this.machine.notes;
    const s = this.state;
    if (t.lastLSN === null) {
      if (s.session === t.txn) s.session = null;
      t.status = 'ended';
      t.outcome = 'rolled-back';
      notes.push(`${t.txn} changed nothing, so there is nothing to undo.`);
      return undefined;
    }
    const abort = this.append({ type: 'abort', txn: t.txn });
    notes.push(
      this.trace
        ? `${t.txn} rolls back: its abort record is LSN ${String(abort.lsn)}.`
        : `${t.txn} rolls back: record LSN ${String(abort.lsn)}, then its changes are undone newest first.`,
    );
    const updates: Extract<LogRecord, { type: 'update' }>[] = [];
    for (let lsn: number | null = abort.prevLSN; lsn !== null; ) {
      const r = this.record(lsn)!;
      if (r.type === 'update') updates.push(r);
      lsn = r.prevLSN;
    }
    for (const u of updates) {
      if (!this.fetch(u.page)) return `No-steal: there is no frame to bring page ${String(u.page)} back into.`;
      const clr = this.append({ type: 'clr', txn: t.txn, page: u.page, key: u.key, after: u.before, undoNextLSN: u.prevLSN });
      this.machine.apply(u.page, u.key, u.before, clr.lsn, t.txn);
      const { table, rid } = parseCellKey(u.key);
      this.say(
        this.trace
          ? `Undo LSN ${String(u.lsn)}: ${t.txn}'s change to slot ${String(rid)} of \`${table}\` on page ${String(u.page)} is reversed — ${cellText(u.after)} goes back to ${cellText(u.before)}. The undo is logged first, as compensation record LSN ${String(clr.lsn)}, which points on to ${u.prevLSN === null ? 'nothing older' : `LSN ${String(u.prevLSN)}`}: a recovery redoes an undo like any change, and never undoes it twice. Page ${String(u.page)} takes pageLSN ${String(clr.lsn)}.`
          : `Undo LSN ${String(u.lsn)}: ${u.key} goes back to ${cellText(u.before)}, logged as a compensation record (LSN ${String(clr.lsn)}) so that the undo is itself redoable and is never done twice.`,
        { stage: 'buffer', action: 'undo', pageId: u.page, lsn: clr.lsn, undoes: u.lsn },
      );
    }
    const end = this.append({ type: 'end', txn: t.txn });
    if (this.trace) notes.push(`Its ${String(updates.length)} ${updates.length === 1 ? 'change was' : 'changes were'} undone in the steps above, newest first, each as a compensation record; its end record is LSN ${String(end.lsn)}.`);
    if (s.session === t.txn) s.session = null;
    t.status = 'ended';
    t.outcome = 'rolled-back';
    this.finish(t.txn, false);
    reslot(s, updates.map((u) => u.key));
    return undefined;
  }

  /** The machine stops: pool, log buffer, transactions gone; disk, durable log and master record kept. */
  stop(): { frames: number; dirty: number; records: number; txns: number } {
    const s = this.state;
    const lost = {
      frames: Object.keys(s.resident).length,
      dirty: Object.values(s.resident).filter((r) => r.recLSN !== null).length,
      records: s.logBuffer.length,
      txns: s.txns.filter((t) => t.status === 'active').length,
    };
    s.pool = emptyPool(s.frames);
    s.resident = {};
    s.logBuffer = [];
    s.txns = [];
    s.owners = {};
    s.deferred = [];
    // A `BEGIN`'s transaction goes with the rest: if it changed anything, recovery finds it a loser.
    s.session = null;
    s.nextLSN = (s.log.at(-1)?.lsn ?? s.logStart - 1) + 1;
    s.crashed = true;
    this.pool = null;
    return lost;
  }
}

const ended = (t: EngineTxn): string => `${t.txn} has already ${t.outcome === 'committed' ? 'committed' : 'rolled back'}.`;

/** Runs one operation on a copy of `log`. A refused one changes nothing and says why. */
export function applyLogOp(log: EngineLog, op: LogOp, options: EngineOptions): LogOpResult {
  const run = new Operation(log, options);
  const s = run.state;
  const notes = run.machine.notes;
  const refuse = (error: string): LogOpResult => ({ log, op, effects: [], notes: [], error });
  let recovery: RecoveryReport | undefined;
  let truncated: number | undefined;

  if (s.crashed && op.op !== 'recover' && op.op !== 'crash') return refuse('The machine is down: nothing runs until it has recovered.');

  const need = (name: string): EngineTxn | string => {
    const t = run.machine.txn(name);
    if (!t) return `${name} is not a running transaction.`;
    if (t.status === 'ended') return ended(t);
    return t;
  };

  switch (op.op) {
    case 'commit': {
      const t = need(op.txn);
      if (typeof t === 'string') return refuse(t);
      run.commit(t);
      break;
    }

    case 'abort': {
      const t = need(op.txn);
      if (typeof t === 'string') return refuse(t);
      const refused = run.abort(t);
      if (refused !== undefined) return refuse(refused);
      break;
    }

    case 'flush-log': {
      if (s.logBuffer.length === 0) {
        notes.push('The log buffer is empty: everything is already durable.');
        break;
      }
      const through = s.logBuffer[s.logBuffer.length - 1]!.lsn;
      run.flush(through, 'explicit');
      notes.push(`The log buffer is flushed: durable through LSN ${String(through)}.`);
      break;
    }

    case 'write-page': {
      const frame = s.resident[op.page];
      if (!s.disk[op.page]) return refuse(`There is no page ${String(op.page)}.`);
      if (!frame) {
        notes.push(`Page ${String(op.page)} is not in the pool, so there is nothing of it to write.`);
      } else if (frame.recLSN === null) {
        notes.push(`Page ${String(op.page)} is clean — the disk already has this copy.`);
      } else if (!s.steal && frame.holders.length > 0) {
        return refuse(`No-steal: page ${String(op.page)} holds ${frame.holders.join(' and ')}'s uncommitted change, and an uncommitted change may not be written to disk.`);
      } else {
        run.write(op.page, 'background');
      }
      break;
    }

    case 'checkpoint': {
      const begin = run.appendSystem({ type: 'begin-checkpoint' });
      const dirtyPages = s.pool.frames
        .filter((f) => f.pageId !== null && (s.resident[f.pageId]?.recLSN ?? null) !== null)
        .map((f) => ({ page: f.pageId!, recLSN: s.resident[f.pageId!]!.recLSN! }))
        .sort((a, b) => a.page - b.page);
      const txns = s.txns.filter((t) => t.status === 'active' && t.lastLSN !== null).map((t) => ({ txn: t.txn, lastLSN: t.lastLSN! }));
      notes.push(
        `Checkpoint begins at LSN ${String(begin.lsn)}. The dirty page table (${String(dirtyPages.length)} ${dirtyPages.length === 1 ? 'page' : 'pages'}) and the transaction table (${String(txns.length)} active) are copied as they are now. No page is written and nobody waits — which is what makes it fuzzy.`,
      );
      const end = run.appendSystem({ type: 'end-checkpoint', beginLSN: begin.lsn, dirtyPages, txns });
      run.flush(end.lsn, 'checkpoint');
      s.masterLSN = begin.lsn;
      notes.push(
        `The checkpoint ends at LSN ${String(end.lsn)} with the tables it copied at LSN ${String(begin.lsn)}, and the log is forced through it. The master record now points at LSN ${String(begin.lsn)}: that is where a restart will begin.`,
      );
      // Truncation: a restart reads from the checkpoint, redoes from the oldest recLSN, and undoes each running
      // transaction back to its first record. Nothing older can be needed again.
      const firsts = s.txns.filter((t) => t.status === 'active' && t.firstLSN !== null).map((t) => t.firstLSN!);
      const keep = Math.min(begin.lsn, ...dirtyPages.map((d) => d.recLSN), ...firsts);
      const before = s.log.length;
      s.log = s.log.filter((r) => r.lsn >= keep);
      truncated = before - s.log.length;
      if (keep > s.logStart) s.logStart = keep;
      notes.push(
        truncated === 0
          ? `Nothing is truncated: the oldest record a restart could need is LSN ${String(keep)}, and the log starts there already.`
          : `The log is truncated before LSN ${String(keep)} — ${String(truncated)} ${truncated === 1 ? 'record' : 'records'} gone. That is the oldest of the checkpoint itself, the oldest recLSN in the dirty page table and the first record of each running transaction, so no restart can need anything older.`,
      );
      break;
    }

    case 'crash': {
      if (s.crashed) {
        notes.push('The machine is already down.');
        break;
      }
      const lost = run.stop();
      // What the Playground holds now is what the disk holds: the pool's copies went with the machine.
      s.expected = diskDatabase(s);
      notes.push(
        `The machine stops. Gone: ${String(lost.frames)} ${lost.frames === 1 ? 'page' : 'pages'} in the pool (${String(lost.dirty)} dirty), ${String(lost.records)} unflushed log ${lost.records === 1 ? 'record' : 'records'}, and ${String(lost.txns)} running ${lost.txns === 1 ? 'transaction' : 'transactions'}. Kept: the disk, the durable log (through LSN ${String(s.flushedLSN)}) and the master record.`,
      );
      break;
    }

    case 'recover': {
      if (!s.crashed) return refuse('Nothing to recover: the machine has not crashed.');
      recovery = restart(run, op.crashAfter);
      break;
    }
  }

  return {
    log: run.state,
    op,
    effects: run.effects,
    notes,
    ...(recovery === undefined ? {} : { recovery }),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

/** After cells changed outside a statement, each touched table's live slots follow what memory now holds. */
function reslot(log: EngineLog, keys: readonly string[]): void {
  const tables = new Set(keys.map((k) => parseCellKey(k).table));
  for (const name of tables) {
    const t = log.tables[name];
    if (!t) continue;
    const rids: number[] = [];
    t.pages.forEach((page, i) => {
      for (let rid = i * log.rowsPerPage; rid < (i + 1) * log.rowsPerPage; rid += 1) {
        if (typeof cellNow(log, page, cellKey(name, rid)) === 'string') rids.push(rid);
      }
    });
    t.rids = rids;
  }
  log.expected = databaseOfLog(log);
}

/**
 * ARIES restart from the durable log alone: analysis, redo, undo — `wal.ts`'s `restart`, on the engine's pages and
 * through its pool. With `crashAfter`, the machine stops again once undo has written that many records.
 */
function restart(run: Operation, crashAfter: number | undefined): RecoveryReport {
  const s = run.state;
  const notes = run.machine.notes;
  const log = s.log;
  const byLsn = new Map(log.map((r) => [r.lsn, r]));

  const from = s.masterLSN !== null && byLsn.has(s.masterLSN) ? s.masterLSN : (log[0]?.lsn ?? 1);
  const tt = new Map<string, { status: 'active' | 'aborting' | 'committed'; lastLSN: number }>();
  const dpt = new Map<PageId, number>();
  const checkpointEnd = log.find((r) => r.type === 'end-checkpoint' && r.beginLSN === s.masterLSN);
  if (checkpointEnd?.type === 'end-checkpoint') {
    for (const d of checkpointEnd.dirtyPages) dpt.set(d.page, d.recLSN);
    for (const t of checkpointEnd.txns) tt.set(t.txn, { status: 'active', lastLSN: t.lastLSN });
  }
  for (const r of log) {
    if (r.lsn < from || !('txn' in r)) continue;
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
      checkpoint: s.masterLSN,
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
    s.masterLSN === null
      ? 'Analysis: there is no checkpoint, so the scan starts at the beginning of the log.'
      : `Analysis: the master record points at the checkpoint that began at LSN ${String(s.masterLSN)}, so the scan starts there, with the tables that checkpoint saved.`,
  );
  notes.push(
    `Analysis finds ${String(dpt.size)} dirty ${dpt.size === 1 ? 'page' : 'pages'} and ${String(tt.size)} ${tt.size === 1 ? 'transaction' : 'transactions'} in flight; ${
      losers.length === 0 ? 'none of them is a loser' : `${losers.join(', ')} never committed, so ${losers.length === 1 ? 'it is a loser' : 'they are losers'}`
    }.`,
  );

  for (const [name, e] of tt) s.txns.push({ txn: name, status: 'active', outcome: null, lastLSN: e.lastLSN, firstLSN: null });

  const touched: string[] = [];
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
      run.fetch(r.page);
      const frame = s.resident[r.page]!;
      const had = frame.pageLSN;
      if (had >= r.lsn) {
        report.redo.push({ lsn: r.lsn, page: r.page, key: r.key, action: 'skip', reason: `the page on disk already has it (pageLSN ${String(had)} ≥ ${String(r.lsn)})` });
        continue;
      }
      run.machine.apply(r.page, r.key, r.after, r.lsn, null);
      touched.push(r.key);
      report.redo.push({ lsn: r.lsn, page: r.page, key: r.key, action: 'redo', reason: `the page's pageLSN is ${String(had)}, older than this record, so ${r.key} is set to ${cellText(r.after)}` });
    }
  } else {
    notes.push('Redo has nothing to do: no page was dirty.');
  }
  for (const [name, e] of tt) {
    if (e.status !== 'committed') continue;
    run.append({ type: 'end', txn: name });
    report.ended.push(name);
  }
  if (s.logBuffer.length > 0) run.flush(s.logBuffer[s.logBuffer.length - 1]!.lsn, 'recovery');

  const toUndo = losers.map((name) => tt.get(name)!.lastLSN);
  let written = 0;
  while (toUndo.length > 0) {
    toUndo.sort((a, b) => a - b);
    const lsn = toUndo.pop()!;
    const r = run.record(lsn);
    if (r === undefined || !('txn' in r)) continue;
    let next: number | null;
    if (r.type === 'update') {
      run.fetch(r.page);
      const record = run.append({ type: 'clr', txn: r.txn, page: r.page, key: r.key, after: r.before, undoNextLSN: r.prevLSN });
      run.machine.apply(r.page, r.key, r.before, record.lsn, null);
      touched.push(r.key);
      run.flush(record.lsn, 'recovery');
      written += 1;
      next = r.prevLSN;
      report.undo.push({ lsn, txn: r.txn, action: 'undo', detail: `${r.key} goes back from ${cellText(r.after)} to ${cellText(r.before)} on page ${String(r.page)}`, clr: record.lsn });
    } else if (r.type === 'clr') {
      next = r.undoNextLSN;
      report.undo.push({ lsn, txn: r.txn, action: 'follow', detail: `this is an undo already logged, so it is not undone again; undoing continues at ${next === null ? 'nothing' : `LSN ${String(next)}`}`, clr: null });
    } else {
      next = r.prevLSN;
      report.undo.push({ lsn, txn: r.txn, action: 'follow', detail: `${r.type} record, nothing to undo; continues at ${next === null ? 'nothing' : `LSN ${String(next)}`}`, clr: null });
    }
    if (next === null) {
      const end = run.append({ type: 'end', txn: r.txn });
      run.flush(end.lsn, 'recovery');
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
    run.stop();
    return report;
  }
  for (const [name, e] of tt) {
    const t = run.machine.txn(name)!;
    t.status = 'ended';
    t.outcome = e.status === 'committed' ? 'committed' : 'rolled-back';
  }
  s.crashed = false;
  // Every table's slots follow the recovered cells: a loser's insert is gone, its delete back.
  reslot(s, Object.keys(s.committed));
  notes.push(
    `Recovery is complete: ${String(report.redo.filter((x) => x.action === 'redo').length)} changes redone, ${String(report.undo.filter((x) => x.action === 'undo').length)} undone. The pages it touched are dirty in the pool and will be written in the ordinary way.`,
  );
  return report;
}

/** What a page's disk copy holds, for a caller that only reads. */
export const diskPage = (log: EngineLog, page: PageId): PageImage | undefined => log.disk[page];

/** What `BEGIN`, `COMMIT` or `ROLLBACK` did to the log: refused (the log as it was), or done, and what to say of it. */
export interface ControlOutcome {
  log: EngineLog;
  /** The transaction it began or ended. */
  txn: string;
  /** The result step's sentence. */
  label: string;
  /** After a `ROLLBACK`: the database the log now holds. */
  database?: Database;
  error?: { message: string; hint?: string };
}

/**
 * `BEGIN`, `COMMIT` or `ROLLBACK` from the SQL box (plan.md §28.5 I3), on a copy of `log`, its steps in `emit`'s trace.
 * One session: `BEGIN` opens its transaction (no nesting, no savepoints), `COMMIT` and `ROLLBACK` end it as the
 * dialog's buttons do — the same records, so the four-page model stays the oracle.
 */
export function runControl(kind: ControlKind, log: EngineLog, options: EngineOptions, emit: Emit): ControlOutcome {
  const refuse = (message: string, hint?: string): ControlOutcome => ({
    log,
    txn: log.session ?? '',
    label: '',
    error: { message, ...(hint === undefined ? {} : { hint }) },
  });
  const settings = settingsRefusal(log, options);
  if (settings) return refuse(settings.message, settings.hint);

  if (kind === 'begin') {
    if (log.session !== null) {
      return refuse(
        `${log.session} is already open, and transactions do not nest: the Playground is one session, with one transaction at a time.`,
        `COMMIT or ROLLBACK ${log.session} first. Savepoints are not part of this engine.`,
      );
    }
    const run = new Operation(log, options, emit);
    const name = `T${String(log.counter + 1)}`;
    run.state.counter += 1;
    run.machine.begin(name);
    run.state.session = name;
    return {
      log: run.state,
      txn: name,
      label: `BEGIN: ${name} starts. Every INSERT, UPDATE and DELETE from here on is ${name}'s — its changes logged as its records, the rows it changes its own — until COMMIT makes them durable or ROLLBACK undoes them. Nothing is logged yet: a transaction's first record is its first change.`,
    };
  }

  const verb = kind === 'commit' ? 'commit' : 'roll back';
  if (log.session === null) {
    return refuse(
      `No transaction is open, so there is nothing to ${verb}.`,
      'Run BEGIN first. A write outside BEGIN is a transaction of its own, left open for Durability to commit or roll back.',
    );
  }
  const run = new Operation(log, options, emit);
  const t = run.machine.txn(log.session);
  if (!t || t.status === 'ended') return refuse(`${log.session} is not a running transaction.`);
  if (kind === 'commit') {
    run.commit(t);
    return { log: run.state, txn: t.txn, label: `COMMIT: ${run.machine.notes.join(' ')}` };
  }
  const refused = run.abort(t);
  if (refused !== undefined) return refuse(refused, 'Under no-steal, undo needs a frame for each page it changes back. Free one in Durability, or start the log with steal.');
  return {
    log: run.state,
    txn: t.txn,
    label: `ROLLBACK: ${run.machine.notes.join(' ')} The rows are as they were before BEGIN.`,
    database: databaseOfLog(run.state),
  };
}

/**
 * What a logged run needs of the log, handed to `runQuery` with it (`RunHooks.engineLog`) instead of imported by it:
 * the engine stays as small as it was for every page that never turns the log on, and only the lazy *Durability*
 * dialog, which opens a log, loads these files.
 */
export const engineLogKit = { StatementLog, loggedNote, inSync, isRefusal, control: runControl };
export type EngineLogKit = typeof engineLogKit;

/** A log and the kit that runs a statement on it: what `runQuery` takes to log a write. */
export interface LoggedRun {
  log: EngineLog;
  kit: EngineLogKit;
}

/** `log`, ready to hand to `runQuery`. */
export function loggedRun(log: EngineLog): LoggedRun {
  return { log, kit: engineLogKit };
}
