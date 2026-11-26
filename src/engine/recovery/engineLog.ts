/**
 * The engine logs (plan.md §28.5 I2). With a log attached, the SQL pipeline's `INSERT`, `UPDATE` and `DELETE` run on
 * the engine's own buffer pool, kept warm from one statement to the next, and every row they change is logged before
 * its page is: a record in the log buffer, the page's pageLSN, the frame's recLSN. A dirty page leaving the pool is
 * written to disk only after the log has been flushed through its pageLSN. That is ARIES's write-ahead rule, here on
 * the pages the engine reads, not on a model of its own.
 *
 * This file holds what a statement needs, so the engine carries only that. `engineLogOps.ts` holds what the
 * *Durability* dialog does between statements: commit, roll back, flush, write a page, checkpoint, crash and recover.
 * Both work on one `EngineLog`, plain data a statement copies and hands back, so a statement that fails leaves the
 * log as it was.
 *
 * The heap here keeps a row in its slot for as long as the log runs. A row's place is its **rid**: page
 * `pages[⌊rid / rowsPerPage⌋]`, a cell named `table#rid`. A delete leaves the slot empty instead of sliding the later
 * rows down, so a change touches one cell on one page, as in a slotted page. An insert takes the next slot, and a
 * full last page means a new page, so a table grows as far as it needs to.
 *
 * Index pages are not logged. The engine builds a table's indexes from its heap for each statement, so the heap is
 * the whole durable state; the index pages a statement read leave the pool when it ends.
 *
 * `/tools/wal` and `/tools/recovery` keep their four-page model (`wal.ts`), and it is this log's oracle (plan.md
 * §28.6 rule 11): the same script gives both the same log, the same disk and the same recovered database
 * (`__tests__/engineLog.test.ts`). It imports only types from that model, so the Playground does not carry it.
 */

import type { Emit } from '../trace.ts';
import type { Database, Row, Table } from '../types.ts';
import type { Heap, Page } from '../storage/page.ts';
import type { BufferPool, PoolAttachment } from '../storage/bufferPool.ts';
import type { BufferState } from '../storage/policy.ts';
import type { Cell, LogRecord, PageId, TxnState } from './wal.ts';

export interface LoggedTable {
  /** The table's heap pages, in order: slot `rid` is on `pages[⌊rid / rowsPerPage⌋]`. */
  pages: PageId[];
  /** The slot of each row the table has now, in table order. */
  rids: number[];
  /** The slot the next insert takes. */
  nextRid: number;
}

export interface PageImage {
  cells: Record<string, Cell>;
  /** The LSN of the last change this copy holds. */
  pageLSN: number;
}

/** A heap page in the pool: its cells as they are in memory, and what makes it dirty. */
export interface ResidentPage extends PageImage {
  /** The first change since this page was last written; null while it is clean. */
  recLSN: number | null;
  /** The running transactions with a change on it. */
  holders: string[];
}

export interface EngineTxn extends TxnState {
  /** Its first record: a checkpoint may not truncate the log past it while it runs, since undo walks back to it. */
  firstLSN: number | null;
}

export type WriteKind = 'insert' | 'update' | 'delete';

export interface LoggedStatement {
  txn: string;
  sql: string;
  table: string;
  kind: WriteKind;
  /** Rows the statement changed. */
  rows: number;
}

export interface EngineLog {
  rowsPerPage: number;
  /** The pool's size when the log began: the frames below are that many. */
  frames: number;
  /** Whether the pool may write a page holding an uncommitted change. Off, such a page's frame is pinned. */
  steal: boolean;
  /** Whether a commit writes every page its transaction changed. */
  force: boolean;
  tables: Record<string, LoggedTable>;
  /** The page id the next new heap page takes; index pages are numbered past it, for one statement at a time. */
  nextPageId: PageId;
  disk: Record<PageId, PageImage>;
  resident: Record<PageId, ResidentPage>;
  /** The pool's frames between statements: only heap pages stay. */
  pool: BufferState;
  logBuffer: LogRecord[];
  log: LogRecord[];
  flushedLSN: number;
  nextLSN: number;
  /** The first LSN the durable log still holds: a checkpoint truncates what no restart can need. */
  logStart: number;
  txns: EngineTxn[];
  /** Which running transaction has changed each cell: it is that transaction's until it ends. */
  owners: Record<string, string>;
  /** Pages a commit under force owes a write, held back by another transaction's change under no-steal. */
  deferred: PageId[];
  /** The begin record of the last completed checkpoint. Survives a crash. */
  masterLSN: number | null;
  crashed: boolean;
  /** The newest committed value of every cell: what a recovery has to give back. */
  committed: Record<string, Cell>;
  statements: LoggedStatement[];
  counter: number;
  /** The database the log began with, for its tables' shapes. */
  base: Database;
  /** The tables as the log believes the Playground holds them: a different database means the log is stale. */
  expected: Database;
}

