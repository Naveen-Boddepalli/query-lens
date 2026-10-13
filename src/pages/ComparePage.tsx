import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createJoinCompareDatabase,
  createSeedDatabase,
  createTraceProjector,
  DATASETS,
  DEFAULT_ENGINE_OPTIONS,
  finalPlan,
  nodeKey,
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
  IndexBuildOptions,
  IndexNode,
  PlanNode,
  ReplacementPolicyName,
  RunResult,
} from '../engine/index.ts';
import { planBTreeWrites } from '../ui/btreeWriteCost.ts';
import { scoreOf } from '../ui/scorecard.ts';
import type { Scorecard } from '../ui/scorecard.ts';
import { demoWrites, LSM_LIMITS, planLsm } from '../ui/lsm.ts';
import type { LsmOptions } from '../ui/lsm.ts';
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
 *  - **nested-loop vs. hash vs. sort-merge vs. index nested-loop join**
 *    (§22.2, §25.4 B4): the same JOIN query run once with each of the four
 *    algorithms forced via `EngineOptions.joinStrategy`, against the small
 *    `authors`/`posts` demo pair plus a larger `comments` table
 *    (`createJoinCompareDatabase`). Same rows out every time; nested-loop
 *    rescans the right table whole per left row, hash join reads each side
 *    exactly once via an in-memory table, sort-merge reads each side once too
 *    but pays for it by sorting both first, and the index join probes the
 *    right table's own B+Tree once per left row — which wins only when the
 *    left side is small and the right side big.
 *  - **B+Tree vs. LSM tree** (§25.4 F1, closing slice): the exact same write
 *    sequence (`/tools/lsm`'s own `demoWrites`) fed to the real engine B+Tree
 *    (`engine/index/btree.ts`, the same code `/tools/btree` drives) and to
 *    `planLsm`. Amplification numbers from real counters on both sides
 *    (`src/ui/btreeWriteCost.ts`'s own doc comment explains why the two
 *    counters are measured in different units — pages touched vs. entries
 *    rewritten — and why that difference IS the lesson, not a bug to paper
 *    over). A B+Tree updates in place: writes stay cheap and roughly constant
 *    regardless of data size. An LSM tree defers writes into a memtable, then
 *    pays for it later in compaction — cheaper to buffer, but physically
 *    rewritten again and again as it cascades through levels, which is why
 *    its own write amplification grows with data size where the B+Tree's
 *    does not. The Bloom filter claws back the LSM tree's read disadvantage:
 *    its worst-case read cost is comparable to the B+Tree's, but its real,
 *    measured cost (with the filter) is usually lower.
 */

type Mode = 'policies' | 'index' | 'build' | 'aggregate' | 'join' | 'lsm' | 'vectorize';

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
  const [readAhead, setReadAhead] = useState(0);

  const optionsA = useMemo<EngineOptions>(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: FRAMES, policy: policyA, readAhead }),
    [policyA, readAhead],
  );
  const optionsB = useMemo<EngineOptions>(
    () => ({ ...DEFAULT_ENGINE_OPTIONS, bufferFrames: FRAMES, policy: policyB, readAhead }),
    [policyB, readAhead],
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
        <label htmlFor="compare-read-ahead" className="flex flex-col gap-1 text-label text-ink-dim">
          Read-ahead
          <select
            id="compare-read-ahead"
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
// index-selection rule and `runQuery`'s `buildIndexes` call both key off
// `indexedColumns`, so this is all it takes to force a sequential scan.
const { indexedColumns: _indexed, ...USERS_NO_INDEX } = SEED.tables.users!;
const NO_INDEX_DB: Database = { tables: { users: USERS_NO_INDEX } };

const INDEX_PRESETS = [
  { label: 'Point lookup on the indexed column', sql: 'SELECT * FROM users WHERE id = 5' },
  { label: 'Range on a non-indexed column', sql: 'SELECT * FROM users WHERE age > 30' },
  { label: 'Every row', sql: 'SELECT * FROM users' },
] as const;

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
/* Bulk-loaded vs. one-at-a-time index build (plan.md §25.4 B3d)              */
/* -------------------------------------------------------------------------- */

// 400 rows with a unique, ascending `id` — big enough that packing shows in the tree's height (at 48 rows the
// trees are the same height however they were built). The index is on `id`.
const BUILD_DB: Database = {
  tables: {
    readings: {
      name: 'readings',
      columns: ['id', 'sensor', 'value'],
      rows: Array.from({ length: 400 }, (_, i) => ({ id: i + 1, sensor: `s${String(i % 12)}`, value: (i * 37) % 1000 })),
      indexedColumns: ['id'],
    },
  },
};

const BUILD_PRESETS = [
  { label: 'Point lookup', sql: 'SELECT * FROM readings WHERE id = 250' },
  { label: 'A range of 30 ids', sql: 'SELECT * FROM readings WHERE id > 360 AND id <= 390' },
] as const;

const BUILDS: { label: string; sub: string; build: IndexBuildOptions }[] = [
  { label: 'One entry at a time', sub: 'insert each row in order, splitting leaves as they fill', build: { method: 'incremental' } },
  { label: 'Bulk load, 100% full', sub: 'sort, pack every leaf, build the levels above — no splits', build: { method: 'bulk', fillFactor: 1 } },
  { label: 'Bulk load, 50% full', sub: 'leave half of every leaf free to grow into', build: { method: 'bulk', fillFactor: 0.5 } },
];

interface BuildScore {
  levels: number;
  nodes: number;
  nodeReads: number;
  diskReads: number;
  steps: number;
  rows: number;
}

const countNodes = (node: IndexNode): number => 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);

