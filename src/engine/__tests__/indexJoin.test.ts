import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createJoinCompareDatabase, createJoinDemoDatabase } from '../seed.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, IndexNode, JoinAlgorithm, PlanNode, Row, StepEvent } from '../types.ts';

/**
 * The index nested-loop join (plan.md §25.4 B4): the fourth algorithm, where the inner side is not
 * scanned but probed — once per outer row — through its own B+Tree.
 */

const ALGORITHMS: JoinAlgorithm[] = ['nested-loop', 'hash', 'sort-merge', 'index-nested-loop'];
const FEW_FRAMES = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 2 };

const run = (sql: string, algorithm: JoinAlgorithm, db: Database = createJoinCompareDatabase(), frames = false) =>
  runQuery(sql, db, { ...(frames ? FEW_FRAMES : DEFAULT_ENGINE_OPTIONS), joinStrategy: algorithm });

const key = (rows: Row[]): string[] => rows.map((r) => JSON.stringify(r)).sort();
const misses = (events: StepEvent[]): number => events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;

/** The plan the query was run with: the last rewrite's result if the optimizer changed anything, else the canonical plan. */
function finalPlan(events: StepEvent[]): PlanNode {
  const rewrites = events.filter((e): e is Extract<StepEvent, { stage: 'optimize' }> => e.stage === 'optimize');
  if (rewrites.length > 0) return rewrites[rewrites.length - 1]!.after;
  const plans = events.filter((e): e is Extract<StepEvent, { stage: 'plan' }> => e.stage === 'plan');
  return plans[plans.length - 1]!.planTree;
}
function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}
function pagesOf(node: IndexNode): number[] {
  return [node.pageId, ...(node.children ?? []).flatMap(pagesOf)];
}

const QUERIES = [
  'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId',
  "SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'",
  'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId',
  'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId WHERE posts.id = 3',
  // The other way round: the inner table is the one indexed on a unique column.
  'SELECT comments.body, posts.title FROM comments JOIN posts ON comments.postId = posts.id WHERE comments.id <= 9',
  'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId WHERE comments.id > 100',
];

describe('the same rows as the other three algorithms', () => {
  for (const sql of QUERIES) {
    it(sql, () => {
      const reference = run(sql, 'nested-loop');
      expect(reference.error).toBeUndefined();
      for (const algorithm of ALGORITHMS) expect(key(run(sql, algorithm).rows), algorithm).toEqual(key(reference.rows));
    });
  }

  it('an inner row that repeats the key is returned once per match, not once per key', () => {
    const { rows } = run('SELECT comments.body FROM posts JOIN comments ON posts.id = comments.postId WHERE posts.id = 3', 'index-nested-loop');
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r['comments.body'])).size).toBe(12);
  });

  it('a NULL join key finds no partner and is never probed', () => {
    const db: Database = {
      tables: {
        parents: { name: 'parents', columns: ['id', 'k'], rows: [{ id: 1, k: 1 }, { id: 2, k: null }, { id: 3, k: 9 }] },
        kids: { name: 'kids', columns: ['id', 'k'], rows: [{ id: 1, k: 1 }, { id: 2, k: null }, { id: 3, k: 1 }], indexedColumns: ['k'] },
      },
    };
    const sql = 'SELECT parents.id, kids.id FROM parents JOIN kids ON parents.k = kids.k';
    const indexed = run(sql, 'index-nested-loop', db);
    expect(key(indexed.rows)).toEqual(key(run(sql, 'nested-loop', db).rows));
    expect(indexed.rows).toHaveLength(2);
    // Two of the three outer rows have a key to look up; the NULL one is skipped without a descent.
    expect(indexed.events.filter((e) => e.stage === 'index' && e.action === 'open')).toHaveLength(2);
  });
});

describe('the plan', () => {
  const sql = 'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId';

  it('replaces the inner scan with an IndexProbe on the join column', () => {
    const nodes = flatten(finalPlan(run(sql, 'index-nested-loop').events));
    const join = nodes.find((n) => n.op === 'Join')!;
    expect(join.label).toBe('Join (index-nested-loop) posts × comments');
    const probe = nodes.find((n) => n.op === 'IndexProbe')!;
    expect(probe.label).toBe('IndexProbe comments.postId');
    expect(probe.detail).toContain('posts.id');
    // The outer side is still a scan, and the inner table is not scanned at all.
    expect(nodes.filter((n) => n.op === 'SeqScan').map((n) => n.label)).toEqual(['SeqScan posts']);
  });

  it('reads as the same join in relational algebra — the probe is just the relation', () => {
    const nodes = flatten(finalPlan(run(sql, 'index-nested-loop').events));
    expect(nodes.find((n) => n.op === 'IndexProbe')?.ra).toEqual({ symbol: 'rel', rel: 'comments' });
    expect(nodes.find((n) => n.op === 'Join')?.ra?.symbol).toBe('⋈');
  });

  it('prices a probe per outer row, so a tiny outer is cheap and a big one is not', () => {
    const rows = (q: string) => flatten(finalPlan(run(q, 'index-nested-loop').events)).find((n) => n.op === 'Join')?.estRows;
    expect(rows(sql)).toBe(120);
    const probe = flatten(finalPlan(run(sql, 'index-nested-loop').events)).find((n) => n.op === 'IndexProbe')!;
    expect(probe.estBasis).toContain('per outer row');
    expect(probe.estRows).toBe(12);
  });

  it('a WHERE on the outer table is pushed into its scan; one on the inner table stays above the join', () => {
    const outer = flatten(finalPlan(run(`${sql} WHERE posts.id = 3`, 'index-nested-loop').events));
    expect(outer.find((n) => n.op === 'SeqScan')?.detail).toContain('id = 3');
    expect(outer.some((n) => n.op === 'Filter')).toBe(false);

    const inner = flatten(finalPlan(run(`${sql} WHERE comments.id > 100`, 'index-nested-loop').events));
    expect(inner.some((n) => n.op === 'Filter')).toBe(true);
    expect(inner.find((n) => n.op === 'SeqScan')?.detail).toBeUndefined();
  });

  it('narrates the strategy in the plan stage', () => {
    const text = run(sql, 'index-nested-loop').events.filter((e) => e.stage === 'plan').map((e) => e.label).join('\n');
    expect(text).toContain("descends `comments`'s B+Tree on `postId`");
  });
});

