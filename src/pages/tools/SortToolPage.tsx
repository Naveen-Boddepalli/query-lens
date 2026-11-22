import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { planExternalSort, shuffledRange, SORT_LIMITS } from '../../ui/externalSort.ts';
import type { SortMerge, SortPass, SortPlan } from '../../ui/externalSort.ts';
import { btnGhost } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
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
 * The sorting standalone (plan.md §22.3 `/tools/sort`). §4's engine has no
 * `Sort` operator yet, so this runs its own driver — `src/ui/externalSort.ts`
 * lays out the whole plan (run generation, every merge pass, the page I/O) and
 * this renders it. No playback: like `/tools/page` it is parameter-driven and
 * cross-highlighted — change the memory budget and watch the pass count and the
 * I/O move.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the data and the memory budget in the inspector, the four
 * numbers in the readout, and every pass on the stage, with the sentence that explains them as the narration.
 *
 * URL state: `n` (records), `page` (records per page), `mem` (buffer pages) and
 * `seed` (the shuffle). Parsed defensively — a pasted link is a stranger's
 * input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = { n: 32, pageSize: 2, memPages: 3, seed: 1 };
const MAX_SEED = 999_999;
const PAGE_SIZES = [2, 3, 4] as const;
const MEM_PAGES = [3, 4, 5, 6] as const;

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

  const reset = () => { setSelected(null); };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="query"
        header={
          <ToolHeader
            id="sort"
            title="External merge sort"
            summary="Sort more records than fit in memory, and watch the buffer budget set the passes and the I/O."
            about={
              <p>
                Sort what fits into short runs, then merge the runs together pass after pass until one sorted run
                remains. The cost is page reads and writes. The same interleave drives every{' '}
                <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
                  disk read in the buffer pool
                </Link>{' '}
                and every scan in the{' '}
                <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
                  Playground
                </Link>
                .
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(n)} records · ${String(memPages)} buffer pages`}>
            <ControlGroup legend="Data">
              <ControlRow label="Records" htmlFor="sort-n">
                <Stepper
                  id="sort-n"
                  value={n}
                  min={SORT_LIMITS.minRecords}
                  max={SORT_LIMITS.maxRecords}
                  unit="records"
                  onChange={(v) => { setN(v); reset(); }}
                />
              </ControlRow>
              <ControlRow label="Records per page" labelId="sort-page">
                <Segmented
                  labelledBy="sort-page"
                  tone="stage"
                  value={String(pageSize)}
                  onChange={(v) => { setPageSize(Number(v)); reset(); }}
                  options={PAGE_SIZES.map((v) => ({ value: String(v), label: String(v) }))}
                />
              </ControlRow>
              <button
                type="button"
                onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); reset(); }}
                className={`${btnGhost} self-start`}
              >
                Shuffle the keys
              </button>
            </ControlGroup>
            <ControlGroup legend="Memory">
              <ControlRow label="Buffer pages" labelId="sort-mem" hint="Pages to sort in, and to merge through: one is the output.">
                <Segmented
                  labelledBy="sort-mem"
                  describedBy={hintIdFor('sort-mem')}
                  tone="stage"
                  value={String(memPages)}
                  onChange={(v) => { setMemPages(Number(v)); reset(); }}
                  options={MEM_PAGES.map((v) => ({ value: String(v), label: String(v) }))}
                />
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Data pages', value: plan.pageCount, sub: `${String(plan.recordCount)} records` },
              { label: 'Initial runs', value: plan.initialRunCount, sub: `${String(plan.memPages)} pages per sort` },
              {
                label: 'Merge passes',
                value: plan.mergePassCount,
                sub: plan.mergePassCount === 0 ? 'sorted in memory' : `${String(plan.fanIn)}-way fan-in`,
              },
              { label: 'Page I/Os', value: plan.totalIO, sub: `${String(plan.ioPerPass)} per pass × ${String(plan.passes.length)}` },
            ]}
          />
        }
        stage={
          <StagePanel title="Passes" legend="Click a merged run to colour its records by the run each came from.">
            <div className="flex flex-col divide-y divide-edge/60">
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
          </StagePanel>
        }
        narration={
          plan.fitsInMemory
            ? `All ${String(plan.recordCount)} records fit in ${String(plan.memPages)} buffer pages, so run generation sorts them in one pass and no merge is needed. Add records or drop a buffer page to force a real external sort.`
            : `With ${String(plan.memPages)} buffer pages you merge ${String(plan.fanIn)} runs at a time. Run generation makes ${plural(plan.initialRunCount, 'run')}; ${plural(plan.mergePassCount, 'merge pass')} then folds them into one. Every pass reads and writes all ${String(plan.pageCount)} pages, so the sort costs ${String(plan.totalIO)} page I/Os. One more buffer page widens every merge and can drop a whole pass.`
        }
      />
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
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <h4 className="font-medium text-ink">{title}</h4>
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
