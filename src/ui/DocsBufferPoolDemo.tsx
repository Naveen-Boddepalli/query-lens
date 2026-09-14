import { useMemo, useState } from 'react';
import {
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceString,
  runBufferTrace,
} from '../engine/index.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';
import { BufferPoolPanel } from './panels/BufferPoolPanel.tsx';
import { PlaybackControls } from './PlaybackControls.tsx';
import { usePlayback, usePlaybackShortcuts } from './usePlayback.ts';
import { btnGhost } from './primitives.ts';

/** Fills all 4 frames, then re-reads page 0 twice to make it "hot" before 4
 *  and 5 arrive needing room. Both policies end up keeping page 0 — the
 *  point of having a policy at all — but clock sweep takes visibly more
 *  steps to get there than LRU's direct recency lookup, the actual
 *  cost/benefit trade the page's own prose describes. */
const REF = '0 1 2 3 0 0 4 5';

/**
 * A live 4-frame buffer pool, embedded directly in the buffer-pool concept
 * page (plan.md §23.1's interactive-docs item) — the exact
 * `runBufferTrace`/`BufferPoolPanel` pair the `/tools/buffer-pool` sandbox
 * and the main pipeline both already use, driven by one fixed reference
 * string and steppable in place, with its own LRU/clock toggle rather than a
 * full policy-comparison workbench.
 */
export function BufferPoolMiniDemo() {
  const [policy, setPolicy] = useState<ReplacementPolicyName>('lru');
  const options = useMemo(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 4, policy }),
    [policy],
  );
  const refs = useMemo(() => parseReferenceString(REF), []);
  const result = useMemo(() => runBufferTrace(refs, options), [refs, options]);
  const projector = useMemo(() => createTraceProjector(result.events, options), [result, options]);
  const dwells = useMemo(() => result.events.map((e) => e.dwell ?? 1), [result]);
  const playback = usePlayback(result.events.length, { dwells, initialStep: 0 });
  usePlaybackShortcuts(playback, false);
  const state = projector.at(playback.step);

  return (
    <div className="not-prose my-6 rounded-xl border border-edge bg-surface-2 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-mono text-label text-ink-dim">references: {REF} · 4 frames</p>
        <div className="ml-auto flex gap-1">
          {(['lru', 'clock'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => { setPolicy(p); playback.reset(); }}
              aria-pressed={policy === p}
              className={`${btnGhost} ${policy === p ? 'border-accent bg-accent-soft text-ink' : ''}`}
            >
              {p === 'lru' ? 'LRU' : 'Clock sweep'}
            </button>
          ))}
        </div>
      </div>
      <BufferPoolPanel
        frames={state.frames}
        stats={state.bufferStats}
        clockHand={state.clockHand}
        policy={policy}
        lastEvent={state.lastEvent}
      />
      <p className="mt-3 text-label text-ink-dim">{state.narration || 'Press step to begin.'}</p>
      <div className="mt-2">
        <PlaybackControls playback={playback} length={result.events.length} />
      </div>
    </div>
  );
}
