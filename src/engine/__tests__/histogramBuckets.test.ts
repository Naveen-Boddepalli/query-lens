/** plan.md §27.5 T5 — `ANALYZE … WITH n BUCKETS`, and what the bucket count does to a range estimate. */

import { describe, expect, it } from 'vitest';
import { DATASETS } from '../datasets.ts';
import { finalPlan } from '../explain.ts';
import { bucketSweep, rangeEstimate, rowsInRange } from '../histogramStudy.ts';
import { parseStatement } from '../parser/index.ts';
import { runQuery } from '../runQuery.ts';
import { DEFAULT_HISTOGRAM_BUCKETS } from '../stats.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, PlanNode } from '../types.ts';

const transactions = (): Database => DATASETS.transactions.make();

describe('ANALYZE … WITH n BUCKETS (plan.md §27.5 T5)', () => {
  it('parses a bucket count, in any case, and leaves it out when absent', () => {
    const withCount = parseStatement('analyze transactions with 20 buckets;');
    expect(withCount.ok && withCount.ast.kind === 'analyze' && withCount.ast.buckets).toBe(20);
    const plain = parseStatement('ANALYZE transactions');
    expect(plain.ok && plain.ast.kind === 'analyze' && plain.ast.buckets).toBeUndefined();
  });

  it('refuses a count outside 1 to 100, a fraction, a word, and a missing BUCKETS', () => {
    const error = (sql: string) => {
      const r = parseStatement(sql);
      return r.ok ? null : r.error.message;
    };
    expect(error('ANALYZE transactions WITH 0 BUCKETS')).toBe('A histogram has between 1 and 100 buckets, not 0.');
    expect(error('ANALYZE transactions WITH 101 BUCKETS')).toBe('A histogram has between 1 and 100 buckets, not 101.');
    expect(error('ANALYZE transactions WITH 2.5 BUCKETS')).toMatch(/Expected a whole number of buckets after WITH/);
    expect(error('ANALYZE transactions WITH many BUCKETS')).toMatch(/Expected a whole number of buckets after WITH/);
    expect(error('ANALYZE transactions WITH 20')).toMatch(/Expected BUCKETS after the bucket count/);
    expect(error('ANALYZE transactions WITH 20 BUCKETS extra')).toMatch(/after the end of the query/);
  });

  it('builds that many buckets, and the default without it', () => {
    const bounds = (sql: string) => runQuery(sql, transactions(), DEFAULT_ENGINE_OPTIONS).analyze!.stats.columns.amount!.histogramBounds.length;
    expect(bounds('ANALYZE transactions WITH 3 BUCKETS')).toBe(4);
    expect(bounds('ANALYZE transactions WITH 100 BUCKETS')).toBe(101);
    expect(bounds('ANALYZE transactions')).toBe(DEFAULT_HISTOGRAM_BUCKETS + 1);
    const run = runQuery('ANALYZE transactions WITH 3 BUCKETS', transactions(), DEFAULT_ENGINE_OPTIONS);
    expect(run.events.some((e) => e.label.includes('each histogram in up to 3 buckets'))).toBe(true);
    // Not keywords: a column may still be called `buckets`.
    expect(parseStatement('SELECT buckets FROM t').ok).toBe(true);
  });
});

describe('a range estimate against the bucket count (plan.md §27.5 T5)', () => {
  /** What `EXPLAIN` would estimate for the range, after `ANALYZE … WITH buckets BUCKETS` on the preset. */
  const explained = (buckets: number, low: number, high: number): number => {
    const db = transactions();
    const stats = runQuery(`ANALYZE transactions WITH ${String(buckets)} BUCKETS`, db, DEFAULT_ENGINE_OPTIONS).analyze!.stats;
    const analyzed: Database = { tables: { transactions: { ...db.tables.transactions!, stats } } };
    const run = runQuery(`SELECT * FROM transactions WHERE amount BETWEEN ${String(low)} AND ${String(high)}`, analyzed, DEFAULT_ENGINE_OPTIONS);
    const scan = (n: PlanNode | null): PlanNode | null => (!n ? null : n.op === 'SeqScan' ? n : (n.children ?? []).map(scan).find((x) => x) ?? null);
    return scan(finalPlan(run.events))!.estRows!;
  };

  it('is the estimate EXPLAIN gives the same range after the same ANALYZE', () => {
    const table = transactions().tables.transactions!;
    for (const [buckets, low, high] of [[1, 100, 400], [10, 100, 400], [37, 2000, 2100], [100, 10, 4999]] as const) {
      expect(rangeEstimate(table, 'amount', low, high, buckets).estimate, `${String(buckets)} ${String(low)}–${String(high)}`).toBe(explained(buckets, low, high));
    }
  });

  it('counts the real rows, and on the preset’s even amounts barely moves with the bucket count', () => {
    const table = transactions().tables.transactions!;
    expect(rowsInRange(table, 'amount', 100, 400)).toBe(183);
    const sweep = bucketSweep(table, 'amount', 100, 400, [1, 2, 5, 10, 20, 50, 100]);
    expect(sweep.map((r) => r.buckets)).toEqual([1, 2, 5, 10, 20, 50, 100]);
    for (const r of sweep) expect(r.qError).toBeLessThan(1.05);
  });

  it('builds fewer buckets than asked when there are fewer values to split', () => {
    const tiny = { name: 't', columns: ['v'], rows: Array.from({ length: 25 }, (_, i) => ({ v: i })) };
    expect(rangeEstimate(tiny, 'v', 0, 5, 100).bounds).toHaveLength(25);
    expect(rangeEstimate(tiny, 'v', 0, 5, 4).bounds).toHaveLength(5);
  });
});
