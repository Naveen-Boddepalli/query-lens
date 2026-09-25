// @vitest-environment node
/**
 * `UNIQUE` against SQLite (plan.md §25.4 B3c). What a unique index accepts and rejects is SQL's rule, not QueryLens's
 * invention — in particular that NULL is not equal to NULL, so any number of rows may hold one — and SQLite is the
 * ground truth for it. Every statement is run by both engines: they must agree on *whether* it is accepted (the
 * messages differ, by design), and an accepted write must leave the two tables identical.
 *
 * Only statements whose outcome does not depend on the order rows are visited in are generated: `SET a = 5` is
 * accepted exactly when at most one row is touched, in any order, whereas `SET a = a + 1` on a unique column is
 * accepted or rejected according to which row goes first — and QueryLens (heap order) and SQLite (its own scan order)
 * are entitled to differ there, as PostgreSQL and SQLite are.
 */

import { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { runQuery } from '../src/engine/runQuery.ts';
import type { Database, IndexSpec, Row, SqlValue } from '../src/engine/types.ts';
import { ORACLE_TIMEOUT, oracleParams } from './config.ts';
import { cell, multisetDiff } from './compare.ts';

vi.setConfig({ testTimeout: ORACLE_TIMEOUT });

const COLUMNS = ['id', 'a', 'b'] as const;

/** The unique indexes a case declares, each as its columns. */
const INDEX_SETS: string[][][] = [[['a']], [['a', 'b']], [['a'], ['b']], [['b', 'a']], [['a'], ['a', 'b']]];

const lit = (v: SqlValue): string => (v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v));
const pool = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 3 }) },
  { weight: 2, arbitrary: fc.constant(null) },
);

/** Rows that satisfy the constraint: no two share a fully non-NULL key under any of `indexes`. */
function rowsFor(indexes: string[][], count: number, values: (number | null)[][]): Row[] {
  const rows: Row[] = [];
  const seen = indexes.map(() => new Set<string>());
  for (let i = 0; i < count; i++) {
    const row: Row = { id: i + 1, a: values[i][0], b: values[i][1] };
    const keys = indexes.map((cols) => cols.map((c) => row[c] ?? null));
    const clash = keys.some((k, j) => !k.includes(null) && seen[j].has(JSON.stringify(k)));
    if (clash) continue;
    keys.forEach((k, j) => { if (!k.includes(null)) seen[j].add(JSON.stringify(k)); });
    rows.push(row);
  }
  return rows;
}

const statement = fc.oneof(
  // INSERT of a key that may or may not be taken, possibly NULL.
  fc.tuple(pool, pool).map(([a, b]) => ({ kind: 'write' as const, sql: `INSERT INTO t (id, a, b) VALUES (@ID, ${lit(a)}, ${lit(b)})` })),
  // UPDATE one row, or several, to a literal.
  fc.tuple(fc.constantFrom('a', 'b'), pool, fc.oneof(fc.integer({ min: 1, max: 6 }).map((id) => `id = ${String(id)}`), fc.constantFrom('a = 0', 'a = 1', 'b = 2', 'id > 2', 'id >= 1', 'a IS NULL'))).map(
    ([col, v, where]) => ({ kind: 'write' as const, sql: `UPDATE t SET ${col} = ${lit(v)} WHERE ${where}` }),
  ),
  // UPDATE of a column no unique index covers is not generated here — `id` carries none — so it is `id` that moves.
  fc.tuple(pool, fc.integer({ min: 1, max: 6 })).map(([v, id]) => ({ kind: 'write' as const, sql: `UPDATE t SET id = ${String(id + 20)} WHERE a = ${lit(v)} AND id = ${String(id)}` })),
  fc.constantFrom('a = 0', 'a = 1', 'b = 2', 'id > 4', 'a IS NULL').map((where) => ({ kind: 'write' as const, sql: `DELETE FROM t WHERE ${where}` })),
);

/** What the run actually exercised — an oracle that never sees a rejection proves nothing. */
const seen = { rejected: 0, accepted: 0, nullInserts: 0, multiRowRejections: 0 };

describe('UNIQUE agrees with SQLite', () => {
  it('accepts and rejects the same statements, and leaves the same rows', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...INDEX_SETS),
        fc.integer({ min: 0, max: 8 }),
        fc.array(fc.tuple(pool, pool), { minLength: 8, maxLength: 8 }),
        fc.array(statement, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 2000, max: 90000 }),
        (indexes, count, values, steps, serial) => {
          let rows = rowsFor(indexes, count, values);
          const specs: IndexSpec[] = indexes.map((columns) => ({ columns, unique: true }));

          const lite = new DatabaseSync(':memory:');
          lite.exec('CREATE TABLE t (id INTEGER, a INTEGER, b INTEGER)');
          indexes.forEach((cols, i) => lite.exec(`CREATE UNIQUE INDEX u${String(i)} ON t (${cols.join(', ')})`));
          const insert = lite.prepare('INSERT INTO t VALUES (?, ?, ?)');
          for (const r of rows) insert.run(...COLUMNS.map((c) => cell(r[c] ?? null)));

          try {
            steps.forEach((step, i) => {
              // Every INSERT gets a fresh id, so a rejection is always about `a`/`b`, never `id`.
              const sql = step.sql.replace('@ID', String(serial + i));
              const db: Database = { tables: { t: { name: 't', columns: [...COLUMNS], rows: rows.map((r) => ({ ...r })), indexes: specs } } };
              const result = runQuery(sql, db);
              let sqliteRejected = false;
              try {
                lite.prepare(sql).run();
              } catch (e) {
                if (!/UNIQUE constraint failed/.test(String((e as Error).message))) throw e;
                sqliteRejected = true;
              }
              expect(result.error !== undefined, `${sql} — QueryLens ${result.error?.message ?? 'accepted'}, SQLite ${sqliteRejected ? 'rejected' : 'accepted'}`).toBe(sqliteRejected);
              seen[sqliteRejected ? 'rejected' : 'accepted'] += 1;
              if (!sqliteRejected && /^INSERT.*NULL/.test(sql)) seen.nullInserts += 1;
              if (sqliteRejected && /^UPDATE/.test(sql) && !/id = \d+ WHERE/.test(sql)) seen.multiRowRejections += 1;
              if (!sqliteRejected) {
                rows = result.write!.rows;
                const lt = (lite.prepare('SELECT id, a, b FROM t').all() as unknown as Record<string, number | null>[]).map((r) => COLUMNS.map((c) => cell(r[c] ?? null)));
                const ql = rows.map((r) => COLUMNS.map((c) => cell(r[c] ?? null)));
                expect(multisetDiff(ql, lt), `${sql} — tables differ`).toBeNull();
              }
            });
          } finally {
            lite.close();
          }
        },
      ),
      oracleParams(),
    );
    // Both outcomes, NULL keys, and a statement rejected part-way through several rows must all have been seen.
    expect(seen.rejected).toBeGreaterThan(100);
    expect(seen.accepted).toBeGreaterThan(100);
    expect(seen.nullInserts).toBeGreaterThan(20);
    expect(seen.multiRowRejections).toBeGreaterThan(5);
  });
});
