import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createJoinDemoDatabase } from '../seed.ts';
import { parse, parseStatement, toDisplayTree } from '../parser/index.ts';
import { exprToSql } from '../parser/print.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { rootEstimate } from '../planner/cost.ts';
import { joinsIn, toPlanDisplay } from '../planner/plan.ts';
import { resolveExists } from '../exists.ts';
import { finalPlan } from '../explain.ts';
import { runSchedule } from '../schedule.ts';
import { planToLatex, planToRelationalAlgebra } from '../../export/toRelationalAlgebra.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions, JoinAlgorithm, PlanNode, Row } from '../types.ts';

// authors: ada, alan, grace, donald, barbara (ids 1–5); posts: 10 rows whose authorId is never 5 — barbara has none.
const db = () => createJoinDemoDatabase();
const run = (sql: string, database: Database = db(), options: EngineOptions = DEFAULT_ENGINE_OPTIONS) =>
  runQuery(sql, database, options);
const ALGORITHMS: readonly JoinAlgorithm[] = ['nested-loop', 'hash', 'sort-merge', 'index-nested-loop'];
const withJoin = (joinStrategy: JoinAlgorithm): EngineOptions => ({ ...DEFAULT_ENGINE_OPTIONS, joinStrategy });
const names = (rows: readonly Row[]) => rows.map((r) => String(r.name ?? r['authors.name'])).sort();

/** The same question asked of the raw rows, with no engine in between. */
function expectedAuthors(database: Database, keep: (author: Row, posts: readonly Row[]) => boolean): string[] {
  const posts = database.tables.posts!.rows;
  return database.tables.authors!.rows
    .filter((a) => keep(a, posts.filter((p) => a.id !== null && p.authorId !== null && p.authorId === a.id)))
    .map((a) => String(a.name))
    .sort();
}

const HAS_POST = 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)';
const NO_POST = 'SELECT name FROM authors WHERE NOT EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)';

/** The semi- or anti-join a query's canonical plan has, once its EXISTS is resolved. */
function semiJoinOf(sql: string) {
  const parsed = parse(sql);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const resolved = resolveExists(parsed.ast, (s) => run(s));
  if (!resolved.ok) throw new Error(resolved.error.message);
  const join = joinsIn(buildPlan(resolved.value))[0];
  if (!join) throw new Error('expected a semi- or anti-join');
  return join;
}

