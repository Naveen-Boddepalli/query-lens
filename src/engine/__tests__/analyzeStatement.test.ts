/**
 * plan.md §25.4 C1 — `ANALYZE table` as a statement: a real scan that produces statistics for the cost model to
 * read on every later query, in place of scanning the live rows itself. Not `EXPLAIN ANALYZE` (plan.md §25.4
 * B6), which runs a *query* for real and shows actual beside estimate.
 */

import { describe, expect, it } from 'vitest';
import { parseStatement } from '../parser/parser.ts';
import { createSeedDatabase } from '../seed.ts';
import { runQuery } from '../runQuery.ts';
import type { Database } from '../types.ts';

const db = (): Database => createSeedDatabase();

describe('parsing', () => {
  it('reads ANALYZE and a table name, case-insensitively', () => {
    const out = parseStatement('ANALYZE users');
    expect(out.ok && out.ast).toMatchObject({ kind: 'analyze', table: { name: 'users' } });
    const lower = parseStatement('analyze users;');
    expect(lower.ok && lower.ast).toMatchObject({ kind: 'analyze', table: { name: 'users' } });
  });

  it('the statement span runs from ANALYZE to the end of the table name', () => {
    const sql = 'ANALYZE users';
    const out = parseStatement(sql);
    expect(out.ok && out.ast.span).toEqual({ from: 0, to: sql.length });
  });

  it.each([
    ['ANALYZE', /Expected a table name/i],
    ['ANALYZE 5', /Expected a table name/i],
    ['ANALYZE users WHERE id = 1', /./],
  ])('rejects %s with a reason', (sql, message) => {
    const out = parseStatement(sql);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.message).toMatch(message);
  });
});

describe('execution', () => {
  it('scans the real table and returns one readable row per column', () => {
    const { rows, error } = runQuery('ANALYZE users', db());
    expect(error).toBeUndefined();
    expect(rows.map((r) => r.column)).toEqual(['id', 'name', 'email', 'age']);
    for (const r of rows) {
      expect(r.n_distinct).toBeTypeOf('number');
      expect(r.null_frac).toBeTypeOf('number');
    }
  });

  it('hands the caller a structured TableStats to persist, alongside the printed rows', () => {
    const { analyze } = runQuery('ANALYZE users', db());
    expect(analyze?.table).toBe('users');
    expect(analyze?.stats.rowCount).toBe(48);
    expect(analyze?.stats.columns.age?.nDistinct).toBeGreaterThan(0);
  });

  it('touches only parse and result — no buffer pool, no locks, nothing to plan or optimize', () => {
    const { events } = runQuery('ANALYZE users', db());
    const stages = new Set(events.map((e) => e.stage));
    expect(stages).toEqual(new Set(['parse', 'result']));
  });

  it('narrates what it found, and how many rows and columns it scanned', () => {
    const { events } = runQuery('ANALYZE users', db());
    expect(events.at(-1)?.label).toMatch(/scanned all 48 rows of `users`/);
    expect(events.at(-1)?.label).toMatch(/4 columns/);
  });

  it('an unknown table is rejected the same way every other statement rejects one', () => {
    const { error } = runQuery('ANALYZE nope', db());
    expect(error?.message).toBe('There is no table called `nope`.');
  });

  it('a later ANALYZE reflects the table as it is by then, not as it was', () => {
    const database = db();
    const before = runQuery('ANALYZE users', database).analyze!.stats;
    expect(before.rowCount).toBe(48);

    const { write } = runQuery("INSERT INTO users (id, name, email, age) VALUES (99, 'zed', 'zed@x.org', 40)", database);
    database.tables.users = { ...database.tables.users!, rows: write!.rows };

    const after = runQuery('ANALYZE users', database).analyze!.stats;
    expect(after.rowCount).toBe(49);
  });

  it('a table that has never been ANALYZEd carries no stats, and the cost model still estimates', () => {
    const { events, error } = runQuery('SELECT * FROM users WHERE age = 34', db());
    expect(error).toBeUndefined();
    const plan = events.filter((e) => e.stage === 'plan').at(-1);
    expect(plan && 'planTree' in plan ? plan.planTree.estBasis : undefined).not.toMatch(/ANALYZE/);
  });

  it('once ANALYZEd and reattached, the very next query reads the stored statistics', () => {
    const database = db();
    const { analyze } = runQuery('ANALYZE users', database);
    database.tables.users = { ...database.tables.users!, stats: analyze!.stats };

    const { events } = runQuery('SELECT * FROM users WHERE age = 34', database);
    const plan = events.filter((e) => e.stage === 'plan').at(-1);
    expect(plan && 'planTree' in plan ? plan.planTree.estBasis : undefined).toMatch(/ANALYZE/);
  });
});
