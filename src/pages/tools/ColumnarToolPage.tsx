import { useEffect, useMemo, useState } from 'react';
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
import { DataView } from '../../ui/DataView.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { inputField, panelSurface } from '../../ui/primitives.ts';

/**
 * The row-vs-column-storage standalone (plan.md §25.4 F3 `/tools/columnar`). Its own driver, `src/ui/columnar.ts`
 * — like `/tools/lsm` and `/tools/hash-index`, the engine has only ever stored rows, so there is nothing
 * existing to reuse here.
 *
 * URL state: `n` (rows), `page` (page size in bytes), `layout`, and `seed`, parsed defensively — a pasted link
 * is a stranger's input, the rule `src/ui/urlState.ts` follows. Per-column encoding choices and the
 * materialization query are session-local UI state, not URL state — four independent dropdowns plus a filter/
 * project pair would make for an unreadable link.
 */

const DEFAULTS = { n: 500, pageSize: 256, layout: 'DSM' as Layout, seed: 1 };
const MAX_SEED = 999_999;
const LAYOUTS: readonly Layout[] = ['NSM', 'DSM', 'PAX'];
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

  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = new URLSearchParams();
      p.set('n', String(n));
      p.set('page', String(pageSize));
      p.set('layout', layout);
      p.set('seed', String(seed));
      const next = `${location.pathname}?${p.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(t); };
  }, [n, pageSize, layout, seed]);

  const selectedLayoutPlan = layoutPlans.find((p) => p.layout === layout)!;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Row vs. column storage">
        NSM (row store), DSM (column store) and PAX (the hybrid) lay the same table out three different ways —
        with real compressed-size counters and the one trick that actually makes a column store pay off: late
        materialization.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Rows
          <input
            type="number"
            min={COLUMNAR_LIMITS.minRows}
            max={COLUMNAR_LIMITS.maxRows}
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= COLUMNAR_LIMITS.minRows && v <= COLUMNAR_LIMITS.maxRows) setN(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Page size (bytes)
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); }} className={inputField}>
            {[64, 128, 256, 512, 1024].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge bg-surface-3 px-3.5 py-2 text-body text-ink-dim shadow-e1 transition hover:border-ink-dim/50 hover:bg-surface-4 hover:text-ink active:translate-y-px"
        >
          Reshuffle
        </button>
      </div>

      <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
        <h3 className="text-body font-semibold text-ink">Compression, per column</h3>
        <p className="text-label text-ink-dim">
          Four columns, four different stories: <code className="font-mono text-ink">id</code> is sorted and
          wins big with delta; <code className="font-mono text-ink">status_grouped</code> has real runs and
          wins with RLE; <code className="font-mono text-ink">status_shuffled</code> holds the exact same
          values with no runs left, so RLE loses to dictionary/bit-packing instead;{' '}
          <code className="font-mono text-ink">amount</code> spans almost the full range nothing compresses
          well, honestly.
        </p>
        <DataView
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
        >
          <div className="flex flex-col gap-2">
          {columnPlans.map((plan) => (
            <div key={plan.name} className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface-3 p-2">
              <span className="w-40 shrink-0 font-mono text-label text-ink">{plan.name}</span>
              <select
                value={plan.encoding}
                onChange={(e) => { setEncodingOverrides((prev) => ({ ...prev, [plan.name]: e.target.value as Encoding })); }}
                className={`${inputField} w-40`}
              >
                {ENCODINGS.map((enc) => <option key={enc} value={enc}>{ENCODING_LABELS[enc]}</option>)}
              </select>
              <span className="text-label tabular-nums text-ink-dim">
                {plan.rawBytes} B → <span className="text-ink">{plan.compressedBytes} B</span>
              </span>
              <div className="h-2 flex-1 min-w-24 overflow-hidden rounded-full bg-surface-4">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${String(Math.min(100, (plan.compressedBytes / plan.rawBytes) * 100))}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-label tabular-nums text-accent">{plan.compressionRatio.toFixed(2)}×</span>
            </div>
          ))}
          </div>
        </DataView>
      </div>

      <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
        <h3 className="text-body font-semibold text-ink">Layout</h3>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={layout === l}
              onClick={() => { setLayout(l); }}
              className={`rounded-lg border px-3 py-1.5 text-body transition ${
                layout === l ? 'border-accent bg-accent/15 text-ink' : 'border-edge bg-surface-3 text-ink-dim hover:border-ink-dim/50'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-label">
          <div className="contents">
            <dt className="text-ink-dim">pages for a full scan (every column, every row)</dt>
            <dd className="text-right font-mono tabular-nums text-ink">{selectedLayoutPlan.pagesForFullScan}</dd>
          </div>
          {columnPlans.map((plan) => (
            <div className="contents" key={plan.name}>
              <dt className="text-ink-dim">pages scanning only {plan.name}</dt>
              <dd className="text-right font-mono tabular-nums text-accent">{selectedLayoutPlan.pagesForSingleColumnScan[plan.name]}</dd>
            </div>
          ))}
          <div className="contents">
            <dt className="text-ink-dim">storage regions to reconstruct one whole row</dt>
            <dd className="text-right font-mono tabular-nums text-ink">{selectedLayoutPlan.regionsToReconstructOneRow}</dd>
          </div>
        </dl>
      </div>

      <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
        <h3 className="text-body font-semibold text-ink">Late vs. early materialization</h3>
        <p className="text-label text-ink-dim">
          <code className="font-mono text-ink">SELECT {projectColumn} WHERE {filterColumn} &gt;= …</code> — early
          materialization reconstructs every column of every row first, throwing away any layout&rsquo;s own
          columnar advantage; late materialization filters on {filterColumn} alone, then fetches{' '}
          {projectColumn} only at the rows that actually matched.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-label text-ink-dim">
            Filter column (&gt;=)
            <select value={filterColumn} onChange={(e) => { setFilterColumn(e.target.value); }} className={inputField}>
              {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-label text-ink-dim">
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
          <label className="flex flex-col gap-1 text-label text-ink-dim">
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
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Every column here is a 4-byte integer, so the only variable is how it is stored and encoded. A real
        table mixes column widths and types — the lesson generalizes; the exact byte counts are this tool&rsquo;s
        own, not a production engine&rsquo;s.
      </p>
    </div>
  );
}
