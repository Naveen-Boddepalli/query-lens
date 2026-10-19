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
import { sandboxHref } from '../learn/sandboxScenarios.ts';

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
  /**
   * The wrong belief this challenge exists to correct (plan.md §G3). Shown once the challenge is solved, not before,
   * so the player meets the belief by running into it rather than by reading it first.
   */
  misconception?: ReactNode;
  /**
   * A sandbox that shows what the challenge is about, opened on the player's own query — the Parser for a challenge
   * about how a query is read, the Grammar diagram for one about what is allowed. `href` returns null when the tool
   * cannot take the text (it takes a bounded source), and the link is then left out.
   */
  tool?: { label: string; href: (sql: string) => string | null };
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

/** The first node of `kind` in a tree, depth-first. */
function findNode(node: ASTNode, match: (n: ASTNode) => boolean): ASTNode | undefined {
  if (match(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, match);
    if (hit) return hit;
  }
  return undefined;
}

/** The predicate under a query's WHERE clause, read from the last parse event the way the other checks read the AST. */
const whereExpr = (events: readonly StepEvent[]): ASTNode | undefined => {
  const ast = lastAst(events);
  return ast ? findNode(ast, (n) => n.kind === 'Where')?.children?.[0] : undefined;
};

const isColumn = (n: ASTNode | undefined, name: string): boolean => n?.kind === 'Column' && n.label === name;

/**
 * How many of a SELECT's optional parts the parse tree shows: DISTINCT, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT and
 * OFFSET. JOIN is the eighth, and needs a second table — which the challenge's one-table database does not have —
 * so it is not counted here.
 */
export function optionalClauses(events: readonly StepEvent[]): number {
  const ast = lastAst(events);
  if (!ast) return 0;
  const has = (match: (n: ASTNode) => boolean) => findNode(ast, match) !== undefined;
  const limit = findNode(ast, (n) => n.kind === 'Limit');
  return [
    has((n) => n.kind === 'SelectList' && n.label === 'DISTINCT columns'),
    has((n) => n.kind === 'Where'),
    has((n) => n.kind === 'GroupBy'),
    has((n) => n.kind === 'Having'),
    has((n) => n.kind === 'OrderBy'),
    limit !== undefined,
    limit?.detail?.includes('OFFSET') === true,
  ].filter(Boolean).length;
}

/** Who a result row is, whether the query kept the `id` column, the `name`, or both. */
const personOf = (row: Record<string, unknown>): string | null => {
  if (row['id'] === 3 || row['name'] === 'barbara') return 'barbara';
  if (row['id'] === 4 || row['name'] === 'brendan') return 'brendan';
  return null;
};

/** The longest source the Parser sandbox takes from its link. */
const PARSER_SOURCE_LIMIT = 2000;

/** A small table with a NULL in it, for the NULL-semantics challenges. */
const contactsDatabase = (): Database => ({
  tables: {
    contacts: {
      name: 'contacts',
      columns: ['id', 'name', 'email'],
      rows: [
        { id: 1, name: 'ana', email: 'ana@example.com' },
        { id: 2, name: 'ben', email: null },
        { id: 3, name: 'cy', email: 'cy@example.com' },
      ],
      indexedColumns: [],
    },
  },
});

