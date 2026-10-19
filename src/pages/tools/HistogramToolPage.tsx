import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataView } from '../../ui/DataView.tsx';
import {
  DEFAULT_BUCKETS,
  estimateAt,
  HISTOGRAM_COLUMNS,
  HISTOGRAM_LIMITS,
  histogramTable,
  isColumnId,
  sweepOf,
} from '../../ui/histogramColumns.ts';
import type { HistogramColumnId } from '../../ui/histogramColumns.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import { encodeShareState } from '../../ui/urlState.ts';

/**
 * The histogram standalone (plan.md §27.5 T5): `ANALYZE` with a chosen bucket count, and what it does to one range
 * estimate. The engine's own `ANALYZE` builds the equi-depth histogram and the planner's own range estimate reads it
 * (`engine/histogramStudy.ts`); this page draws the buckets, the range, and the q-error at every bucket count.
 *
 * URL state: `c` (column), `b` (buckets), `lo` and `hi` (the range), parsed defensively.
 */

const W = 640;
const H = 150;
const fmt = (n: number) => n.toLocaleString('en-US');

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const raw = p.get('c');
  const column: HistogramColumnId = isColumnId(raw) ? raw : 'clustered';
  const preset = HISTOGRAM_COLUMNS.find((c) => c.id === column)!.range;
  const low = clampInt(p.get('lo'), HISTOGRAM_LIMITS.minValue, HISTOGRAM_LIMITS.maxValue, preset.low);
  const high = clampInt(p.get('hi'), HISTOGRAM_LIMITS.minValue, HISTOGRAM_LIMITS.maxValue, preset.high);
  return {
    column,
    buckets: clampInt(p.get('b'), HISTOGRAM_LIMITS.minBuckets, HISTOGRAM_LIMITS.maxBuckets, DEFAULT_BUCKETS),
    low: Math.min(low, high),
    high: Math.max(low, high),
  };
}

const INITIAL = readInitial();

interface BucketRow {
  n: number;
  from: number;
  to: number;
  rows: number;
}

