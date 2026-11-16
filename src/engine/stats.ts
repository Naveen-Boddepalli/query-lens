/**
 * `ANALYZE` (plan.md §25.4 C1) — a real scan of a real table, producing the statistics a query planner actually
 * reads instead of assuming every value in a column is equally likely and every column independent of every
 * other. Shaped after PostgreSQL's own `pg_stats`: distinct count, null fraction, most-common values (with their
 * real frequencies), an equi-depth histogram over what is left, and the column's physical/logical correlation.
 *
 * Pure and synchronous, on the same rules as the rest of `src/engine`. A full scan, not a sample — a real
 * `ANALYZE` samples a fraction of the table for speed and lives with the noise that introduces; a toy table is
 * small enough to just look at every row, so this engine's statistics are as accurate as a scan gets. What they
 * are *not* is fresh forever: `Table.stats` is a snapshot of one `ANALYZE` run, and stays exactly that — even
 * once wrong — until `ANALYZE` runs again (plan.md §25.4 C2 is where that staleness is made to matter).
 */

import type { ColumnStats, Row, SqlValue, Table, TableStats } from './types.ts';
import { compareValues } from './value.ts';

/** How many of a column's most frequent values get their own entry, PostgreSQL's own default. */
const MOST_COMMON_LIMIT = 5;
/**
 * Buckets in the equi-depth histogram over whatever `mostCommonValues` does not already cover, unless `ANALYZE … WITH
 * n BUCKETS` asks for another number (plan.md §27.5 T5). PostgreSQL's default statistics target is 100.
 */
export const DEFAULT_HISTOGRAM_BUCKETS = 10;
/** Below this many non-MCV rows, a histogram is noise, not signal — left empty instead. */
const MIN_ROWS_FOR_HISTOGRAM = 20;

/** `sorted`'s `buckets`-quantile boundaries: `n + 1` values bounding `n` roughly-equal-depth buckets. */
function equiDepthBounds(sorted: readonly SqlValue[], buckets: number): SqlValue[] {
  const n = Math.max(1, Math.min(buckets, sorted.length - 1));
  const bounds: SqlValue[] = [];
  for (let i = 0; i <= n; i++) {
    const at = Math.round((i * (sorted.length - 1)) / n);
    bounds.push(sorted[at]!);
  }
  return bounds;
}

/** Pearson correlation between two equal-length number series — 0 when either has no variation to correlate. */
function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  return denX === 0 || denY === 0 ? 0 : num / Math.sqrt(denX * denY);
}

/**
 * How much `values`' order tracks physical row order: each value's *rank* among all of them (tied values share
 * the average of their positions, same as Spearman's), correlated against its row index. `compareValues`'s
 * NULL-first order decides ties among NULLs the same way it decides everything else here — there is no second
 * rule for them.
 */
function correlationOf(values: readonly SqlValue[]): number {
  const n = values.length;
  if (n < 2) return 0;

  const byValue = values.map((_, i) => i).sort((a, b) => compareValues(values[a]!, values[b]!));
  const rank = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && compareValues(values[byValue[j + 1]!]!, values[byValue[i]!]!) === 0) j += 1;
    const averageRank = (i + j) / 2;
    for (let k = i; k <= j; k++) rank[byValue[k]!] = averageRank;
    i = j + 1;
  }

  const physicalIndex = Array.from({ length: n }, (_, i) => i);
  return pearson(physicalIndex, rank);
}

function analyzeColumn(rows: readonly Row[], column: string, buckets: number): ColumnStats {
  const values = rows.map((row) => row[column] ?? null);
  const nonNull = values.filter((v) => v !== null);
  const nullFraction = values.length === 0 ? 0 : (values.length - nonNull.length) / values.length;

  const counts = new Map<SqlValue, number>();
  for (const v of nonNull) counts.set(v, (counts.get(v) ?? 0) + 1);

  // "Most common" means it actually repeats — a column of all-distinct values (a key) has none, honestly.
  const byFrequency = [...counts.entries()]
    .filter(([, frequency]) => frequency > 1)
    .sort((a, b) => b[1] - a[1] || compareValues(a[0], b[0]));
  const mostCommonValues = byFrequency.slice(0, MOST_COMMON_LIMIT).map(([value, frequency]) => ({ value, frequency }));
  const covered = new Set(mostCommonValues.map((m) => m.value));

  const remaining = nonNull.filter((v) => !covered.has(v)).sort(compareValues);
  const histogramBounds = remaining.length < MIN_ROWS_FOR_HISTOGRAM ? [] : equiDepthBounds(remaining, buckets);

  return {
    nDistinct: counts.size,
    nullFraction,
    mostCommonValues,
    histogramBounds,
    correlation: correlationOf(values),
  };
}

/** The table's statistics, as of right now — what `ANALYZE <table> [WITH n BUCKETS]` computes. */
export function analyzeTable(table: Table, buckets: number = DEFAULT_HISTOGRAM_BUCKETS): TableStats {
  const columns: Record<string, ColumnStats> = {};
  for (const column of table.columns) columns[column] = analyzeColumn(table.rows, column, buckets);
  return { rowCount: table.rows.length, columns };
}

function describeValue(value: SqlValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** `ANALYZE`'s own result, one row per column — what the Playground's result table (and the CLI) already know
 *  how to render, so a learner opens the statistics the same way they open any other query's answer. */
export function statsToRows(stats: TableStats): Row[] {
  return Object.entries(stats.columns).map(([column, s]) => ({
    column,
    n_distinct: s.nDistinct,
    null_frac: Math.round(s.nullFraction * 1000) / 1000,
    most_common: s.mostCommonValues.length === 0 ? null : s.mostCommonValues.map((m) => `${describeValue(m.value)} (${String(m.frequency)})`).join(', '),
    histogram_buckets: Math.max(0, s.histogramBounds.length - 1),
    correlation: Math.round(s.correlation * 1000) / 1000,
  }));
}
