// @vitest-environment node
/**
 * Clustered (index-organized) tables (plan.md §25.4 B3e) are a *physical* fact, never a semantic one: which index
 * doubles as a table's own layout must never change what any query returns, only how the trace gets there. This is
 * the metamorphic property that matters most for this slice — stronger, here, than bouncing the same statements
 * through SQLite (whose own physical layout is not something `node:sqlite` lets a test inspect, and whose row-level
 * semantics for a `WITHOUT ROWID` table are identical to an ordinary one anyway): the same random session of
 * INSERT/UPDATE/DELETE/SELECT is run against two databases that start from the *same* rows and differ only in
 * whether `t.clusteredKey` is set. Every statement must agree — accepted or rejected alike — and every accepted
 * write and every SELECT must return the same rows, as a multiset.
 *
 * `id` is the clustering key everywhere it applies; `a` is a second UNIQUE index (so a lookup through it takes the
 * clustered-secondary path this slice adds) and `b` a plain, non-unique one (so a repeated value's whole run is
 * exercised through it too). After every accepted write, every index of the *clustered* database is checked sound
 * with `validate` — an entry a clustered-aware insert/delete/update maintained wrongly would be caught here even
 * when both databases still happened to agree on the rows.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { runQuery } from '../src/engine/runQuery.ts';
import { validate } from '../src/engine/index/index.ts';
import type { BPlusTree } from '../src/engine/index/index.ts';
import type { Database, IndexSpec, Row, SqlValue } from '../src/engine/types.ts';
import { ORACLE_TIMEOUT, oracleParams } from './config.ts';
import { cell, multisetDiff } from './compare.ts';

vi.setConfig({ testTimeout: ORACLE_TIMEOUT });

const COLUMNS = ['id', 'a', 'b'] as const;
const INDEXES: IndexSpec[] = [{ columns: ['id'], unique: true }, { columns: ['a'], unique: true }, { columns: ['b'] }];

const pool = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 5 }) },
  { weight: 1, arbitrary: fc.constant(null) },
);
const lit = (v: SqlValue): string => (v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v));

/** Rows that satisfy `id` and `a`'s uniqueness (NULL excepted, as SQL allows). */
function rowsFor(count: number, values: (number | null)[][]): Row[] {
  const rows: Row[] = [];
  const seenA = new Set<number>();
  for (let i = 0; i < count; i++) {
    const a = values[i][0];
    if (a !== null && seenA.has(a)) continue;
    if (a !== null) seenA.add(a);
    rows.push({ id: i + 1, a, b: values[i][1] });
  }
  return rows;
}

const statement = fc.oneof(
  fc.tuple(pool, pool).map(([a, b]) => ({ sql: `INSERT INTO t (id, a, b) VALUES (@ID, ${lit(a)}, ${lit(b)})` })),
  fc.tuple(fc.constantFrom('a', 'b'), pool, fc.constantFrom('id = 3', 'a = 1', 'b = 2', 'id > 3', 'b > 2', 'a IS NULL')).map(
    ([col, v, where]) => ({ sql: `UPDATE t SET ${col} = ${lit(v)} WHERE ${where}` }),
  ),
  fc.constantFrom('id = 2', 'a = 1', 'b = 2', 'id > 3', 'b > 2', 'a IS NULL').map((where) => ({ sql: `DELETE FROM t WHERE ${where}` })),
  fc.constantFrom("SELECT * FROM t WHERE id = 3", "SELECT * FROM t WHERE a = 1", "SELECT b FROM t WHERE a = 1", "SELECT * FROM t WHERE b = 2", "SELECT * FROM t WHERE id > 2", "SELECT * FROM t WHERE b > 2").map(
    (sql) => ({ sql }),
  ),
);

const seen = { writes: 0, reads: 0, rejections: 0 };

function tuplesOf(rows: readonly Row[]) {
  return rows.map((r) => COLUMNS.filter((c) => c in r).map((c) => cell(r[c] ?? null)));
}

describe('a clustered table answers every query exactly as the same table unclustered does', () => {
  it('agrees on acceptance, rows and index soundness at every step', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.array(fc.tuple(pool, pool), { minLength: 6, maxLength: 6 }),
        fc.array(statement, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1000, max: 90000 }),
        (count, values, steps, serial) => {
          let clusteredRows = rowsFor(count, values);
          let plainRows = clusteredRows.map((r) => ({ ...r }));

          steps.forEach((step, i) => {
            const sql = step.sql.replace('@ID', String(serial + i));
            const captured: Record<string, BPlusTree> = {};
            const clusteredDb: Database = {
              tables: { t: { name: 't', columns: [...COLUMNS], rows: clusteredRows, indexes: INDEXES, clusteredKey: ['id'] } },
            };
            const plainDb: Database = { tables: { t: { name: 't', columns: [...COLUMNS], rows: plainRows, indexes: INDEXES } } };

            const clustered = runQuery(sql, clusteredDb, undefined, { afterWrite: (t) => Object.assign(captured, t) });
            const plain = runQuery(sql, plainDb);

            expect(clustered.error !== undefined, sql).toBe(plain.error !== undefined);
            if (clustered.error) {
              seen.rejections += 1;
              return;
            }

            expect(multisetDiff(tuplesOf(clustered.rows), tuplesOf(plain.rows)), `${sql} — results differ`).toBeNull();

            if (clustered.write) {
              seen.writes += 1;
              clusteredRows = clustered.write.rows;
              plainRows = plain.write!.rows;
              for (const tree of Object.values(captured)) expect(validate(tree), sql).toEqual([]);
            } else {
              seen.reads += 1;
            }
          });
        },
      ),
      oracleParams(),
    );
    expect(seen.writes).toBeGreaterThan(200);
    expect(seen.reads).toBeGreaterThan(50);
    expect(seen.rejections).toBeGreaterThan(20);
  });
});
