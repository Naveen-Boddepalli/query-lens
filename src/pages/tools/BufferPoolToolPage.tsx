import { useMemo, useState } from 'react';
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
import { SANDBOX_SCENARIOS, type BufferPoolScenario } from '../learn/sandboxScenarios.ts';
import { BufferPoolPanel } from '../../ui/panels/BufferPoolPanel.tsx';
import { usePlayback } from '../../ui/usePlayback.ts';
import { btnGhost, inputField } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  ScenarioPicker,
  StagePanel,
  Stepper,
  ToolHeader,
  ToolShell,
  Transport,
} from '../../ui/tool/index.ts';

/**
 * The OS-course standalone (plan.md §20.4, §21.3): the buffer pool with no
 * SQL, no table, no B+Tree — just a page-reference string and a policy. It
 * renders through the exact panel and the exact event fold the full pipeline
 * uses (`src/engine/bufferTrace.ts`), so "LRU vs clock, one access pattern" —
 * the contrast plan.md §9 is built to demonstrate — is a five-second edit
 * here rather than a crafted SQL query.
 *
 * Laid out on the tool workbench (`src/ui/tool/`, docs/research/tool-layouts.md §4.4 A): scenario and parameters in
 * the inspector, the frames on the stage, the transport under it. There is no Run button: the reference string applies
 * on Enter or when the field loses focus, and every other setting applies as it changes.
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
const READ_AHEAD_OPTIONS = [0, 1, 2, 4] as const;
const SCAN_RING_OPTIONS = [0, 2, 3, 4] as const;

/**
 * The worked examples, from the buffer-pool lesson's own scenarios (`sandboxScenarios.ts`), so each one is the setup a
 * lesson links to and `sandboxLessons.test.ts` checks against what the lesson says about it.
 */
const SCENARIOS: readonly { id: string; title: string; blurb: string; setup: BufferPoolScenario }[] = [
  {
    id: 'loop',
    title: 'A loop one page too big',
    blurb: 'Five pages loop through four frames, so LRU evicts each page just before it is asked for: ten misses in ten.',
    setup: SANDBOX_SCENARIOS.poolLoop,
  },
  {
    id: 'loop-optimal',
    title: 'The same loop, seen ahead',
    blurb: 'The optimal policy evicts the page needed furthest ahead: four hits in ten, the ceiling no real pool can reach.',
    setup: SANDBOX_SCENARIOS.poolLoopOptimal,
  },
  {
    id: 'belady-3',
    title: 'Bélády’s anomaly, three frames',
    blurb: 'The classic string under FIFO misses nine times in three frames.',
    setup: SANDBOX_SCENARIOS.poolBelady,
  },
  {
    id: 'belady-4',
    title: 'Bélády’s anomaly, four frames',
    blurb: 'The same string with one frame more misses ten times: a bigger pool, more misses.',
    setup: SANDBOX_SCENARIOS.poolBeladyMore,
  },
  {
    id: 'scan',
    title: 'A scan sweeps the hot set',
    blurb: 'Four hot pages, a 21-page scan, then the hot pages again. Under LRU the scan pushes them out: 12 hits in 41.',
    setup: SANDBOX_SCENARIOS.poolScan,
  },
  {
    id: 'scan-ring',
    title: 'The scan, with a scan ring',
    blurb: 'The scan reads through two frames of its own and leaves the hot set alone: 16 hits in 41.',
    setup: SANDBOX_SCENARIOS.poolScanRing,
  },
  {
    id: 'scan-lru-k',
    title: 'The scan, under LRU-2',
    blurb: 'LRU-2 judges a page by its second-last use, so the scan’s pages, read once, leave first: 16 hits in 41.',
    setup: SANDBOX_SCENARIOS.poolScanLruK,
  },
];

/** A reference string with its separators normalised, so "0,1, 2" and "0 1 2" are the same string. */
const normalize = (ref: string) => ref.trim().split(/[\s,]+/).filter(Boolean).join(' ');

