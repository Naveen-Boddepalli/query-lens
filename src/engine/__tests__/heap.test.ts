import { describe, expect, it } from 'vitest';
import {
  MAX_ROWS_PER_STATEMENT,
  SPARE_SLOTS,
  cellKey,
  databaseFromCells,
  heapFromCells,
  openHeap,
  pageOf,
  tableOfPage,
  writeSteps,
} from '../recovery/heap.ts';
import { runQuery } from '../runQuery.ts';
import { createAccountsDatabase } from '../seed.ts';
import { databaseCells, runWal } from '../recovery/wal.ts';
import type { WalStep } from '../recovery/wal.ts';
import type { Database } from '../types.ts';

const accounts = (n = 10) => createAccountsDatabase(n);
const run = (sql: string, db: Database) => {
  const r = runQuery(sql, db);
  if (r.error || !r.write) throw new Error(`not a write: ${sql}`);
  return r.write;
};

describe('the heap layout', () => {
  it('puts a row in a cell on the page the engine’s own layout gives it, and leaves spare slots after the last', () => {
    const { heap, pages } = openHeap(accounts(10), 4);
    expect(heap.tables.accounts).toMatchObject({ base: 1, slots: 10 + SPARE_SLOTS, nextRid: 10 });
    expect(pageOf(heap, 'accounts', 0)).toBe(1);
    expect(pageOf(heap, 'accounts', 3)).toBe(1);
    expect(pageOf(heap, 'accounts', 4)).toBe(2);
    expect(Object.keys(pages)).toHaveLength(Math.ceil((10 + SPARE_SLOTS) / 4));
    expect(pages[1]![cellKey('accounts', 0)]).toBe(JSON.stringify(accounts(10).tables.accounts!.rows[0]));
    // The last real row is slot 9; slot 10 is the first spare, empty.
    expect(pages[3]![cellKey('accounts', 10)]).toBeNull();
    expect(tableOfPage(heap, 2)).toBe('accounts');
    expect(tableOfPage(heap, 99)).toBeNull();
  });

  it('gives each table its own run of pages', () => {
    const db: Database = {
      tables: {
        ...accounts(5).tables,
        orders: { name: 'orders', columns: ['id'], rows: [{ id: 1 }, { id: 2 }] },
      },
    };
    const { heap } = openHeap(db, 4);
    expect(heap.tables.accounts!.base).toBe(1);
    expect(heap.tables.orders!.base).toBe(1 + Math.ceil((5 + SPARE_SLOTS) / 4));
  });

  it('reads the database back out of the cells it was laid out as', () => {
    const db = accounts(10);
    const { heap, pages } = openHeap(db, 4);
    const cells = Object.assign({}, ...Object.values(pages)) as Record<string, string | null>;
    const back = databaseFromCells(db, heap, cells);
    expect(back.tables.accounts!.rows).toEqual(db.tables.accounts!.rows);
  });
});

describe('a write as log steps', () => {
  it('an update is one set for each row it changed', () => {
    const db = accounts(10);
    const { heap } = openHeap(db, 4);
    const w = run('UPDATE accounts SET balance = 0 WHERE id <= 2', db);
    const out = writeSteps(heap, 'Q1', 'accounts', 'update', db.tables.accounts!.rows, w.rows);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.steps.map((s) => s.op)).toEqual(['begin', 'set', 'set']);
    expect(out.steps[1]).toMatchObject({ key: 'accounts#0' });
    expect(out.changed).toBe(2);
  });

  it('a delete tombstones the row and the rows after it keep their slots', () => {
    const db = accounts(10);
    const { heap } = openHeap(db, 4);
    const w = run('DELETE FROM accounts WHERE id = 3', db);
    const out = writeSteps(heap, 'Q1', 'accounts', 'delete', db.tables.accounts!.rows, w.rows);
    if (!out.ok) throw new Error(out.error);
    expect(out.steps[1]).toMatchObject({ key: 'accounts#2', value: null });
    expect(out.heap.tables.accounts!.rids).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('an insert takes the next spare slot, and runs out of them', () => {
    let db = accounts(2);
    let { heap } = openHeap(db, 4);
    for (let i = 0; i < SPARE_SLOTS; i += 1) {
      const w = run(`INSERT INTO accounts VALUES (${String(100 + i)}, 'x', 1)`, db);
      const out = writeSteps(heap, `Q${String(i)}`, 'accounts', 'insert', db.tables.accounts!.rows, w.rows);
      if (!out.ok) throw new Error(out.error);
      heap = out.heap;
      db = { tables: { accounts: { ...db.tables.accounts!, rows: w.rows } } };
      expect(out.steps[1]).toMatchObject({ key: cellKey('accounts', 2 + i) });
    }
    const w = run("INSERT INTO accounts VALUES (200, 'x', 1)", db);
    const out = writeSteps(heap, 'Qn', 'accounts', 'insert', db.tables.accounts!.rows, w.rows);
    expect(out).toMatchObject({ ok: false });
  });

  it('refuses a statement that is out of step with the heap, or too big for the log', () => {
    const db = accounts(100);
    const { heap } = openHeap(db, 4);
    expect(writeSteps(heap, 'Q1', 'accounts', 'update', [], []).ok).toBe(false);
    const w = run('UPDATE accounts SET balance = balance + 1', db);
    const big = writeSteps(heap, 'Q1', 'accounts', 'update', db.tables.accounts!.rows, w.rows);
    expect(big).toMatchObject({ ok: false });
    if (!big.ok) expect(big.error).toContain(String(MAX_ROWS_PER_STATEMENT));
    expect(writeSteps(heap, 'Q1', 'nothing', 'update', [], []).ok).toBe(false);
  });
});

describe('through the machine', () => {
  it('a crash and a recovery give back exactly the rows of the statements that committed', () => {
    const db0 = accounts(10);
    const { heap: h0, pages } = openHeap(db0, 4);
    // Q1 commits an update; Q2 deletes a row and does not commit; the pool is lost.
    const w1 = run('UPDATE accounts SET balance = 1 WHERE id = 2', db0);
    const s1 = writeSteps(h0, 'Q1', 'accounts', 'update', db0.tables.accounts!.rows, w1.rows);
    if (!s1.ok) throw new Error(s1.error);
    const db1: Database = { tables: { accounts: { ...db0.tables.accounts!, rows: w1.rows } } };
    const w2 = run('DELETE FROM accounts WHERE id = 5', db1);
    const s2 = writeSteps(s1.heap, 'Q2', 'accounts', 'delete', db1.tables.accounts!.rows, w2.rows);
    if (!s2.ok) throw new Error(s2.error);
    const script: WalStep[] = [
      ...s1.steps,
      { op: 'commit', txn: 'Q1' },
      ...s2.steps,
      { op: 'write-page', page: 2 },
      { op: 'crash' },
      { op: 'recover' },
    ];
    const result = runWal(script, { pages, frames: 4, maxSteps: 100 });
    expect(result.steps.every((s) => s.error === undefined)).toBe(true);
    const recovered = databaseFromCells(db0, h0, databaseCells(result.final));
    const expected = run('UPDATE accounts SET balance = 1 WHERE id = 2', db0).rows;
    expect(recovered.tables.accounts!.rows).toEqual(expected);
    expect(recovered.tables.accounts!.rows).toHaveLength(10);
    // And the heap carries on from the recovered rows.
    const carried = heapFromCells(h0, databaseCells(result.final));
    expect(carried.tables.accounts!.rids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(carried.tables.accounts!.nextRid).toBe(10);
  });
});
