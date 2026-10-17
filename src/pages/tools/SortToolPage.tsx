import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { planExternalSort, shuffledRange, SORT_LIMITS } from '../../ui/externalSort.ts';
import type { SortMerge, SortPass, SortPlan } from '../../ui/externalSort.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The sorting standalone (plan.md §22.3 `/tools/sort`). §4's engine has no
 * `Sort` operator yet, so this runs its own driver — `src/ui/externalSort.ts`
 * lays out the whole plan (run generation, every merge pass, the page I/O) and
 * this renders it. No playback: like `/tools/page` it is parameter-driven and
 * cross-highlighted — change the memory budget and watch the pass count and the
 * I/O move.
 *
 * URL state: `n` (records), `page` (records per page), `mem` (buffer pages) and
 * `seed` (the shuffle). Parsed defensively — a pasted link is a stranger's
 * input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = { n: 32, pageSize: 2, memPages: 3, seed: 1 };
const MAX_SEED = 999_999;

/** One colour per source run while a merge output is selected (fan-in ≤ 5). */
const TINT = [
  { chip: 'bg-accent/25 text-ink', ring: 'ring-accent' },
  { chip: 'bg-hit/25 text-ink', ring: 'ring-hit' },
  { chip: 'bg-miss/30 text-ink', ring: 'ring-miss' },
  { chip: 'bg-evict/25 text-ink', ring: 'ring-evict' },
  { chip: 'bg-stage-index/25 text-ink', ring: 'ring-stage-index' },
] as const;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback; // Number(null) is 0, not NaN
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    n: clampInt(p.get('n'), SORT_LIMITS.minRecords, SORT_LIMITS.maxRecords, DEFAULTS.n),
    pageSize: clampInt(p.get('page'), SORT_LIMITS.minPageSize, SORT_LIMITS.maxPageSize, DEFAULTS.pageSize),
    memPages: clampInt(p.get('mem'), SORT_LIMITS.minMemPages, SORT_LIMITS.maxMemPages, DEFAULTS.memPages),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();
const plural = (k: number, s: string) =>
  `${k} ${k === 1 ? s : /(s|sh|ch|x|z)$/.test(s) ? `${s}es` : `${s}s`}`;

