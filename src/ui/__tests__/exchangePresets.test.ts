/** plan.md §27.5 P2 — the parallel tool's joins: each strategy counts what the engine returns running the join alone. */

import { describe, expect, it } from 'vitest';
import { runParallelJoin } from '../../engine/exchange.ts';
import type { JoinExchange, ParallelJoinResult } from '../../engine/exchange.ts';
import { hashKeyOf } from '../../engine/partitioning.ts';
import { runQuery } from '../../engine/runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../../engine/types.ts';
import type { Database } from '../../engine/types.ts';
import { exchangeDatabase, JOIN_QUERIES, joinRun } from '../exchangePresets.ts';

const ok = (r: ReturnType<typeof runParallelJoin>): ParallelJoinResult => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

/**
 * The rows an equi-join `FROM a JOIN b ON a.x = b.y` returns, counted with a plain hash map over the two tables — no
 * trace. A NULL key matches nothing; keys compare as the engine's `=` does (`hashKeyOf`).
 */
function pairCount(sql: string, db: Database): number {
  const m = /FROM (\w+) JOIN (\w+) ON (\w+)\.(\w+) = (\w+)\.(\w+)/.exec(sql);
  if (!m) throw new Error(`not an equi-join: ${sql}`);
  const [, , , ta, ca, tb, cb] = m as unknown as [string, string, string, string, string, string, string];
  const counts = new Map<string, number>();
  for (const row of db.tables[ta]!.rows) {
    const k = row[ca] ?? null;
    if (k !== null) counts.set(hashKeyOf(k), (counts.get(hashKeyOf(k)) ?? 0) + 1);
  }
  let found = 0;
  for (const row of db.tables[tb]!.rows) {
    const k = row[cb] ?? null;
    if (k !== null) found += counts.get(hashKeyOf(k)) ?? 0;
  }
  return found;
}

/**
 * Joins whose serial trace is too big to hold in a test worker: `big-big` runs 13.5 million steps through
 * `runQuery` — about 2.6 GB of heap for the trace alone — which aborted the worker on CI's 7 GB runners
 * (Node's default heap limit there is under 2 GB). Their expected count comes from `pairCount`, which the test
 * checks against `runQuery` on every other preset.
 */
const TRACE_TOO_BIG = new Set(['big-big']);

describe('the exchange section’s joins (plan.md §27.5 P2)', () => {
  it('counts what the engine returns alone, for every preset join, strategy and number of workers', () => {
    const db = exchangeDatabase();
    for (const q of JOIN_QUERIES) {
      let expected = pairCount(q.sql, db);
      if (!TRACE_TOO_BIG.has(q.id)) {
        const serial = runQuery(q.sql, db, DEFAULT_ENGINE_OPTIONS);
        const engine = q.sql.startsWith('SELECT COUNT(*)') ? (serial.rows[0]!['COUNT(*)'] as number) : serial.rows.length;
        expect(engine, `${q.id}: the engine alone agrees with the hash count`).toBe(expected);
        expected = engine;
      }
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
