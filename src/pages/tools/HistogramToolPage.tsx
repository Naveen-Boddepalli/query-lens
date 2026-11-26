import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '../../ui/DataView.tsx';
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
  ToolSection,
  ToolShell,
} from '../../ui/tool/index.ts';
import { encodeShareState } from '../../ui/urlState.ts';

/**
 * The histogram standalone (plan.md §27.5 T5): `ANALYZE` with a chosen bucket count, and what it does to one range
 * estimate. The engine's own `ANALYZE` builds the equi-depth histogram and the planner's own range estimate reads it
 * (`engine/histogramStudy.ts`); this page draws the buckets, the range, and the q-error at every bucket count.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): column, bucket count and range in the inspector, the estimate
 * against the real count in the readout, the buckets on the stage with a table view, and the bucket-count sweep below.
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
  const [view, setView] = useState<'diagram' | 'table'>('diagram');
  const [sweepView, setSweepView] = useState<'diagram' | 'table'>('diagram');
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

  const resetRange = () => {
    setLow(about.range.low);
    setHigh(about.range.high);
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="query"
        header={
          <ToolHeader
            id="histograms"
            title="Histograms"
            summary="ANALYZE cuts a column into equal-depth buckets. Pick a bucket count and see what it does to one range estimate."
            about={
              <>
                <p>
                  <code className="font-mono text-ink">ANALYZE</code> sorts a column&rsquo;s values and cuts them into
                  buckets that each hold the same number of rows, an <em>equi-depth</em> histogram. A range&rsquo;s
                  estimate is then the share of each bucket it overlaps, as if the bucket&rsquo;s rows were spread evenly
                  across it. Where the values crowd together a bucket is narrow, and where they thin out it is wide; how
                  many buckets there are decides how much of the column&rsquo;s shape the planner gets to see.
                </p>
                <p>
                  The same statement runs in the{' '}
                  <Link to={playground} className="underline underline-offset-2 hover:text-ink">
                    Playground on the transactions preset
                  </Link>
                  : <code className="font-mono text-ink">ANALYZE transactions WITH {buckets} BUCKETS</code>, then{' '}
                  <code className="font-mono text-ink">EXPLAIN ANALYZE</code> a range on{' '}
                  <code className="font-mono text-ink">amount</code> to see the estimate beside the count. The commonest
                  values never reach the histogram: up to five that repeat go in the most-common list with their real
                  counts, and the buckets cover the rest. The other two columns are made here, as tables of one column,
                  for the shapes the preset does not have.
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`${about.label} · ${String(buckets)} buckets · ${String(low)}–${String(high)}`}>
            <ControlGroup legend="Data">
              <ControlRow label="Column" labelId="hist-column" stacked hint={about.about}>
                <Segmented
                  labelledBy="hist-column"
                  describedBy={hintIdFor('hist-column')}
                  tone="stage"
                  value={column}
                  onChange={(id) => {
                    const c = HISTOGRAM_COLUMNS.find((x) => x.id === id)!;
                    setColumn(c.id);
                    setLow(c.range.low);
                    setHigh(c.range.high);
                  }}
                  options={HISTOGRAM_COLUMNS.map((c) => ({
                    value: c.id,
                    label: c.id,
                    ...(c.label === c.id ? {} : { ariaLabel: c.label }),
                  }))}
                />
              </ControlRow>
              <ControlRow label="Buckets" htmlFor="hist-b">
                <Stepper id="hist-b" value={buckets} min={HISTOGRAM_LIMITS.minBuckets} max={HISTOGRAM_LIMITS.maxBuckets} unit="buckets" onChange={setBuckets} />
              </ControlRow>
            </ControlGroup>
            <ControlGroup legend="Range">
              <ControlRow label="From" htmlFor="hist-lo" stacked>
                <Stepper id="hist-lo" value={low} min={HISTOGRAM_LIMITS.minValue} max={high} step={50} unit="from" onChange={setLow} />
              </ControlRow>
              <ControlRow label="To" htmlFor="hist-hi" stacked>
                <Stepper id="hist-hi" value={high} min={low} max={HISTOGRAM_LIMITS.maxValue} step={50} unit="to" onChange={setHigh} />
              </ControlRow>
              <button type="button" onClick={resetRange} className={`${btnGhost} self-start`}>
                Back to this column&rsquo;s range
              </button>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Estimated', value: fmt(now.estimate), sub: 'rows, from the buckets' },
              { label: 'Really', value: fmt(now.actual), sub: 'rows that match' },
              { label: 'q-error', value: `${now.qError.toFixed(2)}×`, sub: 'larger ÷ smaller', ...(now.qError >= 2 ? { tone: 'evict' as const } : {}) },
              { label: 'Buckets built', value: Math.max(0, bounds.length - 1), sub: 'equal depth' },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Buckets"
            legend="Shaded: the range"
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            <p className="mb-3 font-mono text-label break-words text-ink">
              ANALYZE {column} WITH {buckets} BUCKETS; SELECT * FROM {column} WHERE v BETWEEN {low} AND {high};
            </p>
            {view === 'diagram' ? (
              <>
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
                  Each bar is one bucket, as wide as the values it covers and taller the denser its rows, on a log scale
                  so a bucket over a gap still shows. Every bucket holds the same number of rows.
                </p>
              </>
            ) : (
              <DataTable
                caption={`The ${String(bucketRows.length)} buckets of ${column}, as the planner reads them`}
                rows={bucketRows}
                keyOf={(r) => String(r.n)}
                columns={[
                  { header: 'Bucket', cell: (r) => r.n },
                  { header: 'From', cell: (r) => fmt(r.from) },
                  { header: 'To', cell: (r) => fmt(r.to) },
                  { header: 'Rows (assumed)', cell: (r) => fmt(r.rows) },
                ]}
              />
            )}
          </StagePanel>
        }
        narration={`The planner’s own words: ${now.basis}.`}
      >
        <ToolSection
          title="The same range at every bucket count"
          description={`Here the worst is ${plural(worst.buckets, 'bucket')} at ${worst.qError.toFixed(2)}×, the best ${String(best.buckets)} at ${best.qError.toFixed(2)}×. More buckets usually help, but not always: a narrow range can land where one bucket ends and the next begins, and its share of either is a guess.`}
          controls={
            <Segmented
              label="Sweep view"
              size="sm"
              value={sweepView}
              onChange={setSweepView}
              options={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            />
          }
        >
          {sweepView === 'diagram' ? (
            <ul className="flex flex-col gap-1">
              {sweep.map((r) => {
                const width = Math.min(100, (Math.log10(r.qError) / Math.log10(Math.max(worst.qError, 2))) * 100);
                return (
                  <li key={r.buckets} className="grid grid-cols-[6.5rem_1fr_7rem] items-center gap-2 text-label">
                    <button
                      type="button"
                      onClick={() => { setBuckets(r.buckets); }}
                      aria-pressed={r.buckets === buckets}
                      className={`rounded-md border px-2 py-0.5 text-left whitespace-nowrap tabular-nums ${r.buckets === buckets ? 'ql-stage-chip-current text-ink' : 'border-edge text-ink-dim'}`}
                    >
                      {plural(r.buckets, 'bucket')}
                    </button>
                    <span className="h-2 rounded-full bg-surface-3" aria-hidden>
                      <span className={`block h-2 rounded-full ${r.qError >= 2 ? 'bg-evict' : 'bg-accent'}`} style={{ width: `${String(Math.max(2, width))}%` }} />
                    </span>
                    <span className="text-ink tabular-nums">
                      {r.qError.toFixed(2)}× <span className="text-ink-dim">({fmt(r.estimate)})</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <DataTable
              caption="The same range at every bucket count"
              rows={sweep}
              keyOf={(r) => String(r.buckets)}
              columns={[
                { header: 'Buckets', cell: (r) => r.buckets },
                { header: 'Estimated', cell: (r) => fmt(r.estimate) },
                { header: 'Really', cell: (r) => fmt(r.actual) },
                { header: 'q-error', cell: (r) => `${r.qError.toFixed(2)}×` },
              ]}
            />
          )}
        </ToolSection>
      </ToolShell>
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