export function SortToolPage() {
  const [n, setN] = useState(INITIAL.n);
  const [pageSize, setPageSize] = useState(INITIAL.pageSize);
  const [memPages, setMemPages] = useState(INITIAL.memPages);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [selected, setSelected] = useState<number | null>(null);

  const plan = useMemo<SortPlan>(
    () => planExternalSort(shuffledRange(n, seed), { pageSize, memPages }),
    [n, seed, pageSize, memPages],
  );

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('n', String(n));
    p.set('page', String(pageSize));
    p.set('mem', String(memPages));
    p.set('seed', String(seed));
    return p.toString();
  }, [n, pageSize, memPages, seed]);
  useAddressBarQuery(shareQuery);

  // The merge that produced the selected run, if it is a merge output.
  const selectedMerge = useMemo<SortMerge | null>(() => {
    if (selected === null) return null;
    for (const pass of plan.passes) {
      const m = pass.merges.find((x) => x.outputId === selected);
      if (m) return m;
    }
    return null;
  }, [selected, plan]);

  // Selecting a run rings it, its direct parents and its direct child.
  const related = useMemo(() => {
    const set = new Set<number>();
    if (selected === null) return set;
    set.add(selected);
    for (const pass of plan.passes) {
      for (const m of pass.merges) {
        if (m.outputId === selected) m.sourceIds.forEach((id) => set.add(id));
        if (m.sourceIds.includes(selected)) set.add(m.outputId);
      }
    }
    return set;
  }, [selected, plan]);

  // sourceRunId -> its index (0..fanIn-1) within the selected merge.
  const sourceSlot = useMemo(() => {
    const map = new Map<number, number>();
    selectedMerge?.sourceIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [selectedMerge]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="External merge sort">
        Sorting more records than fit in memory: sort what fits into short runs, then merge the runs
        together pass after pass until one sorted run remains. The cost is page reads and writes —
        change the memory budget and watch it move. Not wired to a <code className="font-mono text-ink">Sort</code>{' '}
        operator (the engine has none yet); a self-contained model.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Records
          <input
            type="number"
            min={SORT_LIMITS.minRecords}
            max={SORT_LIMITS.maxRecords}
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= SORT_LIMITS.minRecords && v <= SORT_LIMITS.maxRecords) {
                setN(v);
                setSelected(null);
              }
            }}
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Records / page
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {[2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Buffer pages
          <select
            value={memPages}
            onChange={(e) => { setMemPages(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {[3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <button
          type="button"
          onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); setSelected(null); }}
          className={btnSecondary}
        >
          Shuffle
        </button>
      </div>

      <div className={`${panelSurface} flex flex-wrap items-start gap-x-8 gap-y-3 p-4`}>
        <Stat label="data pages" value={plan.pageCount} sub={`${plan.recordCount} records`} />
        <Stat label="initial runs" value={plan.initialRunCount} sub={`sort ${plan.memPages} pages at once`} />
        <Stat
          label="merge passes"
          value={plan.mergePassCount}
          sub={plan.mergePassCount === 0 ? 'fits in memory' : `${plan.fanIn} runs merged at once`}
        />
        <Stat
          label="page I/Os"
          value={plan.totalIO}
          sub={`${plan.ioPerPass} per pass × ${plan.passes.length}`}
          accent
        />
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        {plan.fitsInMemory ? (
          <>
            All {plan.recordCount} records fit in {plan.memPages} buffer pages, so run generation
            sorts them in one pass — no merge needed. Add records or drop a buffer page to force a
            real external sort.
          </>
        ) : (
          <>
            With <span className="text-ink">{plan.memPages}</span> buffer pages you merge{' '}
            <span className="text-ink">{plan.fanIn}</span> runs at a time. Run generation makes{' '}
            <span className="text-ink">{plural(plan.initialRunCount, 'run')}</span>;{' '}
            <span className="text-ink">{plural(plan.mergePassCount, 'merge pass')}</span> then folds
            them into one. Every pass reads and writes all{' '}
            <span className="text-ink">{plan.pageCount}</span> pages, so the sort costs{' '}
            <span className="text-ink tabular-nums">{plan.totalIO}</span> page I/Os. One more buffer
            page widens every merge and can drop a whole pass.
          </>
        )}
      </p>

      <div className="flex flex-col gap-3">
        {plan.passes.map((pass) => (
          <PassBlock
            key={pass.index}
            pass={pass}
            fanIn={plan.fanIn}
            selected={selected}
            related={related}
            selectedMerge={selectedMerge}
            sourceSlot={sourceSlot}
            onSelect={(id) => { setSelected((cur) => (cur === id ? null : id)); }}
          />
        ))}
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Click any merged run to colour its records by which run each came from, and to light the runs
        that fed it. The same interleave drives every{' '}
        <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
          disk read in the buffer pool
        </Link>{' '}
        and every scan in the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        .
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: number;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className={`text-heading font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>
        {value}
      </span>
      <span className="text-label text-ink-dim">{label}</span>
      <span className="text-label text-ink-dim/70">{sub}</span>
    </div>
  );
}

function PassBlock({
  pass,
  fanIn,
  selected,
  related,
  selectedMerge,
  sourceSlot,
  onSelect,
}: {
  pass: SortPass;
  fanIn: number;
  selected: number | null;
  related: ReadonlySet<number>;
  selectedMerge: SortMerge | null;
  sourceSlot: ReadonlyMap<number, number>;
  onSelect: (id: number) => void;
}) {
  const title = pass.index === 0 ? 'Run generation' : `Merge pass ${pass.index}`;

  return (
    <div className={`${panelSurface} p-3`}>
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-ink-dim">
          {plural(pass.runs.length, 'run')}
          {pass.index > 0 && `, ≤ ${fanIn}-way`}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {pass.runs.map((run) => {
          const isSelected = run.id === selected;
          const slot = sourceSlot.get(run.id);
          const ringClass = isSelected
            ? 'ring-2 ring-accent'
            : slot !== undefined
              ? `ring-2 ${TINT[slot % TINT.length]!.ring}`
              : related.has(run.id)
                ? 'ring-1 ring-ink-dim/40'
                : '';

          const origin =
            selectedMerge && selectedMerge.outputId === run.id ? selectedMerge.origin : null;

          const trimmed = run.values.length > 16;
          const shown = trimmed
            ? [
                ...run.values.slice(0, 8).map((v, i) => ({ v, i })),
                null,
                ...run.values.slice(-6).map((v, k) => ({ v, i: run.values.length - 6 + k })),
              ]
            : run.values.map((v, i) => ({ v, i }));

          return (
            <button
              key={run.id}
              type="button"
              onClick={() => { onSelect(run.id); }}
              aria-pressed={isSelected}
              className={`flex max-w-full flex-col gap-1 rounded-lg border border-edge bg-surface-3 p-2 text-left transition hover:border-ink-dim/50 ${ringClass}`}
            >
              <span className="text-label tabular-nums text-ink-dim/70">
                {plural(run.values.length, 'rec')}
              </span>
              <span className="flex flex-wrap gap-1">
                {shown.map((cell, k) =>
                  cell === null ? (
                    <span key={`gap${k}`} className="px-1 text-label text-ink-dim">…</span>
                  ) : (
                    <Chip
                      key={cell.i}
                      v={cell.v}
                      tint={origin ? (TINT[sourceSlot.get(origin[cell.i]!) ?? 0]?.chip ?? null) : null}
                    />
                  ),
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ v, tint }: { v: number; tint: string | null }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-label tabular-nums ${tint ?? 'bg-surface text-ink-dim'}`}>
      {v}
    </span>
  );
}
