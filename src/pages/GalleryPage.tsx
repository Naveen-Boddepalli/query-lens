import { Link } from 'react-router-dom';
import {
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../engine/index.ts';
import type { ReplacementPolicyName, StepEvent } from '../engine/index.ts';
import { encodeShareState } from '../ui/urlState.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive } from '../ui/primitives.ts';

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

function stepOf(events: readonly StepEvent[], find: (e: StepEvent) => boolean): number {
  const i = events.findIndex(find);
  if (i === -1) throw new Error('gallery moment: no matching event — the query or engine changed');
  return i + 1;
}

interface Moment {
  title: string;
  description: string;
  href: string;
}

function moment(
  title: string,
  description: string,
  sql: string,
  policy: ReplacementPolicyName,
  find: (events: readonly StepEvent[]) => number,
): Moment {
  const result = runQuery(sql, SEED, { ...DEFAULT_ENGINE_OPTIONS, policy });
  const step = find(result.events);
  const query = encodeShareState({ sql, policy, predictOn: false, step }, undefined);
  return { title, description, href: `/playground?${query}` };
}

const MOMENTS: Moment[] = [
  moment(
    'A point lookup, indexed',
    'The B+Tree finds one row in a handful of comparisons — no eviction, because the whole path fits in the pool.',
    POINT_LOOKUP,
    'lru',
    (events) => events.length,
  ),
  moment(
    'The eviction storm',
    'A sequential scan over every page fills all eight frames, then LRU starts evicting. This is the moment that makes the buffer pool worth building.',
    SEQUENTIAL_SCAN,
    'lru',
    (events) => stepOf(events, (e) => e.stage === 'buffer' && e.action === 'evict'),
  ),
  moment(
    'The same scan, clock sweep',
    'Identical access pattern, a different policy. Compare the victim against the LRU moment above — plan.md §9 calls this the flagship contrast.',
    SEQUENTIAL_SCAN,
    'clock',
    (events) => stepOf(events, (e) => e.stage === 'buffer' && e.action === 'evict'),
  ),
  moment(
    'The optimizer rewrites the plan',
    'Predicate pushdown moves the WHERE clause as close to the scan as the rule allows — the before/after tree, mid-rewrite.',
    SEQUENTIAL_SCAN,
    'lru',
    (events) => stepOf(events, (e) => e.stage === 'optimize'),
  ),
];

export function GalleryPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <PageHeader title="Gallery">
        Named moments in the pipeline, each a link that opens the Playground already stepped to
        that exact point. Good for pointing someone at a specific mechanism rather than a query.
      </PageHeader>

      <div className="mt-8 space-y-3">
        {MOMENTS.map((m) => (
          <Link key={m.title} to={m.href} className={cardInteractive}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-body font-semibold text-ink">{m.title}</h3>
              <span
                aria-hidden
                className="text-ink-dim transition group-hover:translate-x-0.5 group-hover:text-accent"
              >
                →
              </span>
            </div>
            <p className="mt-1 text-label text-ink-dim">{m.description}</p>
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
