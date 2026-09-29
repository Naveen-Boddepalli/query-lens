import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createJoinDemoDatabase } from '../seed.ts';
import { parse, parseStatement } from '../parser/index.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { rootEstimate } from '../planner/cost.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions, PlanNode } from '../types.ts';

const db = () => createJoinDemoDatabase();
const run = (sql: string, database: Database = db(), options: EngineOptions = DEFAULT_ENGINE_OPTIONS) =>
  runQuery(sql, database, options);
const HASH = { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'hash' } as const;
const SORT_MERGE = { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'sort-merge' } as const;
const sortRows = (rs: readonly Record<string, unknown>[]) =>
  [...rs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('JOIN — parsing', () => {
  it('parses a qualified ON clause into a JoinClause', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.ast.joins).toBeDefined();
    expect(parsed.ast.joins?.[0]?.table.name).toBe('posts');
    expect(parsed.ast.joins?.[0]?.on.op).toBe('=');
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

  it.each(['INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN'])(
    '%s parses (plan.md §25.4 C3)',
    (words) => {
      const parsed = parse(`SELECT * FROM authors ${words} posts ON authors.id = posts.authorId`);
      expect(parsed.ok, !parsed.ok ? parsed.error.message : undefined).toBe(true);
    },
  );

  it.each(['RIGHT', 'FULL', 'CROSS'])(
    '%s JOIN stays out of scope',
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

  it('buildPlan honours a joinStrategy of "sort-merge"', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast, undefined, 'sort-merge');
    if (plan.op !== 'Project' || plan.child.op !== 'Join') throw new Error('expected Project -> Join');
    expect(plan.child.algorithm).toBe('sort-merge');
  });

  it('prices a sort-merge join as reading each side once plus both sides\' own spill', () => {
    const parsed = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const plan = buildPlan(parsed.ast, undefined, 'sort-merge');
    const { authors, posts } = db().tables;
    const est = rootEstimate(plan, authors!, 4, { posts: posts! });
    // Same row estimate as the other two — the algorithm changes I/O, not cardinality.
    expect(est.estRows).toBe(Math.round((5 * 10) / 4));
    // authors: 2 heap pages + 2*ceil(5/4)=2*2 spill; posts: 3 heap pages + 2*ceil(10/4)=2*3 spill.
    expect(est.estPages).toBe(2 + 3 + 2 * 2 + 2 * 3);
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

  it('WHERE filters the joined result correctly, whether or not it gets pushed into a scan', () => {
    const all = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const filtered = run("SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'");
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.length).toBeLessThan(all.rows.length);
    expect(filtered.rows.every((r) => r['authors.name'] === 'ada')).toBe(true);
  });

  it('a conjunct naming both sides stays a residual Filter above the Join — it cannot be pushed into either scan', () => {
    // `authors.id = posts.authorId` names both tables, so it can only be
    // checked once a row from each side is already paired — restating the
    // ON clause in WHERE changes nothing here.
    const all = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const restated = run(
      'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.id = posts.authorId',
    );
    expect(restated.rows.length).toBe(all.rows.length);
    const rules = restated.events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['none']);
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

describe('JOIN — predicate pushdown into a Join\'s own children', () => {
  it('pushes a conjunct naming only the left table into the left SeqScan', () => {
    const sql = "SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'";
    const { rows, events } = run(sql);
    const baseline = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const expected = baseline.rows.filter((r) => r['authors.name'] === 'ada');
    expect(sortRows(rows)).toEqual(sortRows(expected));

    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['join-predicate-pushdown']);
    const tree = events.find((e) => e.stage === 'optimize')!.after;
    const leftScan = tree.children![0]!.children![0]!;
    expect(leftScan.label).toBe('SeqScan authors');
    // Unqualified — a scan reads that table's own raw rows, never `authors.name`.
    expect(leftScan.detail).toBe("filter: name = 'ada'");
    const rightScan = tree.children![0]!.children![1]!;
    expect(rightScan.detail).toBeUndefined();
  });

  it('pushes a conjunct naming only the right table into the right SeqScan', () => {
    const sql = 'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE posts.id = 3';
    const { rows, events } = run(sql);
    const baseline = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const expected = baseline.rows.filter((r) => r['posts.id'] === 3);
    expect(sortRows(rows)).toEqual(sortRows(expected));
    expect(rows.length).toBeGreaterThan(0);

    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['join-predicate-pushdown']);
    const tree = events.find((e) => e.stage === 'optimize')!.after;
    const rightScan = tree.children![0]!.children![1]!;
    expect(rightScan.label).toBe('SeqScan posts');
    expect(rightScan.detail).toBe('filter: id = 3');
  });

  it('splits a two-sided WHERE, pushing each conjunct to its own side, with nothing left over', () => {
    const sql = "SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada' AND posts.id = 3";
    const { rows, events } = run(sql);
    const baseline = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const expected = baseline.rows.filter((r) => r['authors.name'] === 'ada' && r['posts.id'] === 3);
    expect(sortRows(rows)).toEqual(sortRows(expected));

    const optimizeEvents = events.filter((e) => e.stage === 'optimize');
    expect(optimizeEvents.map((e) => e.rule)).toEqual(['join-predicate-pushdown']);
    // No Filter node survives above the Join — both conjuncts had a home.
    const tree = optimizeEvents[0]!.after;
    expect(tree.op).toBe('Project');
    expect(tree.children![0]!.op).toBe('Join');
  });

  it('leaves a conjunct naming both tables as a residual Filter above the Join', () => {
    const sql = 'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.id = posts.authorId';
    const { events } = run(sql);
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['none']);
  });

  it('cost estimates the Join against the filtered left side\'s row count, not the whole table', () => {
    const sql = "SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'";
    const { events } = run(sql);
    const tree = events.find((e) => e.stage === 'optimize')!.after;
    const leftScan = tree.children![0]!.children![0]!;
    // authors has 5 rows, 1 of them named 'ada' — the same 1/5 selectivity
    // `index-selection` prices an equality at, applied here to a scan instead.
    expect(leftScan.estRows).toBe(1);
    expect(tree.children![0]!.estBasis).toMatch(/^1 × 10 \/ ndistinct/);
  });

  it('agrees with a plain client-side filter of the unfiltered baseline, across all three join algorithms', () => {
    const sql = "SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'";
    const nested = run(sql);
    const hashed = run(sql, db(), HASH);
    const merged = run(sql, db(), SORT_MERGE);
    expect(sortRows(hashed.rows)).toEqual(sortRows(nested.rows));
    expect(sortRows(merged.rows)).toEqual(sortRows(nested.rows));
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

  it('no optimizer rule fires on an unfiltered JOIN — nothing to push down with no WHERE clause', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['none']);
  });
});

describe('JOIN — hash join (the second algorithm)', () => {
  it('agrees with nested-loop on the exact same result set', () => {
    const nested = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const hashed = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), HASH);
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

describe('JOIN — sort-merge join (the third algorithm)', () => {
  it('agrees with nested-loop on the exact same result set', () => {
    const nested = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    const merged = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), SORT_MERGE);
    expect(sortRows(merged.rows)).toEqual(sortRows(nested.rows));
  });

  it('agrees with nested-loop when WHERE filters the joined result', () => {
    const sql = "SELECT * FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'";
    const nested = run(sql);
    const merged = run(sql, db(), SORT_MERGE);
    expect(merged.rows.length).toBe(nested.rows.length);
    expect(merged.rows.length).toBeGreaterThan(0);
  });

  it('a NULL join key matches nothing under sort-merge join either', () => {
    const nullDb: Database = {
      tables: {
        a: { name: 'a', columns: ['id', 'k'], rows: [{ id: 1, k: null }, { id: 2, k: 1 }] },
        b: { name: 'b', columns: ['id', 'k'], rows: [{ id: 1, k: null }, { id: 2, k: 1 }] },
      },
    };
    const { rows } = runQuery('SELECT * FROM a JOIN b ON a.k = b.k', nullDb, SORT_MERGE);
    expect(rows).toEqual([{ 'a.id': 2, 'a.k': 1, 'b.id': 2, 'b.k': 1 }]);
  });

  it('produces zero rows, not an error, when nothing matches', () => {
    const noMatch: Database = {
      tables: {
        a: { name: 'a', columns: ['id'], rows: [{ id: 1 }] },
        b: { name: 'b', columns: ['id', 'aId'], rows: [{ id: 1, aId: 999 }] },
      },
    };
    expect(runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', noMatch, SORT_MERGE).rows).toEqual([]);
  });

  it('a mismatched-type join key that nested-loop would still match, sort-merge also matches', () => {
    // The sort key must coerce the exact way `equalityKeyOf` does, or a
    // number and a numeric string could sort apart instead of adjacent —
    // silently missing a match `compare('=', ...)` says is real.
    const mixedDb: Database = {
      tables: {
        a: { name: 'a', columns: ['id'], rows: [{ id: 5 }] },
        b: { name: 'b', columns: ['id', 'aId'], rows: [{ id: 1, aId: '5' }] },
      },
    };
    const nested = runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', mixedDb);
    const merged = runQuery('SELECT * FROM a JOIN b ON a.id = b.aId', mixedDb, SORT_MERGE);
    expect(nested.rows).toHaveLength(1);
    expect(merged.rows).toEqual(nested.rows);
  });

  it('a repeated key on both sides produces the full cross product, matching nested-loop', () => {
    // Neither side's join column is unique here — the textbook refinement a
    // plain two-pointer merge misses: every left row sharing a key must pair
    // with every right row sharing it, not just the first one found.
    const dupDb: Database = {
      tables: {
        a: { name: 'a', columns: ['id', 'k'], rows: [{ id: 1, k: 5 }, { id: 2, k: 5 }, { id: 3, k: 9 }] },
        b: { name: 'b', columns: ['id', 'k'], rows: [{ id: 1, k: 5 }, { id: 2, k: 5 }, { id: 3, k: 5 }] },
      },
    };
    const sql = 'SELECT * FROM a JOIN b ON a.k = b.k';
    const nested = runQuery(sql, dupDb);
    const merged = runQuery(sql, dupDb, SORT_MERGE);
    // Two left rows (k=5) × three right rows (k=5) = 6 matches; a.id=3 (k=9) matches nothing.
    expect(nested.rows).toHaveLength(6);
    expect(sortRows(merged.rows)).toEqual(sortRows(nested.rows));
  });

  it('LIMIT still caps the result, even though both sides are fully sorted first', () => {
    const { rows } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId LIMIT 1', db(), SORT_MERGE);
    expect(rows).toHaveLength(1);
  });

  it('narrates a sort phase on both sides before any merge match', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), SORT_MERGE);
    const joinLabels = events.flatMap((e) => (e.stage === 'execute' && e.op === 'Join' ? [e.label] : []));
    const mergeStart = joinLabels.findIndex((label) => /merges a row from authors with one from posts/.test(label));
    expect(mergeStart).toBeGreaterThan(0);
    // Everything before the first match is sort-phase narration — each
    // side's own `externalMergeSort` call, then this operator's own summary.
    expect(joinLabels.slice(0, mergeStart).some((label) => /authors has to see every row/.test(label))).toBe(true);
    expect(joinLabels.slice(0, mergeStart).some((label) => /posts has to see every row/.test(label))).toBe(true);
    expect(joinLabels.slice(0, mergeStart).some((label) => /sorts authors and posts .* then merges/.test(label))).toBe(
      true,
    );
    // And every label from the first match onward is a merge match.
    expect(joinLabels.slice(mergeStart).every((label) => /merges a row from authors with one from posts/.test(label))).toBe(
      true,
    );
  });

  it('the right side\'s sort scratch never reuses a page id the left side\'s sort already claimed', () => {
    const { events } = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), SORT_MERGE);
    const written = events.flatMap((e) => (e.stage === 'buffer' && e.action === 'write' ? [e.pageId] : []));
    expect(new Set(written).size).toBe(written.length);
  });

  it('is deterministic — the same query twice gives byte-identical traces', () => {
    const a = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), SORT_MERGE);
    const b = run('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', db(), SORT_MERGE);
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });
});

