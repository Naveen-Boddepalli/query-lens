/**
 * The `Sort` operator's own driver: external merge sort over real `Row[]`,
 * with every page it writes or re-reads flowing through the real buffer pool
 * (plan.md §22.2) — competing for the same frames a heap scan uses, which is
 * the whole point of building this rather than calling `Array.prototype.sort`
 * with a comment.
 *
 * The algorithm mirrors the worked example already built for `/tools/sort`
 * (`src/ui/externalSort.ts`, Ramakrishnan & Gehrke §13.3): `memPages` pages
 * of records sorted in memory become one run each (pass 0), then every later
 * pass merges `memPages − 1` runs at a time until one remains.
 *
 * Page ids are never reused: each pass writes into its own fresh block, so a
 * page a later step still needs to read is never silently overwritten by an
 * earlier one — the property a real spill file gets for free by simply being
 * a different file. `sortTempPageCount` sizes that reservation; `runQuery.ts`
 * adds it to the buffer pool's page count before the pool is built, so every
 * id this module hands out is valid.
 */

import type { Row, SqlValue } from '../types.ts';
import type { Emit } from '../trace.ts';
import type { BufferPool } from '../storage/index.ts';

/** Runs merged per merge step — one buffer page is reserved for the output. */
function fanInFor(memPages: number): number {
  return Math.max(2, memPages - 1);
}

/** Passes a sort of `pageCount` pages needs: run generation, then merges until one run remains. */
export function sortPassCount(pageCount: number, memPages: number): number {
  const fanIn = fanInFor(memPages);
  let runCount = Math.max(1, Math.ceil(pageCount / memPages));
  let passes = 1;
  while (runCount > 1) {
    runCount = Math.ceil(runCount / fanIn);
    passes += 1;
  }
  return passes;
}

/**
 * Distinct page ids to reserve for sorting `rowCount` rows: a fresh block per
 * pass, sized generously above the perfectly-packed page count. Merging
 * several runs whose own last page is only partly full needs a handful more
 * once each merge group repacks its own output — the same last-page waste a
 * real spill file has — so the block leaves `memPages` pages of slack rather
 * than claim an exact figure it cannot defend (plan.md §12).
 */
export function sortTempPageCount(rowCount: number, rowsPerPage: number, memPages: number): number {
  const pageCount = Math.max(1, Math.ceil(rowCount / rowsPerPage));
  const passes = sortPassCount(pageCount, memPages);
  return (pageCount + memPages) * passes;
}

/**
 * Total order over `SqlValue`, ascending: numbers numerically, everything
 * else lexicographically, NULLs last — Postgres's own default, and the
 * reason `direction: 'desc'` below just negates this rather than re-deriving
 * a second rule (negating "NULLs last" gives "NULLs first", Postgres's
 * default there too).
 */
function compareAsc(a: SqlValue, b: SqlValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = typeof a === 'boolean' ? String(Number(a)) : String(a);
  const sb = typeof b === 'boolean' ? String(Number(b)) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export interface SortIO {
  pool: BufferPool;
  emit: Emit;
  /** First page id in this sort's reserved, never-reused range. */
  base: number;
  /** Buffer pages available for an in-memory run — the sort's own memory budget. */
  memPages: number;
  rowsPerPage: number;
}

interface Run {
  id: number;
  /** Page ids holding this run's rows, in order. */
  pages: number[];
}

/** Writes `rows` to a fresh page, through the pool for the frame bookkeeping and narration. */
function spillPage(io: SortIO, spill: Map<number, Row[]>, nextId: () => number, rows: Row[]): number {
  const pageId = nextId();
  const result = io.pool.write(pageId);
  if (result) io.pool.unpin(result.frameId);
  spill.set(pageId, rows);
  return pageId;
}

/** Reads a spilled page's rows back, through the pool for the same reason. */
function readPage(io: SortIO, spill: Map<number, Row[]>, pageId: number): Row[] {
  const result = io.pool.fetch(pageId);
  if (result) io.pool.unpin(result.frameId);
  return spill.get(pageId) ?? [];
}

/** Writes one run's already-sorted rows out, `rowsPerPage` at a time (at least one page, even if empty). */
function writeRun(
  io: SortIO,
  spill: Map<number, Row[]>,
  nextId: () => number,
  id: number,
  rows: Row[],
): Run {
  if (rows.length === 0) return { id, pages: [spillPage(io, spill, nextId, [])] };
  const pages: number[] = [];
  for (let i = 0; i < rows.length; i += io.rowsPerPage) {
    pages.push(spillPage(io, spill, nextId, rows.slice(i, i + io.rowsPerPage)));
  }
  return { id, pages };
}

/** k-way merge of already-sorted runs, read back page by page through the pool. */
function mergeRuns(
  sources: readonly Run[],
  spill: Map<number, Row[]>,
  io: SortIO,
  cmp: (a: Row, b: Row) => number,
): Row[] {
  const rows = sources.map((run) => run.pages.flatMap((pid) => readPage(io, spill, pid)));
  const heads = rows.map(() => 0);
  const merged: Row[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < rows.length; i++) {
      if (heads[i]! >= rows[i]!.length) continue;
      if (pick === -1 || cmp(rows[i]![heads[i]!]!, rows[pick]![heads[pick]!]!) < 0) pick = i;
    }
    if (pick === -1) break;
    merged.push(rows[pick]![heads[pick]!]!);
    heads[pick]! += 1;
  }
  return merged;
}

