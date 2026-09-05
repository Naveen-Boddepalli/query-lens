import { useMemo, useState } from 'react';
import {
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceString,
  runBufferTrace,
} from '../engine/index.ts';
import type { BufferTraceResult, EngineOptions } from '../engine/index.ts';
import { BufferPoolPanel } from '../ui/panels/BufferPoolPanel.tsx';

/**
 * plan.md §13's comparison mode, scoped to the contrast §9 actually validates:
 * the same access pattern under LRU and clock sweep, side by side.
 *
 * The two policies emit different numbers of events for an identical
 * reference string — clock sweep adds a `sweep` event per frame the hand
 * passes — so they cannot share one raw event-index scrubber. Both sides are
 * instead driven by *access index* (`BufferTraceResult.accessBoundaries`,
 * src/engine/bufferTrace.ts), which both traces agree on by construction: "10
 * references in" means the same thing on both panels even though it lands at
 * a different event count in each.
 */

// Pages 0-2 are touched twice each (hot), page 3 once (cold), before page 4
// forces an eviction. Verified to diverge: LRU evicts page 0 — it is purely
// recency-ordered, and 0's last touch happens to be the earliest of the
// repeated three — while clock sweep's usage count has protected 0-2 and
// evicts the genuinely cold page 3 instead. A uniform scan (no repeats) picks
// the same victim under both, which is `bufferTrace.test.ts`'s point; this
// string is chosen to show the other half.
const DEFAULT_REF = '0 1 2 0 1 2 3 4';
const FRAMES = 4;

function side(refs: number[], options: EngineOptions): BufferTraceResult {
  return runBufferTrace(refs, options);
}

function Column({
  label,
  trace,
  options,
  accessIndex,
}: {
  label: string;
  trace: BufferTraceResult;
  options: EngineOptions;
  accessIndex: number;
}) {
  const projector = useMemo(() => createTraceProjector(trace.events, options), [trace, options]);
  const eventStep = accessIndex === 0 ? 0 : (trace.accessBoundaries[accessIndex - 1] ?? 0);
  const state = projector.at(eventStep);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-body font-semibold text-ink">{label}</h3>
      <div className="min-h-56 rounded-lg border border-edge bg-surface-2 p-3">
        <BufferPoolPanel
          frames={state.frames}
          stats={state.bufferStats}
          clockHand={state.clockHand}
          policy={options.policy}
          lastEvent={state.lastEvent}
        />
      </div>
      <p className="min-h-8 text-label text-ink-dim" aria-live="polite">
        {state.narration}
      </p>
    </div>
  );
}

export function ComparePage() {
  const [refInput, setRefInput] = useState(DEFAULT_REF);
  const [refs, setRefs] = useState<number[]>(() => parseReferenceString(DEFAULT_REF));
  const [accessIndex, setAccessIndex] = useState(0);

  const lruOptions = useMemo<EngineOptions>(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: FRAMES, policy: 'lru' }),
    [],
  );
  const clockOptions = useMemo<EngineOptions>(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: FRAMES, policy: 'clock' }),
    [],
  );

  const lru = useMemo(() => side(refs, lruOptions), [refs, lruOptions]);
  const clock = useMemo(() => side(refs, clockOptions), [refs, clockOptions]);

  /**
   * The first access where the two policies chose a different victim, or
   * `null` if they agree throughout.
   *
   * An eviction is not necessarily the *last* event of an access — under
   * clock sweep it is miss, some number of sweep ticks, evict, then load — so
   * this scans every event *within* each access's slice for the one eviction
   * it can contain, rather than looking only at the boundary event (which is
   * always the trailing `load`).
   */
  const divergedAt = useMemo(() => {
    const evictionIn = (trace: BufferTraceResult, accessIndex: number) => {
      const from = accessIndex === 0 ? 0 : (trace.accessBoundaries[accessIndex - 1] ?? 0);
      const to = trace.accessBoundaries[accessIndex] ?? from;
      for (let e = from; e < to; e++) {
        const event = trace.events[e];
        if (event?.stage === 'buffer' && event.action === 'evict') return event.victimPageId;
      }
      return null;
    };
    const accesses = Math.min(lru.accessBoundaries.length, clock.accessBoundaries.length);
    for (let i = 0; i < accesses; i++) {
      const lruVictim = evictionIn(lru, i);
      const clockVictim = evictionIn(clock, i);
      if (lruVictim !== null && clockVictim !== null && lruVictim !== clockVictim) return i + 1;
    }
    return null;
  }, [lru, clock]);

  function run() {
    setRefs(parseReferenceString(refInput));
    setAccessIndex(0);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-4 p-6">
      <div>
        <h2 className="text-heading font-semibold">Compare: LRU vs. clock sweep</h2>
        <p className="mt-1 max-w-2xl text-body text-ink-dim">
          One access pattern, {FRAMES} frames, two policies stepping together. plan.md §9 calls
          this the contrast that makes the honesty problem the product's best teaching moment —
          same inputs, different victim.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-edge bg-surface-2 p-3">
        <label className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
          Reference string
          <input
            type="text"
            value={refInput}
            onChange={(e) => { setRefInput(e.target.value); }}
            className="rounded-md border border-edge bg-surface-3 px-2.5 py-1.5 font-mono text-body text-ink"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          onClick={run}
          className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-accent/25"
        >
          Run
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-label text-ink-dim">
        <button
          type="button"
          onClick={() => { setAccessIndex((i) => Math.max(0, i - 1)); }}
          disabled={accessIndex === 0}
          className="rounded-md border border-edge bg-surface-3 px-3 py-1.5 text-body text-ink transition-colors hover:border-accent/70 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ◀ back
        </button>
        <input
          type="range"
          min={0}
          max={refs.length}
          value={accessIndex}
          onChange={(e) => { setAccessIndex(Number(e.target.value)); }}
          className="flex-1"
          aria-label="Access index"
        />
        <button
          type="button"
          onClick={() => { setAccessIndex((i) => Math.min(refs.length, i + 1)); }}
          disabled={accessIndex >= refs.length}
          className="rounded-md border border-edge bg-surface-3 px-3 py-1.5 text-body text-ink transition-colors hover:border-accent/70 disabled:cursor-not-allowed disabled:opacity-40"
        >
          forward ▶
        </button>
        <span className="tabular-nums">
          access {accessIndex} / {refs.length}
        </span>
      </div>

      {divergedAt !== null && (
        <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-label text-ink">
          The two policies first pick a <em>different</em> victim at access {divergedAt}.{' '}
          <button
            type="button"
            onClick={() => { setAccessIndex(divergedAt); }}
            className="underline underline-offset-2 hover:text-accent"
          >
            Jump there
          </button>
        </p>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <Column label="LRU" trace={lru} options={lruOptions} accessIndex={accessIndex} />
        <Column label="Clock sweep" trace={clock} options={clockOptions} accessIndex={accessIndex} />
      </div>
    </div>
  );
}