describe('EXISTS — parsing (plan.md §27.5 S1)', () => {
  it('parses EXISTS into a node carrying its subquery, and NOT EXISTS as a NOT around one', () => {
    const parsed = parse(HAS_POST);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const where = parsed.ast.where;
    if (where?.kind !== 'exists') throw new Error('expected an exists node');
    expect(where.subquery.select).toBe('*');
    expect(where.subquery.from.name).toBe('posts');
    expect(where.resolved).toBeUndefined();

    const negated = parse(NO_POST);
    if (!negated.ok) throw new Error(negated.error.message);
    expect(negated.ast.where?.kind).toBe('not');
  });

  it('keeps what the subquery selects as written — EXISTS never reads it', () => {
    for (const [sql, select] of [
      ['SELECT name FROM authors WHERE EXISTS (SELECT 1 FROM posts WHERE posts.authorId = authors.id)', '1'],
      ['SELECT name FROM authors WHERE EXISTS (SELECT posts.id FROM posts WHERE posts.authorId = authors.id)', 'posts.id'],
    ] as const) {
      const parsed = parse(sql);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.ast.where?.kind === 'exists' && parsed.ast.where.subquery.select).toBe(select);
    }
  });

  it('round-trips through exprToSql, NOT EXISTS included', () => {
    const parsed = parse(`${NO_POST} AND id > 1`);
    if (!parsed.ok || !parsed.ast.where) throw new Error('expected a WHERE clause');
    expect(exprToSql(parsed.ast.where)).toBe(
      'NOT EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id) AND id > 1',
    );
  });

  it('draws the subquery in the parse tree as an Exists node over its table and WHERE', () => {
    const parsed = parse(HAS_POST);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const find = (node: { kind: string; children?: readonly unknown[] }): { kind: string; children?: readonly unknown[] } | undefined =>
      node.kind === 'Exists' ? node : (node.children ?? []).map((c) => find(c as typeof node)).find(Boolean);
    const exists = find(toDisplayTree(parsed.ast));
    expect(exists).toBeDefined();
    expect((exists?.children ?? []).map((c) => (c as { kind: string }).kind)).toEqual(['Table', 'Compare']);
  });

  it.each([
    ['under OR', 'SELECT name FROM authors WHERE id = 1 OR EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)', /joins with AND/],
    ['inside another test', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id) = TRUE', /joins with AND/],
    ['under two NOTs', 'SELECT name FROM authors WHERE NOT NOT EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)', /joins with AND/],
    ['an unqualified column', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE authorId = authors.id)', /needs a table name inside this subquery/],
    ['an unknown table', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = users.id)', /no table called `users`/],
    ['the outer table again', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM authors WHERE authors.id = 1)', /already in the outer query/],
    ['a table another EXISTS reads', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id) AND NOT EXISTS (SELECT * FROM posts WHERE posts.id = authors.id)', /already read by another EXISTS/],
    ['an aggregate', 'SELECT name FROM authors WHERE EXISTS (SELECT COUNT(*) FROM posts WHERE posts.authorId = authors.id)', /always TRUE/],
    ['DISTINCT', 'SELECT name FROM authors WHERE EXISTS (SELECT DISTINCT * FROM posts)', /DISTINCT/],
    ['two columns', 'SELECT name FROM authors WHERE EXISTS (SELECT posts.id, posts.title FROM posts)', /never reads/],
    ['a JOIN', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts JOIN users ON posts.id = users.id)', /JOIN/],
    ['GROUP BY', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts GROUP BY posts.id)', /GROUP BY/],
    ['ORDER BY', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts ORDER BY posts.id)', /ORDER BY/],
    ['LIMIT', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts LIMIT 1)', /LIMIT/],
    ['a nested EXISTS', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE EXISTS (SELECT * FROM users))', /inside another subquery/],
    ['an IN subquery inside it', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.id IN (SELECT id FROM users))', /inside an EXISTS subquery/],
    ['no parenthesis', 'SELECT name FROM authors WHERE EXISTS posts', /\(SELECT/],
  ] as const)('refuses EXISTS %s', (_label, sql, message) => {
    const result = parseStatement(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });

  it.each([
    ['HAVING', 'SELECT COUNT(*) FROM authors HAVING EXISTS (SELECT * FROM posts)'],
    ['a SELECT item', 'SELECT EXISTS (SELECT * FROM posts) FROM authors'],
    ['a DELETE', 'DELETE FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)'],
    ['an UPDATE', "UPDATE authors SET name = 'x' WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)"],
  ] as const)('refuses EXISTS in %s — only a SELECT’s WHERE runs one', (_label, sql) => {
    const result = parseStatement(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/`EXISTS` is not supported here/);
  });

  it('a subquery in a comparison is a scalar one (plan.md §27.5 S6), and may not hold an EXISTS’s own subquery', () => {
    expect(parseStatement('SELECT * FROM posts WHERE authorId = (SELECT id FROM authors)').ok).toBe(true);
    const nested = parseStatement('SELECT * FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = (SELECT MAX(id) FROM authors))');
    expect(!nested.ok && nested.error.message).toMatch(/subquery inside an EXISTS subquery/);
  });
});

describe('EXISTS — results, under every join algorithm', () => {
  it.each(ALGORITHMS)('EXISTS keeps exactly the authors with a post, each once — %s', (algorithm) => {
    const { rows, error } = run(HAS_POST, db(), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(names(rows)).toEqual(expectedAuthors(db(), (_a, posts) => posts.length > 0));
    // ada has several posts; a semi-join still returns her once — what a plain JOIN would not.
    expect(rows).toHaveLength(4);
  });

  it.each(ALGORITHMS)('NOT EXISTS keeps exactly the authors with none — %s', (algorithm) => {
    const { rows, error } = run(NO_POST, db(), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(names(rows)).toEqual(['barbara']);
  });

  it('chooses an algorithm by cost when none is forced, and returns the same rows', () => {
    expect(names(run(HAS_POST).rows)).toEqual(names(run(HAS_POST, db(), withJoin('nested-loop')).rows));
    expect(names(run(NO_POST).rows)).toEqual(['barbara']);
  });

  it.each(ALGORITHMS)("applies the subquery's own condition to its table — %s", (algorithm) => {
    const sql = 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id AND posts.id > 6)';
    const { rows, error } = run(sql, db(), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(names(rows)).toEqual(expectedAuthors(db(), (_a, posts) => posts.some((p) => Number(p.id) > 6)));
  });

  it.each(ALGORITHMS)('checks a condition naming both tables on each matched pair — %s', (algorithm) => {
    // A post whose id is below its author's id: only a residual, checked after the key matches, can test that.
    const sql = 'SELECT name FROM authors WHERE NOT EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id AND posts.id < authors.id)';
    const { rows, error } = run(sql, db(), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(names(rows)).toEqual(expectedAuthors(db(), (a, posts) => !posts.some((p) => Number(p.id) < Number(a.id))));
  });

  it('combines with the outer WHERE, GROUP BY, ORDER BY and LIMIT above it', () => {
    const counted = run('SELECT COUNT(*) FROM authors WHERE id > 1 AND EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)');
    expect(counted.error).toBeUndefined();
    expect(counted.rows).toEqual([{ 'COUNT(*)': expectedAuthors(db(), (a, posts) => Number(a.id) > 1 && posts.length > 0).length }]);

    const ordered = run(`${HAS_POST} ORDER BY name DESC LIMIT 2`);
    expect(ordered.error).toBeUndefined();
    expect(ordered.rows.map((r) => r.name)).toEqual(expectedAuthors(db(), (_a, posts) => posts.length > 0).reverse().slice(0, 2));
  });

  it.each(ALGORITHMS)('stacks two, on two tables: a semi-join and an anti-join one above the other — %s', (algorithm) => {
    const database = db();
    database.tables.comments = { name: 'comments', columns: ['id', 'authorId'], rows: [{ id: 1, authorId: 1 }, { id: 2, authorId: 3 }] };
    const sql =
      'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id) AND NOT EXISTS (SELECT * FROM comments WHERE comments.authorId = authors.id)';
    const { rows, error, events } = run(sql, database, withJoin(algorithm));
    expect(error).toBeUndefined();
    const commented = new Set([1, 3]);
    expect(names(rows)).toEqual(expectedAuthors(db(), (a, posts) => posts.length > 0 && !commented.has(Number(a.id))));
    const plan = finalPlan(events);
    expect(plan?.children?.[0]?.label).toMatch(/^Anti-join .* authors ▷ comments/);
    expect(plan?.children?.[0]?.children?.[0]?.label).toMatch(/^Semi-join .* authors ⋉ posts/);
  });

  it('sits on top of a JOIN in the outer query, correlated with either of its tables', () => {
    const database = db();
    database.tables.comments = {
      name: 'comments',
      columns: ['id', 'postId'],
      rows: [{ id: 1, postId: 1 }, { id: 2, postId: 1 }, { id: 3, postId: 4 }],
    };
    const sql =
      'SELECT authors.name, posts.id FROM authors JOIN posts ON authors.id = posts.authorId WHERE EXISTS (SELECT * FROM comments WHERE comments.postId = posts.id)';
    for (const algorithm of ALGORITHMS) {
      const { rows, error } = run(sql, database, withJoin(algorithm));
      expect(error).toBeUndefined();
      expect(rows.map((r) => r['posts.id']).sort()).toEqual([1, 4]);
    }
  });
});

describe('EXISTS — NULLs, and how NOT EXISTS differs from NOT IN', () => {
  /** A post with no author, and an author with no id. */
  const withNulls = (): Database => {
    const database = db();
    database.tables.posts!.rows.push({ id: 11, authorId: null, title: 'anonymous' });
    database.tables.authors!.rows.push({ id: null, name: 'nobody' });
    return database;
  };

  it.each(ALGORITHMS)('NOT EXISTS keeps an author whose id is NULL, and is untouched by a post whose author is NULL — %s', (algorithm) => {
    const { rows, error } = run(NO_POST, withNulls(), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(names(rows)).toEqual(['barbara', 'nobody']);
  });

  it.each(ALGORITHMS)('EXISTS never matches on a NULL key — %s', (algorithm) => {
    const { rows } = run(HAS_POST, withNulls(), withJoin(algorithm));
    expect(names(rows)).toEqual(expectedAuthors(db(), (_a, posts) => posts.length > 0));
  });

  it('…while NOT IN over the same posts returns no one at all, once one of them has a NULL author', () => {
    const { rows, error } = run('SELECT name FROM authors WHERE id NOT IN (SELECT authorId FROM posts)', withNulls());
    expect(error).toBeUndefined();
    expect(rows).toEqual([]);
  });
});

describe('EXISTS — uncorrelated: run once, before planning', () => {
  it.each([
    ['EXISTS that finds a row', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.id = 3)', 5],
    ['EXISTS that finds none', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.id > 100)', 0],
    ['NOT EXISTS that finds a row', 'SELECT name FROM authors WHERE NOT EXISTS (SELECT * FROM posts WHERE posts.id = 3)', 0],
    ['NOT EXISTS that finds none', 'SELECT name FROM authors WHERE NOT EXISTS (SELECT * FROM posts WHERE posts.id > 100)', 5],
    ['EXISTS over a whole table', 'SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts)', 5],
  ] as const)('%s', (_label, sql, count) => {
    const { rows, error, events } = run(sql);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(count);
    // No join: the subquery's answer is a fact about the whole query, said once in the WHERE narration.
    const plan = finalPlan(events);
    expect(JSON.stringify(plan)).not.toMatch(/Semi-join|Anti-join/);
    expect(events.some((e) => e.stage === 'plan' && /already ran once, before this plan was built, stopping at the first row/.test(e.label))).toBe(true);
  });

  it('runs the subquery with LIMIT 1 — one row settles it', () => {
    const seen: string[] = [];
    const parsed = parse('SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.id > 2)');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const resolved = resolveExists(parsed.ast, (sql) => {
      seen.push(sql);
      return run(sql);
    });
    expect(resolved.ok).toBe(true);
    expect(seen).toEqual(['SELECT * FROM posts WHERE id > 2 LIMIT 1']);
  });
});

describe('EXISTS — the plan', () => {
  it('becomes a semi-join or an anti-join on the correlation equality, and leaves WHERE', () => {
    const parsed = parse(`${NO_POST} AND id > 1`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const resolved = resolveExists(parsed.ast, (s) => run(s));
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.value.semiJoins).toHaveLength(1);
    expect(resolved.value.semiJoins?.[0]).toMatchObject({ kind: 'anti', outerTable: 'authors', outerColumn: 'id', innerColumn: 'authorId' });
    expect(resolved.value.where && exprToSql(resolved.value.where)).toBe('id > 1');

    const [join] = joinsIn(buildPlan(resolved.value));
    expect(join).toMatchObject({ op: 'Join', joinType: 'anti', leftTable: 'authors', rightTable: 'posts', leftColumn: 'id', rightColumn: 'authorId' });
  });

  it("puts the subquery's own condition on its scan and the rest in the join's residual", () => {
    const join = semiJoinOf('SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.id > 6 AND posts.authorId = authors.id AND posts.id < authors.id)');
    expect(join.right).toMatchObject({ op: 'SeqScan', table: 'posts' });
    expect(join.right.op === 'SeqScan' && join.right.filter && exprToSql(join.right.filter)).toBe('id > 6');
    expect(join.residual && exprToSql(join.residual)).toBe('posts.id < authors.id');
  });

  it("pushes the outer WHERE into the outer table's scan, below the semi-join", () => {
    const { events } = run(`${HAS_POST} AND id > 2`);
    const plan = finalPlan(events);
    const join = plan?.children?.[0];
    expect(join?.label).toMatch(/^Semi-join/);
    expect(join?.children?.[0]).toMatchObject({ op: 'SeqScan', detail: 'filter: id > 2' });
    expect(events.some((e) => e.stage === 'optimize' && e.rule === 'join-predicate-pushdown')).toBe(true);
  });

  it("still pushes the outer WHERE down when the subquery's own condition already filters the inner scan", () => {
    const { events, rows } = run('SELECT name FROM authors WHERE id > 2 AND EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id AND posts.id > 3)');
    const join = finalPlan(events)?.children?.[0];
    expect(join?.children?.[0]).toMatchObject({ op: 'SeqScan', detail: 'filter: id > 2' });
    expect(join?.children?.[1]).toMatchObject({ op: 'SeqScan', detail: 'filter: id > 3' });
    expect(names(rows)).toEqual(expectedAuthors(db(), (a, posts) => Number(a.id) > 2 && posts.some((p) => Number(p.id) > 3)));
  });

  it('refuses a subquery correlated only through something other than an equality, saying why', () => {
    const { error } = run('SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.authorId > authors.id)');
    expect(error?.message).toMatch(/without an equality QueryLens can join on/);
    expect(error?.hint).toMatch(/semi-join on one equality/);
  });

  it('reports a missing subquery table or column the way a JOIN does', () => {
    expect(run('SELECT name FROM authors WHERE EXISTS (SELECT * FROM comments WHERE comments.postId = authors.id)').error?.message).toMatch(
      /no table called `comments`/,
    );
    expect(run('SELECT name FROM authors WHERE EXISTS (SELECT * FROM posts WHERE posts.nope = authors.id)').error?.message).toMatch(
      /`posts` has no column called `nope`/,
    );
  });

  it('narrates why a correlated subquery is a join, and what each kind keeps', () => {
    const semi = run(HAS_POST).events.find((e) => e.stage === 'plan' && /semi-join \(⋉\)/.test(e.label));
    expect(semi?.label).toMatch(/kept once, however many match/);
    const anti = run(NO_POST).events.find((e) => e.stage === 'plan' && /anti-join \(▷\)/.test(e.label));
    expect(anti?.label).toMatch(/unlike NOT IN/);
  });

  it('a nested-loop semi-join stops reading the inner table at the first match', () => {
    const events = run(HAS_POST, db(), withJoin('nested-loop')).events;
    const postRowsRead = events.filter((e) => e.stage === 'execute' && e.op === 'SeqScan' && e.table === 'posts').length;
    const everyPair = db().tables.authors!.rows.length * db().tables.posts!.rows.length;
    expect(postRowsRead).toBeLessThan(everyPair);
    expect(events.some((e) => e.stage === 'execute' && /the rest of posts is not read for it/.test(e.label))).toBe(true);
  });

  it('estimates a semi-join at no more than its outer rows, and an anti-join as the rest', () => {
    const database = db();
    const tables = { posts: database.tables.posts! };
    const semi = rootEstimate(semiJoinOf(HAS_POST), database.tables.authors!, 4, tables).estRows;
    const anti = rootEstimate(semiJoinOf(NO_POST), database.tables.authors!, 4, tables).estRows;
    expect(semi).toBeLessThanOrEqual(5);
    expect(semi + anti).toBe(5);
    // Four distinct authorIds among the posts against five distinct author ids: containment says 4 of 5 match.
    expect(semi).toBe(4);
  });

  it('reads as ⋉ and ▷ in relational algebra, and in LaTeX', () => {
    const display = (sql: string): PlanNode => {
      const plan = finalPlan(run(sql).events);
      if (!plan) throw new Error('no plan');
      return plan;
    };
    expect(planToRelationalAlgebra(display(HAS_POST))).toMatch(/authors ⋉_\{authors\.id = posts\.authorId\} posts/);
    expect(planToRelationalAlgebra(display(NO_POST))).toMatch(/authors ▷_\{authors\.id = posts\.authorId\} posts/);
    expect(planToLatex(display(HAS_POST))).toMatch(/\\ltimes_/);
    expect(planToLatex(display(NO_POST))).toMatch(/\\triangleright_/);
    expect(toPlanDisplay(semiJoinOf(NO_POST)).ra?.symbol).toBe('▷');
    expect(toPlanDisplay(semiJoinOf(HAS_POST)).ra?.symbol).toBe('⋉');
  });

  it('shows as a Semi-join / Anti-join line in EXPLAIN, with actual rows under ANALYZE', () => {
    const explained = run(`EXPLAIN ANALYZE ${NO_POST}`);
    expect(explained.error).toBeUndefined();
    const lines = explained.rows.map((r) => String(Object.values(r)[0]));
    expect(lines.some((l) => /Anti-join \(\S+\) authors ▷ posts/.test(l) && /actual 1 rows/.test(l))).toBe(true);
  });
});

describe('EXISTS — elsewhere in the engine', () => {
  it.each([
    ['no concurrency control', undefined],
    ['row locks', { granularity: 'row' }],
    ['versions and snapshots', { granularity: 'row', mvcc: true }],
  ] as const)('a schedule step with EXISTS runs under %s, locking as if every row might match', (_label, locking) => {
    const result = runSchedule([{ session: 'A', sql: HAS_POST }], db(), DEFAULT_ENGINE_OPTIONS, locking);
    const step = result.steps[0];
    expect(step?.error).toBeUndefined();
    expect(step?.rows.map((r) => String(r.name)).sort()).toEqual(expectedAuthors(db(), (_a, posts) => posts.length > 0));
  });
});
