import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createJoinDemoDatabase } from '../seed.ts';
import { parse, parseStatement } from '../parser/index.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { rootEstimate } from '../planner/cost.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions } from '../types.ts';

const db = () => createJoinDemoDatabase();
const run = (sql: string, database: Database = db(), options: EngineOptions = DEFAULT_ENGINE_OPTIONS) =>
  runQuery(sql, database, options);
const HASH = { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'hash' } as const;

describe('JOIN — parsing', () => {
  it('parses a qualified ON clause into a JoinClause', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.ast.join).toBeDefined();
    expect(parsed.ast.join?.table.name).toBe('posts');
    expect(parsed.ast.join?.on.op).toBe('=');
  });

  it('accepts the ON equality in either order', () => {
    const a = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const b = parse('SELECT * FROM authors JOIN posts ON posts.authorId = authors.id');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('parses a qualified SELECT item and WHERE column', () => {
    const parsed = parse(
      "SELECT authors.name FROM authors JOIN posts ON authors.id = posts.authorId WHERE posts.title = 'x'",
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.ast.select.kind).toBe('columns');
    if (parsed.ast.select.kind === 'columns') {
      expect(parsed.ast.select.items[0]).toMatchObject({ kind: 'column', name: 'name', table: 'authors' });
    }
    expect(parsed.ast.where).toMatchObject({
      kind: 'compare',
      left: { kind: 'column', name: 'title', table: 'posts' },
    });
  });

  it('rejects an unqualified column once a JOIN is present', () => {
    const parsed = parse('SELECT name FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/needs a table name/);
  });

  it('rejects a table qualifier on a query with no JOIN at all', () => {
    const parsed = parse('SELECT authors.name FROM authors');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/does not need a table name/);
  });

  it('rejects a qualifier naming a table the query never mentions', () => {
    const parsed = parse('SELECT bogus.name FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/no table called `bogus`/);
  });

  it('rejects ON with anything but an equality', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id > posts.authorId');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/only supports an equality/);
  });

  it('rejects ON with a literal operand', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = 5');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/qualified column/);
  });

  it('rejects an aggregate SELECT item combined with JOIN', () => {
    const parsed = parse('SELECT COUNT(*) FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/aggregate function is not supported/);
  });

  it('rejects GROUP BY combined with JOIN', () => {
    const parsed = parse(
      'SELECT authors.name FROM authors JOIN posts ON authors.id = posts.authorId GROUP BY authors.name',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/GROUP BY is not supported yet in a query with JOIN/);
  });

  it('rejects ORDER BY combined with JOIN', () => {
    const parsed = parse(
      'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId ORDER BY authors.name',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/ORDER BY is not supported yet in a query with JOIN/);
  });

  it.each(['INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS'])(
    '%s JOIN stays out of scope — only a bare, implicit inner JOIN parses',
    (word) => {
      const parsed = parse(`SELECT * FROM authors ${word} JOIN posts ON authors.id = posts.authorId`);
      expect(parsed.ok).toBe(false);
    },
  );

  it('USING stays out of scope', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts USING (id)');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.hint).toMatch(/USING is not in the v0 subset/);
  });

  it('parseStatement (the broader entry point) accepts JOIN the same way parse does', () => {
    const parsed = parseStatement('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(parsed.ok).toBe(true);
  });
});

describe('JOIN — plan and cost', () => {
  it('buildPlan produces a Join node with both sides resolved', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast);
    if (plan.op !== 'Project' || plan.child.op !== 'Join') throw new Error('expected Project -> Join');
    const join = plan.child;
    expect(join.algorithm).toBe('nested-loop');
    expect(join.leftTable).toBe('authors');
    expect(join.rightTable).toBe('posts');
    expect(join.leftColumn).toBe('id');
    expect(join.rightColumn).toBe('authorId');
    expect(join.left).toEqual({ op: 'SeqScan', table: 'authors' });
    expect(join.right).toEqual({ op: 'SeqScan', table: 'posts' });
  });

  it('resolves leftColumn/rightColumn correctly regardless of ON order', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON posts.authorId = authors.id');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast);
    if (plan.op !== 'Project' || plan.child.op !== 'Join') throw new Error('expected Project -> Join');
    expect(plan.child.leftColumn).toBe('id');
    expect(plan.child.rightColumn).toBe('authorId');
  });

  it('estimates a Join\'s rows as left × right / ndistinct(right key), and pages honestly as a full rescan per left row', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast);
    const { authors, posts } = db().tables;
    const est = rootEstimate(plan, authors!, 4, { posts: posts! });
    // 5 authors, 10 posts, 4 distinct authorIds among them.
    expect(est.estRows).toBe(Math.round((5 * 10) / 4));
    // Left is 2 pages (5 rows / 4 per page); posts is 3 pages (10 rows / 4
    // per page). Nested-loop reads the left once and rescans the right once
    // per left row: 2 + 5*3.
    expect(est.estPages).toBe(2 + 5 * 3);
  });

  it('buildPlan honours a joinStrategy of "hash"', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast, undefined, 'hash');
    if (plan.op !== 'Project' || plan.child.op !== 'Join') throw new Error('expected Project -> Join');
    expect(plan.child.algorithm).toBe('hash');
  });

  it('prices a hash join as reading each side once, not a rescan per left row', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast, undefined, 'hash');
    const { authors, posts } = db().tables;
    const est = rootEstimate(plan, authors!, 4, { posts: posts! });
    // Same row estimate as nested-loop — the algorithm changes I/O, not cardinality.
    expect(est.estRows).toBe(Math.round((5 * 10) / 4));
    // authors is 2 pages, posts is 3 — a hash join reads each exactly once: 2 + 3.
    expect(est.estPages).toBe(2 + 3);
  });
});

