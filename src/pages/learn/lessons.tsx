/* eslint-disable react-refresh/only-export-components --
   This is a data module, not a component module: it exports the lesson list
   and a link-builder. The lesson prose carries JSX, which is why the file is
   `.tsx`, but nothing here is a React component to hot-reload. */
import type { ReactNode } from 'react';
import { createSeedDatabase, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../engine/index.ts';
import type { ReplacementPolicyName, StepEvent } from '../../engine/index.ts';
import { encodeShareState } from '../../ui/urlState.ts';

/**
 * The §17.2 manual tasks as an ordered, in-app track (plan.md §21.3 `/learn`).
 * Each lesson is short and task-shaped; each step that references the Playground
 * computes its deep link from a *real* run of the engine — `findIndex` against
 * the same trace the Playground would produce — so an engine change that moves
 * a step fails to build a lesson rather than shipping a link to the wrong
 * place. Same discipline as `GalleryPage`.
 */

const SEED = createSeedDatabase();

const POINT_LOOKUP = 'SELECT *\nFROM users\nWHERE id = 5;';
const SEQ_SCAN = 'SELECT *\nFROM users\nWHERE age > 30;';

interface OpenSpec {
  sql: string;
  policy?: ReplacementPolicyName;
  predictOn?: boolean;
  /** Returns the 0-based event index to land *after*; `at` adds 1. */
  find: (events: readonly StepEvent[]) => number;
  label?: string;
}

export interface LessonStep {
  heading: string;
  body: ReactNode;
  open?: OpenSpec;
  tryThis?: ReactNode;
}

export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  summary: string;
  steps: LessonStep[];
}

function at(events: readonly StepEvent[], find: (e: StepEvent) => boolean): number {
  const i = events.findIndex(find);
  if (i === -1) throw new Error('learn: no matching event — a lesson is out of sync with the engine');
  return i + 1;
}

const END = (events: readonly StepEvent[]) => events.length;

/** `/playground?…` for an `OpenSpec`, with the step computed from a real run. */
export function stepLink(spec: OpenSpec): { href: string; label: string } {
  const policy = spec.policy ?? 'lru';
  const result = runQuery(spec.sql, SEED, { ...DEFAULT_ENGINE_OPTIONS, policy });
  const step = spec.find(result.events);
  const query = encodeShareState(
    { sql: spec.sql, policy, predictOn: spec.predictOn ?? false, step },
    undefined,
  );
  return { href: `/playground?${query}`, label: spec.label ?? 'Open this in the Playground' };
}