export const cellKey = (table: string, rid: number): string => `${table}#${String(rid)}`;

/** The table and slot a cell names. */
export function parseCellKey(key: string): { table: string; rid: number } {
  const at = key.lastIndexOf('#');
  return { table: key.slice(0, at), rid: Number(key.slice(at + 1)) };
}

/** A copy a statement or an operation may change without touching `log`: records and rows are never changed in place. */
export function copyLog(log: EngineLog): EngineLog {
  return {
    ...log,
    tables: Object.fromEntries(
      Object.entries(log.tables).map(([name, t]) => [name, { pages: [...t.pages], rids: [...t.rids], nextRid: t.nextRid }]),
    ),
    disk: { ...log.disk },
    resident: Object.fromEntries(
      Object.entries(log.resident).map(([page, r]) => [page, { ...r, cells: { ...r.cells }, holders: [...r.holders] }]),
    ),
    pool: structuredClone(log.pool),
    logBuffer: [...log.logBuffer],
    log: [...log.log],
    txns: log.txns.map((t) => ({ ...t })),
    owners: { ...log.owners },
    deferred: [...log.deferred],
    committed: { ...log.committed },
    statements: [...log.statements],
  };
}

const sameRows = (a: Table | undefined, b: Table | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && (a.rows === b.rows || JSON.stringify(a.rows) === JSON.stringify(b.rows)));

/** Whether the Playground still holds the database the log last knew of. */
export function inSync(log: EngineLog, db: Database): boolean {
  const names = Object.keys(log.expected.tables);
  return (
    names.length === Object.keys(db.tables).length && names.every((name) => sameRows(log.expected.tables[name], db.tables[name]))
  );
}

/** What memory holds for a cell: the pool's copy of its page, else the disk's. */
export function cellNow(log: EngineLog, page: PageId, key: string): Cell {
  const resident = log.resident[page];
  // An empty slot is a value, null: only a page the pool does not hold falls back to the disk's copy.
  if (resident && key in resident.cells) return resident.cells[key]!;
  return log.disk[page]?.cells[key] ?? null;
}

/** The pages a statement on `table` reads, laid out as the engine's heap: each page's live rows, in slot order. */
export function heapOf(log: EngineLog, table: Table): Heap {
  const t = log.tables[table.name]!;
  const per = log.rowsPerPage;
  const pages: Page[] = t.pages.map((pageId) => ({ pageId, table: table.name, rows: [], rids: [] }));
  const firstRowIndex: number[] = pages.map(() => 0);
  t.rids.forEach((rid, i) => {
    const page = pages[Math.floor(rid / per)]!;
    if (page.rows.length === 0) firstRowIndex[Math.floor(rid / per)] = i;
    page.rows.push(table.rows[i]!);
    page.rids!.push(rid);
  });
  return { table: table.name, pages, firstRowIndex };
}

/** A statement's refusal: it changes nothing, and the run says why. */
export class LogRefusal extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'LogRefusal';
    this.hint = hint;
  }
}

const rowText = (cell: Cell): string => (cell === null ? 'an empty slot' : String(cell));

/**
 * The log working on a copy: a statement's, or one of the dialog's operations. It is the pool's attachment, so a page
 * the pool reads comes off this disk, a dirty page it evicts goes back to it, and the log is flushed first.
 */
export class LogMachine {
  readonly state: EngineLog;
  private emit: Emit | undefined;
  /** Notes for an operation run outside a query, which has no trace. */
  readonly notes: string[] = [];

  constructor(log: EngineLog, emit?: Emit) {
    this.state = copyLog(log);
    this.emit = emit;
  }

  /** Every page id a pool over this log must allow: the heap pages, then `extra` more. */
  pageCount(extra = 0): number {
    return this.state.nextPageId + extra;
  }

  isHeapPage(page: PageId): boolean {
    return this.state.disk[page] !== undefined;
  }

  attachment(): PoolAttachment {
    return {
      initial: this.state.pool,
      isDirty: (page) => (this.state.resident[page]?.recLSN ?? null) !== null,
      onLoad: (page) => {
        if (!this.isHeapPage(page)) return;
        const disk = this.state.disk[page]!;
        this.state.resident[page] = { cells: { ...disk.cells }, pageLSN: disk.pageLSN, recLSN: null, holders: [] };
      },
      onEvict: (page, dirty) => {
        if (!this.isHeapPage(page)) return undefined;
        const words = dirty ? this.writePage(page, 'eviction') : undefined;
        delete this.state.resident[page];
        return words;
      },
    };
  }

