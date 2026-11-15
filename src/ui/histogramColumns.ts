import { DATASETS } from '../engine/datasets.ts';
import { bucketSweep, rangeEstimate } from '../engine/histogramStudy.ts';
import type { RangeEstimate } from '../engine/histogramStudy.ts';
import { MAX_HISTOGRAM_BUCKETS } from '../engine/parser/parser.ts';
import { DEFAULT_HISTOGRAM_BUCKETS } from '../engine/stats.ts';
import type { Row, Table } from '../engine/types.ts';

/**
 * plan.md §27.5 T5: the histogram tool's columns, its limits, and its one call into the engine. Three columns of
 * 3,000 numbers: the `transactions` preset's own `amount`, and two made here to have a shape a histogram has to work
 * for — skewed, and in clusters. Each is a one-column table the engine's own `ANALYZE` and range estimate run on.
 */

export type HistogramColumnId = 'amount' | 'skewed' | 'clustered';

export interface HistogramColumn {
  id: HistogramColumnId;
  label: string;
  /** What the values are, in a sentence. */
  about: string;
  /** A range worth trying first. */
  range: { low: number; high: number };
}

export const HISTOGRAM_COLUMNS: readonly HistogramColumn[] = [
  {
    id: 'amount',
    label: 'transactions.amount',
    about: 'The transactions preset’s own amounts, 10 to 4,999: spread almost evenly, so every bucket covers about the same width.',
    range: { low: 100, high: 400 },
  },
  {
    id: 'skewed',
    label: 'skewed',
    about: 'Made here: most values small, a long thin tail up to 5,000 — a column of payment sizes, say. The commonest small values go into the most-common list; the rest are bucketed.',
    range: { low: 20, high: 60 },
  },
  {
    id: 'clustered',
    label: 'clustered',
    about: 'Made here: three dense bands — 100 to 199, 2,400 to 2,499, 4,800 to 4,899 — and a hundred values scattered across the gaps between them.',
    range: { low: 500, high: 2000 },
  },
];

/** The bucket counts the sweep tries, and the menu offers. */
export const BUCKET_COUNTS = [1, 2, 5, 10, 20, 50, 100] as const;
export const HISTOGRAM_LIMITS = { minBuckets: 1, maxBuckets: MAX_HISTOGRAM_BUCKETS, minValue: 0, maxValue: 5000 } as const;
export const DEFAULT_BUCKETS = DEFAULT_HISTOGRAM_BUCKETS;

const COUNT = 3000;

function valuesOf(id: HistogramColumnId): number[] {
  if (id === 'amount') {
    return (DATASETS.transactions.make().tables.transactions?.rows ?? []).map((row) => row.amount as number);
  }
  if (id === 'skewed') return Array.from({ length: COUNT }, (_, i) => Math.round(10 + 4990 * ((i + 0.5) / COUNT) ** 3));
  return Array.from({ length: COUNT }, (_, i) =>
    i < 1000 ? 100 + ((i * 37) % 100) : i < 2000 ? 2400 + ((i * 37) % 100) : i < 2900 ? 4800 + ((i * 37) % 100) : 10 + ((i * 53) % 4990),
  );
}

const tables = new Map<HistogramColumnId, Table>();

/** The column as a one-column table, `v`, built once. */
export function histogramTable(id: HistogramColumnId): Table {
  let table = tables.get(id);
  if (!table) {
    table = { name: id, columns: ['v'], rows: valuesOf(id).map((v): Row => ({ v })) };
    tables.set(id, table);
  }
  return table;
}

/** `ANALYZE … WITH buckets BUCKETS`, then the estimate of `v BETWEEN low AND high` and how far off it is. */
export function estimateAt(id: HistogramColumnId, low: number, high: number, buckets: number): RangeEstimate {
  return rangeEstimate(histogramTable(id), 'v', low, high, buckets);
}

/** The same range at every bucket count on the menu. */
export function sweepOf(id: HistogramColumnId, low: number, high: number): RangeEstimate[] {
  return bucketSweep(histogramTable(id), 'v', low, high, BUCKET_COUNTS);
}

export const isColumnId = (raw: string | null): raw is HistogramColumnId =>
  raw === 'amount' || raw === 'skewed' || raw === 'clustered';
