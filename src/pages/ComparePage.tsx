import { useMemo, useState } from 'react';
import {
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
  segBase,
  segOff,
  segOn,
} from '../ui/primitives.ts';

/**
 * plan.md §13's comparison view, in three modes:
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
 */

type Mode = 'policies' | 'index' | 'aggregate';

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

      <div className="mt-2 flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
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
// index-selection rule and `runQuery`'s `buildIndex` call both key off
// `indexedColumn`, so this is all it takes to force a sequential scan.
const { indexedColumn: _indexed, ...USERS_NO_INDEX } = SEED.tables.users!;
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

export function ComparePage() {
  const [mode, setMode] = useState<Mode>('policies');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Compare">
        Two runs, side by side, to make one contrast concrete.
      </PageHeader>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Comparison">
        {(
          [
            ['policies', 'Replacement policies'],
            ['index', 'Index vs. sequential scan'],
            ['aggregate', 'Hash aggregate vs. sort aggregate'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => { setMode(value); }}
            className={`${segBase} ${mode === value ? segOn : segOff}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'policies' ? <PolicyCompare /> : mode === 'index' ? <IndexCompare /> : <AggregateCompare />}
    </div>
  );
}