  /** Says a step: in the trace during a statement, as a note otherwise. */
  say(label: string, body: Parameters<Emit>[1]): void {
    if (this.emit) this.emit(label, body);
    else this.notes.push(label);
  }

  /** Moves the log buffer's records through `through` to the durable log. */
  flushLog(through: number): { from: number; to: number } | null {
    const going = this.state.logBuffer.filter((r) => r.lsn <= through);
    if (going.length === 0) return null;
    this.state.log.push(...going);
    this.state.logBuffer = this.state.logBuffer.filter((r) => r.lsn > through);
    const span = { from: going[0]!.lsn, to: going[going.length - 1]!.lsn };
    this.state.flushedLSN = span.to;
    return span;
  }

  /**
   * Writes a resident dirty page to disk — the log first. Returns the sentence the step says about it. The page stays
   * resident (clean); evicting it is the caller's business.
   */
  writePage(page: PageId, why: 'eviction' | 'background' | 'force'): string {
    const frame = this.state.resident[page]!;
    let flushed = '';
    if (frame.pageLSN > this.state.flushedLSN) {
      const before = this.state.flushedLSN;
      this.flushLog(frame.pageLSN);
      this.say(
        `Page ${String(page)} is about to be written, and it carries changes up to LSN ${String(frame.pageLSN)}, but ${before === 0 ? 'none of the log is durable yet' : `the log is durable only through LSN ${String(before)}`}. The log goes first: it is flushed through LSN ${String(frame.pageLSN)}, so the disk never holds a change that no durable record can undo.`,
        { stage: 'buffer', action: 'flush', pageId: page, lsn: frame.pageLSN },
      );
      flushed = ` The log was flushed through LSN ${String(frame.pageLSN)} first.`;
    }
    this.state.disk[page] = { cells: { ...frame.cells }, pageLSN: frame.pageLSN };
    frame.recLSN = null;
    const reason = why === 'eviction' ? 'so evicting it costs a write' : why === 'force' ? 'and force writes it at commit' : 'and the writer puts it on disk';
    return `Page ${String(page)} is dirty (pageLSN ${String(frame.pageLSN)}), ${reason}: the disk now holds this copy.${flushed}`;
  }

  txn(name: string): EngineTxn | undefined {
    return this.state.txns.find((t) => t.txn === name);
  }

  /** Begins `name` if it has not begun. */
  begin(name: string): EngineTxn {
    const found = this.txn(name);
    if (found) return found;
    const t: EngineTxn = { txn: name, status: 'active', outcome: null, lastLSN: null, firstLSN: null };
    this.state.txns.push(t);
    return t;
  }

  /** Appends a transaction's record to the log buffer, chained to its previous one. */
  append<R extends DistributiveOmit<Extract<LogRecord, { txn: string }>, 'lsn' | 'prevLSN'>>(rec: R): LogRecord {
    const t = this.txn(rec.txn)!;
    const full = { ...rec, lsn: this.state.nextLSN, prevLSN: t.lastLSN } as LogRecord;
    this.state.nextLSN += 1;
    t.lastLSN = full.lsn;
    t.firstLSN ??= full.lsn;
    this.state.logBuffer.push(full);
    return full;
  }

  /** The frame holding a resident page, in the pool's own state. */
  frameOf(page: PageId): BufferState['frames'][number] | undefined {
    return this.state.pool.frames.find((f) => f.pageId === page);
  }

  /** Puts `after` into `key` as the change record `lsn` describes, on a page the pool holds. */
  apply(page: PageId, key: string, after: Cell, lsn: number, txn: string | null): void {
    const frame = this.state.resident[page]!;
    frame.cells[key] = after;
    frame.pageLSN = lsn;
    frame.recLSN ??= lsn;
    if (txn !== null && !frame.holders.includes(txn)) {
      frame.holders.push(txn);
      // No-steal: a page with an uncommitted change may not leave the pool, so its frame is pinned until the
      // transaction ends — a pin the replacement policy honours like any other.
      if (!this.state.steal && frame.holders.length === 1) {
        const f = this.frameOf(page);
        if (f) f.pinCount += 1;
      }
    }
  }

