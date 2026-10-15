import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
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

  it('rejects an ORDER BY on a column the groups do not have one value of', () => {
    const out = run('SELECT age, COUNT(*) FROM users GROUP BY age ORDER BY name');
    expect(out.error?.message).toMatch(/`name` is not aggregated and is not in the GROUP BY list/);
  });

  it('rejects an aggregate in ORDER BY when nothing groups the rows', () => {
    expect(run('SELECT name FROM users ORDER BY COUNT(*)').error?.message).toMatch(/needs a GROUP BY or an aggregate/);
  });

  it('checks the column an ORDER BY aggregate reads', () => {
    expect(run('SELECT age FROM users GROUP BY age ORDER BY SUM(nope)').error?.message).toMatch(/no column called `nope`/);
  });
});

describe('ORDER BY over groups (plan.md §26 Feature 1, slice a)', () => {
  const ages = () => db().tables.users!.rows.map((r) => r.age as number);
  const countsByAge = () => {
    const m = new Map<number, number>();
    for (const a of ages()) m.set(a, (m.get(a) ?? 0) + 1);
    return m;
  };

  it.each(['hash', 'sort'] as const)('sorts the groups by a grouped column, either way (%s aggregate)', (aggregateStrategy) => {
    const options = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy };
    const asc = runQuery('SELECT age, COUNT(*) FROM users GROUP BY age ORDER BY age', db(), options).rows.map((r) => r.age);
    expect(asc).toEqual([...countsByAge().keys()].sort((a, b) => a - b));
    const desc = runQuery('SELECT age, COUNT(*) FROM users GROUP BY age ORDER BY age DESC', db(), options).rows.map((r) => r.age);
    expect(desc).toEqual([...asc].reverse());
  });

  it('sorts by an aggregate, and a LIMIT then keeps the top groups', () => {
    const { rows } = run('SELECT age, COUNT(*) FROM users GROUP BY age ORDER BY COUNT(*) DESC LIMIT 3');
    const counts = rows.map((r) => r['COUNT(*)'] as number);
    expect(counts).toEqual([...countsByAge().values()].sort((a, b) => b - a).slice(0, 3));
  });

  it('sorts by an aggregate nobody selected — the aggregate computes it anyway, and Project drops it', () => {
    // Groups arrive a, b, c and hold 1, 2 and 3 rows, so only a real count puts them in the opposite order.
    const t = { tables: { t: { name: 't', columns: ['k'], rows: ['a', 'b', 'b', 'c', 'c', 'c'].map((k) => ({ k })) } } };
    for (const aggregateStrategy of ['hash', 'sort'] as const) {
      const { rows } = runQuery('SELECT k FROM t GROUP BY k ORDER BY COUNT(*) DESC', t, { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy });
      expect(rows).toEqual([{ k: 'c' }, { k: 'b' }, { k: 'a' }]);
    }
  });

  it('puts a NULL group last ascending and first descending, as a plain ORDER BY does', () => {
    const t = { tables: { t: { name: 't', columns: ['k'], rows: [{ k: 2 }, { k: null }, { k: 1 }, { k: 2 }] } } };
    expect(runQuery('SELECT k, COUNT(*) FROM t GROUP BY k ORDER BY k', t).rows.map((r) => r.k)).toEqual([1, 2, null]);
    expect(runQuery('SELECT k, COUNT(*) FROM t GROUP BY k ORDER BY k DESC', t).rows.map((r) => r.k)).toEqual([null, 2, 1]);
  });

  it('sorts what HAVING kept', () => {
    const { rows, error } = run('SELECT age, COUNT(*) FROM users GROUP BY age HAVING COUNT(*) > 1 ORDER BY COUNT(*)');
    expect(error).toBeUndefined();
    const counts = rows.map((r) => r['COUNT(*)'] as number);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.every((c) => c > 1)).toBe(true);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('plans the Sort above the aggregate, under the Project', () => {
    const { events } = run('SELECT age, COUNT(*) FROM users GROUP BY age ORDER BY COUNT(*) DESC');
    const plan = [...events].reverse().find((e) => e.stage === 'plan')!;
    expect(JSON.stringify(plan.planTree)).toMatch(/"op":"Project".*"op":"Sort".*"op":"HashAggregate".*"op":"SeqScan"/);
  });

  it('gives the aggregate’s own sort and the ORDER BY sort separate scratch pages', () => {
    const options = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' as const, bufferFrames: 3 };
    const { events, rows } = runQuery('SELECT name, COUNT(*) FROM users GROUP BY name ORDER BY COUNT(*) DESC', db(), options);
    expect(rows.length).toBeGreaterThan(1);
    const firstSort = events.findIndex((e) => e.stage === 'execute' && e.op === 'Sort');
    const firstAggregate = events.findIndex((e) => e.stage === 'execute' && e.op === 'SortAggregate');
    expect(firstAggregate).toBeGreaterThan(-1);
    expect(firstSort).toBeGreaterThan(firstAggregate);
    const heapAndIndexPages = Math.max(
      ...events.slice(0, firstAggregate).flatMap((e) => (e.stage === 'buffer' && 'pageId' in e ? [e.pageId] : [])),
    );
    const scratch = (from: number, to: number) =>
      new Set(events.slice(from, to).flatMap((e) => (e.stage === 'buffer' && 'pageId' in e && e.pageId > heapAndIndexPages ? [e.pageId] : [])));
    const aggregatePages = scratch(firstAggregate, firstSort);
    const sortPages = scratch(firstSort, events.length);
    expect(aggregatePages.size).toBeGreaterThan(0);
    expect(sortPages.size).toBeGreaterThan(0);
    expect([...sortPages].filter((p) => aggregatePages.has(p))).toEqual([]);
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
