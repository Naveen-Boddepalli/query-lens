import { describe, expect, it } from 'vitest';
import { DATASETS, DATASET_IDS, DEFAULT_DATASET, isDatasetId } from '../datasets.ts';
import { runQuery } from '../runQuery.ts';

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

  it('orders is large enough to force real buffer eviction on a scan', () => {
    const db = DATASETS.orders.make();
    // 8 frames, 4 rows/page (DEFAULT_ENGINE_OPTIONS) → needs > 32 rows to evict.
    expect(db.tables.orders!.rows.length).toBeGreaterThan(32);
    const scan = runQuery('SELECT * FROM orders WHERE total > 500;', db);
    expect(scan.error).toBeUndefined();
    expect(scan.events.some((e) => e.stage === 'buffer' && e.action === 'evict')).toBe(true);
  });

  it('isDatasetId is a total guard', () => {
    expect(isDatasetId('users')).toBe(true);
    expect(isDatasetId('lineitem')).toBe(false);
    expect(isDatasetId(null)).toBe(false);
    expect(isDatasetId(42)).toBe(false);
  });
});