describe('LEFT JOIN (plan.md §25.4 C3)', () => {
  // `barbara` (id 5) has no posts at all — seed.ts's own foreign-key shape, built for exactly this.
  const LEFT_SQL = 'SELECT authors.name, posts.title FROM authors LEFT JOIN posts ON authors.id = posts.authorId';
  const INDEX_NESTED_LOOP = { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'index-nested-loop' } as const;

  it('parses joinType onto the JoinClause, and a plain JOIN carries none', () => {
    const left = parse('SELECT * FROM authors LEFT JOIN posts ON authors.id = posts.authorId');
    if (!left.ok) throw new Error(left.error.message);
    expect(left.ast.joins?.[0]?.joinType).toBe('left');

    const inner = parse('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId');
    if (!inner.ok) throw new Error(inner.error.message);
    expect(inner.ast.joins?.[0]?.joinType).toBeUndefined();
  });

  it('keeps every author, NULL-padding the one with no posts — an inner JOIN would drop her', () => {
    const left = run(LEFT_SQL).rows;
    expect(left).toHaveLength(11); // 10 posts + barbara's one padded row
    expect(left.filter((r) => r['authors.name'] === 'barbara')).toEqual([{ 'authors.name': 'barbara', 'posts.title': null }]);

    const inner = run(LEFT_SQL.replace('LEFT JOIN', 'JOIN')).rows;
    expect(inner).toHaveLength(10);
    expect(inner.some((r) => r['authors.name'] === 'barbara')).toBe(false);
  });

  it('every matched author still shows her real posts, not NULLs', () => {
    const rows = run(LEFT_SQL).rows;
    const adas = rows.filter((r) => r['authors.name'] === 'ada');
    expect(adas).toHaveLength(3);
    expect(adas.every((r) => typeof r['posts.title'] === 'string')).toBe(true);
  });

  it('agrees across all four join algorithms — nested-loop, hash, sort-merge and index-nested-loop', () => {
    const asBag = (rows: readonly Record<string, unknown>[]) => sortRows(rows).map((r) => JSON.stringify(r));
    const nested = asBag(run(LEFT_SQL).rows);
    expect(asBag(run(LEFT_SQL, db(), HASH).rows)).toEqual(nested);
    expect(asBag(run(LEFT_SQL, db(), SORT_MERGE).rows)).toEqual(nested);
    expect(asBag(run(LEFT_SQL, db(), INDEX_NESTED_LOOP).rows)).toEqual(nested);
  });

  it('a NULL join key on the left is also kept, padded, by every algorithm — not silently dropped', () => {
    // NULL never matches NULL, so an author whose own join column is NULL could not match a post even if one
    // existed for it — an inner join drops the row entirely; a LEFT JOIN must still keep it, NULL-padded.
    const database = db();
    database.tables.authors!.rows.push({ id: null, name: 'null-key-author' });
    const sql = "SELECT authors.name, posts.title FROM authors LEFT JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'null-key-author'";
    for (const options of [DEFAULT_ENGINE_OPTIONS, HASH, SORT_MERGE, INDEX_NESTED_LOOP] as const) {
      const rows = run(sql, database, options).rows;
      expect(rows, JSON.stringify(options)).toEqual([{ 'authors.name': 'null-key-author', 'posts.title': null }]);
    }
  });

  it("a WHERE on the joined table is never pushed below the LEFT JOIN — it would silently turn it into an inner join", () => {
    // The classic pitfall: filtering `posts` down to nothing with a null title *before* the join would make every
    // author look unmatched. Pushed correctly, the join runs first and the residual Filter sees the real rows.
    const rows = run(`${LEFT_SQL} WHERE posts.title IS NULL`).rows;
    expect(rows).toEqual([{ 'authors.name': 'barbara', 'posts.title': null }]);
  });

  it('a WHERE on the outer (left) table is still pushed — filtering it first is always safe', () => {
    const { events, rows } = run(`${LEFT_SQL} WHERE authors.name = 'barbara'`);
    expect(rows).toEqual([{ 'authors.name': 'barbara', 'posts.title': null }]);
    const pushdown = events.find((e) => e.stage === 'optimize' && e.rule === 'join-predicate-pushdown');
    expect(pushdown?.label).toMatch(/moves into that scan/);
    expect(pushdown?.label).not.toMatch(/residual/); // nothing left to recheck once the whole predicate is pushed
  });

  it('the plan and the narration both say LEFT JOIN, not an ordinary join', () => {
    const { events } = run(LEFT_SQL);
    const planStep = events.find((e) => e.stage === 'plan' && /JOIN adds/.test(e.label));
    expect(planStep?.label).toMatch(/This is a LEFT JOIN/);
  });

  it("the cost model's estimate is at least the outer table's own row count — an inner-join guess would undercount it", () => {
    const { events } = run(LEFT_SQL);
    const planStep = events.filter((e) => e.stage === 'plan').at(-1)!;
    if (planStep.stage !== 'plan') throw new Error('unreachable');
    const joinNode = planStep.planTree.children?.find((n) => n.op === 'Join') ?? planStep.planTree;
    expect(joinNode.estRows).toBeGreaterThanOrEqual(5); // 5 authors, every one of them kept
  });

  it('RIGHT and FULL stay out of scope, with a hint pointing at LEFT JOIN or an inner one', () => {
    const right = parseStatement('SELECT * FROM authors RIGHT JOIN posts ON authors.id = posts.authorId');
    expect(right.ok).toBe(false);
    const full = parseStatement('SELECT * FROM authors FULL JOIN posts ON authors.id = posts.authorId');
    expect(full.ok).toBe(false);
  });
});

