/** plan.md §27.5 P2 — the parallel tool's joins: each strategy counts what the engine returns running the join alone. */

import { describe, expect, it } from 'vitest';
import { runParallelJoin } from '../../engine/exchange.ts';
import type { JoinExchange, ParallelJoinResult } from '../../engine/exchange.ts';
import { runQuery } from '../../engine/runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../../engine/types.ts';
import { exchangeDatabase, JOIN_QUERIES, joinRun } from '../exchangePresets.ts';

const ok = (r: ReturnType<typeof runParallelJoin>): ParallelJoinResult => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('the exchange section’s joins (plan.md §27.5 P2)', () => {
  it('counts what the engine returns alone, for every preset join, strategy and number of workers', () => {
    const db = exchangeDatabase();
    for (const q of JOIN_QUERIES) {
      const serial = runQuery(q.sql, db, DEFAULT_ENGINE_OPTIONS);
      const expected = q.sql.startsWith('SELECT COUNT(*)') ? (serial.rows[0]!['COUNT(*)'] as number) : serial.rows.length;
      for (const strategy of ['broadcast', 'repartition'] as JoinExchange[]) {
        for (let workers = 1; workers <= 8; workers++) {
          expect(ok(runParallelJoin(q.sql, db, { workers, strategy })).count, `${q.id} ${strategy} ${String(workers)}`).toBe(expected);
        }
      }
    }
  }, 60_000);


  it('broadcast wins small with big, repartition big with big, and broadcast again on five keys over eight workers', () => {
    const pair = (id: string, w: number) => [joinRun(id, w, 'broadcast').speedup.toFixed(2), joinRun(id, w, 'repartition').speedup.toFixed(2)];
    expect(pair('small-big', 4)).toEqual(['3.58', '2.84']);
    expect(pair('big-big', 4)).toEqual(['1.60', '2.72']);
    expect(pair('few-keys', 8)).toEqual(['5.96', '4.44']);
    expect(joinRun('few-keys', 8, 'repartition').held.probe.filter((h) => h === 0)).toHaveLength(3);
  });
});