describe('JOIN — pipeline correctness', () => {
  it('matches every row whose join columns are equal, and only those', () => {
    const { rows } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const { authors, posts } = db().tables;
    const expected = posts!.rows.flatMap((post) => {
      const author = authors!.rows.find((a) => a.id === post.authorId);
      return author ? [{ author, post }] : [];
    });
    expect(rows).toHaveLength(expected.length);
    for (const { author, post } of expected) {
      expect(
        rows.some(
          (r) =>
            r['authors.id'] === author.id &&
            r['authors.name'] === author.name &&
            r['posts.id'] === post.id &&
            r['posts.title'] === post.title,
        ),
      ).toBe(true);
    }
  });

  it('SELECT * qualifies every column with its table, so same-named columns never collide', () => {
    const { rows } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['authors.id', 'authors.name', 'posts.id', 'posts.authorId', 'posts.title'].sort(),
      );
    }
  });

  it('a qualified SELECT list keeps only the named columns', () => {
    const { rows } = run('SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['authors.name', 'posts.title']);
  });

  it('WHERE filters the joined result, evaluated after the join (a residual, not pushed into either scan)', () => {
    const all = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const filtered = run("SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'");
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.length).toBeLessThan(all.rows.length);
    expect(filtered.rows.every((r) => r['authors.name'] === 'ada')).toBe(true);
  });

  it('LIMIT caps the joined result and short-circuits the nested loop', () => {
    const { rows, events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId LIMIT 1');
    expect(rows).toHaveLength(1);
    const joinEvents = events.filter((e) => e.stage === 'execute' && e.op === 'Join');
    expect(joinEvents).toHaveLength(1);
  });

  it('an author with no posts contributes no row — inner join semantics', () => {
    const { authors } = db().tables;
    const lonely = authors!.rows.find((a) => !db().tables.posts!.rows.some((p) => p.authorId === a.id));
    expect(lonely).toBeDefined();
    const { rows } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(rows.some((r) => r['authors.id'] === lonely!.id)).toBe(false);
  });

  it('a NULL join key matches nothing, on either side', () => {
    const nullDb: Database = {
      tables: {
        a: { name: 'a', columns: ['id', 'k'], rows: [{ id: 1, k: null }, { id: 2, k: 1 }] },
        b: { name: 'b', columns: ['id', 'k'], rows: [{ id: 1, k: null }, { id: 2, k: 1 }] },
      },
    };
    const { rows } = runQuery('SELECT * FROM a JOIN b ON a.k = b.k', nullDb);
    expect(rows).toEqual([{ 'a.id': 2, 'a.k': 1, 'b.id': 2, 'b.k': 1 }]);
  });

  it('produces zero rows, not an error, when nothing matches', () => {
    const noMatch: Database = {
      tables: {
        a: { name: 'a', columns: ['id'], rows: [{ id: 1 }] },
        b: { name: 'b', columns: ['id', 'aId'], rows: [{ id: 1, aId: 999 }] },
      },
    };
    expect(runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', noMatch).rows).toEqual([]);
  });

  it('rejects an unknown JOIN table with the same shape as an unknown FROM table', () => {
    const out = run('SELECT * FROM authors JOIN bogus ON authors.id = bogus.id');
    expect(out.error?.message).toMatch(/no table called `bogus`/);
    expect(out.error?.hint).toMatch(/Tables:/);
  });

  it('rejects an unknown column on the JOIN table, naming that table specifically', () => {
    const out = run('SELECT * FROM authors JOIN posts ON authors.id = posts.bogus');
    expect(out.error?.message).toMatch(/`posts` has no column called `bogus`/);
  });

  it('rejects an unknown column on the FROM side of a JOIN query the same way', () => {
    const out = run('SELECT * FROM authors JOIN posts ON authors.bogus = posts.authorId');
    expect(out.error?.message).toMatch(/`authors` has no column called `bogus`/);
  });
});

