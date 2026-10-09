import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceScans,
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
const MAX_READ_AHEAD = 4;
const MAX_SCAN_RING = 4;

function readInitial() {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const ref = params.get('ref');
  const framesRaw = Number(params.get('frames'));
  const policyRaw = params.get('policy');
  const readAheadRaw = Number(params.get('ra'));
  const scanRingRaw = Number(params.get('sr'));
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
    readAhead: Number.isInteger(readAheadRaw) && readAheadRaw >= 0 && readAheadRaw <= MAX_READ_AHEAD ? readAheadRaw : 0,
    scanRing: Number.isInteger(scanRingRaw) && scanRingRaw >= 0 && scanRingRaw <= MAX_SCAN_RING ? scanRingRaw : 0,
  };
}

const INITIAL = readInitial();

export function BufferPoolToolPage() {
  const [refInput, setRefInput] = useState(INITIAL.refInput);
  const [frames, setFrames] = useState(INITIAL.frames);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(INITIAL.policy);
  const [readAhead, setReadAhead] = useState(INITIAL.readAhead);
  const [scanRing, setScanRing] = useState(INITIAL.scanRing);

  const options = useMemo(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy, readAhead, scanRing }),
    [frames, policy, readAhead, scanRing],
  );

  const [parsed, setParsed] = useState(() => parseReferenceScans(INITIAL.refInput));
  const { refs, scans } = parsed;
  const result = useMemo(() => runBufferTrace(refs, options, scans), [refs, scans, options]);
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
      if (readAhead > 0) params.set('ra', String(readAhead));
      if (scanRing > 0) params.set('sr', String(scanRing));
      const next = `${location.pathname}?${params.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [refInput, frames, policy, readAhead, scanRing]);

  function run() {
    setParsed(parseReferenceScans(refInput));
    playback.reset();
  }

  function generate() {
    const generated = randomReferenceString(20, Math.max(frames + 2, 6));
    setRefInput(generated.join(' '));
    setParsed({ refs: generated, scans: [] });
    playback.reset();
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Buffer pool sandbox">
        Type a page-reference string — the sequence of pages a program touches — and step through
        how {REPLACEMENT_POLICY_LABELS[policy]} decides what stays resident. No SQL: this is the
        buffer pool from the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        , driven directly — with every replacement policy the engine has, and the read-ahead and
        scan-ring options the Playground does not expose.
      </PageHeader>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
          Reference string (page numbers, space or comma separated; a range like 10-50 is one scan)
          <input
            type="text"
            value={refInput}
            onChange={(e) => { setRefInput(e.target.value); }}
            className={`${inputField} font-mono`}
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
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Policy
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

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Read-ahead
          <select
            value={readAhead}
            onChange={(e) => { setReadAhead(Number(e.target.value)); }}
            className={inputField}
          >
            <option value={0}>off</option>
            <option value={1}>1 page</option>
            <option value={2}>2 pages</option>
            <option value={4}>4 pages</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Scan ring
          <select
            value={scanRing}
            onChange={(e) => { setScanRing(Number(e.target.value)); }}
            className={inputField}
          >
            <option value={0}>off</option>
            <option value={2}>2 frames</option>
            <option value={3}>3 frames</option>
            <option value={4}>4 frames</option>
          </select>
        </label>

        <button type="button" onClick={run} className={btnPrimary}>
          Run
        </button>
        <button type="button" onClick={generate} className={btnSecondary}>
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

      <div className={`${panelSurface} min-h-64 flex-1 p-4`}>
        <BufferPoolPanel
          frames={state.frames}
          stats={state.bufferStats}
          clockHand={state.clockHand}
          policy={policy}
          lastEvent={state.lastEvent}
        />
      </div>

      <div className="ql-sheen rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <h3 className="mb-1 text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
          Narration
        </h3>
        <p className="min-h-10 text-body leading-relaxed" aria-live="polite">
          {state.narration || 'Step forward to start.'}
        </p>
      </div>

      <PlaybackControls playback={playback} length={result.events.length} />
    </div>
  );
}