/** `null` when the query never touched the index — there is no tree to compare. */
function buildScoreOf(result: RunResult): BuildScore | null {
  const open = result.events.find((e) => e.stage === 'index' && e.action === 'open');
  if (open?.stage !== 'index' || open.action !== 'open') return null;
  const end = createTraceProjector(result.events, DEFAULT_ENGINE_OPTIONS).at(result.events.length);
  return {
    levels: open.height,
    nodes: countNodes(open.tree),
    nodeReads: end.indexPath.length,
    diskReads: end.bufferStats.misses,
    steps: result.events.length,
    rows: result.rows.length,
  };
}

const BUILD_STAT_ROWS: { key: keyof BuildScore; label: string }[] = [
  { key: 'levels', label: 'tree height (levels)' },
  { key: 'nodes', label: 'index pages' },
  { key: 'nodeReads', label: 'B+Tree node reads' },
  { key: 'diskReads', label: 'disk reads' },
  { key: 'steps', label: 'trace steps' },
  { key: 'rows', label: 'rows returned' },
];

function BuildCompare() {
  const [sqlInput, setSqlInput] = useState<string>(BUILD_PRESETS[0].sql);
  const [sql, setSql] = useState<string>(BUILD_PRESETS[0].sql);

  const runs = useMemo(
    () => BUILDS.map((b) => runQuery(sql, BUILD_DB, { ...DEFAULT_ENGINE_OPTIONS, indexBuild: b.build })),
    [sql],
  );
  const scores = useMemo(() => runs.map(buildScoreOf), [runs]);
  const error = runs[0]!.error;
  const usable = scores.every((s): s is BuildScore => s !== null);
  const best = usable
    ? {
        levels: Math.min(...scores.map((s) => s.levels)),
        nodes: Math.min(...scores.map((s) => s.nodes)),
        nodeReads: Math.min(...scores.map((s) => s.nodeReads)),
        diskReads: Math.min(...scores.map((s) => s.diskReads)),
        steps: Math.min(...scores.map((s) => s.steps)),
      }
    : null;

  return (
    <>
      <p className="text-body text-ink-dim">
        The same index over the same 400 rows, built three ways (plan.md §25.4 B3d). Inserting rows one at a
        time splits a leaf whenever it overflows, and for keys that arrive in order that leaves every leaf a
        quarter empty. A <strong className="text-ink">bulk load</strong> sorts the entries first and packs the
        leaves to a <em>fill factor</em>, then builds each level above from the one below — no splits at all.
        Same rows out every time; a fuller tree is smaller and shallower, so a lookup reads fewer pages, but
        it has no room to grow: the next insert into a 100%-full leaf splits it.
      </p>

      <div className="mt-2 flex flex-col gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="build-preset" className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select
            id="build-preset"
            value={BUILD_PRESETS.some((p) => p.sql === sqlInput) ? sqlInput : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSqlInput(e.target.value); }}
            className={inputField}
          >
            {BUILD_PRESETS.map((p) => (
              <option key={p.label} value={p.sql}>{p.label}</option>
            ))}
            <option value="custom">Custom (edit below)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="build-sql" className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
            SQL
            <input
              id="build-sql"
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

      {error ? (
        <p className="rounded-lg border border-evict/40 bg-evict/10 p-3 text-label text-ink">{error.message}</p>
      ) : !usable || !best ? (
        <p className="rounded-xl border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim shadow-e1">
          This query does not use the index on <code className="font-mono text-ink">id</code> — there is no tree to
          compare. Try an equality or a range on <code className="font-mono text-ink">id</code>.
        </p>
      ) : (
        <>
          <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
            Same <span className="font-mono">{scores[0]!.rows}</span> row{scores[0]!.rows === 1 ? '' : 's'} every
            time. Built one at a time the tree is <span className="font-mono">{scores[0]!.levels}</span> levels and{' '}
            <span className="font-mono">{scores[0]!.nodes}</span> pages; packed full, <span className="font-mono">{scores[1]!.levels}</span>{' '}
            levels and <span className="font-mono">{scores[1]!.nodes}</span> pages; packed half full,{' '}
            <span className="font-mono">{scores[2]!.levels}</span> and <span className="font-mono">{scores[2]!.nodes}</span>.
          </p>

          <div className="flex flex-col gap-4 lg:flex-row">
            {BUILDS.map((b, i) => (
              <div key={b.label} className="flex min-w-0 flex-1 flex-col gap-2">
                <div>
                  <h3 className="text-body font-semibold text-ink">{b.label}</h3>
                  <p className="text-label text-ink-dim">{b.sub}</p>
                </div>
                <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
                  {BUILD_STAT_ROWS.map(({ key, label }) => {
                    const mine = scores[i]![key];
                    const worse = key !== 'rows' && mine > best[key];
                    return (
                      <div key={key} className="contents">
                        <dt className="text-ink-dim">{label}</dt>
                        <dd className={`text-right font-mono tabular-nums ${worse ? 'text-evict' : 'text-ink'}`}>{mine}</dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ))}
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
  // plan.md §25.4 B2: SELECT DISTINCT rides on the same strategy setting as GROUP BY.
  { label: 'SELECT DISTINCT a low-cardinality column', sql: 'SELECT DISTINCT status FROM orders' },
  { label: 'SELECT DISTINCT a high-cardinality column', sql: 'SELECT DISTINCT customer FROM orders' },
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
  { key: 'groups', label: 'rows produced' },
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
          const worse = rowLabel !== 'rows produced' && mine > theirs;
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
  // A `SELECT DISTINCT` is the other query the setting changes (plan.md §25.4 B2): a HashDistinct streams and
  // does no I/O; a SortDistinct sorts everything, spilling through the buffer pool.
  const isDistinctQuery = hashRun.events.some((e) => e.stage === 'execute' && e.op === 'HashDistinct');
  const strategyMatters = isAggregateQuery || isDistinctQuery;
  const noun = isDistinctQuery ? 'distinct' : 'aggregate';

  return (
    <>
      <p className="text-body text-ink-dim">
        The same query, run once with each aggregate strategy forced (plan.md §22.2). A{' '}
        <code className="font-mono text-ink">HashAggregate</code> builds an in-memory hash table — no
        I/O of its own. A <code className="font-mono text-ink">SortAggregate</code> sorts on the GROUP
        BY columns first, spilling through the real buffer pool exactly as ORDER BY&rsquo;s Sort does,
        then collapses the runs. Same groups out either way; the difference is entirely in the I/O.{' '}
        <code className="font-mono text-ink">SELECT DISTINCT</code> takes the same setting: a{' '}
        <code className="font-mono text-ink">HashDistinct</code> remembers the rows it has passed, and
        streams; a <code className="font-mono text-ink">SortDistinct</code> sorts everything first.
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
      ) : !strategyMatters ? (
        <p className="rounded-xl border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim shadow-e1">
          This query has no GROUP BY, aggregate function or DISTINCT, so the strategy makes no difference —
          both runs are the same plan ({hashScore.groups} row{hashScore.groups === 1 ? '' : 's'}). Try one of
          the GROUP BY or DISTINCT presets to see the contrast.
        </p>
      ) : (
        <>
          <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
            Same <span className="font-mono">{hashScore.groups}</span> {isDistinctQuery ? 'row' : 'group'}
            {hashScore.groups === 1 ? '' : 's'} either way. The hash {noun} wrote nothing to disk; the
            sort {noun} wrote <span className="font-mono">{sortScore.writes}</span> page
            {sortScore.writes === 1 ? '' : 's'} and read {sortScore.diskReads} back
            {sortScore.evictions > 0 && (
              <>, evicting {sortScore.evictions} page{sortScore.evictions === 1 ? '' : 's'} on the way</>
            )}
            .
          </p>

          <div className="flex flex-col gap-4 lg:flex-row">
            <AggregateScoreColumn
              label={isDistinctQuery ? 'Hash distinct' : 'Hash aggregate'}
              sub={isDistinctQuery ? 'a hash set of rows seen, streaming, no I/O of its own' : 'one hash table, no I/O of its own'}
              score={hashScore}
              compareTo={sortScore}
            />
            <AggregateScoreColumn
              label={isDistinctQuery ? 'Sort distinct' : 'Sort aggregate'}
              sub={isDistinctQuery ? 'sorts every row first, spilling through the buffer pool' : 'sorts the GROUP BY columns first, spilling through the buffer pool'}
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
/* Nested-loop vs. hash vs. sort-merge vs. index nested-loop join comparison  */
/* -------------------------------------------------------------------------- */

const JOIN_DB = createJoinCompareDatabase();

const JOIN_PRESETS = [
  {
    label: 'Every matching row',
    sql: 'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId',
  },
  {
    label: 'Filtered after the join',
    sql: "SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'",
  },
  {
    label: 'A tiny outer over a big indexed inner',
    sql: 'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId WHERE posts.id = 3',
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
const INDEX_JOIN_OPTIONS = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: JOIN_FRAMES, joinStrategy: 'index-nested-loop' } as const;

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
  const indexRun = useMemo(() => runQuery(sql, JOIN_DB, INDEX_JOIN_OPTIONS), [sql]);

  const nestedScore = useMemo(() => joinScoreOf(nestedRun), [nestedRun]);
  const hashScore = useMemo(() => joinScoreOf(hashRun), [hashRun]);
  const sortMergeScore = useMemo(() => joinScoreOf(sortMergeRun), [sortMergeRun]);
  const indexScore = useMemo(() => joinScoreOf(indexRun), [indexRun]);
  const best = useMemo(
    () => bestOf([nestedScore, hashScore, sortMergeScore, indexScore]),
    [nestedScore, hashScore, sortMergeScore, indexScore],
  );
  // The index join needs an index on the inner join column; without one the engine runs a plain nested-loop and says so.
  const probed = indexRun.events.some((e) => e.stage === 'plan' && JSON.stringify(e.planTree).includes('"op":"IndexProbe"'));

  const isJoinQuery = nestedRun.events.some((e) => e.stage === 'execute' && e.op === 'Join');

  return (
    <>
      <p className="text-body text-ink-dim">
        The same JOIN query, run once with each of the four algorithms forced (plan.md §22.2, §25.4 B4),
        against the small <code className="font-mono text-ink">authors</code>/
        <code className="font-mono text-ink">posts</code> pair and a larger{' '}
        <code className="font-mono text-ink">comments</code> table. A nested-loop join rescans the
        inner table whole for every outer row; a hash join builds one in-memory hash table over it
        and probes that instead; a sort-merge join sorts both tables on the join key first, then
        merges the two sorted lists in a single pass; an index nested-loop join descends the inner
        table&rsquo;s own B+Tree once per outer row. Same rows out every time; the difference is
        entirely in how many pages get read, and when — and which one wins depends on how big the
        outer side is.
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
            {nestedScore.diskReads === 1 ? '' : 's'}, rescanning the inner table once per outer row; the hash
            join needed <span className="font-mono">{hashScore.diskReads}</span>, reading each table once; the
            sort-merge join needed <span className="font-mono">{sortMergeScore.diskReads}</span>, reading each
            table once too but paying for the sort spill it does first;{' '}
            {probed ? (
              <>
                the index join needed <span className="font-mono">{indexScore.diskReads}</span>, probing the
                inner table&rsquo;s B+Tree once per outer row — cheap for a few outer rows, costly for many.
              </>
            ) : (
              <>
                the index join needed <span className="font-mono">{indexScore.diskReads}</span> — the inner
                table has no index on the join column, so it ran as a plain nested-loop.
              </>
            )}
          </p>

          <div className="flex flex-col gap-4 lg:flex-row">
            <JoinScoreColumn
              label="Nested-loop join"
              sub="rescans the inner table once per outer row"
              score={nestedScore}
              compareTo={best}
            />
            <JoinScoreColumn
              label="Hash join"
              sub="builds one hash table over the inner table, then probes it"
              score={hashScore}
              compareTo={best}
            />
            <JoinScoreColumn
              label="Sort-merge join"
              sub="sorts both tables on the join key, then merges them"
              score={sortMergeScore}
              compareTo={best}
            />
            <JoinScoreColumn
              label="Index nested-loop join"
              sub={probed ? 'probes the inner table’s B+Tree once per outer row' : 'no index on the join column — ran as a nested-loop'}
              score={indexScore}
              compareTo={best}
            />
          </div>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* B+Tree vs. LSM tree comparison (plan.md §25.4 F1, closing slice)            */
/* -------------------------------------------------------------------------- */

// The B+Tree side drives the real engine index (`engine/index/btree.ts`, the same code `/tools/btree` drives)
// with DEFAULT_MAX_KEYS, its own standard fanout. The LSM side uses leveled compaction (the default strategy) at
// `/tools/lsm`'s own default parameters — this comparison is about the two STRUCTURES, not about re-exposing
// every tuning knob `/tools/lsm` already has its own page for.
const LSM_COMPARE_MAX_KEYS = 4;
const LSM_COMPARE_OPTIONS: LsmOptions = {
  compactionStrategy: 'leveled',
  memtableCapacity: 4,
  l0CompactionTrigger: 3,
  baseLevelCapacity: 8,
  levelSizeMultiplier: 2,
  bitsPerKey: 8,
};
const LSM_COMPARE_DEFAULT_WRITES = 150;

function LsmCompare() {
  const [n, setN] = useState(LSM_COMPARE_DEFAULT_WRITES);
  const [seed, setSeed] = useState(1);

  const writes = useMemo(() => demoWrites(n, seed), [n, seed]);
  const btree = useMemo(() => planBTreeWrites(writes, LSM_COMPARE_MAX_KEYS), [writes]);
  const lsm = useMemo(() => planLsm(writes, LSM_COMPARE_OPTIONS), [writes]);

  return (
    <>
      <p className="text-body text-ink-dim">
        The exact same {n} writes (plan.md §25.4 F1), fed once into a real B+Tree and once into{' '}
        <Link to="/tools/lsm" className="underline underline-offset-2 hover:text-ink">
          an LSM tree
        </Link>
        . A B+Tree updates <strong className="text-ink">in place</strong>: every write touches at least the one
        leaf it belongs to, and nothing more unless a split cascades upward — cheap, and roughly constant
        regardless of how much data already exists. An LSM tree <strong className="text-ink">defers</strong>{' '}
        writes into a memtable, then pays for it later: the same entry gets physically rewritten again and
        again as compaction sweeps it through deeper, bigger levels — buffering makes the write cheap to
        <em> start</em>, but the total physical work grows with data size in a way the B+Tree&rsquo;s does not.
        Both amplification numbers below come from real counters, not estimates — measured in different units on
        purpose: the B+Tree in index <strong className="text-ink">pages</strong> touched, the LSM tree in raw{' '}
        <strong className="text-ink">entries</strong> rewritten, because that unit difference is itself the
        structural contrast between the two designs.
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="lsm-compare-writes" className="flex flex-col gap-1 text-label text-ink-dim">
          Writes
          <input
            id="lsm-compare-writes"
            type="number"
            min={LSM_LIMITS.minWrites}
            max={LSM_LIMITS.maxWrites}
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= LSM_LIMITS.minWrites && v <= LSM_LIMITS.maxWrites) setN(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <button
          type="button"
          onClick={() => { setSeed(Math.floor(Math.random() * 999_999)); }}
          className={btnSecondary}
        >
          Reshuffle
        </button>
      </div>

      <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
        At {n} writes: the B+Tree touches <span className="font-mono">{btree.writeAmplification.toFixed(2)}</span> index
        page{btree.writeAmplification === 1 ? '' : 's'} per write and a lookup always costs exactly{' '}
        <span className="font-mono">{btree.readCost}</span> page read{btree.readCost === 1 ? '' : 's'}. The LSM
        tree physically rewrites <span className="font-mono">{lsm.writeAmplification.toFixed(2)}</span> entries
        per write, but a real lookup — Bloom filter included — costs only{' '}
        <span className="font-mono">{lsm.readAmplificationAverage.toFixed(2)}</span> table checks on average
        (worst case <span className="font-mono">{lsm.readAmplificationWorstCase}</span>).
      </p>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <h3 className="text-body font-semibold text-ink">B+Tree</h3>
            <p className="text-label text-ink-dim">updates every page in place</p>
          </div>
          <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
            <div className="contents">
              <dt className="text-ink-dim">tree height (levels)</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{btree.finalHeight}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">index pages</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{btree.finalNodeCount}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">page writes, total</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{btree.totalNodeWrites}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">write amplification (pages/write)</dt>
              <dd className="text-right font-mono tabular-nums text-accent">{btree.writeAmplification.toFixed(2)}×</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">point-lookup cost (page reads)</dt>
              <dd className="text-right font-mono tabular-nums text-accent">{btree.readCost}</dd>
            </div>
          </dl>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <h3 className="text-body font-semibold text-ink">LSM tree (leveled)</h3>
            <p className="text-label text-ink-dim">buffers writes, pays for it in compaction</p>
          </div>
          <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
            <div className="contents">
              <dt className="text-ink-dim">levels</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{lsm.levels.length}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">entries on disk</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{lsm.totalEntriesOnDisk}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">entries ever written</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{lsm.totalEntriesEverWritten}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">write amplification (entries/write)</dt>
              <dd className="text-right font-mono tabular-nums text-accent">{lsm.writeAmplification.toFixed(2)}×</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">read amp., measured (Bloom-aided)</dt>
              <dd className="text-right font-mono tabular-nums text-accent">{lsm.readAmplificationAverage.toFixed(2)}×</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">read amp., worst case</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{lsm.readAmplificationWorstCase}</dd>
            </div>
          </dl>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Tuple-at-a-time vs. batched (vectorized) execution (plan.md §25.4 F4)       */
/* -------------------------------------------------------------------------- */

// One database carrying both the join demo's tables and the transactions dataset, so every preset runs against
// the same object — the same single-database convention JoinCompare and AggregateCompare use.
const VECTORIZE_DB: Database = {
  tables: { ...createJoinCompareDatabase().tables, ...DATASETS.transactions.make().tables },
};

const VECTORIZE_PRESETS = [
  { label: 'A large, unindexed scan', sql: 'SELECT * FROM transactions WHERE amount > 4500' },
  {
    label: 'A join across tables of different sizes',
    sql: 'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId',
  },
] as const;

const BATCH_SIZES = [1, 16, 64, 256, 1024] as const;
const VECTORIZE_DEFAULT_BATCH = 256;

interface OperatorCalls {
  label: string;
  rowsProduced: number;
  tupleCalls: number;
  batchedCalls: number;
}

/**
 * The real, measured row count per operator: the largest `rowsProduced` seen for each `nodeKey`. A running max,
 * not last-write — a bookkeeping `execute` event (a residual check that failed, a hash-join build announcement)
 * can carry a smaller or zero `rowsProduced` after the real count has already grown, and taking the last one
 * would undercount. The same trap `explain.ts`'s own actual-row map currently falls into.
 */
function operatorRowCounts(events: RunResult['events']): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.stage !== 'execute') continue;
    const key = nodeKey(e.op, e.table);
    counts.set(key, Math.max(counts.get(key) ?? 0, e.rowsProduced));
  }
  return counts;
}

/**
 * Per operator, how many `next()` calls the engine's own tuple-at-a-time (Volcano) model makes — one per row the
 * operator returns, which is exactly what its own counter measures — against how many a batched model would make
 * for the same rows: `ceil(rows / batchSize)`, one call per batch. The EOF-signalling call is left out of both
 * sides; it is one constant per operator, the same in either model.
 */
function operatorCalls(root: PlanNode, counts: ReadonlyMap<string, number>, batchSize: number): OperatorCalls[] {
  const out: OperatorCalls[] = [];
  const walk = (node: PlanNode): void => {
    const rowsProduced = counts.get(nodeKey(node.op, node.table)) ?? 0;
    out.push({
      label: node.label,
      rowsProduced,
      tupleCalls: rowsProduced,
      batchedCalls: Math.ceil(rowsProduced / batchSize),
    });
    (node.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
}

function VectorizeCompare() {
  const [sqlInput, setSqlInput] = useState<string>(VECTORIZE_PRESETS[0].sql);
  const [sql, setSql] = useState<string>(VECTORIZE_PRESETS[0].sql);
  const [batchSize, setBatchSize] = useState<number>(VECTORIZE_DEFAULT_BATCH);

  const run = useMemo(() => runQuery(sql, VECTORIZE_DB, DEFAULT_ENGINE_OPTIONS), [sql]);
  const plan = useMemo(() => (run.error ? null : finalPlan(run.events)), [run]);
  const rows = useMemo(
    () => (plan ? operatorCalls(plan, operatorRowCounts(run.events), batchSize) : []),
    [plan, run, batchSize],
  );

  const totals = rows.reduce(
    (t, r) => ({ tuple: t.tuple + r.tupleCalls, batched: t.batched + r.batchedCalls }),
    { tuple: 0, batched: 0 },
  );
  const ratio = totals.batched === 0 ? 0 : totals.tuple / totals.batched;

  return (
    <>
      <p className="text-body text-ink-dim">
        The engine executes every query one row at a time: each operator hands its parent one row per{' '}
        <code className="font-mono text-ink">next()</code> call (plan.md §25.4 F4). A vectorized engine hands over
        a batch of rows per call instead, paying the per-call overhead once per batch rather than once per row.
        Both counts below are read from this same run — the tuple-at-a-time column is the engine&rsquo;s own
        measured count; the batched column is the same rows divided into batches of the size you pick. Nothing
        is re-executed, and the rows out are identical either way.
      </p>

      <div className="mt-2 flex flex-col gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label htmlFor="vec-preset" className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select
            id="vec-preset"
            value={VECTORIZE_PRESETS.some((p) => p.sql === sqlInput) ? sqlInput : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSqlInput(e.target.value); }}
            className={inputField}
          >
            {VECTORIZE_PRESETS.map((p) => (
              <option key={p.label} value={p.sql}>{p.label}</option>
            ))}
            <option value="custom">Custom (edit below)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="vec-sql" className="flex flex-1 min-w-64 flex-col gap-1 text-label text-ink-dim">
            SQL
            <input
              id="vec-sql"
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
        <label htmlFor="vec-batch" className="flex flex-col gap-1 text-label text-ink-dim">
          Batch size (rows per <code className="font-mono">next()</code> call)
          <select
            id="vec-batch"
            value={batchSize}
            onChange={(e) => { setBatchSize(Number(e.target.value)); }}
            className={`${inputField} w-40`}
          >
            {BATCH_SIZES.map((b) => (
              <option key={b} value={b}>{b === 1 ? '1 (tuple-at-a-time)' : String(b)}</option>
            ))}
          </select>
        </label>
      </div>

      {run.error ? (
        <p className="rounded-lg border border-evict/40 bg-evict/10 p-3 text-label text-ink">{run.error.message}</p>
      ) : (
        <>
          <p className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink shadow-e1">
            {run.rows.length} row{run.rows.length === 1 ? '' : 's'} out either way. Tuple-at-a-time takes{' '}
            <span className="font-mono">{totals.tuple}</span> <code className="font-mono">next()</code> calls across
            every operator; in batches of <span className="font-mono">{batchSize}</span>, the same rows take{' '}
            <span className="font-mono">{totals.batched}</span> — <span className="font-mono">{ratio.toFixed(1)}×</span> fewer.
          </p>

          <div className={`${panelSurface} overflow-x-auto p-3`}>
            <table className="w-full text-label">
              <thead>
                <tr className="text-left text-ink-dim">
                  <th className="pb-2 font-medium">Operator</th>
                  <th className="pb-2 text-right font-medium">Rows produced</th>
                  <th className="pb-2 text-right font-medium">Tuple-at-a-time calls</th>
                  <th className="pb-2 text-right font-medium">Batched calls</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.label}-${String(i)}`} className="border-t border-edge/60">
                    <td className="py-1.5 font-mono text-ink">{r.label}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink">{r.rowsProduced}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink">{r.tupleCalls}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-accent">{r.batchedCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

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
            ['build', 'Index build'],
            ['aggregate', 'Hash aggregate vs. sort aggregate'],
            ['join', 'JOIN algorithms'],
            ['lsm', 'B+Tree vs. LSM tree'],
            ['vectorize', 'Tuple-at-a-time vs. batched'],
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

      {mode === 'policies' ? (
        <PolicyCompare />
      ) : mode === 'index' ? (
        <IndexCompare />
      ) : mode === 'build' ? (
        <BuildCompare />
      ) : mode === 'aggregate' ? (
        <AggregateCompare />
      ) : mode === 'join' ? (
        <JoinCompare />
      ) : mode === 'lsm' ? (
        <LsmCompare />
      ) : (
        <VectorizeCompare />
      )}
    </div>
  );
}
