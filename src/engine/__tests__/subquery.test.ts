import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createJoinDemoDatabase } from '../seed.ts';
import { parse, parseStatement } from '../parser/index.ts';
import { exprToSql } from '../parser/print.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database } from '../types.ts';

const db = () => createJoinDemoDatabase(); // authors: ada, alan, grace, donald, barbara; posts: 10 rows, a real FK
const run = (sql: string, database: Database = db()) => runQuery(sql, database, DEFAULT_ENGINE_OPTIONS);
const sortRows = (rs: readonly Record<string, unknown>[]) =>
  [...rs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('IN (subquery) — parsing (plan.md §25.4 C3 slice c, closing C3)', () => {
  it('parses IN and NOT IN with a subquery, carrying it on the `in` node', () => {
    const parsed = parse("SELECT * FROM posts WHERE authorId IN (SELECT id FROM authors WHERE name = 'ada')");
    if (!parsed.ok) throw new Error(parsed.error.message);
    const where = parsed.ast.where;
    if (!where || where.kind !== 'in') throw new Error('expected an in node');
    expect(where.negated).toBe(false);
    expect(where.items).toEqual([]);
    expect(where.subquery?.column.name).toBe('id');
    expect(where.subquery?.from.name).toBe('authors');
    expect(where.subquery?.where).toBeDefined();

    const negated = parse('SELECT * FROM posts WHERE authorId NOT IN (SELECT id FROM authors)');
    if (!negated.ok) throw new Error(negated.error.message);
    const notWhere = negated.ast.where;
    if (!notWhere || notWhere.kind !== 'in') throw new Error('expected an in node');
    expect(notWhere.negated).toBe(true);
    expect(notWhere.subquery?.where).toBeUndefined();
  });

  it('a literal-list IN is completely unaffected — no subquery field at all', () => {
    const parsed = parse('SELECT * FROM posts WHERE authorId IN (1, 2, 3)');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const where = parsed.ast.where;
    if (!where || where.kind !== 'in') throw new Error('expected an in node');
    expect(where.subquery).toBeUndefined();
    expect(where.items).toHaveLength(3);
  });

  it('still rejects a subquery anywhere other than IN', () => {
    const result = parseStatement('SELECT * FROM posts WHERE authorId = (SELECT id FROM authors)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/subquery/i);
  });

  it.each([
    ['SELECT *', 'SELECT * FROM authors', /SELECT \*/],
    ['multiple columns', 'SELECT id, name FROM authors', /only select one column/],
    ['an aggregate', 'SELECT COUNT(*) FROM authors', /aggregate/],
    ['DISTINCT', 'SELECT DISTINCT id FROM authors', /DISTINCT/],
    ['a JOIN', 'SELECT authors.id FROM authors JOIN posts ON authors.id = posts.authorId', /JOIN/],
    ['GROUP BY', 'SELECT id FROM authors GROUP BY id', /GROUP BY/],
    ['ORDER BY', 'SELECT id FROM authors ORDER BY id', /ORDER BY/],
    ['LIMIT', 'SELECT id FROM authors LIMIT 1', /LIMIT/],
    ['a table-qualified column', 'SELECT authors.id FROM authors', /does not need a table name/],
  ] as const)('rejects %s inside an IN subquery', (_label, subquerySql, message) => {
    const result = parseStatement(`SELECT * FROM posts WHERE authorId IN (${subquerySql})`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });

  it('exprToSql round-trips the subquery form, not the resolved values', () => {
    const parsed = parse("SELECT * FROM posts WHERE authorId IN (SELECT id FROM authors WHERE name = 'ada')");
    if (!parsed.ok) throw new Error(parsed.error.message);
    if (!parsed.ast.where) throw new Error('expected a WHERE clause');
    expect(exprToSql(parsed.ast.where)).toBe("authorId IN (SELECT id FROM authors WHERE name = 'ada')");
  });
});

describe('IN (subquery) — execution', () => {
  const ADA_POSTS = "SELECT * FROM posts WHERE authorId IN (SELECT id FROM authors WHERE name = 'ada')";

  it('filters SELECT rows to exactly the subquery-matched keys', () => {
    const { rows, error } = run(ADA_POSTS);
    expect(error).toBeUndefined();
    expect(sortRows(rows)).toEqual(
      sortRows([
        { id: 1, authorId: 1, title: "ada's post 1" },
        { id: 2, authorId: 1, title: "ada's post 2" },
        { id: 3, authorId: 1, title: "ada's post 3" },
      ]),
    );
  });

  it('NOT IN keeps everything else', () => {
    const { rows } = run("SELECT id FROM posts WHERE authorId NOT IN (SELECT id FROM authors WHERE name = 'ada')");
    expect(sortRows(rows)).toEqual(sortRows([4, 5, 6, 7, 8, 9, 10].map((id) => ({ id }))));
  });

  it('combines with other WHERE conjuncts the ordinary way', () => {
    const { rows } = run(`${ADA_POSTS.replace('SELECT *', 'SELECT id')} AND id > 1`);
    expect(sortRows(rows)).toEqual(sortRows([{ id: 2 }, { id: 3 }]));
  });

  it('an empty subquery result makes IN match nothing and NOT IN match everything', () => {
    const database = db();
    const empty = run("SELECT id FROM posts WHERE authorId IN (SELECT id FROM authors WHERE name = 'nobody')", database);
    expect(empty.rows).toEqual([]);
    const everything = run(
      "SELECT id FROM posts WHERE authorId NOT IN (SELECT id FROM authors WHERE name = 'nobody')",
      database,
    );
    expect(everything.rows).toHaveLength(10);
  });

  it('the classic NOT IN NULL trap: a NULL anywhere in the subquery result makes NOT IN match nothing', () => {
    // The same three-valued-logic trap a literal `NOT IN (1, NULL)` already has (expressions.test.ts) — a
    // subquery-sourced NULL must trigger it identically, since resolution just produces an ordinary literal list.
    // The subquery excludes ada (id 1) by name, so — NULL trap aside — `NOT IN` would otherwise keep exactly
    // ada's 3 posts; a version that silently dropped the NULL instead of including it would return those 3 rows
    // instead of none, so this genuinely distinguishes the trap from a same-shaped but wrong implementation.
    const database = db();
    database.tables.authors!.rows.push({ id: null, name: 'ghost' });
    const { rows, error } = run("SELECT id FROM posts WHERE authorId NOT IN (SELECT id FROM authors WHERE name <> 'ada')", database);
    expect(error).toBeUndefined();
    expect(rows).toEqual([]);
  });

  it('deduplicates the subquery result before it becomes the IN list', () => {
    // Every post has a repeated authorId (a real foreign key) — SELECT authorId FROM posts as the subquery would
    // return far more rows than distinct values; only the distinct count matters for IN.
    const { rows } = run('SELECT name FROM authors WHERE id IN (SELECT authorId FROM posts)');
    expect(sortRows(rows)).toEqual(sortRows([{ name: 'ada' }, { name: 'alan' }, { name: 'grace' }, { name: 'donald' }]));
  });

  it('DELETE and UPDATE both resolve an IN subquery in their own WHERE clause', () => {
    const deleted = run("DELETE FROM posts WHERE authorId IN (SELECT id FROM authors WHERE name = 'ada')");
    expect(deleted.write?.kind === 'delete' ? deleted.write.deletedCount : -1).toBe(3);

    const updated = run("UPDATE posts SET title = 'x' WHERE authorId IN (SELECT id FROM authors WHERE name = 'ada')");
    expect(updated.write?.kind === 'update' ? updated.write.updatedCount : -1).toBe(3);
    const newRows = updated.write?.kind === 'update' ? updated.write.rows : [];
    expect(newRows.filter((r) => r['title'] === 'x')).toHaveLength(3);
  });

  it('a bad table name inside the subquery is reported as a subquery failure, not a crash', () => {
    const { error } = run('SELECT * FROM posts WHERE authorId IN (SELECT id FROM nope)');
    expect(error?.message).toMatch(/IN subquery failed/);
    expect(error?.message).toMatch(/no table called `nope`/);
  });

  it('a bad column name inside the subquery is reported as a subquery failure too', () => {
    const { error } = run('SELECT * FROM posts WHERE authorId IN (SELECT nope FROM authors)');
    expect(error?.message).toMatch(/IN subquery failed/);
  });

  it("the WHERE clause's own narration says the subquery already ran, and how many values it found", () => {
    const { events } = run(ADA_POSTS);
    const whereStep = events.find((e) => e.stage === 'plan' && e.label.startsWith('The WHERE clause'));
    expect(whereStep?.label).toMatch(/already ran once, before this plan was built, finding 1 distinct value/);
  });

  it('is uncorrelated: the subquery cannot read anything from the outer query at all', () => {
    // `posts` is a real table in this database, but the *subquery's* own scope only ever knows its own FROM table
    // (`authors`) — a qualified reference to the outer query's table is rejected the same "single table" way any
    // reference to an unrelated table already would be.
    const result = parseStatement('SELECT * FROM posts WHERE authorId IN (SELECT id FROM authors WHERE posts.id = 1)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/does not need a table name|no table called/);
  });
});
