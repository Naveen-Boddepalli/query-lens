import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceString,
  randomReferenceString,
  runBufferTrace,
} from '../../engine/index.ts';
import type { ReplacementPolicyName } from '../../engine/index.ts';
import { BufferPoolPanel } from '../../ui/panels/BufferPoolPanel.tsx';
import { PlaybackControls } from '../../ui/PlaybackControls.tsx';
import { usePlayback, usePlaybackShortcuts } from '../../ui/usePlayback.ts';

/**
 * The OS-course standalone (plan.md §20.4, §21.3): the buffer pool with no
 * SQL, no table, no B+Tree — just a page-reference string and a policy. It
 * renders through the exact panel and the exact event fold the full pipeline
 * uses (`src/engine/bufferTrace.ts`), so "LRU vs clock, one access pattern" —
 * the contrast plan.md §9 is built to demonstrate — is a five-second edit
 * here rather than a crafted SQL query.
 *
 * URL state is deliberately minimal next to `src/ui/urlState.ts`: three plain
 * fields (`ref`, `frames`, `policy`), still parsed defensively since a pasted
 * link is untrusted input, but without the rows/predict machinery the full
 * Playground schema carries and this page has no use for.
 */

const DEFAULT_REF = '0 1 2 3 4 0 1 2 3 4';
const MIN_FRAMES = 2;
const MAX_FRAMES = 8;

function readInitial() {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const ref = params.get('ref');
  const framesRaw = Number(params.get('frames'));
  const policyRaw = params.get('policy');
  return {
    refInput: ref && ref.length > 0 ? ref : DEFAULT_REF,
    frames:
      Number.isInteger(framesRaw) && framesRaw >= MIN_FRAMES && framesRaw <= MAX_FRAMES
        ? framesRaw
        : 4,
    policy: policyRaw === 'lru' || policyRaw === 'clock' ? policyRaw : ('lru' as ReplacementPolicyName),
  };
}

const INITIAL = readInitial();

export function BufferPoolToolPage() {
  const [refInput, setRefInput] = useState(INITIAL.refInput);
  const [frames, setFrames] = useState(INITIAL.frames);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(INITIAL.policy);

  const options = useMemo(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy }),
    [frames, policy],
  );

  const [refs, setRefs] = useState<number[]>(() => parseReferenceString(INITIAL.refInput));
  const result = useMemo(() => runBufferTrace(refs, options), [refs, options]);
  const projector = useMemo(() => createTraceProjector(result.events, options), [result, options]);
  const dwells = useMemo(() => result.events.map((e) => e.dwell ?? 1), [result]);

  const playback = usePlayback(result.events.length, { dwells, initialStep: 0 });
  usePlaybackShortcuts(playback, true);

  const state = projector.at(playback.step);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      params.set('ref', refInput);
      params.set('frames', String(frames));
      params.set('policy', policy);
      const next = `${location.pathname}?${params.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [refInput, frames, policy]);

  function run() {
    setRefs(parseReferenceString(refInput));
    playback.reset();
  }

  function generate() {
    const generated = randomReferenceString(20, Math.max(frames + 2, 6));
    setRefInput(generated.join(' '));
    setRefs(generated);
    playback.reset();
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-1 flex-col gap-4 p-6">
      <div>
        <h2 className="text-heading font-semibold">Buffer pool sandbox</h2>
        <p className="mt-1 max-w-2xl text-body text-ink-dim">
          Type a page-reference string — the sequence of pages a program touches — and step through
          how {policy === 'lru' ? 'LRU' : 'clock sweep'} decides what stays resident. No SQL: this
          is the buffer pool from the{' '}
          <Link to="/" className="underline underline-offset-2 hover:text-ink">
            Playground
          </Link>
          , driven directly.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-edge bg-surface-2 p-3">
        <label className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
          Reference string (page numbers, space or comma separated)
          <input
            type="text"
            value={refInput}
            onChange={(e) => { setRefInput(e.target.value); }}
            className="rounded-md border border-edge bg-surface-3 px-2.5 py-1.5 font-mono text-body text-ink"
            spellCheck={false}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Frames
          <input
            type="number"
            min={MIN_FRAMES}
            max={MAX_FRAMES}
            value={frames}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= MIN_FRAMES && n <= MAX_FRAMES) setFrames(n);
            }}
            className="w-20 rounded-md border border-edge bg-surface-3 px-2.5 py-1.5 text-body text-ink tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Policy
          <select
            value={policy}
            onChange={(e) => { setPolicy(e.target.value as ReplacementPolicyName); }}
            className="rounded-md border border-edge bg-surface-3 px-2 py-1.5 text-body text-ink"
          >
            <option value="lru">LRU</option>
            <option value="clock">Clock sweep</option>
          </select>
        </label>

        <button
          type="button"
          onClick={run}
          className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-accent/25"
        >
          Run
        </button>
        <button
          type="button"
          onClick={generate}
          className="rounded-md border border-edge px-3 py-1.5 text-body text-ink-dim transition-colors hover:border-accent/70 hover:text-ink"
        >
          Generate a pattern
        </button>
      </div>

      <p className="text-label text-ink-dim">
        {result.events.length === 0
          ? 'Type at least one page number and press Run.'
          : // Stepped by raw event, the same unit the Playground's own step
            // counter uses — a miss followed by a load is two steps here for
            // the same reason it is two steps there. `refs.length` accesses
            // can take more steps than that under clock sweep, whose sweep
            // ticks are steps of their own.
            `${String(refs.length)} accesses, ${String(result.events.length)} steps · showing step ${String(playback.step)}`}
      </p>

      <div className="min-h-64 flex-1 rounded-lg border border-edge bg-surface-2 p-4">
        <BufferPoolPanel
          frames={state.frames}
          stats={state.bufferStats}
          clockHand={state.clockHand}
          policy={policy}
          lastEvent={state.lastEvent}
        />
      </div>

      <div className="rounded-lg border border-edge bg-surface-2 p-3">
        <h3 className="mb-1 text-label font-medium text-ink-dim">Narration</h3>
        <p className="min-h-10 text-body leading-relaxed" aria-live="polite">
          {state.narration || 'Step forward to start.'}
        </p>
      </div>

      <PlaybackControls playback={playback} length={result.events.length} />
    </div>
  );
}
