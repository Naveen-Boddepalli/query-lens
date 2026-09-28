import { describe, expect, it } from 'vitest';
import { analyzeTable, statsToRows } from '../stats.ts';
import type { Row, Table } from '../types.ts';

/**
 * `ANALYZE` (plan.md §25.4 C1) — a real scan of a real table, shaped after PostgreSQL's own `pg_stats`: distinct
 * count, null fraction, most-common values, an equi-depth histogram, and physical/logical correlation.
 */

function tableOf(rows: Row[], columns: string[] = Object.keys(rows[0] ?? {})): Table {
  return { name: 't', columns, rows };
}

describe('nDistinct and nullFraction', () => {
  it('counts distinct non-NULL values, and NULL separately', () => {
    const rows: Row[] = [{ a: 1 }, { a: 1 }, { a: 2 }, { a: null }, { a: 3 }];
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.nDistinct).toBe(3);
    expect(stats.columns.a!.nullFraction).toBeCloseTo(0.2);
  });

  it('an all-NULL column has zero distinct values and a null fraction of 1', () => {
    const rows: Row[] = [{ a: null }, { a: null }];
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.nDistinct).toBe(0);
    expect(stats.columns.a!.nullFraction).toBe(1);
  });

  it('an empty table has zero distinct values and a null fraction of 0, not NaN', () => {
    const stats = analyzeTable(tableOf([], ['a']));
    expect(stats.columns.a!.nDistinct).toBe(0);
    expect(stats.columns.a!.nullFraction).toBe(0);
  });
});

describe('mostCommonValues', () => {
  it('lists repeated values, most frequent first, with their real counts', () => {
    const rows: Row[] = [
      { team: 'a' }, { team: 'a' }, { team: 'a' },
      { team: 'b' }, { team: 'b' },
      { team: 'c' },
    ];
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.team!.mostCommonValues).toEqual([
      { value: 'a', frequency: 3 },
      { value: 'b', frequency: 2 },
    ]);
  });

  it('a key column (every value distinct) has no most-common values at all', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.id!.mostCommonValues).toEqual([]);
  });

  it('caps at 5, breaking ties by value for a deterministic order', () => {
    const rows: Row[] = [];
    for (let v = 1; v <= 8; v++) rows.push({ a: v }, { a: v }); // 8 distinct values, each repeated once
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.mostCommonValues).toHaveLength(5);
    expect(stats.columns.a!.mostCommonValues.map((m) => m.value)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('histogramBounds', () => {
  it('is empty below the row-count floor — a histogram over a handful of rows is noise', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ a: i }));
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.histogramBounds).toEqual([]);
  });

  it('buckets the non-most-common values into 10 equal-depth buckets, sorted, spanning the real range', () => {
    const rows: Row[] = Array.from({ length: 100 }, (_, i) => ({ a: i })); // all distinct: nothing in mostCommonValues
    const stats = analyzeTable(tableOf(rows));
    const bounds = stats.columns.a!.histogramBounds;
    expect(bounds).toHaveLength(11); // 10 buckets, 11 boundaries
    expect(bounds[0]).toBe(0);
    expect(bounds[bounds.length - 1]).toBe(99);
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]! as number).toBeGreaterThanOrEqual(bounds[i - 1]! as number);
  });

  it('excludes rows already accounted for by mostCommonValues, so a heavily skewed column still buckets the rest', () => {
    const rows: Row[] = [
      ...Array.from({ length: 60 }, () => ({ a: 0 })), // one value, way more common than anything else
      ...Array.from({ length: 40 }, (_, i) => ({ a: i + 1 })), // 40 distinct values, each unique
    ];
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.mostCommonValues).toEqual([{ value: 0, frequency: 60 }]);
    const bounds = stats.columns.a!.histogramBounds;
    // Every bound comes from the 40 non-zero rows, never the value the MCV entry already covers.
    expect(bounds.every((b) => (b as number) >= 1)).toBe(true);
  });
});

describe('correlation', () => {
  it('is (close to) 1 when the column is already in ascending physical order', () => {
    const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({ a: i }));
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.correlation).toBeCloseTo(1, 5);
  });

  it('is (close to) -1 when the column is in descending physical order', () => {
    const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({ a: 49 - i }));
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.correlation).toBeCloseTo(-1, 5);
  });

  it('is 0 for a column with no variation to correlate (every row the same value)', () => {
    const rows: Row[] = Array.from({ length: 20 }, () => ({ a: 7 }));
    const stats = analyzeTable(tableOf(rows));
    expect(stats.columns.a!.correlation).toBe(0);
  });

  it('is near 0 for values scattered with no relation to row order', () => {
    // A fixed, deliberately scrambled permutation — not random, so the test is not flaky.
    const order = [17, 3, 42, 8, 29, 1, 35, 12, 46, 5, 23, 39, 14, 31, 7, 48, 20, 2, 44, 10, 27, 37, 15, 33, 6, 41, 19, 4, 30, 24];
    const rows: Row[] = order.map((a) => ({ a }));
    const stats = analyzeTable(tableOf(rows));
    expect(Math.abs(stats.columns.a!.correlation)).toBeLessThan(0.3);
  });
});

describe('statsToRows', () => {
  it('is one readable row per column, with the histogram given as a bucket count', () => {
    const rows: Row[] = [{ a: 1, b: 'x' }, { a: 1, b: 'y' }, { a: 2, b: null }];
    const stats = analyzeTable(tableOf(rows));
    const out = statsToRows(stats);
    expect(out.map((r) => r.column)).toEqual(['a', 'b']);
    const a = out.find((r) => r.column === 'a')!;
    expect(a.n_distinct).toBe(2);
    expect(a.most_common).toBe('1 (2)');
    expect(a.histogram_buckets).toBe(0); // too few rows for a histogram
    const b = out.find((r) => r.column === 'b')!;
    expect(b.null_frac).toBeCloseTo(1 / 3);
    expect(b.most_common).toBeNull();
  });
});
