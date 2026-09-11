import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import type { StepEvent } from '../types.ts';

const db = () => createSeedDatabase();
const run = (sql: string) => runQuery(sql, db());

describe('Aggregates — correctness', () => {
  it('COUNT(*) with no GROUP BY counts every row, in one row', () => {
    const { rows } = run('SELECT COUNT(*) FROM users');
    expect(rows).toEqual([{ 'COUNT(*)': 48 }]);
  });

  it('COUNT(col) ignores NULLs; COUNT(*) does not', () => {
    const t = { tables: { t: { name: 't', columns: ['id', 'val'], rows: [{ id: 1, val: 10 }, { id: 2, val: null }] } } };
    expect(runQuery('SELECT COUNT(val) FROM t', t).rows).toEqual([{ 'COUNT(val)': 1 }]);
    expect(runQuery('SELECT COUNT(*) FROM t', t).rows).toEqual([{ 'COUNT(*)': 2 }]);
  });

  it('SUM, AVG, MIN, MAX agree with a manual computation over the real seed data', () => {
    const ages = db().tables.users!.rows.map((r) => r.age as number);
    const sum = ages.reduce((a, b) => a + b, 0);
    const { rows } = run('SELECT SUM(age), AVG(age), MIN(age), MAX(age) FROM users');
    expect(rows).toEqual([
      { 'SUM(age)': sum, 'AVG(age)': sum / ages.length, 'MIN(age)': Math.min(...ages), 'MAX(age)': Math.max(...ages) },
    ]);
  });

  it('SUM/AVG over an all-NULL column are NULL, not 0 or NaN', () => {
    const t = { tables: { t: { name: 't', columns: ['id', 'val'], rows: [{ id: 1, val: null }, { id: 2, val: null }] } } };
    expect(runQuery('SELECT SUM(val), AVG(val), COUNT(val) FROM t', t).rows).toEqual([
      { 'SUM(val)': null, 'AVG(val)': null, 'COUNT(val)': 0 },
    ]);
  });

  it('GROUP BY produces one row per distinct value, each with its own COUNT(*)', () => {
    const orders = DATASETS.orders.make();
    const { rows } = runQuery('SELECT status, COUNT(*) FROM orders GROUP BY status', orders);
    const expected = new Map<string, number>();
    for (const r of orders.tables.orders!.rows) {
      expected.set(r.status as string, (expected.get(r.status as string) ?? 0) + 1);
    }
    expect(rows).toHaveLength(expected.size);
    for (const row of rows) expect(row['COUNT(*)']).toBe(expected.get(row.status as string));
  });

  it('GROUP BY with no aggregate function just deduplicates', () => {
    const orders = DATASETS.orders.make();
    const { rows } = runQuery('SELECT status FROM orders GROUP BY status', orders);
    const distinct = new Set(orders.tables.orders!.rows.map((r) => r.status));
    expect(rows.map((r) => r.status).sort()).toEqual([...distinct].sort());
  });

  it('WHERE filters before GROUP BY sees the rows', () => {
    const { rows } = run('SELECT id, COUNT(*) FROM users WHERE age > 60 GROUP BY id');
    const overAge = db().tables.users!.rows.filter((r) => (r.age as number) > 60);
    expect(rows).toHaveLength(overAge.length);
    expect(rows.every((r) => r['COUNT(*)'] === 1)).toBe(true); // id is unique, so every group has exactly 1 row
  });

  it('LIMIT caps the grouped result, same as any other row source', () => {
    const orders = DATASETS.orders.make();
    const { rows } = runQuery('SELECT status, COUNT(*) FROM orders GROUP BY status LIMIT 1', orders);
    expect(rows).toHaveLength(1);
  });

  it('an empty table with no GROUP BY still produces one row — COUNT(*) of nothing is 0, not absent', () => {
    const t = { tables: { t: { name: 't', columns: ['id'], rows: [] } } };
    expect(runQuery('SELECT COUNT(*) FROM t', t).rows).toEqual([{ 'COUNT(*)': 0 }]);
  });

  it('an empty table with GROUP BY produces zero rows — there is nothing to group', () => {
    const t = { tables: { t: { name: 't', columns: ['id'], rows: [] } } };
    expect(runQuery('SELECT id, COUNT(*) FROM t GROUP BY id', t).rows).toEqual([]);
  });

  it('index-selection still fires for an equality WHERE on a GROUP BY query', () => {
    const { events, rows } = run('SELECT id, COUNT(*) FROM users WHERE id = 5 GROUP BY id');
    expect(rows).toEqual([{ id: 5, 'COUNT(*)': 1 }]);
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['predicate-pushdown', 'index-selection']);
  });

  it('works on a table with no index at all', () => {
    const t = { tables: { t: { name: 't', columns: ['id', 'grp'], rows: [{ id: 1, grp: 'a' }, { id: 2, grp: 'a' }, { id: 3, grp: 'b' }] } } };
    const { rows } = runQuery('SELECT grp, COUNT(*) FROM t GROUP BY grp', t);
    expect(rows.sort((a, b) => (a.grp! < b.grp! ? -1 : 1))).toEqual([
      { grp: 'a', 'COUNT(*)': 2 },
      { grp: 'b', 'COUNT(*)': 1 },
    ]);
  });
});

