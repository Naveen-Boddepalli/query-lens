import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bestEncodingFor,
  COLUMNAR_LIMITS,
  demoColumns,
  encodingSize,
  ENCODINGS,
  planColumn,
  planLayout,
  planMaterialization,
  VALUE_BYTE_WIDTH,
} from '../columnar.ts';

describe('demoColumns', () => {
  it('is deterministic for a seed and varies across seeds', () => {
    expect(demoColumns(100, 5)).toEqual(demoColumns(100, 5));
    expect(demoColumns(100, 5)).not.toEqual(demoColumns(100, 6));
  });

  it('produces exactly the four named demo columns, each with `rowCount` values', () => {
    const columns = demoColumns(200, 1);
    expect(columns.map((c) => c.name)).toEqual(['id', 'status_grouped', 'status_shuffled', 'amount']);
    for (const c of columns) expect(c.values).toHaveLength(200);
  });

  it('status_grouped and status_shuffled hold the SAME multiset of values, only reordered', () => {
    const columns = demoColumns(200, 1);
    const grouped = columns.find((c) => c.name === 'status_grouped')!;
    const shuffled = columns.find((c) => c.name === 'status_shuffled')!;
    expect([...grouped.values].sort()).toEqual([...shuffled.values].sort());
  });
});

describe('encodingSize — each demo column has a real, computed sweet spot', () => {
  it('id (sorted ascending, unique) compresses best with delta, far below raw', () => {
    const [id] = demoColumns(300, 2);
    expect(bestEncodingFor(id!.values)).toBe('delta');
    const raw = encodingSize(id!.values, 'none');
    const delta = encodingSize(id!.values, 'delta');
    expect(delta).toBeLessThan(raw / 4); // every delta is 1 — this should be a dramatic win, not a marginal one
  });

  it('status_grouped (real runs) compresses best with RLE', () => {
    const columns = demoColumns(300, 2);
    const grouped = columns.find((c) => c.name === 'status_grouped')!;
    expect(bestEncodingFor(grouped.values)).toBe('rle');
  });

  it('status_shuffled (same values, no runs left) loses RLE its advantage — RLE costs more than doing nothing', () => {
    const columns = demoColumns(300, 2);
    const shuffled = columns.find((c) => c.name === 'status_shuffled')!;
    const raw = encodingSize(shuffled.values, 'none');
    const rle = encodingSize(shuffled.values, 'rle');
    expect(rle).toBeGreaterThan(raw); // the direct, measured contrast with status_grouped
    expect(bestEncodingFor(shuffled.values)).not.toBe('rle');
  });

  it('amount (near-full-int32 range) is the honest case where nothing compresses it well', () => {
    const columns = demoColumns(300, 2);
    const amount = columns.find((c) => c.name === 'amount')!;
    const raw = encodingSize(amount.values, 'none');
    const best = encodingSize(amount.values, bestEncodingFor(amount.values));
    expect(best).toBeGreaterThan(raw * 0.9); // at most a marginal saving — never a dramatic win like id's or status_grouped's
  });

  it('bestEncodingFor always returns the scheme with the genuinely smallest computed size', () => {
    const columns = demoColumns(150, 7);
    for (const c of columns) {
      const sizes = ENCODINGS.map((e) => encodingSize(c.values, e));
      const minSize = Math.min(...sizes);
      expect(encodingSize(c.values, bestEncodingFor(c.values))).toBe(minSize);
    }
  });

  it('a constant column (every value identical) bit-packs to the theoretical minimum — 1 bit per value', () => {
    const values = Array.from({ length: 100 }, () => 42);
    expect(encodingSize(values, 'bitpack')).toBe(Math.ceil(100 / 8)); // 1 bit × 100 values
  });

  it("a column with real runs costs exactly `runs × (value + run-length)` bytes under RLE", () => {
    const values = [1, 1, 1, 2, 2, 3, 3, 3, 3];
    expect(encodingSize(values, 'rle')).toBe(3 * (VALUE_BYTE_WIDTH + 2)); // three runs: [1,1,1], [2,2], [3,3,3,3]
  });
});

describe('planColumn', () => {
  it('reports a compression ratio consistent with raw ÷ compressed', () => {
    const [id] = demoColumns(200, 1);
    const plan = planColumn(id!, 'delta');
    expect(plan.compressionRatio).toBeCloseTo(plan.rawBytes / plan.compressedBytes, 5);
  });
});