describe('JOIN — the pipeline narrates it', () => {
  it('narrates a Join execute stage, above both scans', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const joinEvents = events.filter((e) => e.stage === 'execute' && e.op === 'Join');
    expect(joinEvents.length).toBeGreaterThan(0);
    const seqScans = new Set(
      events.flatMap((e) => (e.stage === 'execute' && e.op === 'SeqScan' ? [e.op] : [])),
    );
    expect(seqScans.has('SeqScan')).toBe(true);
  });

  it('the two tables genuinely share one buffer pool — the right side\'s pages are numbered after the left\'s', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const pageIds = new Set(
      events.flatMap((e) => (e.stage === 'buffer' && (e.action === 'hit' || e.action === 'load' || e.action === 'miss') ? [e.pageId] : [])),
    );
    // authors is 2 pages (0, 1); posts' pages must start at 2, never reusing 0/1.
    expect(pageIds.has(0)).toBe(true);
    expect(pageIds.has(1)).toBe(true);
    expect([...pageIds].some((id) => id >= 2)).toBe(true);
  });

  it('is deterministic — the same JOIN query twice gives byte-identical traces', () => {
    const a = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const b = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    expect(structuredClone(events)).toEqual(events);
  });

  it('no optimizer rule fires on a JOIN plan yet — nested-loop over two full scans is the only plan v1 has', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['none']);
  });
});

describe('JOIN — hash join (the second algorithm)', () => {
  it('agrees with nested-loop on the exact same result set', () => {
    const nested = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const hashed = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), HASH);
    const sortRows = (rs: readonly Record<string, unknown>[]) =>
      [...rs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(sortRows(hashed.rows)).toEqual(sortRows(nested.rows));
  });

  it('agrees with nested-loop when WHERE filters the joined result', () => {
    const sql = "SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'";
    const nested = run(sql);
    const hashed = run(sql, db(), HASH);
    expect(hashed.rows.length).toBe(nested.rows.length);
    expect(hashed.rows.length).toBeGreaterThan(0);
  });

  it('a NULL join key matches nothing under hash join either', () => {
    const nullDb: Database = {
      tables: {
        a: { name: 'a', columns: ['id', 'k'], rows: [{ id: 1, k: null }, { id: 2, k: 1 }] },
        b: { name: 'b', columns: ['id', 'k'], rows: [{ id: 1, k: null }, { id: 2, k: 1 }] },
      },
    };
    const { rows } = runQuery('SELECT * FROM a JOIN b ON a.k = b.k', nullDb, HASH);
    expect(rows).toEqual([{ 'a.id': 2, 'a.k': 1, 'b.id': 2, 'b.k': 1 }]);
  });

  it('produces zero rows, not an error, when nothing matches', () => {
    const noMatch: Database = {
      tables: {
        a: { name: 'a', columns: ['id'], rows: [{ id: 1 }] },
        b: { name: 'b', columns: ['id', 'aId'], rows: [{ id: 1, aId: 999 }] },
      },
    };
    expect(runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', noMatch, HASH).rows).toEqual([]);
  });

  it('a mismatched-type join key that nested-loop would still match, hash join also matches', () => {
    // `compare('=', ...)` coerces a number and a numeric string to equal
    // (plan.md §22.2's `evaluate.ts`) — the hash join's key must agree, or
    // the two algorithms would silently disagree on which rows match.
    const mixedDb: Database = {
      tables: {
        a: { name: 'a', columns: ['id'], rows: [{ id: 5 }] },
        b: { name: 'b', columns: ['id', 'aId'], rows: [{ id: 1, aId: '5' }] },
      },
    };
    const nested = runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', mixedDb);
    const hashed = runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', mixedDb, HASH);
    expect(nested.rows).toHaveLength(1);
    expect(hashed.rows).toEqual(nested.rows);
  });

  it('LIMIT still caps the result, pulled through the probe phase one row at a time', () => {
    const { rows } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId LIMIT 1', db(), HASH);
    expect(rows).toHaveLength(1);
  });

  it('narrates a build step (the hash table) before any probe match', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), HASH);
    const joinLabels = events.flatMap((e) => (e.stage === 'execute' && e.op === 'Join' ? [e.label] : []));
    expect(joinLabels[0]).toMatch(/builds an in-memory hash table/);
    expect(joinLabels.slice(1).every((label) => /probes the hash table/.test(label))).toBe(true);
  });

  it('reads each table once — no repeated page loads the way nested-loop rescans', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), HASH);
    const loads = events.flatMap((e) => (e.stage === 'buffer' && e.action === 'load' ? [e.pageId] : []));
    // authors: 2 pages, posts: 3 pages — each loaded at most once from disk.
    expect(new Set(loads).size).toBe(loads.length);
  });

  it('is deterministic — the same query twice gives byte-identical traces', () => {
    const a = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), HASH);
    const b = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), HASH);
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });
});