describe('when the inner table has no index on the join column', () => {
  // `posts` indexed on `id` alone, so the join column `posts.authorId` has no tree to probe.
  const db = (): Database => {
    const base = createJoinDemoDatabase();
    return { tables: { ...base.tables, posts: { ...base.tables.posts!, indexedColumns: ['id'] } } };
  };
  const sql = 'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId';

  it('runs as an ordinary nested-loop, and says why', () => {
    const asked = run(sql, 'index-nested-loop', db());
    const plain = run(sql, 'nested-loop', db());
    expect(key(asked.rows)).toEqual(key(plain.rows));
    expect(flatten(finalPlan(asked.events)).some((n) => n.op === 'IndexProbe')).toBe(false);
    expect(flatten(finalPlan(asked.events)).find((n) => n.op === 'Join')?.label).toContain('(nested-loop)');
    const planText = asked.events.filter((e) => e.stage === 'plan').map((e) => e.label).join('\n');
    expect(planText).toContain('has no index on `authorId`');
    expect(planText).toContain('ordinary nested-loop');
  });

  it('is not an error, and costs exactly what the plain nested-loop does', () => {
    expect(misses(run(sql, 'index-nested-loop', db()).events)).toBe(misses(run(sql, 'nested-loop', db()).events));
  });
});

describe('what it costs, honestly', () => {
  const tiny = 'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId WHERE posts.id = 3';
  const big = 'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId';
  const reads = (sql: string, a: JoinAlgorithm) => misses(run(sql, a, createJoinCompareDatabase(), true).events);

  it('wins when the outer side is one row over a big indexed inner', () => {
    expect(reads(tiny, 'index-nested-loop')).toBeLessThan(reads(tiny, 'nested-loop'));
    expect(reads(tiny, 'index-nested-loop')).toBeLessThan(reads(tiny, 'hash'));
    expect(reads(tiny, 'index-nested-loop')).toBeLessThan(reads(tiny, 'sort-merge'));
  });

  it('still beats a rescan when the outer is big, but loses to reading each side once', () => {
    expect(reads(big, 'index-nested-loop')).toBeLessThan(reads(big, 'nested-loop'));
    expect(reads(big, 'index-nested-loop')).toBeGreaterThan(reads(big, 'hash'));
  });

  it('on a table too small to be worth probing it is the most expensive of all', () => {
    const small = 'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId';
    const cost = ALGORITHMS.map((a) => reads(small, a));
    expect(Math.max(...cost)).toBe(reads(small, 'index-nested-loop'));
  });

  it('a LIMIT stops the probing early', () => {
    const limited = misses(run(`${big} LIMIT 1`, 'index-nested-loop', createJoinCompareDatabase(), true).events);
    expect(limited).toBeLessThan(reads(big, 'index-nested-loop') / 4);
  });
});

describe('the inner index gets pages of its own', () => {
  it('no index page shares an id with a heap page, so the pool never confuses the two', () => {
    const { events } = run('SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId', 'index-nested-loop');
    const open = events.find((e): e is Extract<StepEvent, { stage: 'index'; action: 'open' }> => e.stage === 'index' && e.action === 'open')!;
    // posts is 3 heap pages and comments is 30, numbered 3..32 — the inner tree starts past them.
    for (const id of pagesOf(open.tree)) expect(id).toBeGreaterThanOrEqual(33);
    const fetched = events.filter((e) => e.stage === 'buffer' && (e.action === 'miss' || e.action === 'hit' || e.action === 'load'));
    expect(fetched.length).toBeGreaterThan(0);
  });

  it('every lock is released', () => {
    let held = 0;
    for (const e of run('SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId', 'index-nested-loop').events) {
      if (e.stage === 'lock') held += e.action === 'acquire' ? 1 : -1;
    }
    expect(held).toBe(0);
  });
});
