import { useMemo, useState } from 'react';
import {
  createJoinDemoDatabase,
  createSeedDatabase,
  createTraceProjector,
  DATASETS,
  DEFAULT_ENGINE_OPTIONS,
  parseReferenceString,
  REPLACEMENT_POLICY_LABELS,
  REPLACEMENT_POLICY_NAMES,
  runBufferTrace,
  runQuery,
} from '../engine/index.ts';
import type {
  BufferTraceResult,
  Database,
  EngineOptions,
  ReplacementPolicyName,
  RunResult,
} from '../engine/index.ts';
import { BufferPoolPanel } from '../ui/panels/BufferPoolPanel.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import {
  btnPrimary,
  btnSecondary,
  inputField,
  panelSurface,
  pill,
  segBase,
  segOff,
  segOn,
  segmentedTrack,
} from '../ui/primitives.ts';

/**
 * plan.md §13's comparison view, in four modes:
 *
 *  - **replacement policies** — the original: one page-reference string under
 *    two of the five policies (§20.4), stepped together by *access index*
 *    (`BufferTraceResult.accessBoundaries`), which every trace agrees on even
 *    though the policies emit different event counts. Flags the first access
 *    where they pick a different victim (§9's teaching moment).
 *  - **index vs. sequential scan** — the full-pipeline half §21.3 records as
 *    unbuilt: the *same SQL* run once with the `id` index and once with it
 *    removed, scored side by side. Same rows, wildly different work — which is
 *    the entire reason an index exists.
 *  - **hash aggregate vs. sort aggregate** (§22.2): the same GROUP BY query run
 *    once with each strategy forced via `EngineOptions.aggregateStrategy` —
 *    same groups out either way, but only the sort aggregate spills through
 *    the buffer pool. "One strategy, nothing to compare" is exactly the gap
 *    this closes.
 *  - **nested-loop vs. hash vs. sort-merge join** (§22.2): the same JOIN query
 *    run once with each of the three algorithms forced via
 *    `EngineOptions.joinStrategy`, against the small `authors`/`posts` demo
 *    pair (`createJoinDemoDatabase`, the same fixture `/tools/planner` uses).
 *    Same rows out every time; nested-loop rescans the right table whole per
 *    left row, hash join reads each side exactly once via an in-memory
 *    table, and sort-merge reads each side once too but pays for it by
 *    sorting both first.
 */

type Mode = 'policies' | 'index' | 'aggregate' | 'join';

/* -------------------------------------------------------------------------- */
/* Replacement-policy comparison                                              */
/* -------------------------------------------------------------------------- */

// Pages 0-2 are touched twice each (hot), page 3 once (cold), before page 4
// forces an eviction. Verified to diverge for the default pair: LRU evicts
// page 0, clock sweep protects the hot pages and takes cold page 3.
const DEFAULT_REF = '0 1 2 0 1 2 3 4';
const FRAMES = 4;

