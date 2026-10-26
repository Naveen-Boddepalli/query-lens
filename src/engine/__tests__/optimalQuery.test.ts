/**
 * Bélády's optimal policy in a query (plan.md §26 Feature 2). It evicts the page whose next use is farthest away, so
 * it needs the future; `runQuery` gets it by running the statement once first, which works because a query's page
 * reads come from its plan, not from the pool.
 */

import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { DATASETS } from '../datasets.ts';
import { REPLACEMENT_POLICY_NAMES } from '../types.ts';
import type { ReplacementPolicyName, RunResult } from '../types.ts';

const SORTED_SCAN = 'SELECT * FROM orders WHERE total > 500 ORDER BY total';
const run = (sql: string, policy: ReplacementPolicyName, dataset: 'orders' | 'users' = 'orders') =>
  runQuery(sql, DATASETS[dataset].make(), { bufferFrames: 4, rowsPerPage: 4, policy });
const references = (r: RunResult) =>
  r.events.flatMap((e) => (e.stage === 'buffer' && (e.action === 'hit' || e.action === 'miss') ? [e.pageId] : []));
const misses = (r: RunResult) => r.events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;

describe('the optimal policy in a query', () => {
  it('reads the same pages, in the same order, as every other policy — the premise of the rehearsal', () => {
    const lru = references(run(SORTED_SCAN, 'lru'));
    for (const policy of REPLACEMENT_POLICY_NAMES) expect(references(run(SORTED_SCAN, policy)), policy).toEqual(lru);
  });

  it('misses no more than any other policy, and fewer than FIFO, which is what it used to do here', () => {
    const optimal = misses(run(SORTED_SCAN, 'optimal'));
    for (const policy of REPLACEMENT_POLICY_NAMES) expect(optimal, policy).toBeLessThanOrEqual(misses(run(SORTED_SCAN, policy)));
    expect(optimal).toBeLessThan(misses(run(SORTED_SCAN, 'fifo')));
  });

  it('returns the same rows, and its narration names it', () => {
    const optimal = run(SORTED_SCAN, 'optimal');
    expect(optimal.rows).toEqual(run(SORTED_SCAN, 'lru').rows);
    expect(optimal.events.some((e) => e.stage === 'buffer' && e.action === 'evict' && /optimal policy picked it/.test(e.label))).toBe(true);
  });

  it('leaves the database untouched by the rehearsal, and a write still reports its own rows once', () => {
    const db = DATASETS.users.make();
    const before = JSON.stringify(db);
    const deleted = runQuery('DELETE FROM users WHERE age > 60', db, { bufferFrames: 4, rowsPerPage: 4, policy: 'optimal' });
    expect(JSON.stringify(db)).toBe(before);
    expect(deleted.write).toEqual(run('DELETE FROM users WHERE age > 60', 'lru', 'users').write);
  });
});
