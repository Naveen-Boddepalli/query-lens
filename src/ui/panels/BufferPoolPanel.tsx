import type { ReactNode } from 'react';
import { USAGE_COUNT_CAP } from '../../engine/index.ts';
import type { BufferFrame, ReplacementPolicyName, StepEvent } from '../../engine/index.ts';

export interface BufferPoolPanelProps {
  frames: BufferFrame[];
  stats: { hits: number; misses: number; evictions: number; writes: number };
  clockHand: number;
  policy: ReplacementPolicyName;
  lastEvent: StepEvent | null;
}

type FrameMood = 'hit' | 'load' | 'write' | 'evict' | 'sweep' | null;

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
  // Violet, not one of the read-path colours — a write is neither a hit nor a
  // disk read, and it shares its tone with the Sort plan node that causes it.
  write:
    'border-hue-violet bg-hue-violet/15 shadow-[0_0_26px_-4px_var(--color-hue-violet)] hover:bg-hue-violet/25',
  evict: 'border-evict bg-evict/20 shadow-[0_0_28px_-4px_var(--color-evict)] hover:bg-evict/30',
  sweep: 'border-accent bg-accent/10 shadow-glow hover:bg-accent/20',
};

// A leading glyph so the mood reads without relying on the border hue — the
// always-on second channel plan.md §22.6 asks for (colour-vision deficiency,
// projector wash-out). `✓` resident, `↓` came from disk, `✎` freshly written,
// `✕` dropped, `↻` swept.
const MOOD_TAG: Record<Exclude<FrameMood, null>, string> = {
  hit: '✓ hit',
  load: '↓ disk read',
  write: '✎ written',
  evict: '✕ evicted',
  sweep: '↻ swept',
};

/**
 * The footnote under the grid — what this policy does and, where it matters,
 * what it gets wrong that the next one fixes. `lru` and `clock` are the
 * pipeline's pair; the other three are the standalone tool's study material
 * (plan.md §20.4).
 */
const POLICY_NOTE: Record<ReplacementPolicyName, ReactNode> = {
  'lru-k': (
    <>
      <span className="text-ink">LRU-2</span> judges a page by its second-most-recent reference, not its last one. A page
      read once has no second reference, so a one-pass scan evicts its own pages and leaves the twice-touched hot set alone.
      It is plain LRU with one more memory of history, not a different mechanism.
    </>
  ),
  lru: (
    <>
      <span className="text-ink">LRU</span> evicts whichever page was used longest ago. It is
      the policy every course teaches — and the one PostgreSQL deliberately avoids, because
      maintaining the ordering needs a lock on every single page access.
    </>
  ),
  clock: (
    <>
      <span className="text-ink">Clock sweep</span> is what PostgreSQL actually does. Each frame
      carries a usage count; the hand walks in a circle, decrementing as it goes, and evicts the
      first frame it finds at zero. Hot pages survive several passes with no list to maintain. On
      a uniform scan it picks the same victims as LRU — the two only diverge once some pages are
      hotter than others.
    </>
  ),
  fifo: (
    <>
      <span className="text-ink">FIFO</span> evicts whichever page has been resident longest, no
      matter how heavily it has been used since. Cheap to run, but it will throw out a page the
      query is about to read again — the failure clock sweep and second-chance both set out to
      fix.
    </>
  ),
  'second-chance': (
    <>
      <span className="text-ink">Second-chance</span> is FIFO with one reprieve. Each frame has a
      reference bit, set when the page is used. The oldest frame is inspected first; if its bit
      is set, the bit clears and the frame goes to the back of the queue instead of out. Clock
      sweep is this idea with a circular hand and a counter instead of a single bit.
    </>
  ),
  optimal: (
    <>
      <span className="text-ink">Optimal</span> evicts the page whose next use is farthest in the
      future — a page never used again first. No real system can run it, because it needs the
      whole future access pattern, but it is the fewest-misses bound every policy above is
      measured against.
    </>
  ),
  midpoint: (
    <>
      <span className="text-ink">Midpoint LRU</span> is what InnoDB (MySQL) does. The LRU list has a
      young half and an old half; a page read from disk enters the <em>old</em> half and only
      reaches the young half if it is read again. A sequential scan touches each page once, so its
      pages evict one another out of the old half and never displace the hot set — the failure
      plain LRU has that this fixes.
    </>
  ),
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

      {/* The counts echo the frame glyphs (§22.6), so the green/amber/red on the
          numbers is a third channel, not the only one. */}
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-label">
        <div>
          <dt className="text-ink-dim"><span aria-hidden>✓ </span>hits</dt>
          <dd className="font-mono text-hit">{stats.hits}</dd>
        </div>
        <div>
          <dt className="text-ink-dim"><span aria-hidden>↓ </span>misses</dt>
          <dd className="font-mono text-miss">{stats.misses}</dd>
        </div>
        <div>
          <dt className="text-ink-dim"><span aria-hidden>↓ </span>disk reads</dt>
          <dd className="font-mono text-miss">{stats.misses}</dd>
        </div>
        <div>
          <dt className="text-ink-dim"><span aria-hidden>✕ </span>evictions</dt>
          <dd className="font-mono text-evict">{stats.evictions}</dd>
        </div>
        {stats.writes > 0 && (
          <div>
            <dt className="text-ink-dim"><span aria-hidden>✎ </span>writes</dt>
            <dd className="font-mono text-hue-violet-ink">{stats.writes}</dd>
          </div>
        )}
        <div>
          <dt className="text-ink-dim">hit rate</dt>
          <dd className="font-mono">{hitRate}</dd>
        </div>
      </dl>

      <p className="mt-auto text-label leading-relaxed text-ink-dim">{POLICY_NOTE[policy]}</p>
    </div>
  );
}