export function HistogramToolPage() {
  const [column, setColumn] = useState<HistogramColumnId>(INITIAL.column);
  const [buckets, setBuckets] = useState(INITIAL.buckets);
  const [low, setLow] = useState(INITIAL.low);
  const [high, setHigh] = useState(INITIAL.high);
  const about = HISTOGRAM_COLUMNS.find((c) => c.id === column)!;

  const now = useMemo(() => estimateAt(column, low, high, buckets), [column, low, high, buckets]);
  const sweep = useMemo(() => sweepOf(column, low, high), [column, low, high]);
  const table = histogramTable(column);

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('c', column);
    p.set('b', String(buckets));
    p.set('lo', String(low));
    p.set('hi', String(high));
    return p.toString();
  }, [column, buckets, low, high]);
  useAddressBarQuery(shareQuery);

  // The buckets as the planner reads them: equal depth, each holding the same share of the rows the most-common list
  // does not already account for.
  const bounds = now.bounds.filter((b): b is number => typeof b === 'number');
  const perBucket = bounds.length > 1 ? (table.rows.length - now.commonRows) / (bounds.length - 1) : 0;
  const bucketRows: BucketRow[] = bounds.slice(0, -1).map((from, i) => ({ n: i + 1, from, to: bounds[i + 1]!, rows: Math.round(perBucket) }));
  const sx = (v: number) => 8 + (v / HISTOGRAM_LIMITS.maxValue) * (W - 16);
  const densities = bucketRows.map((b) => perBucket / Math.max(1, b.to - b.from));
  const top = Math.max(...densities, 1e-9);

  const playground = `/playground?${encodeShareState(
    { sql: `ANALYZE transactions WITH ${String(buckets)} BUCKETS;`, policy: 'lru', predictOn: false, step: 1, dataset: 'transactions' },
    undefined,
  )}`;
  const worst = sweep.reduce((a, b) => (b.qError > a.qError ? b : a));
  const best = sweep.reduce((a, b) => (b.qError < a.qError ? b : a));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Histograms">
        <code className="font-mono text-ink">ANALYZE</code> sorts a column&rsquo;s values and cuts them into buckets that
        each hold the same number of rows — an <em>equi-depth</em> histogram. A range&rsquo;s estimate is then the share of
        each bucket it overlaps, as if the bucket&rsquo;s rows were spread evenly across it. Where the values crowd
        together a bucket is narrow, and where they thin out it is wide; how many buckets there are decides how much of
        the column&rsquo;s shape the planner gets to see.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Column
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Column">
            {HISTOGRAM_COLUMNS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={column === c.id}
                onClick={() => {
                  setColumn(c.id);
                  setLow(c.range.low);
                  setHigh(c.range.high);
                }}
                className={`${segBase} font-mono ${column === c.id ? segOn : segOff}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Buckets
          <input
            type="number"
            min={HISTOGRAM_LIMITS.minBuckets}
            max={HISTOGRAM_LIMITS.maxBuckets}
            value={buckets}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= HISTOGRAM_LIMITS.minBuckets && v <= HISTOGRAM_LIMITS.maxBuckets) setBuckets(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          From
          <input
            type="number"
            min={HISTOGRAM_LIMITS.minValue}
            max={HISTOGRAM_LIMITS.maxValue}
            value={low}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= HISTOGRAM_LIMITS.minValue && v <= high) setLow(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          To
          <input
            type="number"
            min={HISTOGRAM_LIMITS.minValue}
            max={HISTOGRAM_LIMITS.maxValue}
            value={high}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= low && v <= HISTOGRAM_LIMITS.maxValue) setHigh(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
      </div>
      <p className="text-label text-ink-dim">{about.about}</p>

      <div className={`${panelSurface} flex flex-col gap-2 p-4`}>
        <p className="font-mono text-label text-ink">
          ANALYZE {column} WITH {buckets} BUCKETS; SELECT * FROM {column} WHERE v BETWEEN {low} AND {high};
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-label sm:grid-cols-4">
          <div>
            <dt className="text-ink-dim">estimated</dt>
            <dd className="tabular-nums text-body text-ink">{fmt(now.estimate)} rows</dd>
          </div>
          <div>
            <dt className="text-ink-dim">really</dt>
            <dd className="tabular-nums text-body text-ink">{fmt(now.actual)} rows</dd>
          </div>
          <div>
            <dt className="text-ink-dim">q-error</dt>
            <dd className={`tabular-nums text-body ${now.qError >= 2 ? 'text-evict' : 'text-ink'}`}>
              <span role="status">{now.qError.toFixed(2)}×</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-dim">buckets built</dt>
            <dd className="tabular-nums text-body text-ink">{Math.max(0, bounds.length - 1)}</dd>
          </div>
        </dl>
        <p className="text-label text-ink-dim">The planner&rsquo;s own words: {now.basis}.</p>
      </div>

      <DataView
        caption={`The ${String(bucketRows.length)} buckets of ${column}, as the planner reads them`}
        rows={bucketRows}
        keyOf={(r) => String(r.n)}
        columns={[
          { header: 'Bucket', cell: (r) => r.n },
          { header: 'From', cell: (r) => fmt(r.from) },
          { header: 'To', cell: (r) => fmt(r.to) },
          { header: 'Rows (assumed)', cell: (r) => fmt(r.rows) },
        ]}
      >
        <div className={`${panelSurface} p-4`}>
          <svg viewBox={`0 0 ${String(W)} ${String(H + 22)}`} className="h-auto w-full" role="img" aria-label={`${String(bucketRows.length)} buckets over 0 to 5,000, the range ${String(low)} to ${String(high)} shaded`}>
            <rect x={sx(low)} y={0} width={Math.max(1, sx(high) - sx(low))} height={H} className="fill-accent-soft" />
            {bucketRows.map((b, i) => {
              // Log scale: a bucket over a gap can be hundreds of times sparser than one over a cluster.
              const h = Math.max(4, (Math.log10(1 + (99 * densities[i]!) / top) / 2) * (H - 6));
              return (
                <rect
                  key={b.n}
                  x={sx(b.from)}
                  y={H - h}
                  width={Math.max(1, sx(b.to) - sx(b.from))}
                  height={h}
                  className="fill-surface-4 stroke-ink-dim"
                  strokeWidth={0.6}
                />
              );
            })}
            <line x1={sx(low)} x2={sx(low)} y1={0} y2={H} className="stroke-accent" strokeWidth={1.5} />
            <line x1={sx(high)} x2={sx(high)} y1={0} y2={H} className="stroke-accent" strokeWidth={1.5} />
            {[0, 1000, 2000, 3000, 4000, 5000].map((t) => (
              <text key={t} x={sx(t)} y={H + 16} textAnchor={t === 0 ? 'start' : t === 5000 ? 'end' : 'middle'} className="fill-current text-[10px] text-ink-dim">
                {fmt(t)}
              </text>
            ))}
          </svg>
          <p className="mt-1 text-label text-ink-dim">
            Each bar is one bucket, as wide as the values it covers and taller the denser its rows — on a log scale, or a
            bucket over a gap would not show at all. Every bucket holds the same number of rows. The shaded band is the
            range.
          </p>
        </div>
      </DataView>

      <DataView
        caption="The same range at every bucket count"
        rows={sweep}
        keyOf={(r) => String(r.buckets)}
        columns={[
          { header: 'Buckets', cell: (r) => r.buckets },
          { header: 'Estimated', cell: (r) => fmt(r.estimate) },
          { header: 'Really', cell: (r) => fmt(r.actual) },
          { header: 'q-error', cell: (r) => `${r.qError.toFixed(2)}×` },
        ]}
      >
        <div className={`${panelSurface} flex flex-col gap-2 p-4`}>
          <h2 className="text-body font-semibold text-ink">The same range at every bucket count</h2>
          <ul className="flex flex-col gap-1">
            {sweep.map((r) => {
              const width = Math.min(100, (Math.log10(r.qError) / Math.log10(Math.max(worst.qError, 2))) * 100);
              return (
                <li key={r.buckets} className="grid grid-cols-[6.5rem_1fr_7rem] items-center gap-2 text-label">
                  <button
                    type="button"
                    onClick={() => { setBuckets(r.buckets); }}
                    aria-pressed={r.buckets === buckets}
                    className={`whitespace-nowrap rounded-md border px-2 py-0.5 text-left tabular-nums ${r.buckets === buckets ? 'border-accent bg-accent-soft text-ink' : 'border-edge text-ink-dim'}`}
                  >
                    {r.buckets} {r.buckets === 1 ? 'bucket' : 'buckets'}
                  </button>
                  <span className="h-2 rounded-full bg-surface-3" aria-hidden>
                    <span className={`block h-2 rounded-full ${r.qError >= 2 ? 'bg-evict' : 'bg-accent'}`} style={{ width: `${String(Math.max(2, width))}%` }} />
                  </span>
                  <span className="tabular-nums text-ink">
                    {r.qError.toFixed(2)}× <span className="text-ink-dim">({fmt(r.estimate)})</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-label text-ink-dim">
            Here the worst is {worst.buckets} {worst.buckets === 1 ? 'bucket' : 'buckets'} at {worst.qError.toFixed(2)}×, the
            best {best.buckets} at {best.qError.toFixed(2)}×. More buckets usually help, but not always: a narrow range can
            land where one bucket ends and the next begins, and its share of either is a guess.
          </p>
        </div>
      </DataView>

      <p className="text-label leading-relaxed text-ink-dim">
        The same statement runs in the{' '}
        <Link to={playground} className="underline underline-offset-2 hover:text-ink">
          Playground on the transactions preset
        </Link>
        : <code className="font-mono text-ink">ANALYZE transactions WITH {buckets} BUCKETS</code>, then{' '}
        <code className="font-mono text-ink">EXPLAIN ANALYZE</code> a range on <code className="font-mono text-ink">amount</code>{' '}
        to see the estimate beside the count. The commonest values never reach the histogram: up to five that repeat go in
        the most-common list with their real counts, and the buckets cover the rest. The other two columns are made here,
        as tables of one column, for the shapes the preset does not have.
      </p>
      <div>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => {
            setLow(about.range.low);
            setHigh(about.range.high);
          }}
        >
          Back to this column&rsquo;s range
        </button>
      </div>
    </div>
  );
}
