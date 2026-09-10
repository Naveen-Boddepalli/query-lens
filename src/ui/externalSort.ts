/**
 * plan.md §22.3 `/tools/sort`: external merge sort, with its own driver (§4's
 * engine has no `Sort` operator yet). Pure and total — given a list of numbers
 * and a memory budget it returns the whole sort *plan*: the initial sorted
 * runs from run generation, every merge pass after that, and the page-I/O each
 * costs. The tool renders it; nothing here touches the DOM.
 *
 * The model is the textbook one (Ramakrishnan & Gehrke §13.3):
 *
 *   - `pageCount` data pages, `memPages` buffer pages available.
 *   - Pass 0 sorts `memPages` pages at a time in memory → `ceil(pageCount /
 *     memPages)` sorted runs. Cost: read every page, write every page = 2·pageCount.
 *   - Each later pass merges `memPages - 1` runs at once (one page is the output
 *     buffer). Cost: 2·pageCount again.
 *   - Passes continue until one run remains.
 *
 * `memPages` is clamped to ≥ 3 so the fan-in is ≥ 2 and merging actually makes
 * progress — with two buffer pages you can only "merge" one run at a time.
 */

export interface SortRun {
  /** Unique across every pass, so a run can point back at the ones that formed it. */
  id: number;
  /** The run's records, ascending. */
  values: number[];
}

export interface SortMerge {
  /** The id of the run this merge produced (also in the pass's `runs`). */
  outputId: number;
  /** The previous pass's run ids that were merged. */
  sourceIds: number[];
  /** For each element of the output run, the source run id it came from. */
  origin: number[];
}

export interface SortPass {
  /** 0 is run generation; 1, 2, … are merge passes. */
  index: number;
  kind: 'generate' | 'merge';
  runs: SortRun[];
  /** One per output run. Empty for the generate pass. */
  merges: SortMerge[];
}

export interface SortPlan {
  input: number[];
  recordCount: number;
  pageSize: number;
  /** Buffer pages available, after the ≥ 3 clamp. */
  memPages: number;
  /** Runs merged per merge step: `memPages - 1`. */
  fanIn: number;
  /** `ceil(recordCount / pageSize)`. */
  pageCount: number;
  /** Runs after pass 0. */
  initialRunCount: number;
  /** Merge passes after run generation. 0 when the input already fits in memory. */
  mergePassCount: number;
  /** `passes[0]` is always the generate pass. */
  passes: SortPass[];
  /** Page reads + writes for one pass over the data: `2 * pageCount`. */
  ioPerPass: number;
  /** `ioPerPass * (1 + mergePassCount)`. */
  totalIO: number;
  /** True when `pageCount <= memPages` — no merge is needed. */
  fitsInMemory: boolean;
}

export const SORT_LIMITS = {
  minRecords: 6,
  maxRecords: 64,
  minPageSize: 2,
  maxPageSize: 4,
  minMemPages: 3,
  maxMemPages: 6,
} as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** A seeded shuffle of `1..n`, so a `?seed=` link reproduces the exact input. */
export function shuffledRange(n: number, seed: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i + 1);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** k-way merge of already-sorted runs, tracking which run each output came from. */
function mergeRuns(sources: SortRun[], outputId: number): SortMerge & { values: number[] } {
  const heads = sources.map(() => 0);
  const values: number[] = [];
  const origin: number[] = [];
  for (;;) {
    let pick = -1;
    let best = Infinity;
    for (let i = 0; i < sources.length; i++) {
      const run = sources[i]!;
      if (heads[i]! < run.values.length && run.values[heads[i]!]! < best) {
        best = run.values[heads[i]!]!;
        pick = i;
      }
    }
    if (pick === -1) break;
    values.push(best);
    origin.push(sources[pick]!.id);
    heads[pick]!++;
  }
  return { outputId, sourceIds: sources.map((r) => r.id), origin, values };
}

export function planExternalSort(
  input: readonly number[],
  opts: { pageSize: number; memPages: number },
): SortPlan {
  const pageSize = clamp(opts.pageSize, SORT_LIMITS.minPageSize, SORT_LIMITS.maxPageSize);
  const memPages = clamp(opts.memPages, SORT_LIMITS.minMemPages, SORT_LIMITS.maxMemPages);
  const fanIn = memPages - 1;
  const records = [...input];
  const recordCount = records.length;
  const pageCount = Math.max(1, Math.ceil(recordCount / pageSize));
  const ioPerPass = 2 * pageCount;

  let nextId = 0;
  const passes: SortPass[] = [];

  // Pass 0 — run generation: sort `memPages` pages of records at a time.
  const chunk = memPages * pageSize;
  const gen: SortRun[] = [];
  for (let i = 0; i < recordCount; i += chunk) {
    gen.push({ id: nextId++, values: records.slice(i, i + chunk).sort((a, b) => a - b) });
  }
  if (gen.length === 0) gen.push({ id: nextId++, values: [] });
  passes.push({ index: 0, kind: 'generate', runs: gen, merges: [] });

  // Merge passes — `fanIn` runs at a time until one remains.
  let current = gen;
  while (current.length > 1) {
    const runs: SortRun[] = [];
    const merges: SortMerge[] = [];
    for (let i = 0; i < current.length; i += fanIn) {
      const group = current.slice(i, i + fanIn);
      if (group.length === 1) {
        // An odd run rides to the next pass untouched (re-id so provenance holds).
        const carried: SortRun = { id: nextId++, values: group[0]!.values };
        runs.push(carried);
        merges.push({ outputId: carried.id, sourceIds: [group[0]!.id], origin: carried.values.map(() => group[0]!.id) });
        continue;
      }
      const outputId = nextId++;
      const merged = mergeRuns(group, outputId);
      runs.push({ id: outputId, values: merged.values });
      merges.push({ outputId, sourceIds: merged.sourceIds, origin: merged.origin });
    }
    passes.push({ index: passes.length, kind: 'merge', runs, merges });
    current = runs;
  }

  return {
    input: records,
    recordCount,
    pageSize,
    memPages,
    fanIn,
    pageCount,
    initialRunCount: gen.length,
    mergePassCount: passes.length - 1,
    passes,
    ioPerPass,
    totalIO: ioPerPass * passes.length,
    fitsInMemory: pageCount <= memPages,
  };
}