const isPolicy = (p: string): p is ReplacementPolicyName => (REPLACEMENT_POLICY_NAMES as readonly string[]).includes(p);

function readInitial() {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const ref = params.get('ref');
  const framesRaw = Number(params.get('frames'));
  const policyRaw = params.get('policy') ?? '';
  const readAheadRaw = Number(params.get('ra'));
  const scanRingRaw = Number(params.get('sr'));
  return {
    ref: ref && ref.length > 0 ? ref : DEFAULT_REF,
    frames:
      Number.isInteger(framesRaw) && framesRaw >= MIN_FRAMES && framesRaw <= MAX_FRAMES
        ? framesRaw
        : 4,
    policy: isPolicy(policyRaw) ? policyRaw : 'lru',
    readAhead: Number.isInteger(readAheadRaw) && readAheadRaw >= 0 && readAheadRaw <= MAX_READ_AHEAD ? readAheadRaw : 0,
    scanRing: Number.isInteger(scanRingRaw) && scanRingRaw >= 0 && scanRingRaw <= MAX_SCAN_RING ? scanRingRaw : 0,
  };
}

const INITIAL = readInitial();

export function BufferPoolToolPage() {
  /** What is typed in the field, and what the pool is running: they part while the reader edits. */
  const [refInput, setRefInput] = useState(INITIAL.ref);
  const [appliedRef, setAppliedRef] = useState(INITIAL.ref);
  const [frames, setFrames] = useState(INITIAL.frames);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(INITIAL.policy);
  const [readAhead, setReadAhead] = useState(INITIAL.readAhead);
  const [scanRing, setScanRing] = useState(INITIAL.scanRing);

  const options = useMemo(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy, readAhead, scanRing }),
    [frames, policy, readAhead, scanRing],
  );

  const { refs, scans } = useMemo(() => parseReferenceScans(appliedRef), [appliedRef]);
  const result = useMemo(() => runBufferTrace(refs, options, scans), [refs, scans, options]);
  const projector = useMemo(() => createTraceProjector(result.events, options), [result, options]);
  const dwells = useMemo(() => result.events.map((e) => e.dwell ?? 1), [result]);

  const playback = usePlayback(result.events.length, { dwells, initialStep: 0 });
  const state = projector.at(playback.step);

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('ref', appliedRef);
    params.set('frames', String(frames));
    params.set('policy', policy);
    if (readAhead > 0) params.set('ra', String(readAhead));
    if (scanRing > 0) params.set('sr', String(scanRing));
    return params.toString();
  }, [appliedRef, frames, policy, readAhead, scanRing]);
  useAddressBarQuery(shareQuery);

  const scenario = SCENARIOS.find(
    ({ setup }) =>
      normalize(setup.ref) === normalize(appliedRef) &&
      setup.frames === frames &&
      setup.policy === policy &&
      setup.ra === readAhead &&
      setup.sr === scanRing,
  );

  /** Runs the typed string, if it changed: on Enter, and when the field loses focus. */
  function apply() {
    if (refInput === appliedRef) return;
    setAppliedRef(refInput);
    playback.reset();
  }

  function generate() {
    const generated = randomReferenceString(20, Math.max(frames + 2, 6)).join(' ');
    setRefInput(generated);
    setAppliedRef(generated);
    playback.reset();
  }

  function load(id: string) {
    const picked = SCENARIOS.find((s) => s.id === id);
    if (!picked) return;
    const { ref, frames: f, policy: p, ra, sr } = picked.setup;
    setRefInput(ref);
    setAppliedRef(ref);
    setFrames(f);
    if (isPolicy(p)) setPolicy(p);
    setReadAhead(ra);
    setScanRing(sr);
    playback.reset();
  }

  const policyLabel = REPLACEMENT_POLICY_LABELS[policy];
  const summary = [
    `${String(refs.length)} accesses`,
    policyLabel,
    `${String(frames)} frames`,
    readAhead > 0 ? `read-ahead ${String(readAhead)}` : null,
    scanRing > 0 ? `ring ${String(scanRing)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="storage"
        header={
          <ToolHeader
            id="buffer-pool"
            title="Buffer pool sandbox"
            summary={<>Step through how {policyLabel} decides which pages stay in memory.</>}
            about={
              <p>
                Type a page-reference string — the sequence of pages a program touches — and watch a replacement policy
                pick its victims. This is the buffer pool from the{' '}
                <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
                  Playground
                </Link>
                , driven directly, with every replacement policy the engine has and the read-ahead and scan-ring options
                the Playground does not expose.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={summary}>
            <ScenarioPicker id="bp-scenario" scenarios={SCENARIOS} value={scenario?.id ?? null} onPick={load} />

            <ControlGroup legend="Workload">
              <ControlRow
                label="Reference string"
                htmlFor="bp-ref"
                stacked
                hint="Page numbers, separated by spaces or commas. A range like 10-50 is one scan. Press Enter to run it."
              >
                <input
                  id="bp-ref"
                  type="text"
                  value={refInput}
                  onChange={(e) => { setRefInput(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
                  onBlur={apply}
                  aria-describedby={hintIdFor('bp-ref')}
                  className={`${inputField} w-full font-mono`}
                  spellCheck={false}
                />
              </ControlRow>
              <button type="button" onClick={generate} className={`${btnGhost} self-start`}>
                <span aria-hidden="true">↻</span> Generate a random string
              </button>
            </ControlGroup>

            <ControlGroup legend="Pool">
              <ControlRow label="Frames" htmlFor="bp-frames">
                <Stepper id="bp-frames" value={frames} onChange={setFrames} min={MIN_FRAMES} max={MAX_FRAMES} unit="frames" />
              </ControlRow>
              <ControlRow label="Policy" htmlFor="bp-policy">
                <select
                  id="bp-policy"
                  value={policy}
                  onChange={(e) => { if (isPolicy(e.target.value)) setPolicy(e.target.value); }}
                  className={`${inputField} w-full`}
                >
                  {REPLACEMENT_POLICY_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {REPLACEMENT_POLICY_LABELS[name]}
                    </option>
                  ))}
                </select>
              </ControlRow>
            </ControlGroup>

            <ControlGroup legend="Advanced" advanced count={2} defaultOpen={readAhead > 0 || scanRing > 0}>
              <ControlRow label="Read-ahead" htmlFor="bp-ra" hint="After a sequential read, fetch this many next pages early.">
                <select
                  id="bp-ra"
                  value={readAhead}
                  onChange={(e) => { setReadAhead(Number(e.target.value)); }}
                  aria-describedby={hintIdFor('bp-ra')}
                  className={`${inputField} w-full`}
                >
                  {READ_AHEAD_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'off' : `${String(n)} page${n === 1 ? '' : 's'}`}
                    </option>
                  ))}
                </select>
              </ControlRow>
              <ControlRow label="Scan ring" htmlFor="bp-sr" hint="A long scan reuses this many frames of its own, so it cannot flush the pool.">
                <select
                  id="bp-sr"
                  value={scanRing}
                  onChange={(e) => { setScanRing(Number(e.target.value)); }}
                  aria-describedby={hintIdFor('bp-sr')}
                  className={`${inputField} w-full`}
                >
                  {SCAN_RING_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'off' : `${String(n)} frames`}
                    </option>
                  ))}
                </select>
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        stage={
          <StagePanel title="Frames" legend={`${policyLabel} · ${String(frames)} frames`}>
            <BufferPoolPanel
              frames={state.frames}
              stats={state.bufferStats}
              clockHand={state.clockHand}
              policy={policy}
              lastEvent={state.lastEvent}
            />
          </StagePanel>
        }
        narration={state.narration || 'Step forward to start.'}
        transport={<Transport playback={playback} length={result.events.length} />}
      />
    </div>
  );
}