function PolicyColumn({
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
      <div className="flex items-center justify-between">
        <h3 className="text-body font-semibold text-ink">{label}</h3>
        <span className={`${pill} text-[11px] font-mono text-ink-dim`}>
          misses: {state.bufferStats.misses} · hits: {state.bufferStats.hits}
        </span>
      </div>
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

function PolicyCompare() {
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

  const a = useMemo(() => runBufferTrace(refs, optionsA), [refs, optionsA]);
  const b = useMemo(() => runBufferTrace(refs, optionsB), [refs, optionsB]);

  const projectorA = useMemo(() => createTraceProjector(a.events, optionsA), [a, optionsA]);
  const projectorB = useMemo(() => createTraceProjector(b.events, optionsB), [b, optionsB]);

  const eventStepA = accessIndex === 0 ? 0 : (a.accessBoundaries[accessIndex - 1] ?? 0);
  const eventStepB = accessIndex === 0 ? 0 : (b.accessBoundaries[accessIndex - 1] ?? 0);

  const stateA = projectorA.at(eventStepA);
  const stateB = projectorB.at(eventStepB);

  const missesA = stateA.bufferStats.misses;
  const missesB = stateB.bufferStats.misses;
  const missDiff = missesA - missesB;
  const hitsA = stateA.bufferStats.hits;
  const hitsB = stateB.bufferStats.hits;
  const evictA = stateA.bufferStats.evictions;
  const evictB = stateB.bufferStats.evictions;

  /**
   * The first access where the two policies chose a different victim. An
   * eviction is not necessarily the *last* event of an access, so this scans
   * every event within each access's slice rather than the boundary event.
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
    <>
      <p className="text-body text-ink-dim">
        One access pattern, {FRAMES} frames, two policies stepping together. plan.md §9 calls the
        LRU/clock-sweep version of this the contrast that makes the honesty problem the
        product&rsquo;s best teaching moment — same inputs, different victim.
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
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

      {/* Diff callout highlights */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Buffer Misses Diff</div>
          <div className="mt-1 flex items-baseline justify-between font-mono">
            <span className="text-body font-semibold text-ink">{missesA} vs {missesB}</span>
            <span className={`text-label font-bold ${missDiff === 0 ? 'text-ink-dim' : missDiff > 0 ? 'text-amber-500' : 'text-hit'}`}>
              {missDiff === 0 ? 'tied' : `Δ ${Math.abs(missDiff)}`}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Page Loads Diff</div>
          <div className="mt-1 flex items-baseline justify-between font-mono">
            <span className="text-body font-semibold text-ink">{missesA} vs {missesB}</span>
            <span className={`text-label font-bold ${missDiff === 0 ? 'text-ink-dim' : 'text-accent'}`}>
              {missDiff === 0 ? '0' : `Δ ${Math.abs(missDiff)} loads`}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Buffer Hits Diff</div>
          <div className="mt-1 flex items-baseline justify-between font-mono">
            <span className="text-body font-semibold text-ink">{hitsA} vs {hitsB}</span>
            <span className="text-label font-bold text-ink-dim">
              Δ {Math.abs(hitsA - hitsB)}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Evictions Diff</div>
          <div className="mt-1 flex items-baseline justify-between font-mono">
            <span className="text-body font-semibold text-ink">{evictA} vs {evictB}</span>
            <span className="text-label font-bold text-ink-dim">
              Δ {Math.abs(evictA - evictB)}
            </span>
          </div>
        </div>
      </div>

      {divergedAt !== null && (
        <p className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3.5 py-2 text-label text-ink shadow-e1">
          <span>
            The two policies first pick a <em>different</em> victim at access {divergedAt}.{' '}
          </span>
          <button
            type="button"
            onClick={() => { setAccessIndex(divergedAt); }}
            className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-accent/20 px-2.5 py-0.5 text-label font-medium text-ink transition hover:bg-accent/30 active:scale-95"
          >
            <span>Jump there</span>
            <svg viewBox="0 0 16 16" className="h-3 w-3 stroke-current stroke-2" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </p>
      )}

      {/* Synchronized scrubber bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm text-label text-ink-dim">
        <button
          type="button"
          onClick={() => { setAccessIndex((i) => Math.max(0, i - 1)); }}
          disabled={accessIndex === 0}
          className={`${btnSecondary} text-label py-1.5 px-3`}
          aria-label="Step back"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 stroke-current stroke-2" fill="none" aria-hidden="true">
            <path d="M10 13l-5-5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Back</span>
        </button>
        <input
          type="range"
          min={0}
          max={refs.length}
          value={accessIndex}
          onChange={(e) => { setAccessIndex(Number(e.target.value)); }}
          className="scrubber flex-1 accent-[var(--color-accent)] cursor-pointer"
          aria-label="Access index"
        />
        <button
          type="button"
          onClick={() => { setAccessIndex((i) => Math.min(refs.length, i + 1)); }}
          disabled={accessIndex >= refs.length}
          className={`${btnSecondary} text-label py-1.5 px-3`}
          aria-label="Step forward"
        >
          <span>Forward</span>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 stroke-current stroke-2" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className={`${pill} font-mono tabular-nums text-ink text-label`}>
          access {accessIndex} / {refs.length}
        </span>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <PolicyColumn
          label={REPLACEMENT_POLICY_LABELS[policyA]}
          policy={policyA}
          trace={a}
          options={optionsA}
          accessIndex={accessIndex}
        />
        <PolicyColumn
          label={REPLACEMENT_POLICY_LABELS[policyB]}
          policy={policyB}
          trace={b}
          options={optionsB}
          accessIndex={accessIndex}
        />
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Index vs. sequential-scan comparison                                       */
/* -------------------------------------------------------------------------- */

const SEED = createSeedDatabase();
// The same table with the index declaration dropped — the optimizer's
// index-selection rule and `runQuery`'s `buildIndexes` call both key off
// `indexedColumns`, so this is all it takes to force a sequential scan.
const { indexedColumns: _indexed, ...USERS_NO_INDEX } = SEED.tables.users!;
const NO_INDEX_DB: Database = { tables: { users: USERS_NO_INDEX } };

const INDEX_PRESETS = [
  { label: 'Point lookup on the indexed column', sql: 'SELECT * FROM users WHERE id = 5' },
  { label: 'Range on a non-indexed column', sql: 'SELECT * FROM users WHERE age > 30' },
  { label: 'Every row', sql: 'SELECT * FROM users' },
] as const;

interface Scorecard {
  steps: number;
  diskReads: number;
  hits: number;
  evictions: number;
  btreeReads: number;
  locks: number;
  rows: number;
  usedIndex: boolean;
}

function scoreOf(result: RunResult): Scorecard {
  const end = createTraceProjector(result.events, DEFAULT_ENGINE_OPTIONS).at(result.events.length);
  return {
    steps: result.events.length,
    diskReads: end.bufferStats.misses,
    hits: end.bufferStats.hits,
    evictions: end.bufferStats.evictions,
    btreeReads: end.indexPath.length,
    locks: end.locksTaken,
    rows: result.rows.length,
    usedIndex: result.events.some((e) => e.stage === 'index'),
  };
}

const STAT_ROWS: { key: keyof Scorecard; label: string }[] = [
  { key: 'steps', label: 'trace steps' },
  { key: 'diskReads', label: 'disk reads' },
  { key: 'hits', label: 'buffer hits' },
  { key: 'evictions', label: 'evictions' },
  { key: 'btreeReads', label: 'B+Tree node reads' },
  { key: 'locks', label: 'locks acquired' },
  { key: 'rows', label: 'rows returned' },
];

function ScoreColumn({
  label,
  sub,
  score,
  compareTo,
}: {
  label: string;
  sub: string;
  score: Scorecard;
  compareTo: Scorecard;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div>
        <h3 className="text-body font-semibold text-ink">{label}</h3>
        <p className="text-label text-ink-dim">{sub}</p>
      </div>
      <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
        {STAT_ROWS.map(({ key, label: rowLabel }) => {
          const mine = score[key] as number;
          const theirs = compareTo[key] as number;
          const worse = rowLabel !== 'buffer hits' && rowLabel !== 'rows returned' && mine > theirs;
          return (
            <div key={key} className="contents">
              <dt className="text-ink-dim">{rowLabel}</dt>
              <dd className={`text-right font-mono tabular-nums ${worse ? 'text-evict' : 'text-ink'}`}>
                {mine}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function IndexCompare() {
  const [sqlInput, setSqlInput] = useState<string>(INDEX_PRESETS[0].sql);
  const [sql, setSql] = useState<string>(INDEX_PRESETS[0].sql);

  const withIndex = useMemo(() => runQuery(sql, SEED, DEFAULT_ENGINE_OPTIONS), [sql]);
  const noIndex = useMemo(() => runQuery(sql, NO_INDEX_DB, DEFAULT_ENGINE_OPTIONS), [sql]);

  const indexed = useMemo(() => scoreOf(withIndex), [withIndex]);
  const scan = useMemo(() => scoreOf(noIndex), [noIndex]);

  const samePlan = !indexed.usedIndex;
  const ratio =
    indexed.diskReads > 0 ? Math.round((scan.diskReads / indexed.diskReads) * 10) / 10 : null;

  return (
    <>
      <p className="text-body text-ink-dim">
        The same query, run once with the B+Tree index on <code className="font-mono text-ink">id</code>{' '}
        and once with it removed. plan.md §13: same rows out, and the whole point of the index is how
        differently it gets there.
      </p>

      <div className="mt-2 flex flex-col gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="index-preset" className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select
            id="index-preset"
            value={INDEX_PRESETS.some((p) => p.sql === sqlInput) ? sqlInput : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSqlInput(e.target.value); }}
            className={inputField}
          >
            {INDEX_PRESETS.map((p) => (
              <option key={p.label} value={p.sql}>{p.label}</option>
            ))}
            <option value="custom">Custom (edit below)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="index-sql" className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
            SQL
            <input
              id="index-sql"
              type="text"
              value={sqlInput}
              onChange={(e) => { setSqlInput(e.target.value); }}
              className={`${inputField} font-mono`}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={() => { setSql(sqlInput); }} className={btnPrimary}>
            Run
          </button>
        </div>
      </div>

      {withIndex.error ? (
        <p className="rounded-lg border border-evict/40 bg-evict/10 p-3 text-label text-ink">
          {withIndex.error.message}
        </p>
      ) : samePlan ? (
        <p className="rounded-xl border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim shadow-e1">
          This query has no equality on <code className="font-mono text-ink">id</code>, so the
          optimizer cannot use the index — both runs are the same sequential scan
          ({scan.diskReads} disk reads, {scan.rows} row{scan.rows === 1 ? '' : 's'}). Try the point
          lookup preset to see the contrast.
        </p>
      ) : (
        <>
          <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
            Same <span className="font-mono">{indexed.rows}</span> row
            {indexed.rows === 1 ? '' : 's'} either way. The index found them in{' '}
            <span className="font-mono">{indexed.diskReads}</span> disk read
            {indexed.diskReads === 1 ? '' : 's'} and{' '}
            <span className="font-mono">{indexed.btreeReads}</span> B+Tree node read
            {indexed.btreeReads === 1 ? '' : 's'}; the sequential scan needed{' '}
            <span className="font-mono">{scan.diskReads}</span>
            {scan.evictions > 0 && <>, evicting {scan.evictions} page{scan.evictions === 1 ? '' : 's'} on the way</>}
            {ratio !== null && ratio >= 2 && <> — {ratio}× the disk work</>}.
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Disk Reads Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{indexed.diskReads} vs {scan.diskReads}</span>
                <span className="text-label font-bold text-hit">
                  -{scan.diskReads - indexed.diskReads}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Page Loads Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{indexed.diskReads} vs {scan.diskReads}</span>
                <span className="text-label font-bold text-accent">
                  Δ {scan.diskReads - indexed.diskReads}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">B+Tree Node Reads</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{indexed.btreeReads} vs {scan.btreeReads}</span>
                <span className="text-label font-bold text-accent">
                  +{indexed.btreeReads}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Evictions Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{indexed.evictions} vs {scan.evictions}</span>
                <span className="text-label font-bold text-ink-dim">
                  Δ {scan.evictions - indexed.evictions}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row">
            <ScoreColumn
              label="With the index"
              sub="B+Tree lookup on id"
              score={indexed}
              compareTo={scan}
            />
            <ScoreColumn
              label="Sequential scan"
              sub="index removed — every page read"
              score={scan}
              compareTo={indexed}
            />
          </div>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Hash aggregate vs. sort aggregate comparison                               */
/* -------------------------------------------------------------------------- */

// 120 rows is enough to make the sort aggregate's spill real — the same
// dataset the buffer-pool tools reach for when `users`' 48 rows never evict
// hard enough to make a point.
const ORDERS = DATASETS.orders.make();

const AGGREGATE_PRESETS = [
  { label: 'GROUP BY a low-cardinality column', sql: 'SELECT status, COUNT(*) FROM orders GROUP BY status' },
  { label: 'GROUP BY a high-cardinality column', sql: 'SELECT customer, COUNT(*) FROM orders GROUP BY customer' },
  { label: 'No GROUP BY — one group over everything', sql: 'SELECT COUNT(*), AVG(total) FROM orders' },
] as const;

interface AggregateScorecard {
  steps: number;
  diskReads: number;
  writes: number;
  evictions: number;
  groups: number;
}

function aggregateScoreOf(result: RunResult): AggregateScorecard {
  const end = createTraceProjector(result.events, DEFAULT_ENGINE_OPTIONS).at(result.events.length);
  return {
    steps: result.events.length,
    diskReads: end.bufferStats.misses,
    writes: end.bufferStats.writes,
    evictions: end.bufferStats.evictions,
    groups: result.rows.length,
  };
}

const AGGREGATE_STAT_ROWS: { key: keyof AggregateScorecard; label: string }[] = [
  { key: 'steps', label: 'trace steps' },
  { key: 'diskReads', label: 'disk reads' },
  { key: 'writes', label: 'pages written' },
  { key: 'evictions', label: 'evictions' },
  { key: 'groups', label: 'groups produced' },
];

function AggregateScoreColumn({
  label,
  sub,
  score,
  compareTo,
}: {
  label: string;
  sub: string;
  score: AggregateScorecard;
  compareTo: AggregateScorecard;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div>
        <h3 className="text-body font-semibold text-ink">{label}</h3>
        <p className="text-label text-ink-dim">{sub}</p>
      </div>
      <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
        {AGGREGATE_STAT_ROWS.map(({ key, label: rowLabel }) => {
          const mine = score[key];
          const theirs = compareTo[key];
          const worse = rowLabel !== 'groups produced' && mine > theirs;
          return (
            <div key={key} className="contents">
              <dt className="text-ink-dim">{rowLabel}</dt>
              <dd className={`text-right font-mono tabular-nums ${worse ? 'text-evict' : 'text-ink'}`}>
                {mine}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

const HASH_OPTIONS = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'hash' } as const;
const SORT_OPTIONS = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' } as const;

function AggregateCompare() {
  const [sqlInput, setSqlInput] = useState<string>(AGGREGATE_PRESETS[0].sql);
  const [sql, setSql] = useState<string>(AGGREGATE_PRESETS[0].sql);

  const hashRun = useMemo(() => runQuery(sql, ORDERS, HASH_OPTIONS), [sql]);
  const sortRun = useMemo(() => runQuery(sql, ORDERS, SORT_OPTIONS), [sql]);

  const hashScore = useMemo(() => aggregateScoreOf(hashRun), [hashRun]);
  const sortScore = useMemo(() => aggregateScoreOf(sortRun), [sortRun]);

  const isAggregateQuery = hashRun.events.some((e) => e.stage === 'execute' && e.op === 'HashAggregate');

  return (
    <>
      <p className="text-body text-ink-dim">
        The same query, run once with each aggregate strategy forced (plan.md §22.2). A{' '}
        <code className="font-mono text-ink">HashAggregate</code> builds an in-memory hash table — no
        I/O of its own. A <code className="font-mono text-ink">SortAggregate</code> sorts on the GROUP
        BY columns first, spilling through the real buffer pool exactly as ORDER BY&rsquo;s Sort does,
        then collapses the runs. Same groups out either way; the difference is entirely in the I/O.
      </p>

      <div className="mt-2 flex flex-col gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="aggregate-preset" className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select
            id="aggregate-preset"
            value={AGGREGATE_PRESETS.some((p) => p.sql === sqlInput) ? sqlInput : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSqlInput(e.target.value); }}
            className={inputField}
          >
            {AGGREGATE_PRESETS.map((p) => (
              <option key={p.label} value={p.sql}>{p.label}</option>
            ))}
            <option value="custom">Custom (edit below)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="aggregate-sql" className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
            SQL
            <input
              id="aggregate-sql"
              type="text"
              value={sqlInput}
              onChange={(e) => { setSqlInput(e.target.value); }}
              className={`${inputField} font-mono`}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={() => { setSql(sqlInput); }} className={btnPrimary}>
            Run
          </button>
        </div>
      </div>

      {hashRun.error ? (
        <p className="rounded-lg border border-evict/40 bg-evict/10 p-3 text-label text-ink">
          {hashRun.error.message}
        </p>
      ) : !isAggregateQuery ? (
        <p className="rounded-xl border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim shadow-e1">
          This query has no GROUP BY or aggregate function, so the strategy makes no difference — both
          runs are the same plan ({hashScore.groups} row{hashScore.groups === 1 ? '' : 's'}). Try one of
          the GROUP BY presets to see the contrast.
        </p>
      ) : (
        <>
          <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
            Same <span className="font-mono">{hashScore.groups}</span> group
            {hashScore.groups === 1 ? '' : 's'} either way. The hash aggregate wrote nothing to disk; the
            sort aggregate wrote <span className="font-mono">{sortScore.writes}</span> page
            {sortScore.writes === 1 ? '' : 's'} and read {sortScore.diskReads} back
            {sortScore.evictions > 0 && (
              <>, evicting {sortScore.evictions} page{sortScore.evictions === 1 ? '' : 's'} on the way</>
            )}
            .
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Pages Written Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{hashScore.writes} vs {sortScore.writes}</span>
                <span className="text-label font-bold text-hit">
                  +{sortScore.writes - hashScore.writes} spilled
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Disk Reads Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{hashScore.diskReads} vs {sortScore.diskReads}</span>
                <span className="text-label font-bold text-accent">
                  Δ {Math.abs(sortScore.diskReads - hashScore.diskReads)}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Page Loads Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{hashScore.diskReads} vs {sortScore.diskReads}</span>
                <span className="text-label font-bold text-ink-dim">
                  Δ {Math.abs(sortScore.diskReads - hashScore.diskReads)}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Evictions Diff</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{hashScore.evictions} vs {sortScore.evictions}</span>
                <span className="text-label font-bold text-ink-dim">
                  Δ {Math.abs(sortScore.evictions - hashScore.evictions)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row">
            <AggregateScoreColumn
              label="Hash aggregate"
              sub="one hash table, no I/O of its own"
              score={hashScore}
              compareTo={sortScore}
            />
            <AggregateScoreColumn
              label="Sort aggregate"
              sub="sorts the GROUP BY columns first, spilling through the buffer pool"
              score={sortScore}
              compareTo={hashScore}
            />
          </div>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Nested-loop vs. hash vs. sort-merge join comparison                        */
/* -------------------------------------------------------------------------- */

const JOIN_DB = createJoinDemoDatabase();

const JOIN_PRESETS = [
  {
    label: 'Every matching row',
    sql: 'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId',
  },
  {
    label: 'Filtered after the join',
    sql: "SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'",
  },
] as const;

interface JoinScorecard {
  steps: number;
  diskReads: number;
  evictions: number;
  rows: number;
}

function joinScoreOf(result: RunResult): JoinScorecard {
  const end = createTraceProjector(result.events, DEFAULT_ENGINE_OPTIONS).at(result.events.length);
  return {
    steps: result.events.length,
    diskReads: end.bufferStats.misses,
    evictions: end.bufferStats.evictions,
    rows: result.rows.length,
  };
}

const JOIN_STAT_ROWS: { key: keyof JoinScorecard; label: string }[] = [
  { key: 'steps', label: 'trace steps' },
  { key: 'diskReads', label: 'disk reads' },
  { key: 'evictions', label: 'evictions' },
  { key: 'rows', label: 'rows returned' },
];

/** `compareTo` is the best (lowest) figure across every algorithm shown, from `bestOf` below — a column is flagged only where it is not the winner, not merely where it loses to one specific other. */
function JoinScoreColumn({
  label,
  sub,
  score,
  compareTo,
}: {
  label: string;
  sub: string;
  score: JoinScorecard;
  compareTo: JoinScorecard;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div>
        <h3 className="text-body font-semibold text-ink">{label}</h3>
        <p className="text-label text-ink-dim">{sub}</p>
      </div>
      <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
        {JOIN_STAT_ROWS.map(({ key, label: rowLabel }) => {
          const mine = score[key];
          const best = compareTo[key];
          const worse = rowLabel !== 'rows returned' && mine > best;
          return (
            <div key={key} className="contents">
              <dt className="text-ink-dim">{rowLabel}</dt>
              <dd className={`text-right font-mono tabular-nums ${worse ? 'text-evict' : 'text-ink'}`}>
                {mine}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

// `authors`/`posts` together are only 5 heap pages — under the default 8
// buffer frames the whole demo fits in cache, so after the *first* rescan
// every later one is a hit, not a miss, and the algorithms' disk-read counts
// tie even though their real work differs (the same reason `AggregateCompare`
// reaches for the 120-row `orders` dataset instead of `users`). Fewer frames
// than the 5 pages, rather than a bigger dataset, makes nested-loop's
// *repeated* rescans — and sort-merge's own sort spill — genuinely re-fetch
// from disk here.
const JOIN_FRAMES = 2;
const NESTED_LOOP_OPTIONS = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: JOIN_FRAMES, joinStrategy: 'nested-loop' } as const;
const HASH_JOIN_OPTIONS = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: JOIN_FRAMES, joinStrategy: 'hash' } as const;
const SORT_MERGE_JOIN_OPTIONS = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: JOIN_FRAMES, joinStrategy: 'sort-merge' } as const;

/** The best (lowest) figure across every scorecard shown — see `JoinScoreColumn`'s doc comment. */
function bestOf(scores: readonly JoinScorecard[]): JoinScorecard {
  return {
    steps: Math.min(...scores.map((s) => s.steps)),
    diskReads: Math.min(...scores.map((s) => s.diskReads)),
    evictions: Math.min(...scores.map((s) => s.evictions)),
    rows: scores[0]!.rows, // same rows out of every algorithm, by construction
  };
}

function JoinCompare() {
  const [sqlInput, setSqlInput] = useState<string>(JOIN_PRESETS[0].sql);
  const [sql, setSql] = useState<string>(JOIN_PRESETS[0].sql);

  const nestedRun = useMemo(() => runQuery(sql, JOIN_DB, NESTED_LOOP_OPTIONS), [sql]);
  const hashRun = useMemo(() => runQuery(sql, JOIN_DB, HASH_JOIN_OPTIONS), [sql]);
  const sortMergeRun = useMemo(() => runQuery(sql, JOIN_DB, SORT_MERGE_JOIN_OPTIONS), [sql]);

  const nestedScore = useMemo(() => joinScoreOf(nestedRun), [nestedRun]);
  const hashScore = useMemo(() => joinScoreOf(hashRun), [hashRun]);
  const sortMergeScore = useMemo(() => joinScoreOf(sortMergeRun), [sortMergeRun]);
  const best = useMemo(() => bestOf([nestedScore, hashScore, sortMergeScore]), [nestedScore, hashScore, sortMergeScore]);

  const isJoinQuery = nestedRun.events.some((e) => e.stage === 'execute' && e.op === 'Join');

  return (
    <>
      <p className="text-body text-ink-dim">
        The same JOIN query, run once with each of the three algorithms forced (plan.md §22.2),
        against the small <code className="font-mono text-ink">authors</code>/
        <code className="font-mono text-ink">posts</code> pair. A nested-loop join rescans{' '}
        <code className="font-mono text-ink">posts</code> whole for every{' '}
        <code className="font-mono text-ink">authors</code> row; a hash join builds one in-memory
        hash table over <code className="font-mono text-ink">posts</code> and probes it instead;
        a sort-merge join sorts both tables on the join key first, then merges the two sorted
        lists in a single pass. Same rows out every time; the difference is entirely in how many
        pages get read, and when.
      </p>

      <div className="mt-2 flex flex-col gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="join-preset" className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select
            id="join-preset"
            value={JOIN_PRESETS.some((p) => p.sql === sqlInput) ? sqlInput : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSqlInput(e.target.value); }}
            className={inputField}
          >
            {JOIN_PRESETS.map((p) => (
              <option key={p.label} value={p.sql}>{p.label}</option>
            ))}
            <option value="custom">Custom (edit below)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="join-sql" className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
            SQL
            <input
              id="join-sql"
              type="text"
              value={sqlInput}
              onChange={(e) => { setSqlInput(e.target.value); }}
              className={`${inputField} font-mono`}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={() => { setSql(sqlInput); }} className={btnPrimary}>
            Run
          </button>
        </div>
      </div>

      {nestedRun.error ? (
        <p className="rounded-lg border border-evict/40 bg-evict/10 p-3 text-label text-ink">
          {nestedRun.error.message}
        </p>
      ) : !isJoinQuery ? (
        <p className="rounded-xl border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim shadow-e1">
          This query has no JOIN, so the algorithm makes no difference — both runs are the same plan
          ({nestedScore.rows} row{nestedScore.rows === 1 ? '' : 's'}). Try one of the JOIN presets to see
          the contrast.
        </p>
      ) : (
        <>
          <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
            Same <span className="font-mono">{nestedScore.rows}</span> row
            {nestedScore.rows === 1 ? '' : 's'} every time. The nested-loop join needed{' '}
            <span className="font-mono">{nestedScore.diskReads}</span> disk read
            {nestedScore.diskReads === 1 ? '' : 's'}, rescanning <code className="font-mono">posts</code>{' '}
            once per author; the hash join needed only{' '}
            <span className="font-mono">{hashScore.diskReads}</span>, reading each table once; the
            sort-merge join needed <span className="font-mono">{sortMergeScore.diskReads}</span>,
            reading each table once too but paying for the sort spill it does first.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Best Disk Reads</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{best.diskReads} reads</span>
                <span className="text-label font-bold text-hit">
                  Hash Join ({hashScore.diskReads})
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Nested-Loop Cost</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{nestedScore.diskReads} reads</span>
                <span className="text-label font-bold text-evict">
                  +{nestedScore.diskReads - best.diskReads} vs best
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Sort-Merge Cost</div>
              <div className="mt-1 flex items-baseline justify-between font-mono">
                <span className="text-body font-semibold text-ink">{sortMergeScore.diskReads} reads</span>
                <span className="text-label font-bold text-amber-500">
                  +{sortMergeScore.diskReads - best.diskReads} vs best
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row">
            <JoinScoreColumn
              label="Nested-loop join"
              sub="rescans posts once per authors row"
              score={nestedScore}
              compareTo={best}
            />
            <JoinScoreColumn
              label="Hash join"
              sub="builds one hash table over posts, then probes it"
              score={hashScore}
              compareTo={best}
            />
            <JoinScoreColumn
              label="Sort-merge join"
              sub="sorts both tables on the join key, then merges them"
              score={sortMergeScore}
              compareTo={best}
            />
          </div>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

const MODES = [
  { id: 'policies', label: 'Buffer Policies', sublabel: 'Replacement policies' },
  { id: 'index', label: 'Index Scan vs Seq Scan', sublabel: 'Index vs. sequential scan' },
  { id: 'aggregate', label: 'Aggregation algorithms', sublabel: 'Hash aggregate vs. sort aggregate' },
  { id: 'join', label: 'Join algorithms', sublabel: 'JOIN algorithms' },
] as const;

export function ComparePage() {
  const [mode, setMode] = useState<Mode>('policies');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader title="Compare">
        Two runs, side by side, to make one contrast concrete.
      </PageHeader>

      <div className={segmentedTrack} role="radiogroup" aria-label="Comparison">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            aria-label={`${m.sublabel} (${m.label})`}
            onClick={() => { setMode(m.id); }}
            className={`${segBase} text-label py-1.5 px-3 flex items-center gap-1.5 ${mode === m.id ? segOn : segOff}`}
          >
            <span className="font-semibold">{m.label}</span>
            <span className="text-[11px] text-ink-dim">· {m.sublabel}</span>
          </button>
        ))}
      </div>

      {mode === 'policies' ? (
        <PolicyCompare />
      ) : mode === 'index' ? (
        <IndexCompare />
      ) : mode === 'aggregate' ? (
        <AggregateCompare />
      ) : (
        <JoinCompare />
      )}
    </div>
  );
}
