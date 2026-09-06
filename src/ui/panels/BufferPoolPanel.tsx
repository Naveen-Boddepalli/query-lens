import { USAGE_COUNT_CAP } from '../../engine/index.ts';
import type { BufferFrame, ReplacementPolicyName, StepEvent } from '../../engine/index.ts';

export interface BufferPoolPanelProps {
  frames: BufferFrame[];
  stats: { hits: number; misses: number; evictions: number };
  clockHand: number;
  policy: ReplacementPolicyName;
  lastEvent: StepEvent | null;
}

type FrameMood = 'hit' | 'load' | 'evict' | 'sweep' | null;

function moodOf(frame: BufferFrame, lastEvent: StepEvent | null): FrameMood {
  if (lastEvent?.stage !== 'buffer') return null;
  // A miss has not chosen a frame yet, so it highlights nothing.
  if (lastEvent.action === 'miss') return null;
  return lastEvent.frameId === frame.frameId ? lastEvent.action : null;
}

/**
 * The hover half of each mood follows plan.md §16.2 item 4's tinted rule —
 * deepen the fill one step, brighten the border — rather than reaching for a
 * neutral lift, so pointing at an evicted frame does not momentarily make it
 * look like an ordinary one.
 */
const MOOD_CLASS: Record<Exclude<FrameMood, null>, string> = {
  hit: 'border-hit bg-hit/15 shadow-[0_0_26px_-4px_var(--color-hit)] hover:bg-hit/25',
  load: 'border-miss bg-miss/15 shadow-[0_0_26px_-4px_var(--color-miss)] hover:bg-miss/25',
  evict: 'border-evict bg-evict/20 shadow-[0_0_28px_-4px_var(--color-evict)] hover:bg-evict/30',
  sweep: 'border-accent bg-accent/10 shadow-glow hover:bg-accent/20',
};

const MOOD_TAG: Record<Exclude<FrameMood, null>, string> = {
  hit: 'hit',
  load: 'disk read',
  evict: 'evicted',
  sweep: 'swept',
};

export function BufferPoolPanel({
  frames,
  stats,
  clockHand,
  policy,
  lastEvent,
}: BufferPoolPanelProps) {
  const reads = stats.hits + stats.misses;
  const hitRate = reads === 0 ? '—' : `${Math.round((stats.hits / reads) * 100)}%`;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        {frames.map((frame) => {
          const mood = moodOf(frame, lastEvent);
          const empty = frame.pageId === null;
          return (
            <div
              key={frame.frameId}
              /* A frame is not a control — nothing happens when you click one —
                 so it gets the hover feedback and no `cursor-pointer`, per
                 plan.md §16.2 item 4. The feedback still earns its place: in a
                 four-up grid of near-identical boxes, pointing at one and
                 seeing it respond is how you keep your place while stepping. */
              className={[
                // Was `transition-all duration-200`, which animated the mood
                // glow's geometry as well as its colour and used a literal
                // duration nobody had chosen (§16.2 item 5). `.cell` lists the
                // properties and names the timing.
                'cell ql-sheen relative rounded-xl border p-2.5 shadow-e1',
                mood
                  ? MOOD_CLASS[mood]
                  : empty
                    ? 'border-dashed border-edge/60 shadow-none hover:border-ink-dim/50'
                    : 'border-edge bg-surface-3 hover:border-ink-dim/50 hover:bg-surface-4',
              ].join(' ')}
            >
              <div className="flex items-baseline justify-between text-label text-ink-dim">
                <span>frame {frame.frameId}</span>
                {policy === 'clock' && clockHand === frame.frameId && (
                  <span title="clock hand is here" aria-label="clock hand">
                    👉
                  </span>
                )}
              </div>

              <div className="mt-0.5 font-mono text-body">
                {empty ? (
                  <span className="text-ink-dim">empty</span>
                ) : (
                  <span>page {frame.pageId}</span>
                )}
              </div>

              {policy === 'clock' && !empty && (
                <div
                  className="mt-1 flex gap-0.5"
                  title={`usage count ${frame.usageCount} of ${USAGE_COUNT_CAP}`}
                >
                  {Array.from({ length: USAGE_COUNT_CAP }, (_, i) => (
                    <span
                      key={i}
                      className={`h-1 flex-1 rounded-full ${
                        i < frame.usageCount ? 'bg-accent' : 'bg-edge'
                      }`}
                    />
                  ))}
                </div>
              )}

              {mood && (
                <div className="mt-1 text-label tracking-wide uppercase opacity-80">
                  {MOOD_TAG[mood]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-label">
        <div>
          <dt className="text-ink-dim">hits</dt>
          <dd className="font-mono text-hit">{stats.hits}</dd>
        </div>
        <div>
          <dt className="text-ink-dim">misses</dt>
          <dd className="font-mono text-miss">{stats.misses}</dd>
        </div>
        <div>
          <dt className="text-ink-dim">disk reads</dt>
          <dd className="font-mono text-miss">{stats.misses}</dd>
        </div>
        <div>
          <dt className="text-ink-dim">evictions</dt>
          <dd className="font-mono text-evict">{stats.evictions}</dd>
        </div>
        <div>
          <dt className="text-ink-dim">hit rate</dt>
          <dd className="font-mono">{hitRate}</dd>
        </div>
      </dl>

      <p className="mt-auto text-label leading-relaxed text-ink-dim">
        {policy === 'lru' ? (
          <>
            <span className="text-ink">LRU</span> evicts whichever page was used
            longest ago. It is the policy every course teaches — and the one
            PostgreSQL deliberately avoids, because maintaining the ordering needs a
            lock on every single page access.
          </>
        ) : (
          <>
            <span className="text-ink">Clock sweep</span> is what PostgreSQL actually
            does. Each frame carries a usage count; the hand walks in a circle,
            decrementing as it goes, and evicts the first frame it finds at zero. Hot
            pages survive several passes with no list to maintain. On a uniform scan
            it picks the same victims as LRU — the two only diverge once some pages
            are hotter than others.
          </>
        )}
      </p>
    </div>
  );
}
