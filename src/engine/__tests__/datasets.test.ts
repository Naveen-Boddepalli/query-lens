import { describe, expect, it } from 'vitest';
import { DATASETS, DATASET_IDS, DEFAULT_DATASET, isDatasetId } from '../datasets.ts';
import { runQuery } from '../runQuery.ts';
import { buildHeap, buildIndex, height } from '../index.ts';
import type { SqlValue } from '../types.ts';

/** The real tree's own height for `table`'s `id` index — the same B+Tree the engine builds to run a query. */
function treeHeightOf(tableName: 'orders' | 'employees' | 'transactions'): number {
  const db = DATASETS[tableName].make();
  const table = db.tables[tableName]!;
  const heap = buildHeap(table, 4);
  return height(buildIndex(heap, 'id'));
}

describe('preset datasets', () => {
  it('the default is a member of the id list', () => {
    expect(DATASET_IDS).toContain(DEFAULT_DATASET);
  });

  it.each([...DATASET_IDS])('%s builds a database whose one table matches its declared name', (id) => {
    const spec = DATASETS[id];
    const db = spec.make();
    expect(Object.keys(db.tables)).toEqual([spec.table]);
    const table = db.tables[spec.table]!;
    expect(table.name).toBe(spec.table);
    expect(table.rows.length).toBeGreaterThan(0);
    // Every row has exactly the declared columns.
    for (const row of table.rows) {
      expect(Object.keys(row).sort()).toEqual([...table.columns].sort());
    }
    for (const column of table.indexedColumns ?? []) expect(table.columns).toContain(column);
  });

  it.each([...DATASET_IDS])('a point lookup on %s runs without an engine error', (id) => {
    const spec = DATASETS[id];
    const result = runQuery(`SELECT * FROM ${spec.table} WHERE id = 1;`, spec.make());
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
  });

  it('the logins skew is real: `blocked` is a small minority', () => {
    const rows = DATASETS.logins.make().tables.logins!.rows;
    const blocked = rows.filter((r) => r.status === 'blocked').length;
    expect(blocked).toBeGreaterThan(0);
    expect(blocked * 4).toBeLessThan(rows.length); // < 25% — a clear minority
  });

  it('the employees correlation is real: department determines office, with no exceptions', () => {
    const rows = DATASETS.employees.make().tables.employees!.rows;
    const officeOf = new Map<SqlValue, SqlValue>();
    for (const row of rows) {
      const department = row.department ?? null;
      const office = row.office ?? null;
      const seen = officeOf.get(department);
      if (seen === undefined) officeOf.set(department, office);
      else expect(office, `department ${String(department)} has both ${String(seen)} and ${String(office)}`).toBe(seen);
    }
    expect(officeOf.size).toBeGreaterThan(20); // enough distinct departments for `department`×`office` to badly underestimate
  });

  it('orders is large enough to force real buffer eviction on a scan', () => {
    const db = DATASETS.orders.make();
    // 8 frames, 4 rows/page (DEFAULT_ENGINE_OPTIONS) → needs > 32 rows to evict.
    expect(db.tables.orders!.rows.length).toBeGreaterThan(32);
    const scan = runQuery('SELECT * FROM orders WHERE total > 500;', db);
    expect(scan.error).toBeUndefined();
    expect(scan.events.some((e) => e.stage === 'buffer' && e.action === 'evict')).toBe(true);
  });

  it('transactions has a genuinely taller B+Tree than every other preset (plan.md §25.4 C6)', () => {
    expect(treeHeightOf('transactions')).toBeGreaterThan(treeHeightOf('employees'));
    expect(treeHeightOf('transactions')).toBeGreaterThan(treeHeightOf('orders'));
  });

  it('transactions evicts far harder than orders on a comparable full-table scan', () => {
    const ordersEvictions = runQuery(
      'SELECT * FROM orders WHERE total > 500;',
      DATASETS.orders.make(),
    ).events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length;
    const transactionsEvictions = runQuery(
      'SELECT * FROM transactions WHERE amount > 4500;',
      DATASETS.transactions.make(),
    ).events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length;
    expect(transactionsEvictions).toBeGreaterThan(ordersEvictions * 5);
  });

  it('a point lookup and a narrow indexed range on transactions still stay a short trace', () => {
    const db = DATASETS.transactions.make();
    const point = runQuery('SELECT * FROM transactions WHERE id = 1500;', db);
    const range = runQuery('SELECT * FROM transactions WHERE id BETWEEN 1500 AND 1520;', db);
    expect(point.events.length).toBeLessThan(100);
    expect(range.events.length).toBeLessThan(300);
    expect(range.rows).toHaveLength(21);
  });

  it('isDatasetId is a total guard', () => {
    expect(isDatasetId('users')).toBe(true);
    expect(isDatasetId('lineitem')).toBe(false);
    expect(isDatasetId(null)).toBe(false);
    expect(isDatasetId(42)).toBe(false);
  });
});