export const LESSONS: Lesson[] = [
  {
    id: 'first-query',
    title: 'Run your first query',
    minutes: 2,
    summary: 'The whole path, end to end, in one query — parse, plan, execute, result.',
    steps: [
      {
        heading: 'Open the Playground',
        body: (
          <>
            The editor is on the left, the trace on the right. It opens on a real query already —{' '}
            <code className="font-mono">SELECT * FROM users WHERE id = 5</code> — so there is
            something to look at before you touch anything.
          </>
        ),
        open: { sql: POINT_LOOKUP, find: () => 1, label: 'Open the Playground here' },
      },
      {
        heading: 'Step through it',
        body: (
          <>
            Press <kbd className="rounded border border-edge px-1">Space</kbd> to play, or{' '}
            <kbd className="rounded border border-edge px-1">→</kbd> to move one event at a time. The
            row of chips across the top is the pipeline; each lights as its stage runs.
          </>
        ),
        open: { sql: POINT_LOOKUP, find: (e) => at(e, (x) => x.stage === 'index'), label: 'Jump to the index descent' },
      },
      {
        heading: 'Read the result',
        body: 'The last step hands back the rows. One row, because `id` is unique — but the buffer pool and the B+Tree still did real work to find it.',
        open: { sql: POINT_LOOKUP, find: END, label: 'Jump to the result' },
        tryThis: (
          <>
            Change <code className="font-mono">id = 5</code> to <code className="font-mono">id = 999</code>{' '}
            and run it again. How many rows come back — and did the engine still read pages to find
            that out?
          </>
        ),
      },
    ],
  },
  {
    id: 'one-row',
    title: 'Follow one row from disk to result',
    minutes: 5,
    summary: 'The spine of the whole tool: one row, crossing every stage once.',
    steps: [
      {
        heading: 'Parse: text becomes a tree',
        body: 'The SQL string is tokenised and parsed into an abstract syntax tree. Nothing has been executed yet — this is only structure.',
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'plan'),
          label: 'Jump to the end of parsing',
        },
      },
      {
        heading: 'Plan and optimise: the scan becomes a lookup',
        body: (
          <>
            The planner builds a logical plan, then the optimiser rewrites it: because{' '}
            <code className="font-mono">id</code> is indexed and the predicate is an equality on it,
            the sequential scan becomes a B+Tree lookup. Watch the before/after trees.
          </>
        ),
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'optimize'),
          label: 'Jump to the optimiser rewrite',
        },
      },
      {
        heading: 'Descend the B+Tree',
        body: 'From the root to a leaf, one node read per level. The leaf holds a pointer to the row — a heap page and a slot — not the row itself.',
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'index' && x.action === 'found'),
          label: 'Jump to the moment the key is found',
        },
      },
      {
        heading: 'Buffer pool and result',
        body: 'That heap page is fetched through the buffer pool — a disk read if it is not already resident — and the row is read from its slot and handed back.',
        open: { sql: POINT_LOOKUP, find: END, label: 'Jump to the result' },
        tryThis: (
          <>
            Run <code className="font-mono">WHERE name = &apos;grace&apos;</code> instead.{' '}
            <code className="font-mono">name</code> is not indexed — so which stage looks different,
            and how much more work does it do?
          </>
        ),
      },
    ],
  },
  {
    id: 'eviction',
    title: 'Watch a page get evicted',
    minutes: 4,
    summary: 'Fill the pool, then see LRU and clock sweep pick different victims.',
    steps: [
      {
        heading: 'Fill every frame',
        body: (
          <>
            A sequential scan reads every page of the table. There are more pages than frames, so
            once the pool is full the next read has to evict something. The run stops and asks you
            which frame dies.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          predictOn: true,
          find: (e) => at(e, (x) => x.stage === 'buffer' && x.action === 'evict'),
          label: 'Jump to the first eviction (LRU)',
        },
      },
      {
        heading: 'The same scan, a different policy',
        body: (
          <>
            Clock sweep is what PostgreSQL actually does. Identical access pattern — but it protects
            recently-used pages differently, so on a skewed pattern it picks a different victim. On
            this uniform scan it happens to agree; the contrast shows up when some pages are hotter.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          policy: 'clock',
          find: (e) => at(e, (x) => x.stage === 'buffer' && x.action === 'evict'),
          label: 'Jump to the first eviction (clock sweep)',
        },
        tryThis: (
          <>
            Note the victim page number here, then go back to the LRU step and compare. Then open{' '}
            the <strong>Compare</strong> tool, which steps both policies together on a pattern built
            to make them disagree.
          </>
        ),
      },
    ],
  },
  {
    id: 'planner',
    title: 'Make the planner change its mind',
    minutes: 3,
    summary: 'One predicate becomes an index lookup; another cannot. See why.',
    steps: [
      {
        heading: 'An equality on the indexed column',
        body: (
          <>
            <code className="font-mono">id = 5</code> is an equality on the indexed column, so the
            optimiser swaps the scan for an <code className="font-mono">IndexScan</code>. The
            before/after trees are on screen together.
          </>
        ),
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'optimize'),
          label: 'Jump to the index-selection rewrite',
        },
      },
      {
        heading: 'A range on a column with no index',
        body: (
          <>
            <code className="font-mono">age &gt; 30</code> cannot use an index the table does not
            have, so the only rewrite is predicate pushdown — the filter folds into the scan, which
            still reads every page.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          find: (e) => at(e, (x) => x.stage === 'optimize'),
          label: 'Jump to the pushdown rewrite',
        },
        tryThis: (
          <>
            Try <code className="font-mono">WHERE id &gt; 5</code> — a range on the{' '}
            <em>indexed</em> column. Does it become an <code className="font-mono">IndexScan</code>?
            (It does not: the rule needs an equality.)
          </>
        ),
      },
    ],
  },
];

export function lessonById(id: string | undefined): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}