  /** A transaction has ended: its cells are free, and a page holding no other change is no longer pinned for it. */
  release(name: string): void {
    for (const [key, who] of Object.entries(this.state.owners)) if (who === name) delete this.state.owners[key];
    for (const [page, frame] of Object.entries(this.state.resident)) {
      if (!frame.holders.includes(name)) continue;
      frame.holders = frame.holders.filter((h) => h !== name);
      if (!this.state.steal && frame.holders.length === 0) {
        const f = this.frameOf(Number(page));
        if (f && f.pinCount > 0) f.pinCount -= 1;
      }
    }
  }

  /** The pool's frames as a statement may leave them: heap pages only, nothing pinned but no-steal's own pins. */
  settle(): void {
    const pool = this.state.pool;
    delete pool.lookahead;
    pool.lookaheadCursor = 0;
    for (const f of pool.frames) {
      if (f.pageId !== null && !this.isHeapPage(f.pageId)) {
        f.pageId = null;
        f.usageCount = 0;
        f.loadedAt = -1;
        f.pinCount = 0;
      } else if (f.pageId !== null) {
        const frame = this.state.resident[f.pageId];
        f.pinCount = !this.state.steal && frame && frame.holders.length > 0 ? 1 : 0;
      } else {
        f.pinCount = 0;
      }
    }
  }
}

/** `Omit` over each member of a union, keeping it a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * One write statement's hold on the log: the heap it reads, the pool it runs on, and each change it makes, logged
 * before it is applied. Built by `runQuery` when a log is attached; `finish` hands back the log it leaves.
 */
export class StatementLog {
  readonly machine: LogMachine;
  readonly txn: string;
  readonly table: Table;
  private pool: BufferPool | null = null;
  /** Records this statement appended. */
  records = 0;
  /** Rows it changed. */
  changed = 0;
  /** The slots it emptied and the ones it filled. */
  private readonly removed = new Set<number>();
  private readonly inserted: number[] = [];

  constructor(log: EngineLog, table: Table, emit: Emit, options: { bufferFrames: number; rowsPerPage: number }) {
    if (options.bufferFrames !== log.frames || options.rowsPerPage !== log.rowsPerPage) {
      throw new LogRefusal(
        `The log began on a pool of ${String(log.frames)} frames and pages of ${String(log.rowsPerPage)} rows, and the engine now has ${String(options.bufferFrames)} and ${String(options.rowsPerPage)}: its pages and frames are not these.`,
        'Start the log again in Durability, or put the settings back.',
      );
    }
    if (log.crashed) {
      throw new LogRefusal(
        'The machine is down: the log has crashed and nothing runs until it has recovered.',
        'Open Durability and press Recover.',
      );
    }
    if (table.clusteredKey) {
      throw new LogRefusal(
        `\`${table.name}\` is a clustered table, whose rows move to stay in key order; the log keeps each row in a fixed slot, so it cannot log a write to it.`,
        'Turn the log off in Durability to write to it.',
      );
    }
    if (!log.tables[table.name]) {
      throw new LogRefusal(`The log has no heap for \`${table.name}\`.`, 'Start the log again from this database in Durability.');
    }
    this.machine = new LogMachine(log, emit);
    this.txn = `Q${String(log.counter + 1)}`;
    this.table = table;
  }

  get state(): EngineLog {
    return this.machine.state;
  }

  heap(): Heap {
    return heapOf(this.state, this.table);
  }

  /** Where the statement's index pages begin: past every heap page, and past one more for an insert's new page. */
  firstIndexPage(): number {
    return this.state.nextPageId + 1;
  }

  bind(pool: BufferPool): void {
    this.pool = pool;
  }

  /**
   * Where an insert's row goes: the next slot, on a new page when the last one is full. A new page starts empty on
   * disk — its allocation is not logged, only the row put on it.
   */
  insertTarget(): { pageId: PageId; slot: number; rid: number; isNewPage: boolean } {
    const t = this.state.tables[this.table.name]!;
    const per = this.state.rowsPerPage;
    const rid = t.nextRid;
    const index = Math.floor(rid / per);
    let isNewPage = false;
    if (index >= t.pages.length) {
      const pageId = this.state.nextPageId;
      this.state.nextPageId += 1;
      t.pages.push(pageId);
      const cells: Record<string, Cell> = {};
      for (let r = index * per; r < (index + 1) * per; r += 1) cells[cellKey(this.table.name, r)] = null;
      this.state.disk[pageId] = { cells, pageLSN: 0 };
      // Its empty slots are what a recovery gives back for them, unless a committed insert fills one.
      Object.assign(this.state.committed, cells);
      isNewPage = true;
    }
    const pageId = t.pages[index]!;
    const slot = t.rids.filter((r) => Math.floor(r / per) === index).length;
    return { pageId, slot, rid, isNewPage };
  }

