import { describe, expect, it } from 'vitest';
import { DATASETS } from '../datasets.ts';
import { runQuery } from '../runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions, RunResult, StepEvent } from '../types.ts';
import type { EngineLog } from '../recovery/engineLog.ts';
import { loggedRun } from '../recovery/engineLog.ts';
import { applyLogOp, crashImageOf, databaseOfLog, diskDatabase, memoryCells, openEngineLog } from '../recovery/engineLogOps.ts';
import type { LogOp, LogOpResult } from '../recovery/engineLogOps.ts';
import { committedCells, crashImage, databaseCells, runWal } from '../recovery/wal.ts';
import type { Cell, PageId, WalStep } from '../recovery/wal.ts';

/**
 * plan.md §28.5 I2: the SQL pipeline's writes logged on the engine's own buffer pool. The four-page model of
 * `/tools/wal` is held as the oracle (§28.6 rule 11): every script below is also run on it, step for step, and the two
 * must keep the same log, the same transactions, the same database and — when neither pool has to evict on its own —
 * the same disk, crash image and recovery.
 */

const users = (): Database => {
  const db = DATASETS.users.make();
  // Twelve rows, three pages of four: few enough pages for the model's pool to hold them all.
  return { tables: { users: { ...db.tables.users!, rows: db.tables.users!.rows.slice(0, 12) } } };
};

/** A session: a database and its log, with every statement and operation mirrored as the model's steps. */
class Session {
  db: Database;
  log: EngineLog;
  readonly options: EngineOptions;
  readonly steps: WalStep[] = [];
  readonly initial: Record<PageId, Record<string, Cell>>;
  private begun = new Set<string>();
  last: RunResult | null = null;
  lastOp: LogOpResult | null = null;

  constructor(db: Database, frames: number, choice: { steal: boolean; force: boolean } = { steal: true, force: false }) {
    this.db = db;
    this.options = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames };
    this.log = openEngineLog(db, this.options, choice);
    this.initial = Object.fromEntries(Object.entries(this.log.disk).map(([p, img]) => [p, { ...img.cells }]));
  }

  /** A write in the Playground, logged; the model gets a `set` for each record and a `write-page` for each dirty eviction. */
  run(sql: string): RunResult {
    const r = runQuery(sql, this.db, this.options, { engineLog: loggedRun(this.log) });
    this.last = r;
    if (r.error) return r;
    const after = r.engineLog!;
    const records = new Map([...after.log, ...after.logBuffer].map((x) => [x.lsn, x]));
    for (const e of r.events) {
      if (e.stage !== 'buffer') continue;
      if (e.action === 'log') {
        const rec = records.get(e.lsn)!;
        if (rec.type !== 'update') throw new Error('a statement logs updates only');
        if (!this.begun.has(rec.txn)) {
          this.begun.add(rec.txn);
          this.steps.push({ op: 'begin', txn: rec.txn });
        }
        this.steps.push({ op: 'set', txn: rec.txn, key: rec.key, value: rec.after });
      } else if (e.action === 'evict' && e.writtenBack) {
        this.steps.push({ op: 'write-page', page: e.victimPageId });
      }
    }
    // A new page the engine gave an insert is, on disk, a page of empty slots: the model's pages include it from the start.
    for (const [page, img] of Object.entries(after.disk)) {
      if (!(page in this.initial)) this.initial[Number(page)] = Object.fromEntries(Object.keys(img.cells).map((k) => [k, null]));
    }
    this.log = after;
    this.db = { tables: { ...this.db.tables, [r.write!.table]: { ...this.db.tables[r.write!.table]!, rows: r.write!.rows } } };
    return r;
  }

  /** One of the dialog's operations, on both. */
  op(op: LogOp): LogOpResult {
    const r = applyLogOp(this.log, op, this.options);
    this.lastOp = r;
    if (r.error) return r;
    this.log = r.log;
    this.db = op.op === 'crash' ? diskDatabase(r.log) : databaseOfLog(r.log);
    this.steps.push(op.op === 'recover' && op.crashAfter !== undefined ? { op: 'recover', crashAfter: op.crashAfter } : (op));
    return r;
  }

  model() {
    return runWal(this.steps, { pages: this.initial, frames: 8, steal: this.log.steal, force: this.log.force, maxSteps: 10_000 });
  }

  /** The engine and the model agree on everything a pool's own evictions cannot change. */
  agrees(): void {
    const model = this.model();
    const errors = model.steps.filter((s) => s.error).map((s) => `${String(s.index)}: ${s.error!}`);
    expect(errors).toEqual([]);
    const m = model.final;
    expect(this.log.log).toEqual(m.log.filter((r) => r.lsn >= this.log.logStart));
    expect(this.log.logBuffer).toEqual(m.logBuffer);
    expect(this.log.flushedLSN).toBe(m.flushedLSN);
    expect(this.log.nextLSN).toBe(m.nextLSN);
    expect(this.log.crashed).toBe(m.crashed);
    expect(this.log.masterLSN).toBe(m.masterLSN);
    expect(this.log.txns.map(({ firstLSN: _f, ...t }) => t)).toEqual(m.txns);
    expect(memoryCells(this.log)).toEqual(databaseCells(m));
    expect(this.log.committed).toEqual(committedCells(m, this.initial));
    const report = [...model.steps].reverse().find((s) => s.recovery)?.recovery;
    if (this.lastOp?.recovery) expect(this.lastOp.recovery).toEqual(report);
  }

  /** And, when the engine's pool is as big as the model's, on the disk and what a crash would find too. */
  agreesExactly(): void {
    this.agrees();
    const m = this.model().final;
    const disk = Object.fromEntries(m.disk.map((p) => [p.page, { cells: p.cells, pageLSN: p.pageLSN }]));
    expect(this.log.disk).toEqual(disk);
    if (!m.crashed) expect(crashImageOf(this.log)).toEqual(crashImage(m, this.initial));
  }
}

