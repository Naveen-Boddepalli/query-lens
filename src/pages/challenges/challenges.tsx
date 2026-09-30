/**
 * A data module: the challenge list and its pure checks. Briefs carry JSX,
 * which is why the file is `.tsx`; nothing here is a hot-reloadable component.
 */
import type { ReactNode } from 'react';
import {
  createJoinDemoDatabase,
  DATASETS,
  DEFAULT_DATASET,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../../engine/index.ts';
import type { ASTNode, Database, DatasetId, EngineOptions, RunResult, StepEvent } from '../../engine/index.ts';

/**
 * plan.md §22.4/§23.1: goal-shaped puzzles with a client-side check. Each
 * `check` is a pure predicate over a `RunResult` — no backend, no new engine
 * surface — evaluated on every Run. The set is small on purpose (§22.4 scopes
 * the full thing at a week); this is the first cut plus a second, engine-depth
 * one (§23.1: sort spills, join algorithms, dirty writeback, range scans).
 */

export interface Challenge {
  id: string;
  title: string;
  brief: ReactNode;
  hint: ReactNode;
  /** The query the editor opens on — usually one that does *not* pass yet. */
  starter: string;
  /** Which preset table the check runs against (plan.md §22.7). Default `users`. */
  dataset?: DatasetId;
  /**
   * Overrides `dataset` entirely when set — for a challenge whose database no
   * `DatasetId` names, e.g. the `authors`/`posts` JOIN demo. Called fresh per
   * run, the same way `DatasetSpec.make()` already is, so nothing carries
   * state between attempts.
   */
  database?: () => Database;
  /** Merged over `DEFAULT_ENGINE_OPTIONS` for the player's own run. */
  engineOptions?: Partial<EngineOptions>;
  /**
   * `sql` is the query that produced `result` — most checks only need
   * `result`, but one (`hash-beats-loop`) reruns the same text itself under a
   * different `joinStrategy` to compare two real algorithms head to head,
   * rather than trusting an estimate.
   */
  check: (result: RunResult, sql: string) => boolean;
}

/** A challenge's dataset, defaulted. Meaningless once `database` is set — `challengeDatabase` below is what actually runs. */
export const challengeDataset = (c: Challenge): DatasetId => c.dataset ?? DEFAULT_DATASET;

/** The database a challenge actually runs against. */
export const challengeDatabase = (c: Challenge): Database =>
  c.database ? c.database() : DATASETS[challengeDataset(c)].make();

/** The engine options a challenge runs under — `DEFAULT_ENGINE_OPTIONS`, with a challenge's own overrides layered on. */
export const challengeOptions = (c: Challenge): EngineOptions => ({
  ...DEFAULT_ENGINE_OPTIONS,
  ...(c.engineOptions ?? {}),
});

const diskReads = (events: readonly StepEvent[]): number =>
  events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;

const evictions = (events: readonly StepEvent[]): number =>
  events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length;

/** Evictions that cost a writeback — the victim held a change nothing had flushed yet. */
const dirtyEvictions = (events: readonly StepEvent[]): number =>
  events.filter((e) => e.stage === 'buffer' && e.action === 'evict' && e.writtenBack).length;

/** `Sort`/`SortAggregate` spill pages — the only two callers of `BufferPool.write()` besides `INSERT`. */
const writes = (events: readonly StepEvent[]): number =>
  events.filter((e) => e.stage === 'buffer' && e.action === 'write').length;

const usesIndex = (events: readonly StepEvent[]): boolean =>
  events.some(
    (e) =>
      (e.stage === 'optimize' && e.rule === 'index-selection') ||
      (e.stage === 'execute' && e.op === 'IndexScan'),
  );

/** plan.md §23.1's leaf-chaining range scan, fired instead of a full SeqScan. */
const usesRangeScan = (events: readonly StepEvent[]): boolean =>
  events.some(
    (e) =>
      (e.stage === 'optimize' && e.rule === 'range-index-selection') ||
      (e.stage === 'execute' && e.op === 'IndexRangeScan'),
  );

function astHasKind(node: ASTNode | undefined, kind: string): boolean {
  if (!node) return false;
  if (node.kind === kind) return true;
  return (node.children ?? []).some((c) => astHasKind(c, kind));
}

const lastAst = (events: readonly StepEvent[]): ASTNode | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.stage === 'parse') return e.ast;
  }
  return undefined;
};

