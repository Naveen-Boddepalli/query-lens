import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database } from '../types.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { parseStatement } from '../parser/index.ts';
import { rootEstimate } from '../planner/cost.ts';

const db = () => createSeedDatabase();
const SORT_OPTS = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' as const };
const run = (sql: string, database: Database = db()) => runQuery(sql, database, SORT_OPTS);
const runHash = (sql: string, database: Database = db()) => runQuery(sql, database, DEFAULT_ENGINE_OPTIONS);

/** Order-independent row comparison — a sort aggregate's groups can come out in a different order than a hash aggregate's. */
const sortedByJson = (rows: readonly object[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('SortAggregate — parity with HashAggregate', () => {
  it('COUNT(*) with no GROUP BY counts every row, in one row', () => {
    expect(run('SELECT COUNT(*) FROM users').rows).toEqual([{ 'COUNT(*)': 48 }]);
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
    expect(run('SELECT SUM(val), AVG(val), COUNT(val) FROM t', t).rows).toEqual([
      { 'SUM(val)': null, 'AVG(val)': null, 'COUNT(val)': 0 },
    ]);
  });

  it('GROUP BY produces exactly the same groups as HashAggregate, order aside', () => {
    const orders = DATASETS.orders.make();
    const sortRows = run('SELECT status, COUNT(*) FROM orders GROUP BY status', orders).rows;
    const hashRows = runHash('SELECT status, COUNT(*) FROM orders GROUP BY status', orders).rows;
    expect(sortedByJson(sortRows)).toEqual(sortedByJson(hashRows));
  });

  it('GROUP BY on more than one column groups by the full composite key, same as HashAggregate', () => {
    const orders = DATASETS.orders.make();
    const sql = 'SELECT status, customer, COUNT(*) FROM orders GROUP BY status, customer';
    expect(sortedByJson(run(sql, orders).rows)).toEqual(sortedByJson(runHash(sql, orders).rows));
  });

  it('WHERE filters before GROUP BY sees the rows', () => {
    const { rows } = run('SELECT id, COUNT(*) FROM users WHERE age > 60 GROUP BY id');
    const overAge = db().tables.users!.rows.filter((r) => (r.age as number) > 60);
    expect(rows).toHaveLength(overAge.length);
    expect(rows.every((r) => r['COUNT(*)'] === 1)).toBe(true);
  });

  it('LIMIT caps the grouped result, same as any other row source', () => {
    const orders = DATASETS.orders.make();
    expect(run('SELECT status, COUNT(*) FROM orders GROUP BY status LIMIT 1', orders).rows).toHaveLength(1);
  });

  it('an empty table with no GROUP BY still produces one row', () => {
    const t = { tables: { t: { name: 't', columns: ['id'], rows: [] } } };
    expect(run('SELECT COUNT(*) FROM t', t).rows).toEqual([{ 'COUNT(*)': 0 }]);
  });

  it('an empty table with GROUP BY produces zero rows', () => {
    const t = { tables: { t: { name: 't', columns: ['id'], rows: [] } } };
    expect(run('SELECT id, COUNT(*) FROM t GROUP BY id', t).rows).toEqual([]);
  });

  it('index-selection still fires for an equality WHERE on a GROUP BY query', () => {
    const { events, rows } = run('SELECT id, COUNT(*) FROM users WHERE id = 5 GROUP BY id');
    expect(rows).toEqual([{ id: 5, 'COUNT(*)': 1 }]);
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['predicate-pushdown', 'index-selection']);
  });
});

describe('SortAggregate — the pipeline', () => {
  it('narrates a SortAggregate execute stage, above the scan', () => {
    const { events } = run('SELECT COUNT(*) FROM users');
    const sortAgg = events.filter((e) => e.stage === 'execute' && e.op === 'SortAggregate');
    expect(sortAgg.length).toBeGreaterThan(0);
  });

  it('never emits a HashAggregate event when the sort strategy is forced', () => {
    const { events } = run('SELECT status, COUNT(*) FROM orders GROUP BY status', DATASETS.orders.make());
    expect(events.some((e) => e.stage === 'execute' && e.op === 'HashAggregate')).toBe(false);
  });

  it('spills through the real buffer pool — unlike a HashAggregate, which never writes a page', () => {
    const orders = DATASETS.orders.make();
    const sortEvents = run('SELECT status, COUNT(*) FROM orders GROUP BY status', orders).events;
    const hashEvents = runHash('SELECT status, COUNT(*) FROM orders GROUP BY status', orders).events;

    const writes = (events: typeof sortEvents) =>
      events.filter((e) => e.stage === 'buffer' && e.action === 'write').length;

    expect(writes(sortEvents)).toBeGreaterThan(0);
    expect(writes(hashEvents)).toBe(0);
  });

  it('ends with a result event whose rows are the aggregated rows', () => {
    const { events, rows } = run('SELECT COUNT(*) FROM users');
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('is deterministic — the same query twice gives byte-identical traces', () => {
    const a = run('SELECT id, COUNT(*) FROM users GROUP BY id');
    const b = run('SELECT id, COUNT(*) FROM users GROUP BY id');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('SELECT id, COUNT(*) FROM users GROUP BY id');
    expect(structuredClone(events)).toEqual(events);
  });

  it('defaults to HashAggregate when aggregateStrategy is not set — no behaviour change for every existing caller', () => {
    const { events } = runQuery('SELECT COUNT(*) FROM users', db());
    expect(events.some((e) => e.stage === 'execute' && e.op === 'HashAggregate')).toBe(true);
    expect(events.some((e) => e.stage === 'execute' && e.op === 'SortAggregate')).toBe(false);
  });
});

describe('SortAggregate — plan and cost', () => {
  it('buildPlan produces a SortAggregate node when asked, HashAggregate otherwise', () => {
    const parsed = parseStatement('SELECT status, COUNT(*) FROM orders GROUP BY status');
    if (!parsed.ok || parsed.ast.kind !== 'select') throw new Error('expected a parsed SELECT');
    const ast = parsed.ast;
    const aggOp = (strategy?: 'hash' | 'sort') => {
      const plan = buildPlan(ast, strategy);
      if (plan.op !== 'Project') throw new Error('expected a Project at the root');
      return plan.child.op;
    };
    expect(aggOp('sort')).toBe('SortAggregate');
    expect(aggOp('hash')).toBe('HashAggregate');
    expect(aggOp()).toBe('HashAggregate');
  });

  it('estimates the same output row count as HashAggregate, but more pages for its own spill', () => {
    const parsed = parseStatement('SELECT status, COUNT(*) FROM orders GROUP BY status');
    if (!parsed.ok || parsed.ast.kind !== 'select') throw new Error('expected a parsed SELECT');
    const ast = parsed.ast;
    const orders = DATASETS.orders.make().tables.orders!;
    const sortPlan = buildPlan(ast, 'sort');
    const hashPlan = buildPlan(ast, 'hash');
    const sortEst = rootEstimate(sortPlan, orders, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    const hashEst = rootEstimate(hashPlan, orders, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    expect(sortEst.estRows).toBe(hashEst.estRows);
    expect(sortEst.estPages).toBeGreaterThan(hashEst.estPages);
  });
});
