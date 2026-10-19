/**
 * What a histogram's bucket count buys a range estimate (plan.md §27.5 T5). For one numeric column and one range,
 * `ANALYZE … WITH n BUCKETS` for each `n` asked, and the planner's own range estimate read off each — the same
 * `boundedRangeSelectivity` a `WHERE c BETWEEN low AND high` gets — against the rows really in the range. The gap is
 * the **q-error**, `EXPLAIN ANALYZE`'s own measure: how many times too high or too low.
 */

import { qError } from './explain.ts';
import { boundedRangeSelectivity } from './planner/cost.ts';
import { analyzeTable } from './stats.ts';
import type { SqlValue, Table } from './types.ts';

export interface RangeEstimate {
  /** The bucket count asked for. */
  buckets: number;
  /** The histogram it built: `n + 1` boundaries, fewer buckets when the column has fewer values to split. */
  bounds: SqlValue[];
  /** Rows the most-common list accounts for, with their real counts: the histogram's buckets share the rest. */
  commonRows: number;
  /** Rows the planner estimates for `low ≤ column ≤ high`, rounded as `EXPLAIN` rounds them. */
  estimate: number;
  /** Rows really in the range. */
  actual: number;
  qError: number;
  /** The planner's own words for how it got the estimate. */
  basis: string;
}

/** The rows of `table` whose `column` lies in `[low, high]` (either bound `null`: open on that side). */
export function rowsInRange(table: Table, column: string, low: number | null, high: number | null): number {
  return table.rows.filter((row) => {
    const v = row[column];
    return typeof v === 'number' && (low === null || v >= low) && (high === null || v <= high);
  }).length;
}

/** The range estimate after `ANALYZE … WITH buckets BUCKETS`, and how far off it is. */
export function rangeEstimate(table: Table, column: string, low: number | null, high: number | null, buckets: number): RangeEstimate {
  const stats = analyzeTable(table, buckets);
  const selectivity = boundedRangeSelectivity(column, low, high, { ...table, stats });
  const estimate = Math.round(selectivity.fraction * table.rows.length);
  const actual = rowsInRange(table, column, low, high);
  return {
    buckets,
    bounds: stats.columns[column]?.histogramBounds ?? [],
    commonRows: (stats.columns[column]?.mostCommonValues ?? []).reduce((sum, m) => sum + m.frequency, 0),
    estimate,
    actual,
    qError: qError(estimate, actual),
    basis: selectivity.basis,
  };
}

/** The same range at each bucket count, in the order given. */
export function bucketSweep(
  table: Table,
  column: string,
  low: number | null,
  high: number | null,
  counts: readonly number[],
): RangeEstimate[] {
  return counts.map((buckets) => rangeEstimate(table, column, low, high, buckets));
}
