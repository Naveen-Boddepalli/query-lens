import { useMemo, useState } from 'react';
import {
  bestEncodingFor,
  COLUMNAR_LIMITS,
  demoColumns,
  ENCODINGS,
  planColumn,
  planLayout,
  planMaterialization,
} from '../../ui/columnar.ts';
import type { Encoding, Layout } from '../../ui/columnar.ts';
import { DataTable } from '../../ui/DataView.tsx';
import { btnGhost, controlLabel, inputField } from '../../ui/primitives.ts';
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

/**
 * The row-vs-column-storage standalone (plan.md §25.4 F3 `/tools/columnar`). Its own driver, `src/ui/columnar.ts`
 * — like `/tools/lsm` and `/tools/hash-index`, the engine has only ever stored rows, so there is nothing
 * existing to reuse here.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): table size, page size and layout in the inspector, the chosen
 * layout's page counts in the readout, per-column compression on the stage with a table view, and the
 * materialization comparison below.
 *
 * URL state: `n` (rows), `page` (page size in bytes), `layout`, and `seed`, parsed defensively — a pasted link
 * is a stranger's input, the rule `src/ui/urlState.ts` follows. Per-column encoding choices and the
 * materialization query are session-local UI state, not URL state — four independent dropdowns plus a filter/
 * project pair would make for an unreadable link.
 */

const DEFAULTS = { n: 500, pageSize: 256, layout: 'DSM' as Layout, seed: 1 };
const MAX_SEED = 999_999;
const LAYOUTS: readonly Layout[] = ['NSM', 'DSM', 'PAX'];
const PAGE_SIZES = [64, 128, 256, 512, 1024] as const;
const LAYOUT_HINTS: Record<Layout, string> = {
  NSM: 'Row store: each page holds whole rows.',
  DSM: 'Column store: each column in its own pages.',
  PAX: 'Hybrid: whole rows per page, grouped by column inside it.',
};
const ENCODING_LABELS: Record<Encoding, string> = {
  none: 'None (raw)',
  dictionary: 'Dictionary',
  rle: 'RLE',
  delta: 'Delta',
  bitpack: 'Bit-packed',
};

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    n: clampInt(p.get('n'), COLUMNAR_LIMITS.minRows, COLUMNAR_LIMITS.maxRows, DEFAULTS.n),
    pageSize: clampInt(p.get('page'), COLUMNAR_LIMITS.minPageSize, COLUMNAR_LIMITS.maxPageSize, DEFAULTS.pageSize),
    layout: LAYOUTS.includes(p.get('layout') as Layout) ? (p.get('layout') as Layout) : DEFAULTS.layout,
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();

