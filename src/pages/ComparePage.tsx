import { useMemo, useState } from 'react';
import {
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceString,
  REPLACEMENT_POLICY_LABELS,
  REPLACEMENT_POLICY_NAMES,
  runBufferTrace,
} from '../engine/index.ts';
import type {
  BufferTraceResult,
  EngineOptions,
  ReplacementPolicyName,
} from '../engine/index.ts';
import { BufferPoolPanel } from '../ui/panels/BufferPoolPanel.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, inputField, panelSurface } from '../ui/primitives.ts';

/**
 * plan.md §13's comparison mode. It started life fixed on the contrast §9
 * validates — LRU vs. clock sweep — and now lets you pick either side from the
 * five replacement policies (§20.4), so "FIFO vs. the optimal bound on this
 * pattern" is a two-click question rather than a rebuild.
 *
 * Two policies emit different numbers of events for an identical reference
 * string — clock sweep and second-chance add a `sweep` event per frame they
 * pass — so they cannot share one raw event-index scrubber. Both sides are
 * instead driven by *access index* (`BufferTraceResult.accessBoundaries`,
 * src/engine/bufferTrace.ts), which every trace agrees on by construction: "10
 * references in" means the same thing on both panels even though it lands at a
 * different event count in each.
 */

// Pages 0-2 are touched twice each (hot), page 3 once (cold), before page 4
// forces an eviction. Verified to diverge for the default pair: LRU evicts
// page 0 — purely recency-ordered, and 0's last touch is the earliest of the
// repeated three — while clock sweep's usage count has protected 0-2 and
// evicts the genuinely cold page 3 instead. A uniform scan (no repeats) picks
// the same victim under both, which is `bufferTrace.test.ts`'s point.
const DEFAULT_REF = '0 1 2 0 1 2 3 4';
const FRAMES = 4;

function side(refs: number[], options: EngineOptions): BufferTraceResult {
  return runBufferTrace(refs, options);
}

function Column({
  label,
  policy,
  trace,
  options,
  accessIndex,
}: {
  label: string;
  policy: ReplacementPolicyName;
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
      <div className={`${panelSurface} min-h-56 p-3`}>
        <BufferPoolPanel
          frames={state.frames}
          stats={state.bufferStats}
          clockHand={state.clockHand}
          policy={policy}
          lastEvent={state.lastEvent}
        />
      </div>
      <p className="min-h-8 text-label text-ink-dim" aria-live="polite">
        {state.narration}
      </p>
    </div>
  );
}

function PolicyPicker({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: ReplacementPolicyName;
  onChange: (next: ReplacementPolicyName) => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-label text-ink-dim">
      {label}
      <select
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value as ReplacementPolicyName); }}
        className={inputField}
      >
        {REPLACEMENT_POLICY_NAMES.map((name) => (
          <option key={name} value={name}>
            {REPLACEMENT_POLICY_LABELS[name]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ComparePage() {
  const [refInput, setRefInput] = useState(DEFAULT_REF);
  const [refs, setRefs] = useState<number[]>(() => parseReferenceString(DEFAULT_REF));
  const [accessIndex, setAccessIndex] = useState(0);
  const [policyA, setPolicyA] = useState<ReplacementPolicyName>('lru');
  const [policyB, setPolicyB] = useState<ReplacementPolicyName>('clock');

  const optionsA = useMemo<EngineOptions>(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: FRAMES, policy: policyA }),
    [policyA],
  );
  const optionsB = useMemo<EngineOptions>(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: FRAMES, policy: policyB }),
    [policyB],
  );

  const a = useMemo(() => side(refs, optionsA), [refs, optionsA]);
  const b = useMemo(() => side(refs, optionsB), [refs, optionsB]);

  /**
   * The first access where the two policies chose a different victim, or
   * `null` if they agree throughout (which includes picking the same policy
   * on both sides).
   *
   * An eviction is not necessarily the *last* event of an access — under
   * clock sweep or second-chance it is miss, some number of sweep ticks,
   * evict, then load — so this scans every event *within* each access's slice
   * for the one eviction it can contain, rather than looking only at the
   * boundary event (which is always the trailing `load`).
   */
  const divergedAt = useMemo(() => {
    if (policyA === policyB) return null;
    const evictionIn = (trace: BufferTraceResult, i: number) => {
      const from = i === 0 ? 0 : (trace.accessBoundaries[i - 1] ?? 0);
      const to = trace.accessBoundaries[i] ?? from;
      for (let e = from; e < to; e++) {
        const event = trace.events[e];
        if (event?.stage === 'buffer' && event.action === 'evict') return event.victimPageId;
      }
      return null;
    };
    const accesses = Math.min(a.accessBoundaries.length, b.accessBoundaries.length);
    for (let i = 0; i < accesses; i++) {
      const victimA = evictionIn(a, i);
      const victimB = evictionIn(b, i);
      if (victimA !== null && victimB !== null && victimA !== victimB) return i + 1;
    }
    return null;
  }, [a, b, policyA, policyB]);

  function run() {
    setRefs(parseReferenceString(refInput));
    setAccessIndex(0);
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Compare replacement policies">
        One access pattern, {FRAMES} frames, two policies stepping together. plan.md §9 calls the
        LRU/clock-sweep version of this the contrast that makes the honesty problem the product&rsquo;s
        best teaching moment — same inputs, different victim. Swap either side to line any two of
        the five up against each other.
      </PageHeader>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="ref" className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
          Reference string
          <input
            id="ref"
            type="text"
            value={refInput}
            onChange={(e) => { setRefInput(e.target.value); }}
            className={`${inputField} font-mono`}
            spellCheck={false}
          />
        </label>
        <PolicyPicker id="policy-a" label="Left policy" value={policyA} onChange={setPolicyA} />
        <PolicyPicker id="policy-b" label="Right policy" value={policyB} onChange={setPolicyB} />
        <button type="button" onClick={run} className={btnPrimary}>
          Run
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-label text-ink-dim">
        <button
          type="button"
          onClick={() => { setAccessIndex((i) => Math.max(0, i - 1)); }}
          disabled={accessIndex === 0}
          className={btnSecondary}
        >
          ◀ back
        </button>
        <input
          type="range"
          min={0}
          max={refs.length}
          value={accessIndex}
          onChange={(e) => { setAccessIndex(Number(e.target.value)); }}
          className="scrubber flex-1 accent-[var(--color-accent)]"
          aria-label="Access index"
        />
        <button
          type="button"
          onClick={() => { setAccessIndex((i) => Math.min(refs.length, i + 1)); }}
          disabled={accessIndex >= refs.length}
          className={btnSecondary}
        >
          forward ▶
        </button>
        <span className="tabular-nums text-ink">
          access {accessIndex} / {refs.length}
        </span>
      </div>

      {divergedAt !== null && (
        <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
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
        <Column
          label={REPLACEMENT_POLICY_LABELS[policyA]}
          policy={policyA}
          trace={a}
          options={optionsA}
          accessIndex={accessIndex}
        />
        <Column
          label={REPLACEMENT_POLICY_LABELS[policyB]}
          policy={policyB}
          trace={b}
          options={optionsB}
          accessIndex={accessIndex}
        />
      </div>
    </div>
  );
}
