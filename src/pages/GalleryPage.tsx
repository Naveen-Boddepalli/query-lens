import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../engine/index.ts';
import type { ReplacementPolicyName, StepEvent } from '../engine/index.ts';
import { encodeShareState } from '../ui/urlState.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive, pill, segBase, segOff, segOn, segmentedTrack } from '../ui/primitives.ts';

/**
 * Named, deep-linked traces (plan.md §21.3, §19.2's preset-chip idea promoted
 * to a page). Each step number is *computed* from a real run of the engine —
 * `events.findIndex(...)` against the same trace the Playground would produce
 * — rather than hand-typed, so an engine change that moves an eviction fails
 * a build here instead of quietly shipping a card pointing at the wrong step
 * (the discipline `scripts/build-og.ts` already uses for the link-preview
 * card).
 */

const SEED = createSeedDatabase();

const POINT_LOOKUP = 'SELECT *\nFROM users\nWHERE id = 5;';
const SEQUENTIAL_SCAN = 'SELECT *\nFROM users\nWHERE age > 30;';

type Topic = 'All' | 'Eviction' | 'Optimization' | 'Indexing';

function stepOf(events: readonly StepEvent[], find: (e: StepEvent) => boolean): number {
  const i = events.findIndex(find);
  if (i === -1) throw new Error('gallery moment: no matching event — the query or engine changed');
  return i + 1;
}

interface Moment {
  title: string;
  description: string;
  topic: 'Eviction' | 'Optimization' | 'Indexing';
  step: number;
  policy: ReplacementPolicyName;
  querySummary: string;
  href: string;
}

function moment(
  title: string,
  description: string,
  topic: 'Eviction' | 'Optimization' | 'Indexing',
  sql: string,
  policy: ReplacementPolicyName,
  find: (events: readonly StepEvent[]) => number,
): Moment {
  const result = runQuery(sql, SEED, { ...DEFAULT_ENGINE_OPTIONS, policy });
  const step = find(result.events);
  const query = encodeShareState({ sql, policy, predictOn: false, step }, undefined);
  const querySummary = sql.replace(/\s+/g, ' ').trim();
  return { title, description, topic, step, policy, querySummary, href: `/playground?${query}` };
}

const MOMENTS: Moment[] = [
  moment(
    'A point lookup, indexed',
    'The B+Tree finds one row in a handful of comparisons — no eviction, because the whole path fits in the pool.',
    'Indexing',
    POINT_LOOKUP,
    'lru',
    (events) => events.length,
  ),
  moment(
    'B+Tree root-to-leaf traversal',
    'Follow the index walker descending through the root and internal nodes directly to the target leaf page containing the key.',
    'Indexing',
    POINT_LOOKUP,
    'lru',
    (events) => stepOf(events, (e) => e.stage === 'index' && e.action === 'traverse'),
  ),
  moment(
    'The eviction storm',
    'A sequential scan over every page fills all eight frames, then LRU starts evicting. This is the moment that makes the buffer pool worth building.',
    'Eviction',
    SEQUENTIAL_SCAN,
    'lru',
    (events) => stepOf(events, (e) => e.stage === 'buffer' && e.action === 'evict'),
  ),
  moment(
    'The same scan, clock sweep',
    'Identical access pattern, a different policy. Compare the victim against the LRU moment above — plan.md §9 calls this the flagship contrast.',
    'Eviction',
    SEQUENTIAL_SCAN,
    'clock',
    (events) => stepOf(events, (e) => e.stage === 'buffer' && e.action === 'evict'),
  ),
  moment(
    'The optimizer rewrites the plan',
    'Predicate pushdown moves the WHERE clause as close to the scan as the rule allows — the before/after tree, mid-rewrite.',
    'Optimization',
    SEQUENTIAL_SCAN,
    'lru',
    (events) => stepOf(events, (e) => e.stage === 'optimize'),
  ),
  moment(
    'Index selection rewrite',
    'The query planner detects an equality condition on the indexed id column and swaps a full sequential scan for an efficient B+Tree index scan.',
    'Optimization',
    POINT_LOOKUP,
    'lru',
    (events) => stepOf(events, (e) => e.stage === 'optimize' && e.rule === 'index-selection'),
  ),
];

const TOPICS: readonly Topic[] = ['All', 'Eviction', 'Optimization', 'Indexing'];

export function GalleryPage() {
  const [activeTopic, setActiveTopic] = useState<Topic>('All');

  const filtered = useMemo(() => {
    if (activeTopic === 'All') return MOMENTS;
    return MOMENTS.filter((m) => m.topic === activeTopic);
  }, [activeTopic]);

  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
      <PageHeader title="Gallery">
        Named moments in the pipeline, each a link that opens the Playground already stepped to
        that exact point. Good for pointing someone at a specific mechanism rather than a query.
      </PageHeader>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className={segmentedTrack} role="tablist" aria-label="Topic filter">
          {TOPICS.map((topic) => (
            <button
              key={topic}
              type="button"
              role="tab"
              aria-selected={activeTopic === topic}
              onClick={() => { setActiveTopic(topic); }}
              className={`${segBase} text-label py-1 px-3 ${activeTopic === topic ? segOn : segOff}`}
            >
              {topic}
            </button>
          ))}
        </div>
        <span className="text-label text-ink-dim tabular-nums">
          Showing {filtered.length} of {MOMENTS.length} moments
        </span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {filtered.map((m) => (
          <Link key={m.title} to={m.href} className={`${cardInteractive} flex flex-col justify-between`}>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${pill} text-[11px] font-mono tracking-wider uppercase text-accent border-accent/40 bg-accent-soft`}>
                  {m.topic}
                </span>
                <span className={`${pill} text-[11px] font-mono tabular-nums text-ink`}>
                  Step {m.step}
                </span>
                <span className={`${pill} text-[11px] font-mono text-ink-dim`}>
                  {m.policy}
                </span>
              </div>
              <h3 className="mt-3 text-body font-semibold text-ink group-hover:text-accent transition-colors">
                {m.title}
              </h3>
              <p className="mt-1.5 text-label text-ink-dim leading-relaxed">
                {m.description}
              </p>
              <div className="mt-3 overflow-hidden rounded-md border border-edge/60 bg-surface/70 px-2.5 py-1 text-code font-mono text-ink-dim truncate">
                {m.querySummary}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between pt-3 border-t border-edge/50 text-label font-medium text-accent">
              <span className="inline-flex items-center gap-1.5 transition-transform group-hover:translate-x-0.5">
                Jump to Step {m.step}
              </span>
              <svg
                viewBox="0 0 16 16"
                className="h-4 w-4 stroke-current stroke-2 transition-transform group-hover:translate-x-1"
                fill="none"
                aria-hidden="true"
              >
                <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </Link>
        ))}
      </div>

      <p className="mt-8 text-label text-ink-dim">
        Want the two policies moving side by side instead of one link each? See{' '}
        <Link to="/compare" className="underline underline-offset-2 hover:text-ink">
          Compare
        </Link>
        .
      </p>
    </div>
  );
}