  /**
   * Logs one row's change and then makes it: fetch the page (pinned while it is changed), append the record to the
   * log buffer, apply it, take the page's pageLSN, mark it dirty, unpin. `before` and `after` are null for an insert's
   * empty slot and a delete's.
   */
  change(pageId: PageId, rid: number, before: Row | null, after: Row | null): void {
    const pool = this.pool!;
    const key = cellKey(this.table.name, rid);
    const owner = this.state.owners[key];
    if (owner !== undefined && owner !== this.txn) {
      throw new LogRefusal(
        `${owner} has changed row ${String(rid)} of \`${this.table.name}\` and has not ended, so the row is ${owner}'s until it does.`,
        `Commit or roll back ${owner} in Durability first.`,
      );
    }
    const fetched = pool.fetch(pageId);
    if (!fetched) {
      const holders = [...new Set(Object.values(this.state.resident).flatMap((r) => r.holders))];
      throw new LogRefusal(
        `No-steal: every frame holds a page with an uncommitted change (${holders.join(', ')}), and none may be written out to make room, so page ${String(pageId)} cannot be brought in.`,
        'A transaction under no-steal needs a frame for every page it changes. Commit or roll back in Durability, or start the log with steal.',
      );
    }
    const t = this.machine.begin(this.txn);
    const wasEmpty = t.lastLSN === null;
    const beforeCell: Cell = before === null ? null : JSON.stringify(before);
    const afterCell: Cell = after === null ? null : JSON.stringify(after);
    const record = this.machine.append({ type: 'update', txn: this.txn, page: pageId, key, before: beforeCell, after: afterCell });
    this.machine.apply(pageId, key, afterCell, record.lsn, this.txn);
    this.state.owners[key] = this.txn;
    pool.unpin(fetched.frameId);
    this.records += 1;
    this.changed += 1;
    if (after === null) this.removed.add(rid);
    if (before === null) this.inserted.push(rid);
    const what = before === null ? 'puts a new row in' : after === null ? 'empties' : 'changes';
    this.machine.say(
      `Log record LSN ${String(record.lsn)}: ${this.txn} ${what} slot ${String(rid)} of \`${this.table.name}\` on page ${String(pageId)} (${rowText(beforeCell)} → ${rowText(afterCell)}). The record goes to the log buffer before the page is changed${wasEmpty ? `, and it is ${this.txn}'s first, so ${this.txn} begins here` : ''}; page ${String(pageId)} takes pageLSN ${String(record.lsn)} and is dirty in the pool. Neither is on disk yet.`,
      { stage: 'buffer', action: 'log', pageId, lsn: record.lsn },
    );
  }

  /** The log the statement leaves: its transaction left open, as every statement's is until the dialog decides. */
  finish(sql: string, kind: WriteKind, rows: readonly Row[]): EngineLog {
    const t = this.state.tables[this.table.name]!;
    t.rids = [...t.rids.filter((rid) => !this.removed.has(rid)), ...this.inserted];
    t.nextRid = Math.max(t.nextRid, ...this.inserted.map((r) => r + 1));
    this.machine.settle();
    const s = this.state;
    s.expected = { tables: { ...s.expected.tables, [this.table.name]: { ...this.table, rows: [...rows] } } };
    if (this.changed > 0) {
      s.counter += 1;
      s.statements.push({ txn: this.txn, sql, table: this.table.name, kind, rows: this.changed });
    }
    return s;
  }
}

/** The narration a logged write's result step adds. */
export function loggedNote(statement: StatementLog): string {
  if (statement.changed === 0) return ' Nothing changed, so nothing was logged.';
  const s = statement.state;
  const inBuffer = s.logBuffer.length;
  return ` Logged as ${statement.txn}: ${String(statement.records)} ${statement.records === 1 ? 'record' : 'records'}, and ${String(inBuffer)} in the log buffer, durable through LSN ${String(s.flushedLSN)}. ${statement.txn} stays open until you commit or roll it back in Durability.`;
}

/**
 * What a logged run needs of this file, handed to `runQuery` with the log (`RunHooks.engineLog`) instead of imported
 * by it: the engine stays as small as it was for every page that never turns the log on, and only the lazy
 * *Durability* dialog, which opens a log, loads this file.
 */
export const engineLogKit = { StatementLog, loggedNote, inSync, isRefusal: (e: unknown): e is LogRefusal => e instanceof LogRefusal };
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