describe('planLayout — structural invariants', () => {
  it('NSM can never skip a column within a page — every column costs exactly the full-scan page count', () => {
    const columns = demoColumns(400, 3);
    const plan = planLayout('NSM', columns, 256);
    for (const c of columns) expect(plan.pagesForSingleColumnScan[c.name]).toBe(plan.pagesForFullScan);
  });

  it("DSM's own per-column page counts sum exactly to its full-scan total — each column is its own separate region", () => {
    const columns = demoColumns(400, 3);
    const plan = planLayout('DSM', columns, 256);
    const sum = Object.values(plan.pagesForSingleColumnScan).reduce((a, b) => a + b, 0);
    expect(sum).toBe(plan.pagesForFullScan);
  });

  it('DSM and PAX read far fewer pages than NSM for a single column, at a group size that gives PAX room to skip', () => {
    const columns = demoColumns(1000, 4);
    const pageSize = 256; // rowsPerGroup = max(16, 256/4) = 64 — comfortably larger than this test needs
    const nsm = planLayout('NSM', columns, pageSize);
    const dsm = planLayout('DSM', columns, pageSize);
    const pax = planLayout('PAX', columns, pageSize);
    for (const c of columns) {
      expect(dsm.pagesForSingleColumnScan[c.name]).toBeLessThan(nsm.pagesForFullScan);
      expect(pax.pagesForSingleColumnScan[c.name]).toBeLessThan(nsm.pagesForFullScan);
    }
  });

  it('PAX reconstructs a whole row from one nearby region, same as NSM — DSM needs one region per column', () => {
    const columns = demoColumns(400, 3);
    expect(planLayout('NSM', columns, 256).regionsToReconstructOneRow).toBe(1);
    expect(planLayout('PAX', columns, 256).regionsToReconstructOneRow).toBe(1);
    expect(planLayout('DSM', columns, 256).regionsToReconstructOneRow).toBe(columns.length);
  });

  it('never crashes and keeps every real invariant, for any legal row count and page size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: COLUMNAR_LIMITS.minRows, max: COLUMNAR_LIMITS.maxRows }),
        fc.integer({ min: COLUMNAR_LIMITS.minPageSize, max: COLUMNAR_LIMITS.maxPageSize }),
        fc.integer({ min: 0, max: 9999 }),
        (rowCount, pageSize, seed) => {
          const columns = demoColumns(rowCount, seed);
          const nsm = planLayout('NSM', columns, pageSize);
          const dsm = planLayout('DSM', columns, pageSize);
          const pax = planLayout('PAX', columns, pageSize);

          for (const c of columns) expect(nsm.pagesForSingleColumnScan[c.name]).toBe(nsm.pagesForFullScan);
          const dsmSum = Object.values(dsm.pagesForSingleColumnScan).reduce((a, b) => a + b, 0);
          expect(dsmSum).toBe(dsm.pagesForFullScan);
          for (const c of columns) {
            expect(dsm.pagesForSingleColumnScan[c.name]).toBeLessThanOrEqual(nsm.pagesForFullScan);
            expect(pax.pagesForSingleColumnScan[c.name]).toBeLessThanOrEqual(pax.pagesForFullScan);
            expect(pax.pagesForSingleColumnScan[c.name]).toBeLessThanOrEqual(nsm.pagesForFullScan);
          }
        },
      ),
    );
  });
});

describe('planMaterialization', () => {
  it('late materialization never touches more bytes than early materialization', () => {
    const columns = demoColumns(500, 1);
    const mat = planMaterialization(columns, 'amount', 2 ** 31 * 0.9, 'id');
    expect(mat.lateBytesTouched).toBeLessThan(mat.earlyBytesTouched);
    expect(mat.matchingRows).toBeGreaterThan(0);
    expect(mat.matchingRows).toBeLessThan(500); // a real, partial match — not vacuously everything or nothing
  });

  it('a threshold below every value matches every row; one above every value matches none', () => {
    const columns = demoColumns(200, 2);
    const allMatch = planMaterialization(columns, 'id', -1, 'amount');
    expect(allMatch.matchingRows).toBe(200);
    const noneMatch = planMaterialization(columns, 'id', 999_999, 'amount');
    expect(noneMatch.matchingRows).toBe(0);
  });

  it('filtering and projecting the same column never double-counts its own bytes', () => {
    const columns = demoColumns(200, 2);
    const mat = planMaterialization(columns, 'id', 100, 'id');
    expect(mat.lateBytesTouched).toBe(200 * VALUE_BYTE_WIDTH); // just the one column's own full read
  });

  it('never crashes, and late materialization never exceeds early, for any legal parameters', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: COLUMNAR_LIMITS.minRows, max: COLUMNAR_LIMITS.maxRows }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: 0, max: 2 ** 31 }),
        (rowCount, seed, threshold) => {
          const columns = demoColumns(rowCount, seed);
          const mat = planMaterialization(columns, 'amount', threshold, 'id');
          expect(mat.lateBytesTouched).toBeLessThanOrEqual(mat.earlyBytesTouched);
          expect(mat.matchingRows).toBeGreaterThanOrEqual(0);
          expect(mat.matchingRows).toBeLessThanOrEqual(rowCount);
        },
      ),
    );
  });
});