export const CHALLENGES: Challenge[] = [
  {
    id: 'use-the-index',
    title: 'Make the planner use the index',
    brief: (
      <>
        The seed table has a B+Tree index on <code className="font-mono">id</code>. Write a query the
        optimiser rewrites into an <code className="font-mono">IndexScan</code> instead of a
        sequential scan.
      </>
    ),
    hint: (
      <>
        The index-selection rule fires only on an <em>equality</em> on the indexed column —{' '}
        <code className="font-mono">id = …</code>, not <code className="font-mono">id &gt; …</code>.
      </>
    ),
    starter: 'SELECT * FROM users WHERE age > 30;',
    check: (r) => !r.error && usesIndex(r.events),
  },
  {
    id: 'eviction-storm',
    title: 'Force an eviction',
    brief: (
      <>
        The buffer pool has eight frames; the heap has twelve pages. Write one query that reads
        enough of them to make the pool evict a page at least once.
      </>
    ),
    hint: (
      <>
        A point lookup touches about three pages and never evicts. You need a query with no usable
        index that has to read the whole table — <code className="font-mono">age</code> is not
        indexed.
      </>
    ),
    starter: 'SELECT * FROM users WHERE id = 5;',
    check: (r) => !r.error && evictions(r.events) >= 1,
  },
  {
    id: 'exactly-one',
    title: 'Return exactly one row',
    brief: <>Get a result set with exactly one row — no more, no fewer — and no error.</>,
    hint: (
      <>
        <code className="font-mono">id</code> is unique, so an equality on it returns at most one
        row. Pick a value the seed data actually has (1–48).
      </>
    ),
    starter: 'SELECT * FROM users;',
    check: (r) => !r.error && r.rows.length === 1,
  },
  {
    id: 'empty-but-not-free',
    title: 'Empty result, real work',
    brief: (
      <>
        Return <strong>zero</strong> rows — but make the engine read pages from disk to find that
        out, rather than answering from the index in a couple of hops.
      </>
    ),
    hint: (
      <>
        An impossible condition on a <em>non-indexed</em> column (say{' '}
        <code className="font-mono">age &gt; 200</code>) still forces a full scan before it can say
        &ldquo;nothing&rdquo;.
      </>
    ),
    starter: 'SELECT * FROM users WHERE id = 999;',
    check: (r) =>
      !r.error && r.rows.length === 0 && !usesIndex(r.events) && diskReads(r.events) > 0,
  },
  {
    id: 'and-that-matches',
    title: 'Two conditions, still a hit',
    brief: (
      <>
        Write a query whose <code className="font-mono">WHERE</code> clause uses{' '}
        <code className="font-mono">AND</code> and still returns at least one row.
      </>
    ),
    hint: (
      <>
        Both sides have to be true for the same row. <code className="font-mono">id = 5</code> pins
        one row; add a second condition that row also satisfies.
      </>
    ),
    starter: "SELECT * FROM users WHERE id = 5 AND name = 'zzz';",
    check: (r) => !r.error && r.rows.length >= 1 && astHasKind(lastAst(r.events), 'And'),
  },
  {
    id: 'push-it-down',
    title: 'Push the filter down',
    brief: (
      <>
        The optimiser&rsquo;s first move is <em>predicate pushdown</em>: folding the{' '}
        <code className="font-mono">WHERE</code> into the scan so rows are dropped as they are read.
        Get it to fire — <strong>without</strong> the query also turning into an index lookup.
      </>
    ),
    hint: (
      <>
        Pushdown fires on any <code className="font-mono">WHERE</code>. Index selection only fires on
        an equality on <code className="font-mono">id</code> — so filter on something else, like{' '}
        <code className="font-mono">age</code>.
      </>
    ),
    starter: 'SELECT * FROM users;',
    check: (r) =>
      !r.error &&
      r.events.some((e) => e.stage === 'optimize' && e.rule === 'predicate-pushdown') &&
      !usesIndex(r.events),
  },
  {
    id: 'deep-descent',
    title: 'A lookup on the big table',
    dataset: 'orders',
    brief: (
      <>
        <code className="font-mono">orders</code> has 120 rows, so its B+Tree is a level deeper than{' '}
        <code className="font-mono">users</code>&rsquo;s. Get the planner to answer a query with a
        single-row index lookup on it.
      </>
    ),
    hint: (
      <>
        Same rule as on <code className="font-mono">users</code>: an equality on the indexed column,{' '}
        <code className="font-mono">id</code>. <code className="font-mono">orders.id</code> runs 1 to
        120.
      </>
    ),
    starter: "SELECT * FROM orders WHERE customer = 'acme';",
    check: (r) => !r.error && usesIndex(r.events) && r.rows.length === 1,
  },
  {
    id: 'needle-in-the-skew',
    title: 'The selective end of a skew',
    dataset: 'logins',
    brief: (
      <>
        In <code className="font-mono">logins</code>, <code className="font-mono">status</code> is{' '}
        <code className="font-mono">&apos;ok&apos;</code> for about nine rows in ten. Write a scan
        that returns <strong>fewer than 20</strong> rows — the rare end.
      </>
    ),
    hint: (
      <>
        <code className="font-mono">status = &apos;blocked&apos;</code> is the small set. Those rows
        also have a higher <code className="font-mono">attempts</code> count.
      </>
    ),
    starter: "SELECT * FROM logins WHERE status = 'ok';",
    check: (r) => !r.error && r.rows.length > 0 && r.rows.length < 20 && !usesIndex(r.events),
  },
  {
    id: 'sort-spill',
    title: 'The sort spill',
    brief: (
      <>
        <code className="font-mono">ORDER BY</code> looks instant, but QueryLens&rsquo;s{' '}
        <code className="font-mono">Sort</code> is a real external merge sort: it writes its sorted
        runs out to pages and reads them back to merge, through the same buffer pool as everything
        else. Sort enough rows that it needs more than one run.
      </>
    ),
    hint: (
      <>
        A one-row result sorts trivially — one run, nothing to merge. Widen the{' '}
        <code className="font-mono">WHERE</code>, or drop it, so there is enough to sort that the
        spill is real.
      </>
    ),
    starter: 'SELECT * FROM users WHERE id = 5 ORDER BY age;',
    check: (r) => !r.error && writes(r.events) >= 5,
  },
  {
    id: 'hash-beats-loop',
    title: 'Hash beats loop',
    database: createJoinDemoDatabase,
    // Forced small on purpose, same reason `/compare`'s own JOIN mode does:
    // the demo's 5 heap pages fit entirely inside the default 8 frames, which
    // would let nested-loop's rescans hit cache and hide the very difference
    // this challenge exists to show.
    engineOptions: { bufferFrames: 2 },
    brief: (
      <>
        This engine has three join algorithms. Nested-loop rescans all of the right-hand table once
        per row of the left; hash join reads it once into memory instead. Join{' '}
        <code className="font-mono">authors</code> to <code className="font-mono">posts</code> and
        confirm hash join reads fewer pages than nested-loop does for the exact same query — the
        check reruns your SQL under both algorithms itself and compares.
      </>
    ),
    hint: (
      <>
        Any real join on <code className="font-mono">authors.id = posts.authorId</code> works.
        Nested-loop pays for every row of <code className="font-mono">posts</code> a second time for
        each author; hash join pays for it once, however many authors there are.
      </>
    ),
    starter: 'SELECT * FROM authors;',
    check: (r, sql) => {
      if (r.error) return false;
      const nestedLoopReads = diskReads(r.events);
      const hash = runQuery(sql, createJoinDemoDatabase(), { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 2, joinStrategy: 'hash' });
      return !hash.error && diskReads(hash.events) < nestedLoopReads;
    },
  },
  {
    id: 'dirty-eviction',
    title: 'The dirty eviction',
    brief: (
      <>
        Evicting a page an <code className="font-mono">UPDATE</code> already changed costs more than
        evicting a page nobody touched — the dirty one has to be written back first.{' '}
        <code className="font-mono">UPDATE</code> enough rows, spread across enough pages, that at
        least one dirty page gets evicted before the statement finishes.
      </>
    ),
    hint: (
      <>
        One row is one page, and the pool has eight frames — nothing gets evicted.{' '}
        <code className="font-mono">WHERE</code> a broad enough condition that the write touches more
        pages than the pool can hold at once.
      </>
    ),
    starter: "UPDATE users SET name = 'edited' WHERE id = 5;",
    check: (r) => !r.error && dirtyEvictions(r.events) >= 1,
  },
  {
    id: 'range-leap',
    title: 'The range leap',
    brief: (
      <>
        A range predicate on an <em>indexed</em> column can descend the B+Tree once and walk the
        leaf chain sideways, instead of reading the whole table — but only when the slice it asks
        for is narrow enough to actually cost less than the scan it replaces. Write a range query
        — not an equality — that touches fewer pages than a full sequential scan does.
      </>
    ),
    hint: (
      <>
        <code className="font-mono">age</code> is not indexed, so any range on it is a full 12-page
        scan. <code className="font-mono">id</code> is — but a wide range on it still loses to the
        scan, one heap page per matching row with no credit for sharing a page. Narrow it down: try{' '}
        <code className="font-mono">id &gt; 44</code>, <code className="font-mono">id &lt; 5</code>,
        or a narrow <code className="font-mono">BETWEEN</code>.
      </>
    ),
    starter: 'SELECT * FROM users WHERE age > 30;',
    check: (r) => !r.error && usesRangeScan(r.events) && diskReads(r.events) < 12,
  },
];

export function challengeById(id: string | undefined): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}

/** The handful of numbers the challenge page shows under the editor. */
export function challengeStats(result: RunResult): {
  rows: number;
  diskReads: number;
  evictions: number;
  usesIndex: boolean;
  writes: number;
  dirtyEvictions: number;
  usesRangeScan: boolean;
} {
  return {
    rows: result.rows.length,
    diskReads: diskReads(result.events),
    evictions: evictions(result.events),
    usesIndex: usesIndex(result.events),
    writes: writes(result.events),
    dirtyEvictions: dirtyEvictions(result.events),
    usesRangeScan: usesRangeScan(result.events),
  };
}
