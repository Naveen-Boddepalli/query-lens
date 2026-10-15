// @vitest-environment node
/**
 * Ternary-logic partitioning (plan.md §25.4 A1c, unblocked by B1). For any
 * predicate P — including one that is UNKNOWN on some rows —
 *
 *   rows(WHERE P)  ⊎  rows(WHERE NOT P)  ⊎  rows(WHERE P IS NULL)  =  all rows
 *
 * because under three-valued logic every row makes P exactly one of TRUE, FALSE
 * or UNKNOWN. No external oracle is needed, and no expected answer: it finds
 * bugs in `NOT`, `OR`, `IN`, `LIKE` and the optimizer's handling of them by
 * *contradiction* — a row that lands in two partitions, or in none, means one of
 * the three queries was answered wrongly. It is the check that would have caught
 * the `WHERE k = k` bug without SQLite.
 *
 * What it cannot see is a *consistently* wrong truth table: if `UNKNOWN OR FALSE`
 * wrongly came out FALSE, the row would simply land in the NOT partition instead
 * of the IS NULL one — still exactly one partition. That is what the SQLite
 * comparison (`differential.test.ts`) is for; the two cover each other's blind spot.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { runQuery } from '../src/engine/runQuery.ts';
import { multisetDiff } from './compare.ts';
import { ORACLE_TIMEOUT, oracleParams } from './config.ts';
import { optionsArb, poolOf, predArb, refsOf, subSources, tableT, tableU } from './generate.ts';
import { toDatabase } from './harness.ts';
import { renderPred } from './model.ts';
import { tupleOf } from './sqlite.ts';

vi.setConfig({ testTimeout: ORACLE_TIMEOUT });

describe('ternary-logic partitioning', () => {
  it('a predicate, its negation and its IS NULL partition every table', () => {
    fc.assert(
      fc.property(
        tableT.chain((t) => tableU(t).map((u) => [t, u] as const)),
        optionsArb,
        fc.boolean(),
        (tables, options, useIndex) => {
          const [t, u] = tables;
          const pool = poolOf([t, u]);
          const refs = refsOf(t, false);
          // fast-check arbitraries cannot be drawn from inside a property, so the predicate is drawn by sampling its arbitrary
          // with a seed derived from the table (deterministic per counterexample, and shrinking still works on the table).
          const seed = t.rows.length * 7919 + u.rows.length * 104729 + (useIndex ? 1 : 0);
          // Subqueries over `u` and `t` itself too: `(x IN (SELECT …)) IS NULL` is one of the three partitions, so a
          // subquery the engine left unresolved there (it once did) puts a row in no partition at all.
          const predicates = fc.sample(predArb(refs, pool, 3, subSources([u, t], pool)), { seed, numRuns: 12 });

          const db = toDatabase([t, u], useIndex);
          const cols = t.columns.map((c) => c.name);
          const rows = (where: string) => {
            const sql = `SELECT * FROM t${where}`;
            const result = runQuery(sql, db, options);
            expect(result.error, sql).toBeUndefined();
            return result.rows.map((r) => tupleOf(r, cols));
          };

          const all = rows('');
          for (const p of predicates) {
            const text = renderPred(p);
            const yes = rows(` WHERE ${text}`);
            const no = rows(` WHERE NOT (${text})`);
            const unknown = rows(` WHERE (${text}) IS NULL`);
            expect(multisetDiff([...yes, ...no, ...unknown], all), `WHERE ${text}`).toBeNull();
          }
        },
      ),
      oracleParams(0.5),
    );
  });
});
