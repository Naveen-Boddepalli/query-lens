/**
 * A data module: the challenge list and its pure checks. Briefs carry JSX,
 * which is why the file is `.tsx`; nothing here is a hot-reloadable component.
 */
import type { ReactNode } from 'react';
import type { ASTNode, RunResult, StepEvent } from '../../engine/index.ts';

/**
 * plan.md §22.4: goal-shaped puzzles with a client-side check. Each `check` is
 * a pure predicate over a `RunResult` — no backend, no new engine surface —
 * evaluated on every Run. The set is small on purpose (§22.4 scopes the full
 * thing at a week); this is the first cut.
 */

export interface Challenge {
  id: string;
  title: string;
  brief: ReactNode;
  hint: ReactNode;
  /** The query the editor opens on — usually one that does *not* pass yet. */
  starter: string;
  check: (result: RunResult) => boolean;
}

const diskReads = (events: readonly StepEvent[]): number =>
  events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;

const evictions = (events: readonly StepEvent[]): number =>
  events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length;

const usesIndex = (events: readonly StepEvent[]): boolean =>
  events.some(
    (e) =>
      (e.stage === 'optimize' && e.rule === 'index-selection') ||
      (e.stage === 'execute' && e.op === 'IndexScan'),
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
} {
  return {
    rows: result.rows.length,
    diskReads: diskReads(result.events),
    evictions: evictions(result.events),
    usesIndex: usesIndex(result.events),
  };
}
