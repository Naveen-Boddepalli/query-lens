import { describe, expect, it } from 'vitest';
import { DATASETS } from '../datasets.ts';
import { runQuery } from '../runQuery.ts';
import { cutOf, TRACE_BUDGET } from '../trace.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, RunResult } from '../types.ts';
import { stateAt } from '../viewState.ts';
import type { DatasetId } from '../datasets.ts';

/**
 * plan.md §28.5 I1: a trace keeps at most `TRACE_BUDGET` steps and its result step. The run itself is not cut short —
 * its rows are the same — and the counts at the last step are the whole run's, because the result step carries the
 * totals of the steps it dropped. Each case here runs one query twice, once with a budget small enough to cut it and
 * once without, and holds every number a reader sees at the end to be the same.
 */

const CASES: { dataset: DatasetId; sql: string; options?: Partial<EngineOptions> }[] = [
  { dataset: 'users', sql: 'SELECT * FROM users WHERE age > 30' },
  { dataset: 'transactions', sql: 'SELECT * FROM transactions WHERE amount > 4500' },
  { dataset: 'shop', sql: 'SELECT customers.name, COUNT(orders.id) FROM customers LEFT JOIN orders ON orders.customerId = customers.id GROUP BY customers.name' },
  { dataset: 'shop', sql: 'SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT * FROM orders o WHERE o.customerId = c.id)' },
  { dataset: 'shop', sql: 'SELECT city FROM customers UNION SELECT name FROM products ORDER BY city' },
  { dataset: 'orders', sql: 'SELECT * FROM orders WHERE total > 500', options: { policy: 'clock', bufferFrames: 3 } },
  { dataset: 'orders', sql: 'SELECT * FROM orders WHERE total > 500', options: { policy: 'optimal', bufferFrames: 3 } },
  { dataset: 'users', sql: "UPDATE users SET age = age + 1 WHERE name LIKE '%a%'" },
];

const run = (c: (typeof CASES)[number], traceBudget?: number): RunResult => {
  const options = { ...DEFAULT_ENGINE_OPTIONS, ...c.options };
  return runQuery(c.sql, DATASETS[c.dataset].make(), options, traceBudget === undefined ? {} : { traceBudget });
};

const lastState = (r: RunResult, c: (typeof CASES)[number]) =>
  stateAt(r.events, r.events.length, { ...DEFAULT_ENGINE_OPTIONS, ...c.options });

describe('a trace past its ceiling', () => {
  for (const c of CASES) {
    const label = `${c.sql.slice(0, 50)}${c.options?.policy ? ` (${c.options.policy})` : ''}`;

    it(`keeps its first steps and its result step: ${label}`, () => {
      const whole = run(c);
      const budget = Math.floor(whole.events.length / 3);
      const cut = run(c, budget);
      expect(whole.error).toBeUndefined();
      expect(cutOf(whole.events)).toBeUndefined();

      expect(cut.events).toHaveLength(budget + 1);
      expect(cut.events.map((e) => e.id)).toEqual(cut.events.map((_, i) => i));
      // The steps it keeps are the run's own first steps, word for word.
      expect(cut.events.slice(0, budget).map((e) => e.label)).toEqual(whole.events.slice(0, budget).map((e) => e.label));
      const last = cut.events.at(-1)!;
      expect(last.stage).toBe('result');
      expect(cutOf(cut.events)).toMatchObject({ kept: budget, total: whole.events.length - 1 });
      expect(last.label).toContain(`took ${whole.events.length.toLocaleString('en')} steps`);
    });

    it(`ends on the whole run's rows and counts: ${label}`, () => {
      const whole = run(c);
      const cut = run(c, Math.floor(whole.events.length / 3));
      expect(cut.rows).toEqual(whole.rows);
      expect(cut.write).toEqual(whole.write);
      const [a, b] = [lastState(cut, c), lastState(whole, c)];
      expect(a.bufferStats).toEqual(b.bufferStats);
      expect(a.locksTaken).toBe(b.locksTaken);
      expect(a.operators).toEqual(b.operators);
      expect(a.rows).toEqual(b.rows);
    });
  }

  it('is cut only when a step before the result does not fit: the result step never counts against it', () => {
    const c = CASES[0]!;
    const n = run(c).events.length;
    expect(cutOf(run(c, n).events)).toBeUndefined();
    expect(cutOf(run(c, n - 1).events)).toBeUndefined();
    expect(cutOf(run(c, n - 2).events)).toMatchObject({ kept: n - 2, total: n - 1 });
  });

  it('leaves EXPLAIN ANALYZE’s actual rows and buffer counts as they are', () => {
    for (const c of CASES.filter((x) => x.sql.startsWith('SELECT'))) {
      const sql = `EXPLAIN ANALYZE ${c.sql}`;
      const whole = runQuery(sql, DATASETS[c.dataset].make(), { ...DEFAULT_ENGINE_OPTIONS, ...c.options });
      const cut = runQuery(sql, DATASETS[c.dataset].make(), { ...DEFAULT_ENGINE_OPTIONS, ...c.options }, { traceBudget: 20 });
      expect(cut.rows, sql).toEqual(whole.rows);
      expect(cutOf(cut.events), sql).toBeDefined();
      expect(lastState(cut, c).bufferStats, sql).toEqual(lastState(whole, c).bufferStats);
    }
  });

  it('leaves plain EXPLAIN’s counts at zero: it keeps no step of the run, so none of its totals', () => {
    const r = runQuery('EXPLAIN SELECT * FROM transactions WHERE amount > 4500', DATASETS.transactions.make(), DEFAULT_ENGINE_OPTIONS, { traceBudget: 20 });
    expect(cutOf(r.events)).toBeUndefined();
    expect(stateAt(r.events, r.events.length, DEFAULT_ENGINE_OPTIONS).bufferStats.misses).toBe(0);
  });

  it('does not change what the optimal policy evicts: its rehearsal watches every read, kept or not', () => {
    const c = CASES.find((x) => x.options?.policy === 'optimal')!;
    for (const budget of [0, 5, 50]) {
      expect(lastState(run(c, budget), c).bufferStats, String(budget)).toEqual(lastState(run(c), c).bufferStats);
    }
  });

  it('is far above every preset’s own trace', () => {
    // The largest preset trace (a full scan of `transactions`) measured 9,749 steps when the budget was set.
    const biggest = runQuery('SELECT * FROM transactions', DATASETS.transactions.make(), DEFAULT_ENGINE_OPTIONS);
    expect(cutOf(biggest.events)).toBeUndefined();
    expect(biggest.events.length * 10).toBeLessThan(TRACE_BUDGET);
  });
});