/**
 * Runs a full external merge sort and returns the rows in final order. Runs
 * to completion before returning a single row — `Sort` is the one operator
 * in this engine that cannot stream, and the narration says so.
 *
 * `keyOf` returns a *tuple* — compared lexicographically, left column first —
 * rather than a single `SqlValue`, so this same driver serves `Sort`'s
 * one-column `ORDER BY` (a one-element tuple) and `SortAggregate`'s
 * potentially multi-column `GROUP BY` key without duplicating the algorithm.
 * `subject` and `op` name the caller in the narration and in the emitted
 * `execute` events (`'Sort'` by default; `SortAggregate` passes its own name
 * so its internal sort phase is not mistaken for a top-level `Sort` node).
 * `table` is `sortMergeJoin`'s own disambiguator (its `Join`'s `rightTable`) passed through so these internal,
 * zero-row progress pings carry the same `table` as that `Join`'s real `execute` events — otherwise one of these
 * could land in `explain.ts`'s per-node lookup without the table that identifies which `Join`, in a chain with
 * more than one, it belongs to. `undefined` for `Sort`/`SortAggregate`/`SortDistinct`, which never repeat.
 */
export function externalMergeSort(
  rows: readonly Row[],
  keyOf: (row: Row) => SqlValue[],
  direction: 'asc' | 'desc',
  io: SortIO,
  subject = 'Sort',
  op = 'Sort',
  table?: string,
): Row[] {
  const cmp = (a: Row, b: Row): number => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i++) {
      const c = compareAsc(ka[i] ?? null, kb[i] ?? null);
      if (c !== 0) return direction === 'desc' ? -c : c;
    }
    return 0;
  };

  const spill = new Map<number, Row[]>();
  let cursor = io.base;
  const nextId = () => cursor++;
  const fanIn = fanInFor(io.memPages);
  const chunk = io.memPages * io.rowsPerPage;

  io.emit(
    `${subject} has to see every row before it can produce one — the one operator here that cannot stream. ${plural(rows.length, 'row')} to sort, ${plural(io.memPages, 'page')} of memory at a time.`,
    { stage: 'execute', op, rowsProduced: 0, ...(table === undefined ? {} : { table }) },
  );

  let runs: Run[] = [];
  let runId = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const sorted = [...rows.slice(i, i + chunk)].sort(cmp);
    runs.push(writeRun(io, spill, nextId, runId++, sorted));
  }
  if (runs.length === 0) runs.push(writeRun(io, spill, nextId, runId++, []));

  const pagesWritten = runs.reduce((n, r) => n + r.pages.length, 0);
  io.emit(
    `Run generation: ${plural(runs.length, 'sorted run')} written, ${plural(pagesWritten, 'page')} total.`,
    { stage: 'execute', op, rowsProduced: 0, ...(table === undefined ? {} : { table }) },
  );

  let passIndex = 1;
  while (runs.length > 1) {
    const next: Run[] = [];
    for (let g = 0; g < runs.length; g += fanIn) {
      const merged = mergeRuns(runs.slice(g, g + fanIn), spill, io, cmp);
      next.push(writeRun(io, spill, nextId, runId++, merged));
    }
    io.emit(
      `Merge pass ${String(passIndex)}: ${plural(runs.length, 'run')} become ${plural(next.length, 'run')}.`,
      { stage: 'execute', op, rowsProduced: 0, ...(table === undefined ? {} : { table }) },
    );
    runs = next;
    passIndex += 1;
  }

  return runs[0]!.pages.flatMap((pid) => readPage(io, spill, pid));
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
