import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { demoWrites, LSM_LIMITS, planLsm } from '../../ui/lsm.ts';
import type { LsmEvent, SSTable } from '../../ui/lsm.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';

/**
 * The LSM-tree standalone (plan.md §25.4 F1 `/tools/lsm`). §4's engine has only ever built a B+Tree, so this
 * runs its own driver — `src/ui/lsm.ts` lays out the whole resulting structure (every flush, every compaction,
 * the final levels) and this renders it. No playback: like `/tools/sort` and `/tools/hash-join` it is
 * parameter-driven — change the memtable size or a level's capacity and watch the cascade, the amplification
 * numbers, and the level shapes move.
 *
 * URL state: `n` (writes), `mem` (memtable capacity), `trigger` (L0 compaction trigger), `base` (L1 capacity),
 * `mult` (level size multiplier) and `seed` (the write-key draw). Parsed defensively — a pasted link is a
 * stranger's input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = { n: 60, memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, seed: 1 };
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
    memtableCapacity: clampInt(p.get('mem'), LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity, DEFAULTS.memtableCapacity),
    l0CompactionTrigger: clampInt(p.get('trigger'), LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger, DEFAULTS.l0CompactionTrigger),
    baseLevelCapacity: clampInt(p.get('base'), MIN_BASE_LEVEL_CAPACITY, MAX_BASE_LEVEL_CAPACITY, DEFAULTS.baseLevelCapacity),
    levelSizeMultiplier: clampInt(p.get('mult'), LSM_LIMITS.minLevelSizeMultiplier, LSM_LIMITS.maxLevelSizeMultiplier, DEFAULTS.levelSizeMultiplier),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();

export function LsmToolPage() {
  const [n, setN] = useState(INITIAL.n);
  const [memtableCapacity, setMemtableCapacity] = useState(INITIAL.memtableCapacity);
  const [l0CompactionTrigger, setL0CompactionTrigger] = useState(INITIAL.l0CompactionTrigger);
  const [baseLevelCapacity, setBaseLevelCapacity] = useState(INITIAL.baseLevelCapacity);
  const [levelSizeMultiplier, setLevelSizeMultiplier] = useState(INITIAL.levelSizeMultiplier);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [selected, setSelected] = useState<number | null>(null);

  const plan = useMemo(
    () =>
      planLsm(demoWrites(n, seed), {
        memtableCapacity,
        l0CompactionTrigger,
        baseLevelCapacity,
        levelSizeMultiplier,
      }),
    [n, memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier, seed],
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = new URLSearchParams();
      p.set('n', String(n));
      p.set('mem', String(memtableCapacity));
      p.set('trigger', String(l0CompactionTrigger));
      p.set('base', String(baseLevelCapacity));
      p.set('mult', String(levelSizeMultiplier));
      p.set('seed', String(seed));
      const next = `${location.pathname}?${p.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(t); };
  }, [n, memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier, seed]);

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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="LSM tree">
        Writes buffer in memory, then flush to disk as an immutable, sorted file — an SSTable — rather than
        updating one in place. Once a level holds too many, several files merge into fewer, larger ones at the
        next level down. Not wired to the engine (which has only ever built a B+Tree); a self-contained model.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Writes
          <input
            type="number"
            min={LSM_LIMITS.minWrites}
            max={LSM_LIMITS.maxWrites}
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= LSM_LIMITS.minWrites && v <= LSM_LIMITS.maxWrites) {
                setN(v);
                setSelected(null);
              }
            }}
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Memtable capacity
          <select
            value={memtableCapacity}
            onChange={(e) => { setMemtableCapacity(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {Array.from({ length: LSM_LIMITS.maxMemtableCapacity - LSM_LIMITS.minMemtableCapacity + 1 }, (_, i) => LSM_LIMITS.minMemtableCapacity + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          L0 compaction trigger
          <select
            value={l0CompactionTrigger}
            onChange={(e) => { setL0CompactionTrigger(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {Array.from({ length: LSM_LIMITS.maxL0Trigger - LSM_LIMITS.minL0Trigger + 1 }, (_, i) => LSM_LIMITS.minL0Trigger + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          L1 capacity
          <select
            value={baseLevelCapacity}
            onChange={(e) => { setBaseLevelCapacity(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {[4, 8, 16, 32].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Level size ×
          <select
            value={levelSizeMultiplier}
            onChange={(e) => { setLevelSizeMultiplier(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {[2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <button
          type="button"
          onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); setSelected(null); }}
          className={btnSecondary}
        >
          Reshuffle
        </button>
      </div>

      <div className={`${panelSurface} flex flex-wrap items-start gap-x-8 gap-y-3 p-4`}>
        <Stat label="distinct keys" value={plan.distinctKeysWritten} sub={`${plan.writes.length} writes`} />
        <Stat
          label="flushes / compactions"
          value={plan.events.length}
          sub={`${plan.events.filter((e) => e.kind === 'flush').length} flush, ${plan.events.filter((e) => e.kind === 'compaction').length} compaction`}
        />
        <Stat label="write amplification" value={plan.writeAmplification} decimals={2} sub="bytes written ÷ bytes you asked to write" accent />
        <Stat label="space amplification" value={plan.spaceAmplification} decimals={2} sub="bytes on disk ÷ bytes of live data" accent />
        <Stat label="read amplification" value={plan.readAmplificationWorstCase} sub="SSTables a lookup might check, worst case — no Bloom filter yet" accent />
      </div>

      <div className="flex flex-col gap-3">
        {plan.levels.map((level, levelIndex) => (
          <LevelBlock
            key={levelIndex}
            levelIndex={levelIndex}
            tables={level}
            selected={selected}
            related={related}
            eventFor={eventFor}
            onSelect={(id) => { setSelected((cur) => (cur === id ? null : id)); }}
          />
        ))}
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Click any SSTable to see what it was built from — a flush's own memtable writes, or a compaction's
        source tables (which it replaced and removed). Level 0's tables can overlap in key range; every level
        below it is kept non-overlapping by compaction, the same reason a B+Tree's{' '}
        <Link to="/tools/btree" className="underline underline-offset-2 hover:text-ink">
          leaf chain
        </Link>{' '}
        never holds two leaves covering the same keys.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  decimals = 0,
  accent = false,
}: {
  label: string;
  value: number;
  sub: string;
  decimals?: number;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className={`text-heading font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>
        {decimals > 0 ? `${value.toFixed(decimals)}×` : value}
      </span>
      <span className="text-label text-ink-dim">{label}</span>
      <span className="text-label text-ink-dim/70">{sub}</span>
    </div>
  );
}

function LevelBlock({
  levelIndex,
  tables,
  selected,
  related,
  eventFor,
  onSelect,
}: {
  levelIndex: number;
  tables: readonly SSTable[];
  selected: number | null;
  related: ReadonlySet<number>;
  eventFor: ReadonlyMap<number, LsmEvent>;
  onSelect: (id: number) => void;
}) {
  const title = levelIndex === 0 ? 'L0 (flushed from the memtable)' : `L${String(levelIndex)}`;

  return (
    <div className={`${panelSurface} p-3`}>
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-ink-dim">
          {tables.length} SSTable{tables.length === 1 ? '' : 's'}
          {levelIndex === 0 && tables.length > 1 ? ' — key ranges may overlap' : ''}
        </span>
      </div>

      {tables.length === 0 ? (
        <p className="text-label text-ink-dim/70">empty</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tables.map((table) => {
            const isSelected = table.id === selected;
            const isRelated = related.has(table.id);
            const ringClass = isSelected ? 'ring-2 ring-accent' : isRelated ? 'ring-1 ring-ink-dim/40' : '';
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
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