/** Three people, and a banned list that contains a NULL. */
const bannedDatabase = (): Database => ({
  tables: {
    people: {
      name: 'people',
      columns: ['id', 'name'],
      rows: [
        { id: 1, name: 'ana' },
        { id: 2, name: 'ben' },
        { id: 3, name: 'cy' },
      ],
      indexedColumns: [],
    },
    banned: {
      name: 'banned',
      columns: ['person_id'],
      rows: [{ person_id: 2 }, { person_id: null }],
      indexedColumns: [],
    },
  },
});

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
    // this challenge exists to show. `joinStrategy` is pinned to nested-loop too
    // (plan.md §25.4 C5 slice 2 would otherwise cost-choose hash for the player's
    // own run too, same as it would for anyone else's) — the whole point here is
    // naming two specific algorithms and comparing them head to head, not
    // whichever one the optimizer would have picked on its own.
    engineOptions: { bufferFrames: 2, joinStrategy: 'nested-loop' },
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
  {
    id: 'the-index-it-cannot-serve',
    title: 'Filter the indexed column the index cannot serve',
    brief: (
      <>
        The seed table has a B+Tree index on <code className="font-mono">id</code>. Write a query that filters on{' '}
        <code className="font-mono">id</code> and still returns rows, but that the planner cannot answer from the index.
      </>
    ),
    hint: (
      <>
        The index answers equality and ranges. A <em>not-equal</em> test has no contiguous run of keys to walk, so the
        planner reads the table.
      </>
    ),
    starter: 'SELECT * FROM users WHERE id = 5;',
    check: (r) => {
      const w = whereExpr(r.events);
      return (
        !r.error &&
        r.rows.length > 0 &&
        !usesIndex(r.events) &&
        !usesRangeScan(r.events) &&
        w?.kind === 'Compare' &&
        w.label === '<>' &&
        isColumn(w.children?.[0], 'id')
      );
    },
    misconception: (
      <>
        An index on a column makes every filter on that column fast. The index serves some predicates and not others —
        here the planner reads all 47 rows and the index sits unused.
      </>
    ),
  },
  {
    id: 'wrap-the-column',
    title: 'Wrap the indexed column in arithmetic',
    brief: (
      <>
        Write a query that filters <code className="font-mono">id</code> through an arithmetic expression, returns at least
        one row, and gets no help from the index.
      </>
    ),
    hint: (
      <>
        The index matches a bare column on one side of the comparison. Put anything around it — even{' '}
        <code className="font-mono">+ 0</code> — and the optimiser can no longer see the column.
      </>
    ),
    starter: 'SELECT * FROM users WHERE id = 5;',
    check: (r) => {
      const w = whereExpr(r.events);
      return (
        !r.error &&
        r.rows.length > 0 &&
        !usesIndex(r.events) &&
        !usesRangeScan(r.events) &&
        w?.kind === 'Compare' &&
        w.children?.[0]?.kind === 'Arith' &&
        (w.children[0].children ?? []).some((c) => isColumn(c, 'id'))
      );
    },
    misconception: (
      <>
        Wrapping an indexed column in a function or expression keeps the index in play. The planner matches the column
        itself; <code className="font-mono">id + 0</code> is a different expression with no index behind it.
      </>
    ),
  },
  {
    id: 'equals-null',
    title: 'Find the rows where the email is missing',
    brief: (
      <>
        The <code className="font-mono">contacts</code> table has one row whose <code className="font-mono">email</code>{' '}
        is missing. Return that row, and only that kind of row.
      </>
    ),
    hint: (
      <>
        NULL is not a value, so no comparison with it is ever true — not even <code className="font-mono">= NULL</code>.
        SQL has a dedicated test for missing values.
      </>
    ),
    starter: 'SELECT * FROM contacts WHERE email = NULL;',
    database: contactsDatabase,
    check: (r) => {
      const w = whereExpr(r.events);
      return (
        !r.error &&
        r.rows.length > 0 &&
        r.rows.every((row) => row.email === null) &&
        w?.kind === 'IsNull' &&
        isColumn(w.children?.[0], 'email')
      );
    },
    misconception: (
      <>
        <code className="font-mono">x = NULL</code> finds the missing values. It finds nothing, because a comparison
        with NULL is unknown, not true. Missing values are tested with <code className="font-mono">IS NULL</code>.
      </>
    ),
  },
  {
    id: 'count-the-nulls',
    title: 'Count the rows, then count the emails',
    brief: (
      <>
        In one query on <code className="font-mono">contacts</code>, return the number of rows and the number of emails
        side by side, so the two can be compared.
      </>
    ),
    hint: (
      <>
        <code className="font-mono">COUNT(*)</code> counts rows. <code className="font-mono">COUNT(col)</code> counts the
        rows where that column is not NULL. Put both in the SELECT list.
      </>
    ),
    starter: 'SELECT COUNT(*) FROM contacts;',
    database: contactsDatabase,
    check: (r) => {
      if (r.error || r.rows.length !== 1) return false;
      const values = Object.values(r.rows[0]!);
      return values.includes(3) && values.includes(2);
    },
    misconception: (
      <>
        <code className="font-mono">COUNT(*)</code> and <code className="font-mono">COUNT(col)</code> always agree. They
        differ exactly where the column holds a NULL — here three rows, two emails.
      </>
    ),
  },
  {
    id: 'not-in-the-null',
    title: 'Return the people who are not banned',
    brief: (
      <>
        Return the people who are <em>not</em> on the <code className="font-mono">banned</code> list. Ana and Cy are not
        banned, so a correct answer returns them — but check what the list actually contains.
      </>
    ),
    hint: (
      <>
        The banned list has a NULL in it. Compare that NULL with <code className="font-mono">NOT IN</code> and think about
        what <code className="font-mono">id &lt;&gt; NULL</code> is.
      </>
    ),
    starter: 'SELECT * FROM people WHERE id NOT IN (SELECT person_id FROM banned WHERE person_id IS NOT NULL);',
    database: bannedDatabase,
    check: (r) => {
      const w = whereExpr(r.events);
      return !r.error && r.rows.length === 0 && w?.kind === 'In' && w.label === 'NOT IN';
    },
    misconception: (
      <>
        <code className="font-mono">NOT IN</code> returns the rows that are not in the list. One NULL in the list makes
        every <code className="font-mono">NOT IN</code> comparison unknown, so the query returns nothing at all, even
        though Ana and Cy are not banned.
      </>
    ),
  },
  {
    // plan.md §26 Feature 3 — on `customers`, the preset with NULLs.
    id: 'not-paris-either',
    title: 'Everyone not in Paris',
    brief: (
      <>
        Return every customer who does not live in Paris — including the ones whose city is not on record. A customer
        with no known city is not known to live in Paris either.
      </>
    ),
    hint: (
      <>
        <code className="font-mono">city &lt;&gt; 'Paris'</code> is unknown when the city is NULL, so those rows fall
        out. Count the result against the table: Paris has four customers, and there are twenty.
      </>
    ),
    starter: "SELECT * FROM customers WHERE city <> 'Paris';",
    dataset: 'customers',
    // The exact set of customers — by whatever query (`<> … OR IS NULL`, or `id NOT IN (SELECT id … WHERE city =
    // 'Paris')`), told apart by `id` or by `name`, which is unique here, whichever the query selected.
    check: (r) => {
      const key = r.rows.every((row) => 'id' in row) ? 'id' : r.rows.every((row) => 'name' in row) ? 'name' : null;
      if (r.error || key === null) return false;
      const want = DATASETS.customers.make().tables.customers!.rows.filter((row) => row['city'] !== 'Paris').map((row) => row[key]);
      const got = r.rows.map((row) => row[key]);
      return got.length === want.length && want.every((v) => got.includes(v));
    },
    misconception: (
      <>
        <code className="font-mono">city &lt;&gt; 'Paris'</code> means &ldquo;everyone else&rdquo;. It means everyone
        whose city is <em>known</em> to be something else: for a NULL city the comparison is unknown, and a WHERE clause
        keeps only what is true. <code className="font-mono">city = 'Paris'</code> and{' '}
        <code className="font-mono">city &lt;&gt; 'Paris'</code> together still leave out every NULL.
      </>
    ),
  },
  {
    // plan.md §27.5 S1, on the `shop` preset (S2): the NOT IN trap, where NOT EXISTS is the plain answer.
    id: 'never-ordered',
    title: 'Customers who never ordered',
    brief: (
      <>
        Return the customers who have never placed an order. The starting query asks with{' '}
        <code className="font-mono">NOT IN</code>, and finds no one.
      </>
    ),
    hint: (
      <>
        Two orders were placed by a guest, so <code className="font-mono">customerId</code> holds a NULL, and{' '}
        <code className="font-mono">NOT IN</code> against a list with a NULL is never true. Ask whether a matching order{' '}
        <em>exists</em> instead — or keep the NULLs out of the list.
      </>
    ),
    starter: 'SELECT name FROM customers WHERE id NOT IN (SELECT customerId FROM orders);',
    dataset: 'shop',
    // The exact set of customers with no order — by any query that finds it, told apart by `id` or `name` (unique here),
    // bare or, after a JOIN, as `customers.id` / `customers.name`.
    check: (r) => {
      const keys = (['id', 'name'] as const).flatMap((c) => [c, `customers.${c}`]);
      const at = keys.find((k) => r.rows.length > 0 && r.rows.every((row) => k in row));
      if (r.error || at === undefined) return false;
      const column = at.replace('customers.', '');
      const shop = DATASETS.shop.make().tables;
      const ordered = new Set(shop.orders!.rows.map((row) => row['customerId']));
      const want = shop.customers!.rows.filter((row) => !ordered.has(row['id'] ?? null)).map((row) => row[column]);
      const got = r.rows.map((row) => row[at]);
      return want.length > 0 && got.length === want.length && want.every((v) => got.includes(v));
    },
    misconception: (
      <>
        <code className="font-mono">NOT IN</code> and <code className="font-mono">NOT EXISTS</code> are two spellings of
        one question. They part company at a NULL: <code className="font-mono">NOT IN</code> compares the value with
        every item in the list, and a comparison with NULL is unknown, so one NULL leaves no row true.{' '}
        <code className="font-mono">NOT EXISTS</code> only asks whether a matching row exists, and a NULL matches nothing.
      </>
    ),
  },
  {
    // plan.md §27.5 S3, on the `shop` preset: EXCEPT, with its columns matched by position.
    id: 'nobody-ordered-it',
    title: 'Products nobody ordered',
    brief: (
      <>
        Return the product that no order mentions — with <code className="font-mono">EXCEPT</code>, not a subquery.
      </>
    ),
    hint: (
      <>
        <code className="font-mono">EXCEPT</code> keeps the rows of the first SELECT that the second does not return. The
        two columns need not share a name: <code className="font-mono">products.id</code> and{' '}
        <code className="font-mono">orders.productId</code> are matched by position.
      </>
    ),
    starter: 'SELECT id FROM products UNION SELECT productId FROM orders;',
    dataset: 'shop',
    // An EXCEPT ran, and its one row is the vase — by its id or its name, in whichever single column was selected.
    check: (r) => {
      if (r.error || r.rows.length !== 1) return false;
      const values = Object.values(r.rows[0]!);
      const vase = DATASETS.shop.make().tables.products!.rows.find((p) => !DATASETS.shop.make().tables.orders!.rows.some((o) => o['productId'] === p['id']))!;
      const usedExcept = r.events.some((e) => e.stage === 'execute' && e.op === 'SetOp' && e.label.startsWith('Except'));
      return usedExcept && values.length === 1 && (values[0] === vase['id'] || values[0] === vase['name']);
    },
    misconception: (
      <>
        Set operators match columns by name, so <code className="font-mono">id</code> and{' '}
        <code className="font-mono">productId</code> cannot be compared. They are matched by position — the first column
        of one SELECT with the first of the other — and the result takes the first SELECT's names.
      </>
    ),
  },
  {
    id: 'keep-the-unmatched',
    title: 'Keep the authors who have no posts',
    brief: (
      <>
        Return the authors who have written no posts, using a <code className="font-mono">LEFT JOIN</code> on{' '}
        <code className="font-mono">posts</code>. Show the author&rsquo;s name.
      </>
    ),
    hint: (
      <>
        A <code className="font-mono">LEFT JOIN</code> keeps an author with no match, padding the posts columns with NULL.
        The filter that keeps only those padded rows is a test on a posts column for NULL.
      </>
    ),
    starter:
      'SELECT authors.name, posts.title FROM authors LEFT JOIN posts ON authors.id = posts.authorId WHERE posts.id = 999;',
    database: createJoinDemoDatabase,
    check: (r) =>
      !r.error &&
      r.rows.length > 0 &&
      r.rows.every((row) => row['posts.title'] === null) &&
      r.rows.some((row) => row['authors.name'] === 'barbara'),
    misconception: (
      <>
        A <code className="font-mono">LEFT JOIN</code> keeps the unmatched rows no matter what the{' '}
        <code className="font-mono">WHERE</code> says. A condition on the joined table drops them — and the way to keep
        exactly the unmatched rows is to test that table for NULL.
      </>
    ),
  },
  {
    // plan.md §27.5 S4, on the `shop` preset: a FULL JOIN, each unmatched row once.
    id: 'leave-no-one-out',
    title: 'Leave no one out',
    brief: (
      <>
        Return <code className="font-mono">customers.name</code> and <code className="font-mono">orders.id</code> for
        every customer and every order: each order beside the customer who placed it, a customer with no order on a row of
        their own, and an order with no customer on a row of its own.
      </>
    ),
    hint: (
      <>
        A <code className="font-mono">LEFT JOIN</code> keeps the customers nothing matched, a{' '}
        <code className="font-mono">RIGHT JOIN</code> the orders. One kind of join keeps both, padding whichever side is
        missing with NULL.
      </>
    ),
    starter: 'SELECT customers.name, orders.id\nFROM customers\nLEFT JOIN orders ON customers.id = orders.customerId;',
    dataset: 'shop',
    // Every matched pair once, the three customers who never ordered, and the two guest orders — however it was written.
    check: (r) => {
      if (r.error || !r.rows[0] || !('customers.name' in r.rows[0]) || !('orders.id' in r.rows[0])) return false;
      const { customers, orders } = DATASETS.shop.make().tables;
      const expected: string[] = [];
      for (const o of orders!.rows) {
        const c = customers!.rows.find((row) => o['customerId'] !== null && row['id'] === o['customerId']);
        expected.push(`${String(c?.['name'] ?? null)}|${String(o['id'])}`);
      }
      for (const c of customers!.rows) if (!orders!.rows.some((o) => o['customerId'] === c['id'])) expected.push(`${String(c['name'])}|null`);
      const got = r.rows.map((row) => `${String(row['customers.name'])}|${String(row['orders.id'])}`);
      return got.length === expected.length && [...got].sort().join() === [...expected].sort().join();
    },
    misconception: (
      <>
        A <code className="font-mono">FULL JOIN</code> is a <code className="font-mono">LEFT JOIN</code> and a{' '}
        <code className="font-mono">RIGHT JOIN</code> stacked together. Stack them with{' '}
        <code className="font-mono">UNION ALL</code> and every matched pair comes back twice — once from each. A{' '}
        <code className="font-mono">FULL JOIN</code> returns each pair once, then each row nothing matched once.
      </>
    ),
  },
  {
    id: 'and-before-or',
    title: 'Where the AND lands',
    brief: (
      <>
        Return <strong>barbara and brendan</strong> — the users whose <code className="font-mono">id</code> is 1, 3 or 4{' '}
        <em>and</em> who are over 30 — with a <code className="font-mono">WHERE</code> that uses both{' '}
        <code className="font-mono">OR</code> and <code className="font-mono">AND</code>. The starter returns ada as
        well; fix where the <code className="font-mono">AND</code> applies.
      </>
    ),
    hint: (
      <>
        <code className="font-mono">AND</code> binds tighter than <code className="font-mono">OR</code>, so the starter
        asks <code className="font-mono">age &gt; 30</code> of id 4 alone. Parentheses around the three ids make the{' '}
        <code className="font-mono">OR</code> happen first and the <code className="font-mono">AND</code> cover them all.
      </>
    ),
    starter: 'SELECT * FROM users WHERE id = 1 OR id = 3 OR id = 4 AND age > 30;',
    check: (r) => {
      const where = whereExpr(r.events);
      const people = new Set(r.rows.map(personOf));
      return (
        !r.error &&
        people.size === 2 &&
        !people.has(null) &&
        astHasKind(where, 'And') &&
        astHasKind(where, 'Or')
      );
    },
    tool: {
      label: 'Read this query’s tree in the Parser →',
      href: (sql) =>
        sql.trim().length > 0 && sql.length <= PARSER_SOURCE_LIMIT ? sandboxHref({ tool: 'parser', src: sql }) : null,
    },
    misconception: (
      <>
        <code className="font-mono">AND</code> and <code className="font-mono">OR</code> are not read left to right.{' '}
        <code className="font-mono">a OR b AND c</code> is <code className="font-mono">a OR (b AND c)</code>, so in the
        starter ada got in through <code className="font-mono">id = 1</code> without ever being asked her age. The
        parentheses are how you move the <code className="font-mono">AND</code>, and the tree shows where it landed.
      </>
    ),
  },
  {
    id: 'every-clause',
    title: 'Seven clauses in one SELECT',
    brief: (
      <>
        A <code className="font-mono">SELECT</code> on one table has seven optional parts:{' '}
        <code className="font-mono">DISTINCT</code>, <code className="font-mono">WHERE</code>,{' '}
        <code className="font-mono">GROUP BY</code>, <code className="font-mono">HAVING</code>,{' '}
        <code className="font-mono">ORDER BY</code>, <code className="font-mono">LIMIT</code> and{' '}
        <code className="font-mono">OFFSET</code> (a <code className="font-mono">JOIN</code> is the eighth, and needs a
        second table). The grammar reads them in that order, and the engine runs them all together — if what each one
        names makes sense beside the others. Write one query that <strong>runs</strong> with all seven.
      </>
    ),
    hint: (
      <>
        Once there is a <code className="font-mono">GROUP BY</code>, every selected column must be grouped or
        aggregated, and <code className="font-mono">ORDER BY</code> sorts the groups — so name a grouped column, or an
        aggregate. With <code className="font-mono">DISTINCT</code>, the sort key must be one you selected. And{' '}
        <code className="font-mono">OFFSET</code> only comes after a <code className="font-mono">LIMIT</code>.
      </>
    ),
    starter: 'SELECT DISTINCT age FROM users WHERE age > 20 ORDER BY age LIMIT 5;',
    check: (r) => !r.error && optionalClauses(r.events) >= 7,
    tool: { label: 'See the select rule in the Grammar →', href: () => sandboxHref({ tool: 'grammar', rule: 'select' }) },
    misconception: (
      <>
        The grammar diagram is what the parser can <em>read</em>, not what the query <em>means</em>. A query can be
        perfectly well-formed and still be refused — a column that is not grouped has no one value per group — and the
        message says which rule said no.
      </>
    ),
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
