import { describe, expect, it } from 'vitest';
import { createBufferPool } from '../storage/bufferPool.ts';
import { createTracer } from '../trace.ts';
import { externalMergeSort, sortPassCount, sortTempPageCount } from '../exec/sort.ts';
import type { SortIO } from '../exec/sort.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Row, StepEvent } from '../types.ts';

describe('sortPassCount', () => {
  it('is 1 — generation only — when everything fits in one run', () => {
    expect(sortPassCount(4, 8)).toBe(1);
    expect(sortPassCount(8, 8)).toBe(1);
  });

  it('grows as the data outgrows memory, and never shrinks with more pages', () => {
    let last = sortPassCount(1, 8);
    for (const pages of [1, 8, 20, 100, 1000]) {
      const passes = sortPassCount(pages, 8);
      expect(passes, String(pages)).toBeGreaterThanOrEqual(last);
      last = passes;
    }
  });

  it('a larger memory budget never needs more passes for the same data', () => {
    for (const pages of [20, 100, 1000]) {
      expect(sortPassCount(pages, 16)).toBeLessThanOrEqual(sortPassCount(pages, 8));
    }
  });

  it('is deterministic', () => {
    expect(sortPassCount(30, 8)).toBe(sortPassCount(30, 8));
  });
});

describe('sortTempPageCount', () => {
  it('is at least the perfectly-packed page count times the pass count', () => {
    for (const [rows, rpp, mem] of [
      [48, 4, 8],
      [120, 4, 8],
      [80, 4, 8],
      [1, 4, 8],
    ] as const) {
      const pageCount = Math.max(1, Math.ceil(rows / rpp));
      const passes = sortPassCount(pageCount, mem);
      expect(sortTempPageCount(rows, rpp, mem)).toBeGreaterThanOrEqual(pageCount * passes);
    }
  });

  it('is always at least one page, even for an empty table', () => {
    expect(sortTempPageCount(0, 4, 8)).toBeGreaterThanOrEqual(1);
  });
});

interface KeyedRow extends Row {
  id: number;
  key: number | string | null;
}

const row = (id: number, key: number | string | null): KeyedRow => ({ id, key });

/** A real buffer pool sized exactly to the reservation `externalMergeSort` needs. */
function makeIO(rowCount: number, rowsPerPage: number, memPages: number): { io: SortIO; drain: () => StepEvent[] } {
  const { emit, drain } = createTracer();
  const pageCount = sortTempPageCount(rowCount, rowsPerPage, memPages);
  const pool = createBufferPool(pageCount, { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: memPages }, emit);
  return { io: { pool, emit, base: 0, memPages, rowsPerPage }, drain };
}

describe('externalMergeSort', () => {
  it('sorts ascending by the given key', () => {
    const rows = [row(1, 5), row(2, 1), row(3, 3), row(4, 2), row(5, 4)];
    const { io } = makeIO(rows.length, 2, 4);
    const sorted = externalMergeSort(rows, (r) => r.key ?? null, 'asc', io);
    expect(sorted.map((r) => r.key ?? null)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts descending', () => {
    const rows = [row(1, 5), row(2, 1), row(3, 3), row(4, 2), row(5, 4)];
    const { io } = makeIO(rows.length, 2, 4);
    const sorted = externalMergeSort(rows, (r) => r.key ?? null, 'desc', io);
    expect(sorted.map((r) => r.key ?? null)).toEqual([5, 4, 3, 2, 1]);
  });

  it('preserves every row exactly once — sorting reorders, it does not drop or duplicate', () => {
    const rows = Array.from({ length: 23 }, (_, i) => row(i, (i * 7) % 13));
    const { io } = makeIO(rows.length, 3, 4);
    const sorted = externalMergeSort(rows, (r) => r.key ?? null, 'asc', io);
    const ids = (list: readonly Row[]) => list.map((r) => Number(r.id ?? -1)).sort((a, b) => a - b);
    expect(ids(sorted)).toEqual(ids(rows));
  });

  it('handles an empty input', () => {
    const { io } = makeIO(0, 4, 8);
    expect(externalMergeSort([], (r) => r.key ?? null, 'asc', io)).toEqual([]);
  });

  it('handles a single row', () => {
    const { io } = makeIO(1, 4, 8);
    expect(externalMergeSort([row(1, 9)], (r) => r.key ?? null, 'asc', io)).toEqual([row(1, 9)]);
  });

  it('spills across multiple runs and multiple merge passes when memory is tight', () => {
    // memPages=2 → fan-in 2, rowsPerPage=1 → one record per page: 20 rows
    // need 20 initial runs, so more than one merge pass is unavoidable.
    const rows = Array.from({ length: 20 }, (_, i) => row(i, 20 - i));
    const { io, drain } = makeIO(rows.length, 1, 2);
    const sorted = externalMergeSort(rows, (r) => r.key ?? null, 'asc', io);
    expect(sorted.map((r) => r.key ?? null)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const passCount = sortPassCount(20, 2);
    expect(passCount).toBeGreaterThan(2); // confirms this case actually exercises multiple merges

    const writes = drain().filter((e) => e.stage === 'buffer' && e.action === 'write');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('sorts NULLs last ascending, first descending — Postgres’s own default', () => {
    const rows = [row(1, 3), row(2, null), row(3, 1), row(4, null), row(5, 2)];
    const { io: ascIO } = makeIO(rows.length, 2, 4);
    const asc = externalMergeSort(rows, (r) => r.key ?? null, 'asc', ascIO);
    expect(asc.map((r) => r.key ?? null)).toEqual([1, 2, 3, null, null]);

    const { io: descIO } = makeIO(rows.length, 2, 4);
    const desc = externalMergeSort(rows, (r) => r.key ?? null, 'desc', descIO);
    expect(desc.map((r) => r.key ?? null)).toEqual([null, null, 3, 2, 1]);
  });

  it('compares numbers numerically and strings lexicographically', () => {
    const numeric = [row(1, 10), row(2, 2), row(3, 1)];
    const { io: numIO } = makeIO(numeric.length, 2, 4);
    expect(externalMergeSort(numeric, (r) => r.key ?? null, 'asc', numIO).map((r) => r.key ?? null)).toEqual([1, 2, 10]);

    const strings = [row(1, 'banana'), row(2, 'apple'), row(3, 'cherry')];
    const { io: strIO } = makeIO(strings.length, 2, 4);
    expect(externalMergeSort(strings, (r) => r.key ?? null, 'asc', strIO).map((r) => r.key ?? null)).toEqual([
      'apple',
      'banana',
      'cherry',
    ]);
  });

  it('never writes the same page id twice — every spill page is fresh', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, 20 - i));
    const { io, drain } = makeIO(rows.length, 1, 2);
    externalMergeSort(rows, (r) => r.key ?? null, 'asc', io);
    const writePageIds = drain()
      .filter((e) => e.stage === 'buffer' && e.action === 'write')
      .map((e) => (e.stage === 'buffer' && e.action === 'write' ? e.pageId : -1));
    expect(new Set(writePageIds).size).toBe(writePageIds.length);
  });

  it('is stable across a real multi-run merge: equal keys keep their relative input order', () => {
    // rowsPerPage=1, memPages=1 forces one row per run — every tie below is
    // resolved by the merge itself, not by a single in-memory sort.
    const rows = [row(1, 1), row(2, 1), row(3, 1), row(4, 1)];
    const { io } = makeIO(rows.length, 1, 1);
    const sorted = externalMergeSort(rows, (r) => r.key ?? null, 'asc', io);
    expect(sorted.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});
