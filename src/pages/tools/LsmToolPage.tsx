import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { demoWrites, LSM_LIMITS, lookupKey, planLsm } from '../../ui/lsm.ts';
import type { CompactionStrategy, LookupResult, LsmEvent, SSTable } from '../../ui/lsm.ts';
import { DataTable } from '../../ui/DataView.tsx';
import { btnGhost, controlLabel, inputField } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  CommandBar,
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  MetricStrip,
  Segmented,
  StagePanel,
  Stepper,
  ToolHeader,
  ToolShell,
} from '../../ui/tool/index.ts';

/**
 * The LSM-tree standalone (plan.md §25.4 F1 `/tools/lsm`). §4's engine has only ever built a B+Tree, so this
 * runs its own driver — `src/ui/lsm.ts` lays out the whole resulting structure (every flush, every compaction,
 * the final levels) and this renders it. No playback: like `/tools/sort` and `/tools/hash-join` it is
 * parameter-driven — change the memtable size or a level's capacity and watch the cascade, the amplification
 * numbers, and the level shapes move.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the workload, compaction and Bloom filter settings in the
 * inspector (the leveled-only ones give way to a note under tiered compaction), a key lookup in the command bar, the
 * amplification numbers in the readout, and the levels on the stage with a table view.
 *
 * URL state: `n` (writes), `mem` (memtable capacity), `trigger` (L0 compaction trigger), `base` (L1 capacity),
 * `mult` (level size multiplier), `bits` (Bloom filter bits per key) and `seed` (the write-key draw). Parsed
 * defensively — a pasted link is a stranger's input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = {
  n: 60,
  compactionStrategy: 'leveled' as CompactionStrategy,
  memtableCapacity: 4,
  l0CompactionTrigger: 3,
  baseLevelCapacity: 8,
  levelSizeMultiplier: 2,
  bitsPerKey: 8,
  seed: 1,
};
const MAX_SEED = 999_999;
const MAX_BASE_LEVEL_CAPACITY = 32;
const MIN_BASE_LEVEL_CAPACITY = 2;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback; // Number(null) is 0, not NaN
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    n: clampInt(p.get('n'), LSM_LIMITS.minWrites, LSM_LIMITS.maxWrites, DEFAULTS.n),
    compactionStrategy: p.get('strategy') === 'tiered' ? 'tiered' : DEFAULTS.compactionStrategy,
    memtableCapacity: clampInt(p.get('mem'), LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity, DEFAULTS.memtableCapacity),
    l0CompactionTrigger: clampInt(p.get('trigger'), LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger, DEFAULTS.l0CompactionTrigger),
    baseLevelCapacity: clampInt(p.get('base'), MIN_BASE_LEVEL_CAPACITY, MAX_BASE_LEVEL_CAPACITY, DEFAULTS.baseLevelCapacity),
    levelSizeMultiplier: clampInt(p.get('mult'), LSM_LIMITS.minLevelSizeMultiplier, LSM_LIMITS.maxLevelSizeMultiplier, DEFAULTS.levelSizeMultiplier),
    bitsPerKey: clampInt(p.get('bits'), LSM_LIMITS.minBitsPerKey, LSM_LIMITS.maxBitsPerKey, DEFAULTS.bitsPerKey),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();

export function LsmToolPage() {
  const [n, setN] = useState(INITIAL.n);
  const [compactionStrategy, setCompactionStrategy] = useState<CompactionStrategy>(INITIAL.compactionStrategy);
  const [memtableCapacity, setMemtableCapacity] = useState(INITIAL.memtableCapacity);
  const [l0CompactionTrigger, setL0CompactionTrigger] = useState(INITIAL.l0CompactionTrigger);
  const [baseLevelCapacity, setBaseLevelCapacity] = useState(INITIAL.baseLevelCapacity);
  const [levelSizeMultiplier, setLevelSizeMultiplier] = useState(INITIAL.levelSizeMultiplier);
  const [bitsPerKey, setBitsPerKey] = useState(INITIAL.bitsPerKey);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<'diagram' | 'table'>('diagram');
  const [lookupInput, setLookupInput] = useState('');
  // Paired with the exact `plan` it was traced through, not just the result — so a parameter change (a new
  // `plan` reference) can invalidate a stale lookup at render time, without an effect to do it imperatively.
  const [lookupState, setLookupState] = useState<{ plan: ReturnType<typeof planLsm>; result: LookupResult } | null>(null);

  const plan = useMemo(
    () =>
      planLsm(demoWrites(n, seed), {
        compactionStrategy,
        memtableCapacity,
        l0CompactionTrigger,
        baseLevelCapacity,
        levelSizeMultiplier,
        bitsPerKey,
      }),
    [n, compactionStrategy, memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier, bitsPerKey, seed],
  );

  const lookupResult = lookupState?.plan === plan ? lookupState.result : null;

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('n', String(n));
    p.set('strategy', compactionStrategy);
    p.set('mem', String(memtableCapacity));
    p.set('trigger', String(l0CompactionTrigger));
    p.set('base', String(baseLevelCapacity));
    p.set('mult', String(levelSizeMultiplier));
    p.set('bits', String(bitsPerKey));
    p.set('seed', String(seed));
    return p.toString();
  }, [n, compactionStrategy, memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier, bitsPerKey, seed]);
  useAddressBarQuery(shareQuery);

  // Every table this table's own event (as the thing created, or the thing a later event removed) connects to —
  // its sources if it was compacted into being, or what it became if it was later compacted away.
  const related = useMemo(() => {
    const set = new Set<number>();
    if (selected === null) return set;
    set.add(selected);
    for (const event of plan.events) {
      if (event.created.includes(selected)) event.removed.forEach((id) => set.add(id));
      if (event.removed.includes(selected)) event.created.forEach((id) => set.add(id));
    }
    return set;
  }, [selected, plan]);

  const eventFor = useMemo(() => {
    const map = new Map<number, LsmEvent>();
    for (const event of plan.events) for (const id of event.created) map.set(id, event);
    return map;
  }, [plan]);

  const flushes = plan.events.filter((e) => e.kind === 'flush').length;
  const compactions = plan.events.length - flushes;
  const leveled = compactionStrategy === 'leveled';
  const lookupValid = lookupInput.trim() !== '' && Number.isInteger(Number(lookupInput));
  const runLookup = () => {
    if (!lookupValid) return;
    setSelected(null);
    setLookupState({ plan, result: lookupKey(plan.levels, Number(lookupInput), plan.options.compactionStrategy) });
  };
  const change = <T,>(set: (v: T) => void) => (v: T) => { set(v); setSelected(null); };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="indexing"
        header={
          <ToolHeader
            id="lsm"
            title="LSM tree"
            summary="Writes flush to sorted files that merge level by level. Watch the cascade and what it costs to write, store and read."
            about={
              <>
                <p>
                  Writes buffer in memory, then flush to disk as an immutable, sorted file, an SSTable, rather than
                  updating one in place. Once a level holds too many, several files merge into fewer, larger ones at the
                  next level down. This is a self-contained model, not wired to the engine, which has only ever built a{' '}
                  <Link to="/tools/btree" className="underline underline-offset-2 hover:text-ink">
                    B+Tree
                  </Link>
                  .
                </p>
                <p>
                  Level 0's tables can overlap in key range; under leveled compaction every level below it is kept
                  non-overlapping, the same reason a B+Tree's leaf chain never holds two leaves covering the same keys.
                  Tiered compaction never re-splits a merge's output, so any level can hold overlapping tables.
                </p>
                <p>
                  Click an SSTable to see what it was built from: a flush's own memtable writes, or the source tables a
                  compaction replaced. A key lookup marks in green the table that held the key and in amber each filter
                  false positive, a table the Bloom filter sent to a real check that did not hold it.
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(n)} writes · ${compactionStrategy} · memtable ${String(memtableCapacity)}`}>
            <ControlGroup legend="Workload">
              <ControlRow label="Writes" htmlFor="lsm-n">
                <Stepper id="lsm-n" value={n} min={LSM_LIMITS.minWrites} max={LSM_LIMITS.maxWrites} step={10} unit="writes" onChange={change(setN)} />
              </ControlRow>
              <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); setSelected(null); }} className={`${btnGhost} self-start`}>
                Shuffle the keys
              </button>
            </ControlGroup>
            <ControlGroup legend="Compaction">
              <ControlRow label="Compaction strategy" labelId="lsm-strategy" stacked>
                <Segmented
                  labelledBy="lsm-strategy"
                  tone="stage"
                  value={compactionStrategy}
                  onChange={change(setCompactionStrategy)}
                  options={[{ value: 'leveled', label: 'Leveled' }, { value: 'tiered', label: 'Tiered' }]}
                />
              </ControlRow>
              <ControlRow label="Memtable capacity" htmlFor="lsm-mem" hint="Writes held in memory before a flush.">
                <Stepper id="lsm-mem" value={memtableCapacity} min={LSM_LIMITS.minMemtableCapacity} max={LSM_LIMITS.maxMemtableCapacity} unit="entries" describedBy={hintIdFor('lsm-mem')} onChange={change(setMemtableCapacity)} />
              </ControlRow>
              {/* Keyed so it remounts: relabelling a container-query row in place left Chromium with a stale,
                  zero-height box for it until the next reflow. */}
              <ControlRow
                key={compactionStrategy}
                label={leveled ? 'L0 compaction trigger' : 'Files per tier'}
                htmlFor="lsm-trigger"
                hint={leveled ? 'L0 files that start a merge into L1.' : 'Files that make a tier, merged as one.'}
              >
                <Stepper id="lsm-trigger" value={l0CompactionTrigger} min={LSM_LIMITS.minL0Trigger} max={LSM_LIMITS.maxL0Trigger} unit="files" describedBy={hintIdFor('lsm-trigger')} onChange={change(setL0CompactionTrigger)} />
              </ControlRow>
              {leveled ? (
                <>
                  <ControlRow label="L1 capacity" labelId="lsm-base" stacked>
                    <Segmented
                      labelledBy="lsm-base"
                      tone="stage"
                      value={String(baseLevelCapacity)}
                      onChange={(v) => { setBaseLevelCapacity(Number(v)); setSelected(null); }}
                      options={[4, 8, 16, 32].map((v) => ({ value: String(v), label: String(v) }))}
                    />
                  </ControlRow>
                  <ControlRow label="Level size ×" labelId="lsm-mult" hint="Each level below L1 holds this many times the one above.">
                    <Segmented
                      labelledBy="lsm-mult"
                      describedBy={hintIdFor('lsm-mult')}
                      tone="stage"
                      value={String(levelSizeMultiplier)}
                      onChange={(v) => { setLevelSizeMultiplier(Number(v)); setSelected(null); }}
                      options={[2, 3, 4].map((v) => ({ value: String(v), label: String(v) }))}
                    />
                  </ControlRow>
                </>
              ) : (
                <p className="text-label text-ink-dim">
                  Tiered compaction merges whole tiers and never re-splits them, so it has no level sizes to set.
                </p>
              )}
            </ControlGroup>
            <ControlGroup legend="Bloom filter">
              <ControlRow label="Bits per key" htmlFor="lsm-bits" hint="More bits, fewer false positives, more memory.">
                <select id="lsm-bits" value={bitsPerKey} aria-describedby={hintIdFor('lsm-bits')} onChange={(e) => { setBitsPerKey(Number(e.target.value)); }} className={inputField}>
                  {[2, 4, 8, 10, 16, 20].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        command={
          <CommandBar primary={{ label: 'Look up', onClick: runLookup, disabled: !lookupValid }}>
            <label htmlFor="lsm-key" className={`flex flex-col gap-1 ${controlLabel}`}>
              Look up a key
              <input
                id="lsm-key"
                type="number"
                value={lookupInput}
                onChange={(e) => { setLookupInput(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') runLookup(); }}
                placeholder="e.g. 5"
                className={`${inputField} w-28 tabular-nums`}
              />
            </label>
          </CommandBar>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Flushes', value: flushes, sub: `memtable to L0 · ${String(plan.distinctKeysWritten)} distinct keys` },
              { label: 'Compactions', value: compactions, sub: 'merges into a lower level' },
              { label: 'Write amplification', value: `${plan.writeAmplification.toFixed(2)}×`, sub: 'bytes written ÷ bytes asked for' },
              { label: 'Space amplification', value: `${plan.spaceAmplification.toFixed(2)}×`, sub: 'bytes on disk ÷ live data' },
              { label: 'Read amplification', value: `${plan.readAmplificationAverage.toFixed(2)}×`, sub: `measured; worst case ${plural(plan.readAmplificationWorstCase, 'table')}` },
              { label: 'False positives', value: `${(plan.measuredFalsePositiveRate * 100).toFixed(1)}%`, sub: 'of filter checks that said “maybe”' },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Levels"
            legend={leveled ? 'Only L0 files overlap.' : 'Any level may overlap.'}
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            {view === 'diagram' ? (
              <div className="flex flex-col divide-y divide-edge/60">
                {plan.levels.map((level, levelIndex) => (
                  <LevelBlock
                    key={levelIndex}
                    levelIndex={levelIndex}
                    tables={level}
                    compactionStrategy={compactionStrategy}
                    selected={selected}
                    related={related}
                    eventFor={eventFor}
                    lookupResult={lookupResult}
                    onSelect={(id) => { setSelected((cur) => (cur === id ? null : id)); setLookupState(null); }}
                  />
                ))}
              </div>
            ) : (
              <DataTable
                caption="SSTables by level, with the key range, entries and how each was built"
                rows={plan.levels.flatMap((tables, level) => tables.map((table) => ({ level, table })))}
                keyOf={(r) => String(r.table.id)}
                columns={[
                  { header: 'Level', cell: (r) => (r.level === 0 ? 'L0' : `L${String(r.level)}`) },
                  { header: 'SSTable', cell: (r) => r.table.id },
                  {
                    header: 'Keys',
                    cell: (r) => (r.table.minKey === r.table.maxKey ? String(r.table.minKey) : `${String(r.table.minKey)}–${String(r.table.maxKey)}`),
                  },
                  { header: 'Entries', cell: (r) => r.table.entries.length },
                  {
                    header: 'Built by',
                    cell: (r) => {
                      const built = eventFor.get(r.table.id);
                      if (!built) return '';
                      return built.kind === 'flush' ? 'flush' : `compaction of ${String(built.removed.length)} tables`;
                    },
                  },
                ]}
              />
            )}
          </StagePanel>
        }
        narration={
          lookupResult
            ? lookupResult.found
              ? `Key ${String(lookupResult.key)} found — value ${String(lookupResult.value)}, after checking ${plural(lookupResult.tablesChecked.length, 'SSTable')}${lookupResult.falsePositives.length > 0 ? `, ${plural(lookupResult.falsePositives.length, 'filter false positive')} along the way` : ''}. Green marks the table that held it${lookupResult.falsePositives.length > 0 ? ', amber a false positive' : ''}.`
              : `Key ${String(lookupResult.key)} not found, after the Bloom filter still sent ${plural(lookupResult.tablesChecked.length, 'false positive')} to a real check.`
            : 'Click an SSTable to see what it was built from, or look up a key to trace a real read through the levels.'
        }
      />
    </div>
  );
}

function LevelBlock({
  levelIndex,
  tables,
  compactionStrategy,
  selected,
  related,
  eventFor,
  lookupResult,
  onSelect,
}: {
  levelIndex: number;
  tables: readonly SSTable[];
  compactionStrategy: CompactionStrategy;
  selected: number | null;
  related: ReadonlySet<number>;
  eventFor: ReadonlyMap<number, LsmEvent>;
  lookupResult: LookupResult | null;
  onSelect: (id: number) => void;
}) {
  const title = levelIndex === 0 ? 'L0 (flushed from the memtable)' : `L${String(levelIndex)}`;
  const mayOverlap = levelIndex === 0 || compactionStrategy === 'tiered';

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <h4 className="font-medium text-ink">{title}</h4>
        <span className="text-ink-dim">
          {tables.length} SSTable{tables.length === 1 ? '' : 's'}
          {mayOverlap && tables.length > 1 ? ' — key ranges may overlap' : ''}
        </span>
      </div>

      {tables.length === 0 ? (
        <p className="text-label text-ink-dim/70">empty</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tables.map((table) => {
            const isSelected = table.id === selected;
            const isRelated = related.has(table.id);
            const isFalsePositive = lookupResult?.falsePositives.includes(table.id) ?? false;
            const isRealHit = lookupResult?.found && lookupResult.tablesChecked.includes(table.id) && !isFalsePositive;
            const ringClass = isRealHit
              ? 'ring-2 ring-hit'
              : isFalsePositive
                ? 'ring-2 ring-evict'
                : isSelected
                  ? 'ring-2 ring-accent'
                  : isRelated
                    ? 'ring-1 ring-ink-dim/40'
                    : '';
            const builtBy = eventFor.get(table.id);

            return (
              <button
                key={table.id}
                type="button"
                onClick={() => { onSelect(table.id); }}
                aria-pressed={isSelected}
                className={`flex max-w-full flex-col gap-1 rounded-lg border border-edge bg-surface-3 p-2 text-left transition hover:border-ink-dim/50 ${ringClass}`}
              >
                <span className="text-label tabular-nums text-ink-dim/70">
                  {table.minKey === table.maxKey ? `key ${String(table.minKey)}` : `keys ${String(table.minKey)}–${String(table.maxKey)}`}
                  {' · '}
                  {table.entries.length} entr{table.entries.length === 1 ? 'y' : 'ies'}
                </span>
                {isSelected && builtBy && (
                  <span className="text-label text-ink-dim">
                    {builtBy.kind === 'flush'
                      ? 'flushed from the memtable'
                      : `compacted from ${plural(builtBy.removed.length, 'table')}`}
                  </span>
                )}
                {isRealHit && <span className="text-label text-hit">found here</span>}
                {isFalsePositive && <span className="text-label text-evict">filter false positive</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
