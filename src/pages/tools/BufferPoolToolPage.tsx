import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceString,
  randomReferenceString,
  REPLACEMENT_POLICY_LABELS,
  REPLACEMENT_POLICY_NAMES,
  runBufferTrace,
} from '../../engine/index.ts';
import type { ReplacementPolicyName } from '../../engine/index.ts';
import { BufferPoolPanel } from '../../ui/panels/BufferPoolPanel.tsx';
import { PlaybackControls } from '../../ui/PlaybackControls.tsx';
import { usePlayback, usePlaybackShortcuts } from '../../ui/usePlayback.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';

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
  const policy = (REPLACEMENT_POLICY_NAMES as readonly string[]).includes(policyRaw ?? '')
    ? (policyRaw as ReplacementPolicyName)
    : 'lru';
  return {
    refInput: ref && ref.length > 0 ? ref : DEFAULT_REF,
    frames:
      Number.isInteger(framesRaw) && framesRaw >= MIN_FRAMES && framesRaw <= MAX_FRAMES
        ? framesRaw
        : 4,
    policy,
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
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'Buffer Pool' }]}
        title="Buffer Pool Sandbox"
      >
        Type a page-reference string — the sequence of pages a program touches — and step through
        how {REPLACEMENT_POLICY_LABELS[policy]} decides what stays resident. This is the buffer pool
        from the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        , driven directly with five policies: LRU, clock sweep, FIFO, second-chance, and the optimal bound.
      </PageHeader>

      {/* Control Toolbar */}
      <div className="ql-sheen flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <label className="flex flex-1 min-w-64 flex-col gap-1.5 text-label text-ink-dim">
          <span>Reference string <span className="text-ink-dim/60 font-mono text-[0.75rem]">(space or comma separated)</span></span>
          <input
            type="text"
            value={refInput}
            onChange={(e) => { setRefInput(e.target.value); }}
            className={`${inputField} font-mono`}
            spellCheck={false}
          />
        </label>

        <label className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Frames</span>
          <input
            type="number"
            min={MIN_FRAMES}
            max={MAX_FRAMES}
            value={frames}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= MIN_FRAMES && n <= MAX_FRAMES) setFrames(n);
            }}
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Policy</span>
          <select
            value={policy}
            onChange={(e) => { setPolicy(e.target.value as ReplacementPolicyName); }}
            className={inputField}
          >
            {REPLACEMENT_POLICY_NAMES.map((name) => (
              <option key={name} value={name}>
                {REPLACEMENT_POLICY_LABELS[name]}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <button type="button" onClick={run} className={btnPrimary}>
            Run
          </button>
          <button type="button" onClick={generate} className={btnSecondary}>
            Generate pattern
          </button>
        </div>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: 'Accesses', value: String(refs.length), sub: `${result.events.length} trace events` },
          {
            label: 'Current Step',
            value: `${playback.step} / ${Math.max(0, result.events.length - 1)}`,
            sub: 'timeline position',
            color: 'text-accent',
          },
          {
            label: 'Hit Ratio',
            value: `${state.bufferStats && state.bufferStats.hits + state.bufferStats.misses > 0 ? Math.round((state.bufferStats.hits / (state.bufferStats.hits + state.bufferStats.misses)) * 100) : 0}%`,
            sub: `${state.bufferStats?.hits ?? 0} hits · ${state.bufferStats?.misses ?? 0} misses`,
            color: 'text-hit',
          },
          { label: 'Active Policy', value: REPLACEMENT_POLICY_LABELS[policy], sub: `${frames} frames` },
        ].map((m) => (
          <div key={m.label} className="ql-sheen rounded-xl border border-edge bg-surface-2/60 p-3 shadow-neu-rest backdrop-blur-sm">
            <span className="block font-mono text-[0.7rem] uppercase tracking-wider text-ink-dim">{m.label}</span>
            <span className={`mt-1 block truncate text-heading font-semibold tabular-nums ${m.color ?? 'text-ink'}`}>
              {m.value}
            </span>
            <span className="text-[0.75rem] text-ink-dim">{m.sub}</span>
          </div>
        ))}
      </div>

      {/* Main visualization panel */}
      <div className={`${panelSurface} min-h-64 flex-1 p-5`}>
        <BufferPoolPanel
          frames={state.frames}
          stats={state.bufferStats}
          clockHand={state.clockHand}
          policy={policy}
          lastEvent={state.lastEvent}
        />
      </div>

      {/* Narration */}
      <div className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-sm">
        <h3 className="mb-1 text-label font-medium tracking-[0.12em] text-ink-dim uppercase font-mono">
          Narration
        </h3>
        <p className="min-h-10 text-body leading-relaxed text-ink" aria-live="polite">
          {state.narration || 'Step forward to start.'}
        </p>
      </div>

      <PlaybackControls playback={playback} length={result.events.length} />
    </div>
  );
}