describe('Aggregates — errors, same discipline as SELECT', () => {
  it('rejects an unknown table', () => {
    const out = run('SELECT COUNT(*) FROM widgets');
    expect(out.error?.message).toMatch(/no table called `widgets`/);
  });

  it('rejects an unknown column inside an aggregate', () => {
    const out = run('SELECT SUM(bogus) FROM users');
    expect(out.error?.message).toMatch(/no column called `bogus`/);
  });

  it('rejects an unknown column in GROUP BY', () => {
    const out = run('SELECT COUNT(*) FROM users GROUP BY bogus');
    expect(out.error?.message).toMatch(/no column called `bogus`/);
  });

  it('rejects a plain column mixed with an aggregate and no GROUP BY, at parse time', () => {
    const out = run('SELECT name, COUNT(*) FROM users');
    expect(out.error?.message).toMatch(/`name` is not aggregated/);
  });

  it('rejects a plain column that is not in the GROUP BY list, at parse time', () => {
    const out = run('SELECT name, age, COUNT(*) FROM users GROUP BY name');
    expect(out.error?.message).toMatch(/`age` is not aggregated and is not in the GROUP BY list/);
  });

  it('rejects SELECT * combined with GROUP BY, at parse time', () => {
    const out = run('SELECT * FROM users GROUP BY age');
    expect(out.error?.message).toMatch(/SELECT \*.*GROUP BY/);
  });

  it('rejects `*` for anything but COUNT, at parse time', () => {
    const out = run('SELECT SUM(*) FROM users');
    expect(out.error?.message).toMatch(/SUM\(\*\).*not supported/);
  });

  it('rejects ORDER BY combined with GROUP BY, at parse time', () => {
    const out = run('SELECT name, COUNT(*) FROM users GROUP BY name ORDER BY name');
    expect(out.error?.message).toMatch(/ORDER BY with GROUP BY/);
  });
});

describe('Aggregates — the pipeline', () => {
  it('narrates a HashAggregate execute stage, above the scan', () => {
    const { events } = run('SELECT COUNT(*) FROM users');
    const hashAgg = events.filter((e) => e.stage === 'execute' && e.op === 'HashAggregate');
    expect(hashAgg.length).toBeGreaterThan(0);
  });

  it('ends with a result event whose rows are the aggregated rows', () => {
    const { events, rows } = run('SELECT COUNT(*) FROM users');
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('is deterministic — the same aggregate query twice gives byte-identical traces', () => {
    const a = run('SELECT id, COUNT(*) FROM users GROUP BY id');
    const b = run('SELECT id, COUNT(*) FROM users GROUP BY id');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('SELECT id, COUNT(*) FROM users GROUP BY id');
    expect(structuredClone(events)).toEqual(events);
  });

  it('does not touch the planner/optimizer stages differently than an ordinary WHERE-less SELECT', () => {
    const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
    expect(stages(run('SELECT id, COUNT(*) FROM users GROUP BY id').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });
});