describe('multi-join (plan.md §25.4 C3 slice b)', () => {
  // A third table, local to this file — the seed's own authors/posts pair (seed.ts) is documented as staying a
  // pair, so a chain's third table is added here instead of growing that shared fixture. `postId` is deliberately
  // *not* indexed — every existing index lives on `posts` (`id`, `title`, `authorId`) — so a chain that asks for
  // `index-nested-loop` has to fall back to nested-loop at exactly this one step, proving the fallback is decided
  // per join step, not once for the whole query.
  const threeTableDb = (): Database => {
    const database = db();
    database.tables.comments = {
      name: 'comments',
      columns: ['id', 'postId', 'body'],
      rows: [
        { id: 1, postId: 1, body: 'nice' }, // ada's post 1
        { id: 2, postId: 1, body: 'great' }, // ada's post 1, a second comment
        { id: 3, postId: 4, body: 'cool' }, // donald's post 10 (POST_AUTHORS[3]=2 → post id 4 is alan's post 4)
      ],
    };
    return database;
  };
  const CHAIN_SQL =
    'SELECT authors.name, posts.title, comments.body FROM authors JOIN posts ON authors.id = posts.authorId JOIN comments ON posts.id = comments.postId';
  const INDEX_NESTED_LOOP = { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'index-nested-loop' } as const;

  it('parses a chain of JOINs into `joins`, in source order', () => {
    const parsed = parse(CHAIN_SQL);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.ast.joins).toHaveLength(2);
    expect(parsed.ast.joins?.map((j) => j.table.name)).toEqual(['posts', 'comments']);
  });

  it('rejects joining the same table twice — no aliasing to tell the two apart', () => {
    const result = parseStatement(
      'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId JOIN authors ON posts.id = authors.id',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/already in this query/);
  });

  it("rejects an ON clause that names neither the table it introduces nor a table already in scope", () => {
    // Both `authors` and `posts` are already known by the time `comments` joins in — neither side of this ON
    // names `comments` at all.
    const result = parseStatement(
      'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId JOIN comments ON authors.id = posts.id',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Neither side of ON names `comments`/);
  });

  it('rejects an ON clause naming a table not yet in the query', () => {
    const result = parseStatement('SELECT * FROM authors JOIN posts ON posts.authorId = missing.id');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/no table called `missing` yet/);
  });

  it("a later JOIN's ON may name an earlier table in the chain, not just the one just before it", () => {
    // `comments` joins against `authors.id`, skipping over `posts` entirely — still valid: `authors` is already
    // in scope by then, exactly as `posts` would be.
    const sql =
      'SELECT authors.name, comments.body FROM authors JOIN posts ON authors.id = posts.authorId JOIN comments ON authors.id = comments.postId';
    const { rows, error } = run(sql, threeTableDb());
    expect(error).toBeUndefined();
    // authors.id=1 (ada) has 3 posts × comments.postId=1's 2 comments = 6 rows.
    expect(rows.filter((r) => r['authors.name'] === 'ada')).toHaveLength(6);
  });

  it('joins three tables correctly — a real foreign-key chain, not just two joins bolted together', () => {
    const { rows, error } = run(CHAIN_SQL, threeTableDb());
    expect(error).toBeUndefined();
    expect(sortRows(rows)).toEqual(
      sortRows([
        { 'authors.name': 'ada', 'posts.title': "ada's post 1", 'comments.body': 'nice' },
        { 'authors.name': 'ada', 'posts.title': "ada's post 1", 'comments.body': 'great' },
        { 'authors.name': 'alan', 'posts.title': "alan's post 4", 'comments.body': 'cool' },
      ]),
    );
  });

  it('agrees across all four join algorithms on the same three-table chain', () => {
    const asBag = (rows: readonly Record<string, unknown>[]) => sortRows(rows).map((r) => JSON.stringify(r));
    const nested = asBag(run(CHAIN_SQL, threeTableDb()).rows);
    expect(nested.length).toBeGreaterThan(0);
    expect(asBag(run(CHAIN_SQL, threeTableDb(), HASH).rows)).toEqual(nested);
    expect(asBag(run(CHAIN_SQL, threeTableDb(), SORT_MERGE).rows)).toEqual(nested);
    expect(asBag(run(CHAIN_SQL, threeTableDb(), INDEX_NESTED_LOOP).rows)).toEqual(nested);
  });

  it('falls back per join step — the indexed step runs index-nested-loop, the unindexed one runs nested-loop', () => {
    const { events } = run(CHAIN_SQL, threeTableDb(), INDEX_NESTED_LOOP);
    const planStep = events.filter((e) => e.stage === 'plan').at(-1)!;
    if (planStep.stage !== 'plan') throw new Error('unreachable');
    const joinsInTree = (node: PlanNode): PlanNode[] => [
      ...(node.op === 'Join' ? [node] : []),
      ...(node.children ?? []).flatMap(joinsInTree),
    ];
    const joins = joinsInTree(planStep.planTree);
    expect(joins).toHaveLength(2);
    expect(joins.find((j) => j.label.includes('authors'))?.label).toMatch(/index-nested-loop/);
    expect(joins.find((j) => j.label.includes('comments'))?.label).toMatch(/\(nested-loop\)/);
  });

  it('a chain of LEFT JOINs NULL-pads at every level independently', () => {
    const sql = CHAIN_SQL.replace(/JOIN/g, 'LEFT JOIN');
    const rows = run(sql, threeTableDb()).rows;
    // barbara: no posts at all → both posts.title and comments.body NULL.
    expect(rows.filter((r) => r['authors.name'] === 'barbara')).toEqual([
      { 'authors.name': 'barbara', 'posts.title': null, 'comments.body': null },
    ]);
    // grace has posts but none of them have comments → posts.title real, comments.body NULL.
    const graceRows = rows.filter((r) => r['authors.name'] === 'grace');
    expect(graceRows.length).toBeGreaterThan(0);
    expect(graceRows.every((r) => typeof r['posts.title'] === 'string' && r['comments.body'] === null)).toBe(true);
  });

  it('a mixed chain — inner then LEFT — only pads the LEFT step', () => {
    const sql = 'SELECT authors.name, posts.title, comments.body FROM authors JOIN posts ON authors.id = posts.authorId LEFT JOIN comments ON posts.id = comments.postId';
    const rows = run(sql, threeTableDb()).rows;
    // barbara has no posts, so an inner JOIN on posts drops her entirely — even though the second join is LEFT.
    expect(rows.some((r) => r['authors.name'] === 'barbara')).toBe(false);
    // every post without a comment still survives, NULL-padded, since that step is a LEFT JOIN.
    expect(rows.some((r) => r['posts.title'] === "grace's post 6" && r['comments.body'] === null)).toBe(true);
  });

  it('GROUP BY, ORDER BY, HAVING and an aggregate SELECT item are all still rejected with a chain of two JOINs', () => {
    const base = 'FROM authors JOIN posts ON authors.id = posts.authorId JOIN comments ON posts.id = comments.postId';
    expect(parseStatement(`SELECT COUNT(*) ${base}`).ok).toBe(false);
    expect(parseStatement(`SELECT authors.name ${base} GROUP BY authors.name`).ok).toBe(false);
    expect(parseStatement(`SELECT authors.name ${base} ORDER BY authors.name`).ok).toBe(false);
  });

  it('EXPLAIN and EXPLAIN ANALYZE both narrate a chain without crashing — a chain-wide cost-model regression check', () => {
    // The cost model's own recursion (cost.ts) has to resolve *every* table in the chain by name at every nesting
    // depth, including the original FROM table once the recursion reaches the bottom — a real crash this exact
    // test caught during development (`otherTables` only carried the join partners, not the FROM table itself).
    const plain = run(`EXPLAIN ${CHAIN_SQL}`, threeTableDb());
    expect(plain.error).toBeUndefined();
    expect(plain.rows.length).toBeGreaterThan(3);
    const analyzed = run(`EXPLAIN ANALYZE ${CHAIN_SQL}`, threeTableDb());
    expect(analyzed.error).toBeUndefined();
    expect(analyzed.rows.some((r) => String(r['QUERY PLAN']).includes('Result: 3 rows'))).toBe(true);
  });

  it('DISTINCT still works above a chain, and by both strategies', () => {
    const sql = `SELECT DISTINCT authors.name ${'FROM authors JOIN posts ON authors.id = posts.authorId JOIN comments ON posts.id = comments.postId'}`;
    const hash = run(sql, threeTableDb()).rows;
    const sorted = run(sql, threeTableDb(), { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' }).rows;
    expect(sortRows(hash)).toEqual(sortRows([{ 'authors.name': 'ada' }, { 'authors.name': 'alan' }]));
    expect(sortRows(sorted)).toEqual(sortRows(hash));
  });
});