const bufferEvents = (r: RunResult): Extract<StepEvent, { stage: 'buffer' }>[] =>
  r.events.filter((e): e is Extract<StepEvent, { stage: 'buffer' }> => e.stage === 'buffer');

describe('the engine logs (plan.md §28.5 I2)', () => {
  it('logs each row before its page changes, on the engine’s own pool', () => {
    const s = new Session(users(), 8);
    const r = s.run("UPDATE users SET name = 'x' WHERE id <= 2");
    expect(r.error).toBeUndefined();
    const logs = bufferEvents(r).filter((e) => e.action === 'log');
    expect(logs.map((e) => e.lsn)).toEqual([1, 2]);
    expect(s.log.logBuffer.map((x) => x.type)).toEqual(['update', 'update']);
    // In the pool, dirty, with the record's LSN; on disk, untouched.
    const page = s.log.tables.users!.pages[0]!;
    expect(s.log.resident[page]).toMatchObject({ pageLSN: 2, recLSN: 1, holders: ['Q1'] });
    expect(s.log.disk[page]!.pageLSN).toBe(0);
    expect(r.events.at(-1)!.label).toContain('Logged as Q1');
    expect(s.log.statements).toEqual([{ txn: 'Q1', sql: "UPDATE users SET name = 'x' WHERE id <= 2", table: 'users', kind: 'update', rows: 2 }]);
    s.agreesExactly();
  });

  it('flushes the log before it writes a dirty page, every time the pool evicts one', () => {
    const s = new Session(users(), 2);
    const r = s.run('UPDATE users SET age = age + 1');
    const events = bufferEvents(r);
    const writes = events.filter((e) => e.action === 'evict' && e.writtenBack);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      const at = events.indexOf(w);
      const victim = (w as Extract<StepEvent, { action: 'evict' }>).victimPageId;
      // The log is durable through the victim's pageLSN before the page reaches the disk.
      expect(s.log.disk[victim]!.pageLSN).toBeLessThanOrEqual(s.log.flushedLSN);
      const flush = events.slice(0, at).reverse().find((e) => e.action === 'flush');
      expect(flush && 'pageId' in flush ? flush.pageId : null).toBe(victim);
    }
    s.agrees();
  });

  it('keeps the pool warm between statements, and only the heap’s pages', () => {
    const s = new Session(users(), 8);
    s.run("UPDATE users SET name = 'x' WHERE id = 1");
    const r = s.run("UPDATE users SET name = 'y' WHERE id = 2");
    const first = bufferEvents(r).find((e) => e.action === 'hit' || e.action === 'miss');
    expect(first?.action).toBe('hit');
    const heapPages = new Set(Object.keys(s.log.disk).map(Number));
    for (const f of s.log.pool.frames) if (f.pageId !== null) expect(heapPages.has(f.pageId)).toBe(true);
  });

  it('commits by forcing the log, not the pages (no-force)', () => {
    const s = new Session(users(), 8);
    s.run("UPDATE users SET name = 'x' WHERE id = 1");
    const c = s.op({ op: 'commit', txn: 'Q1' });
    expect(c.effects.map((e) => e.kind)).toEqual(['log-append', 'log-flush', 'log-append']);
    expect(s.log.committed['users#0']).toContain('"name":"x"');
    s.agreesExactly();
  });

  it('writes the transaction’s pages at commit under force', () => {
    const s = new Session(users(), 8, { steal: true, force: true });
    s.run("UPDATE users SET name = 'x' WHERE id IN (1, 5)");
    const c = s.op({ op: 'commit', txn: 'Q1' });
    expect(c.effects.filter((e) => e.kind === 'page-write').map((e) => (e.kind === 'page-write' ? e.reason : ''))).toEqual(['force', 'force']);
    s.agreesExactly();
  });

  it('refuses, under no-steal, a statement that needs more frames than uncommitted pages leave free', () => {
    const s = new Session(users(), 2, { steal: false, force: false });
    const before = s.log;
    const r = s.run('UPDATE users SET age = 1');
    expect(r.error?.message).toMatch(/^No-steal: every frame holds a page with an uncommitted change/);
    expect(r.engineLog).toBeUndefined();
    expect(s.log).toBe(before);
    // Two pages fit, and stay pinned until Q1 ends.
    s.run('UPDATE users SET age = 1 WHERE id <= 8');
    expect(s.last!.error).toBeUndefined();
    expect(s.log.pool.frames.every((f) => f.pinCount === 1)).toBe(true);
    s.op({ op: 'commit', txn: 'Q1' });
    expect(s.log.pool.frames.every((f) => f.pinCount === 0)).toBe(true);
    s.agrees();
  });

  it('rolls a statement back newest first, with a compensation record for each change', () => {
    const start = users();
    const s = new Session(start, 8);
    s.run("UPDATE users SET name = 'x' WHERE id <= 3");
    s.run('DELETE FROM users WHERE id = 7');
    const r = s.op({ op: 'abort', txn: 'Q1' });
    expect(r.effects.filter((e) => e.kind === 'log-append').map((e) => (e.kind === 'log-append' ? e.record.type : ''))).toEqual(['abort', 'clr', 'clr', 'clr', 'end']);
    s.op({ op: 'abort', txn: 'Q2' });
    expect(s.db.tables.users!.rows).toEqual(start.tables.users!.rows);
    s.agreesExactly();
  });

  it('keeps a row its open transaction changed from a second statement', () => {
    const s = new Session(users(), 8);
    s.run("UPDATE users SET name = 'x' WHERE id = 1");
    const r = s.run("UPDATE users SET name = 'y' WHERE id = 1");
    expect(r.error?.message).toMatch(/^Q1 has changed row 0 of `users` and has not ended/);
    s.op({ op: 'commit', txn: 'Q1' });
    expect(s.run("UPDATE users SET name = 'y' WHERE id = 1").error).toBeUndefined();
  });

  it('leaves a deleted row’s slot empty, and gives an insert the next slot — on a new page when the last is full', () => {
    const s = new Session(users(), 8);
    s.run('DELETE FROM users WHERE id = 2');
    const t = s.log.tables.users!;
    expect(t.rids).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    s.run("INSERT INTO users VALUES (99, 'new', 'new@example.com', 40)");
    expect(s.log.tables.users!.rids.at(-1)).toBe(12);
    expect(s.log.tables.users!.pages).toHaveLength(4);
    expect(s.db.tables.users!.rows.at(-1)).toMatchObject({ id: 99 });
    expect(databaseOfLog(s.log).tables.users!.rows).toEqual(s.db.tables.users!.rows);
    s.agreesExactly();
  });

  it('recovers what committed and undoes what did not, as the model does', () => {
    const s = new Session(users(), 8);
    s.run("UPDATE users SET name = 'kept' WHERE id = 1");
    s.op({ op: 'commit', txn: 'Q1' });
    s.run("UPDATE users SET name = 'lost' WHERE id = 5");
    s.op({ op: 'flush-log' });
    s.op({ op: 'write-page', page: s.log.tables.users!.pages[1]! });
    s.run('DELETE FROM users WHERE id = 9');
    s.agreesExactly();
    s.op({ op: 'crash' });
    s.agreesExactly();
    const r = s.op({ op: 'recover' });
    expect(r.recovery!.analysis.losers).toEqual(['Q2']);
    const names = s.db.tables.users!.rows.map((x) => x.name);
    expect(names).toContain('kept');
    expect(names).not.toContain('lost');
    // Q3's delete never reached the durable log, so its row is still there.
    expect(s.db.tables.users!.rows.some((x) => x.id === 9)).toBe(true);
    s.agreesExactly();
  });

  it('recovers through its own pool when that pool is small, and still agrees on the database', () => {
    const s = new Session(users(), 2);
    s.run('UPDATE users SET age = age + 1');
    s.op({ op: 'commit', txn: 'Q1' });
    s.run("UPDATE users SET name = 'lost'");
    s.op({ op: 'crash' });
    s.op({ op: 'recover' });
    s.agrees();
    expect(s.db.tables.users!.rows.every((x) => x.name !== 'lost')).toBe(true);
  });

  it('undoes nothing twice when recovery itself is interrupted', () => {
    const s = new Session(users(), 8);
    s.run("UPDATE users SET name = 'x' WHERE id <= 3");
    s.op({ op: 'flush-log' });
    s.op({ op: 'crash' });
    s.op({ op: 'recover', crashAfter: 2 });
    expect(s.log.crashed).toBe(true);
    s.agreesExactly();
    s.op({ op: 'recover' });
    expect(s.lastOp!.recovery!.undo.filter((u) => u.action === 'follow').length).toBeGreaterThan(0);
    s.agreesExactly();
    expect(s.db.tables.users!.rows).toEqual(users().tables.users!.rows);
  });

  it('truncates the log at a checkpoint to what a restart can still need, and still recovers', () => {
    const s = new Session(users(), 8);
    s.run("UPDATE users SET name = 'a' WHERE id = 1");
    s.op({ op: 'commit', txn: 'Q1' });
    s.op({ op: 'write-page', page: s.log.tables.users!.pages[0]! });
    s.run("UPDATE users SET name = 'b' WHERE id = 5");
    const cp = s.op({ op: 'checkpoint' });
    // Q1 is over and its page clean: everything before Q2's first record (LSN 4) goes.
    expect(cp.truncated).toBe(3);
    expect(s.log.logStart).toBe(4);
    expect(s.log.log[0]!.lsn).toBe(4);
    s.agreesExactly();
    s.op({ op: 'crash' });
    s.op({ op: 'recover' });
    s.agreesExactly();
    const names = s.db.tables.users!.rows.map((x) => x.name);
    expect(names[0]).toBe('a');
    expect(names[4]).not.toBe('b');
  });

  it('refuses every write while the machine is down, and a log begun on other settings', () => {
    const s = new Session(users(), 8);
    s.op({ op: 'crash' });
    expect(s.run("UPDATE users SET name = 'x' WHERE id = 1").error?.message).toMatch(/^The machine is down/);
    s.op({ op: 'recover' });
    const other = runQuery("UPDATE users SET name = 'x' WHERE id = 1", s.db, { ...s.options, bufferFrames: 4 }, { engineLog: loggedRun(s.log) });
    expect(other.error?.message).toMatch(/^The log began on a pool of 8 frames/);
  });

  it('changes nothing about a run with no log attached, or a SELECT with one', () => {
    const db = users();
    const plain = runQuery("UPDATE users SET name = 'x' WHERE id <= 2", db, DEFAULT_ENGINE_OPTIONS);
    expect(plain.engineLog).toBeUndefined();
    expect(plain.events.some((e) => e.stage === 'buffer' && (e.action === 'log' || e.action === 'flush'))).toBe(false);
    const log = openEngineLog(db, DEFAULT_ENGINE_OPTIONS, { steal: true, force: false });
    const select = runQuery('SELECT * FROM users', db, DEFAULT_ENGINE_OPTIONS, { engineLog: loggedRun(log) });
    expect(select.events.map((e) => e.label)).toEqual(runQuery('SELECT * FROM users', db, DEFAULT_ENGINE_OPTIONS).events.map((e) => e.label));
    expect(select.engineLog).toBeUndefined();
  });

  it('runs the optimal policy’s rehearsal logged, on a copy', () => {
    const db = users();
    const options = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 2, policy: 'optimal' as const };
    const log = openEngineLog(db, options, { steal: true, force: false });
    const r = runQuery('UPDATE users SET age = age + 1', db, options, { engineLog: loggedRun(log) });
    expect(r.error).toBeUndefined();
    expect(r.engineLog!.logBuffer.length + r.engineLog!.log.length).toBe(12);
    expect(log.log).toHaveLength(0);
  });

  it('logs a big table’s write under a 1,536 MB heap without a ceiling of its own', () => {
    const db = DATASETS.transactions.make();
    const options = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 8 };
    const log = openEngineLog(db, options, { steal: true, force: false });
    const r = runQuery('UPDATE transactions SET amount = amount + 1', db, options, { engineLog: loggedRun(log) });
    expect(r.error).toBeUndefined();
    expect(r.engineLog!.log.length + r.engineLog!.logBuffer.length).toBe(db.tables.transactions!.rows.length);
    const c = applyLogOp(r.engineLog!, { op: 'crash' }, options);
    const back = applyLogOp(c.log, { op: 'recover' }, options);
    expect(databaseOfLog(back.log).tables.transactions!.rows).toEqual(db.tables.transactions!.rows);
  });
});