export function ColumnarToolPage() {
  const [n, setN] = useState(INITIAL.n);
  const [pageSize, setPageSize] = useState(INITIAL.pageSize);
  const [layout, setLayout] = useState<Layout>(INITIAL.layout);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [view, setView] = useState<'diagram' | 'table'>('diagram');

  const columns = useMemo(() => demoColumns(n, seed), [n, seed]);
  // Only the user's own explicit picks — a column with no override here falls back to its genuinely best
  // encoding, derived at render time below rather than synced back into state via an effect.
  const [encodingOverrides, setEncodingOverrides] = useState<Partial<Record<string, Encoding>>>({});

  const columnPlans = useMemo(
    () => columns.map((c) => planColumn(c, encodingOverrides[c.name] ?? bestEncodingFor(c.values))),
    [columns, encodingOverrides],
  );

  const layoutPlans = useMemo(() => LAYOUTS.map((l) => planLayout(l, columns, pageSize)), [columns, pageSize]);

  const [filterColumn, setFilterColumn] = useState('amount');
  const [projectColumn, setProjectColumn] = useState('id');
  const [thresholdPercent, setThresholdPercent] = useState(80);

  const filterRange = useMemo(() => {
    const col = columns.find((c) => c.name === filterColumn);
    if (!col) return { min: 0, max: 0 };
    return { min: Math.min(...col.values), max: Math.max(...col.values) };
  }, [columns, filterColumn]);

  const threshold = filterRange.min + ((filterRange.max - filterRange.min) * thresholdPercent) / 100;
  const materialization = useMemo(
    () => planMaterialization(columns, filterColumn, threshold, projectColumn),
    [columns, filterColumn, threshold, projectColumn],
  );

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('n', String(n));
    p.set('page', String(pageSize));
    p.set('layout', layout);
    p.set('seed', String(seed));
    return p.toString();
  }, [n, pageSize, layout, seed]);
  useAddressBarQuery(shareQuery);

  const selectedLayoutPlan = layoutPlans.find((p) => p.layout === layout)!;

  const singleScans = columnPlans.map((c) => selectedLayoutPlan.pagesForSingleColumnScan[c.name] ?? 0);
  const fewest = Math.min(...singleScans);
  const most = Math.max(...singleScans);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="storage"
        header={
          <ToolHeader
            id="columnar"
            title="Row vs. column storage"
            summary="Lay one table out as rows, columns or the hybrid, and compare compression, pages scanned and bytes touched."
            about={
              <>
                <p>
                  NSM (a row store), DSM (a column store) and PAX (the hybrid) lay the same table out three different
                  ways, with real compressed-size counters and the one trick that makes a column store pay off: late
                  materialization.
                </p>
                <p>
                  Every column here is a 4-byte integer, so the only variable is how it is stored and encoded. A real
                  table mixes column widths and types; the lesson generalizes, but the exact byte counts are this
                  tool&rsquo;s own, not a production engine&rsquo;s.
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(n)} rows · ${String(pageSize)} B pages · ${layout}`}>
            <ControlGroup legend="Table">
              <ControlRow label="Rows" htmlFor="col-n">
                <Stepper id="col-n" value={n} min={COLUMNAR_LIMITS.minRows} max={COLUMNAR_LIMITS.maxRows} step={50} unit="rows" onChange={setN} />
              </ControlRow>
              <ControlRow label="Page size (bytes)" labelId="col-page" stacked>
                <Segmented
                  labelledBy="col-page"
                  tone="stage"
                  value={String(pageSize)}
                  onChange={(v) => { setPageSize(Number(v)); }}
                  options={PAGE_SIZES.map((v) => ({ value: String(v), label: String(v) }))}
                />
              </ControlRow>
              <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }} className={`${btnGhost} self-start`}>
                Shuffle the rows
              </button>
            </ControlGroup>
            <ControlGroup legend="Storage">
              <ControlRow label="Layout" labelId="col-layout" stacked hint={LAYOUT_HINTS[layout]}>
                <Segmented
                  labelledBy="col-layout"
                  describedBy={hintIdFor('col-layout')}
                  tone="stage"
                  value={layout}
                  onChange={setLayout}
                  options={LAYOUTS.map((l) => ({ value: l, label: l }))}
                />
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Full scan', value: selectedLayoutPlan.pagesForFullScan, sub: 'pages, every column' },
              ...columnPlans.map((c) => ({
                label: `Only ${c.name}`,
                value: selectedLayoutPlan.pagesForSingleColumnScan[c.name] ?? 0,
                sub: 'pages',
              })),
              { label: 'Rebuild one row', value: selectedLayoutPlan.regionsToReconstructOneRow, sub: 'storage regions' },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Compression, per column"
            legend="Best encoding unless you pick one."
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            {view === 'diagram' ? (
              <div className="flex flex-col gap-3">
                <p className="text-label text-ink-dim">
                  Four columns, four different stories: <code className="font-mono text-ink">id</code> is sorted and
                  wins big with delta; <code className="font-mono text-ink">status_grouped</code> has real runs and
                  wins with RLE; <code className="font-mono text-ink">status_shuffled</code> holds the exact same
                  values with no runs left, so RLE loses to dictionary or bit-packing; and{' '}
                  <code className="font-mono text-ink">amount</code> spans almost the full range, so nothing
                  compresses it well.
                </p>
                <ul className="flex flex-col gap-2">
                  {columnPlans.map((plan) => (
                    <li key={plan.name} className="flex flex-wrap items-center gap-3 rounded-lg border border-edge/70 p-2">
                      <span className="w-36 shrink-0 font-mono text-label text-ink">{plan.name}</span>
                      <select
                        aria-label={`Encoding for ${plan.name}`}
                        value={plan.encoding}
                        onChange={(e) => { setEncodingOverrides((prev) => ({ ...prev, [plan.name]: e.target.value as Encoding })); }}
                        className={`${inputField} w-36`}
                      >
                        {ENCODINGS.map((enc) => <option key={enc} value={enc}>{ENCODING_LABELS[enc]}</option>)}
                      </select>
                      <span className="text-label tabular-nums text-ink-dim">
                        {plan.rawBytes} B → <span className="text-ink">{plan.compressedBytes} B</span>
                      </span>
                      <div className="h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-4">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${String(Math.min(100, (plan.compressedBytes / plan.rawBytes) * 100))}%` }}
                        />
                      </div>
                      <span className="w-14 shrink-0 text-right text-label tabular-nums text-accent">{plan.compressionRatio.toFixed(2)}×</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <DataTable
                caption="Each column's encoding, its size raw and compressed, and the ratio"
                rows={columnPlans}
                keyOf={(r) => r.name}
                columns={[
                  { header: 'Column', cell: (r) => r.name },
                  { header: 'Encoding', cell: (r) => ENCODING_LABELS[r.encoding] },
                  { header: 'Raw bytes', cell: (r) => r.rawBytes },
                  { header: 'Compressed bytes', cell: (r) => r.compressedBytes },
                  { header: 'Ratio', cell: (r) => `${r.compressionRatio.toFixed(2)}×` },
                ]}
              />
            )}
          </StagePanel>
        }
        narration={
          fewest === most && most === selectedLayoutPlan.pagesForFullScan
            ? `${layout} keeps each row together: scanning any one column still reads all ${String(most)} pages, but a row comes back from ${plural(selectedLayoutPlan.regionsToReconstructOneRow, 'region')}.`
            : `${layout} reads ${fewest === most ? String(most) : `${String(fewest)} to ${String(most)}`} of ${String(selectedLayoutPlan.pagesForFullScan)} pages to scan one column, and rebuilds a row from ${plural(selectedLayoutPlan.regionsToReconstructOneRow, 'storage region')}.`
        }
      >
        <ToolSection
          title="Late vs. early materialization"
          description={`SELECT ${projectColumn} WHERE ${filterColumn} >= …: early materialization rebuilds every column of every row first, throwing away the layout's columnar advantage; late materialization filters on ${filterColumn} alone, then fetches ${projectColumn} only at the rows that matched.`}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className={`flex flex-col gap-1 ${controlLabel}`}>
              Filter column (&gt;=)
              <select value={filterColumn} onChange={(e) => { setFilterColumn(e.target.value); }} className={inputField}>
                {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            <label className={`flex flex-col gap-1 ${controlLabel}`}>
              Threshold (percentile)
              <input
                type="range"
                min={0}
                max={100}
                value={thresholdPercent}
                onChange={(e) => { setThresholdPercent(Number(e.target.value)); }}
                className="w-32"
              />
            </label>
            <label className={`flex flex-col gap-1 ${controlLabel}`}>
              Project column
              <select value={projectColumn} onChange={(e) => { setProjectColumn(e.target.value); }} className={inputField}>
                {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <p className="text-label text-ink-dim">
            <span className="font-mono text-ink">{materialization.matchingRows}</span> of {n} rows match.
          </p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-label">
            <div className="contents">
              <dt className="text-ink-dim">early materialization — bytes touched</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{materialization.earlyBytesTouched.toLocaleString()}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-dim">late materialization — bytes touched</dt>
              <dd className="text-right font-mono tabular-nums text-accent">{materialization.lateBytesTouched.toLocaleString()}</dd>
            </div>
          </dl>
        </ToolSection>
      </ToolShell>
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
