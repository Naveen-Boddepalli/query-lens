import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { buildHeap, createSeedDatabase, DEFAULT_ENGINE_OPTIONS } from '../../engine/index.ts';
import { layOutPage } from '../../ui/slottedPage.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { inputField, panelSurface } from '../../ui/primitives.ts';

/**
 * The storage-course standalone (plan.md §22.3): one heap page, laid out to the
 * byte. QueryLens's own `Page` is just a `Row[]` (§7), so `src/ui/slottedPage.ts`
 * *synthesises* the classic slotted layout — a header, a line-pointer array
 * growing forward, tuples packed from the far end backward, free space between —
 * with the seed rows as the payload. The point is to make "rows per page" a
 * real number: four toy rows barely dent a 4 KB page, and the size slider lets
 * you shrink the page until they fill it.
 *
 * URL state: `page` (which page) and `bytes` (the page size), both parsed
 * defensively — a pasted link is a stranger's input (`urlState.ts`'s rule).
 */

const USERS = createSeedDatabase().tables.users!;
const HEAP = buildHeap(USERS, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
const LAST_PAGE = HEAP.pages.length - 1;

const MIN_BYTES = 128;
const MAX_BYTES = 16384;
const DEFAULT_BYTES = 4096;

function readInitial() {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const pageRaw = Number(params.get('page'));
  const bytesRaw = Number(params.get('bytes'));
  return {
    pageId:
      Number.isInteger(pageRaw) && pageRaw >= 0 && pageRaw <= LAST_PAGE ? pageRaw : 0,
    pageBytes:
      Number.isInteger(bytesRaw) && bytesRaw >= MIN_BYTES && bytesRaw <= MAX_BYTES
        ? bytesRaw
        : DEFAULT_BYTES,
  };
}

const INITIAL = readInitial();
const B = (n: number) => `${n.toLocaleString()} B`;

export function PageToolPage() {
  const [pageId, setPageId] = useState(INITIAL.pageId);
  const [pageBytes, setPageBytes] = useState(INITIAL.pageBytes);
  const [selected, setSelected] = useState<number | null>(null);

  const page = HEAP.pages[pageId]!;
  const layout = useMemo(
    () => layOutPage(page.rows, USERS.columns, { pageBytes }),
    [page, pageBytes],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      params.set('page', String(pageId));
      params.set('bytes', String(pageBytes));
      const next = `${location.pathname}?${params.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [pageId, pageBytes]);

  const usedPct = Math.min(100, Math.round((layout.usedBytes / pageBytes) * 100));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'Slotted Page' }]}
        title="Slotted Page Inspector"
      >
        One heap page of <code className="font-mono text-ink">users</code>, laid out to the byte &mdash;
        the header, the slot array, the tuples, and the free space between them. The engine models a
        page as a list of rows; this illustrates the physical binary layout on disk.
      </PageHeader>

      {/* Control Toolbar */}
      <div className="ql-sheen flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <label className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Target Page</span>
          <select
            value={pageId}
            onChange={(e) => { setPageId(Number(e.target.value)); setSelected(null); }}
            className={inputField}
          >
            {HEAP.pages.map((p) => (
              <option key={p.pageId} value={p.pageId}>
                Page {p.pageId} &middot; rows {HEAP.firstRowIndex[p.pageId]}&ndash;
                {HEAP.firstRowIndex[p.pageId]! + p.rows.length - 1}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Page Size (bytes)</span>
          <input
            type="number"
            min={MIN_BYTES}
            max={MAX_BYTES}
            step={256}
            value={pageBytes}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= MIN_BYTES && n <= MAX_BYTES) setPageBytes(n);
            }}
            className={`${inputField} w-28 tabular-nums`}
          />
        </label>

        <div className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Preset Sizes</span>
          <div className="flex gap-1.5">
            {([['512 B', 512], ['4 KB', 4096], ['8 KB', 8192]] as const).map(([label, n]) => (
              <button
                key={n}
                type="button"
                onClick={() => { setPageBytes(n); }}
                className={`rounded-lg border px-3 py-1.5 text-label font-medium transition duration-150 ease-out select-none ${
                  pageBytes === n
                    ? 'border-accent bg-accent-soft text-ink shadow-neu-rest backdrop-blur-sm'
                    : 'border-edge bg-surface-2/80 text-ink-dim hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: 'Page Size', value: B(pageBytes), sub: `${pageBytes} B disk frame` },
          { label: 'Space Used', value: `${usedPct}%`, sub: `${B(layout.usedBytes)} allocated`, color: 'text-accent' },
          {
            label: 'Free Space',
            value: layout.overflow ? 'Overflow' : B(layout.freeBytes),
            sub: layout.overflow ? 'exceeds capacity' : `${100 - usedPct}% remaining`,
            color: layout.overflow ? 'text-evict' : 'text-hit',
          },
          { label: 'Tuples', value: String(layout.tuples.length), sub: `~${layout.moreRowsFit} more fit` },
        ].map((m) => (
          <div key={m.label} className="ql-sheen rounded-xl border border-edge bg-surface-2/60 p-3 shadow-neu-rest backdrop-blur-sm">
            <span className="block font-mono text-[0.7rem] uppercase tracking-wider text-ink-dim">{m.label}</span>
            <span className={`mt-1 block truncate text-heading font-semibold tabular-nums ${m.color ?? 'text-ink'}`}>
              {m.value}
            </span>
            <span className="text-[0.75rem] text-ink-dim">{m.sub}</span>
          </div>
        ))}
      </div>

      {/* The map. A proportional strip: header, slot array, free space, then the
          tuple region — drawn slot-0-rightmost, because tuples pack from the
          high end of the page down. Tiny segments keep a min width so their
          labels stay legible; the exact ratio is in the table below. */}
      <div className={`${panelSurface} p-4`}>
        <div className="mb-2 flex items-baseline justify-between text-label text-ink-dim">
          <span>0</span>
          <span className="tabular-nums">
            {usedPct}% used · {layout.overflow ? 'overflows' : `${B(layout.freeBytes)} free`}
          </span>
          <span className="tabular-nums">{B(pageBytes)}</span>
        </div>

        <div className="flex h-14 w-full overflow-hidden rounded-lg border border-edge">
          <Seg grow={layout.headerBytes} min={64} className="bg-surface-4 text-ink-dim">
            header
          </Seg>
          <Seg
            grow={layout.slotArrayBytes}
            min={layout.tuples.length === 0 ? 0 : 56}
            className="border-l border-edge bg-accent/10 text-accent"
          >
            {layout.tuples.length} slot{layout.tuples.length === 1 ? '' : 's'}
          </Seg>
          <Seg
            grow={Math.max(layout.freeBytes, layout.overflow ? 0 : 1)}
            min={0}
            className="border-l border-dashed border-edge bg-transparent text-ink-dim"
          >
            {layout.overflow ? '' : 'free space'}
          </Seg>
          <div className="flex flex-1 flex-row-reverse" style={{ flexGrow: countBytes(layout) }}>
            {layout.tuples.map((t) => {
              const on = selected === t.slot;
              return (
                <button
                  key={t.slot}
                  type="button"
                  onClick={() => { setSelected((cur) => (cur === t.slot ? null : t.slot)); }}
                  style={{ flexGrow: t.length }}
                  className={[
                    'flex min-w-11 items-center justify-center border-l border-edge font-mono text-label transition',
                    on
                      ? 'bg-hit/25 text-ink'
                      : 'bg-hit/10 text-hit hover:bg-hit/20',
                  ].join(' ')}
                  title={`slot ${t.slot} · offset ${t.offset} · ${t.length} B`}
                >
                  #{t.slot}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-ink-dim">
          <span><span className="text-ink">header</span> {B(layout.headerBytes)}</span>
          <span>
            <span className="text-accent">slot array</span> {layout.tuples.length} ×{' '}
            {B(layout.slotBytes)} = {B(layout.slotArrayBytes)}
          </span>
          <span><span className="text-hit">tuples</span> {B(countBytes(layout))}</span>
          <span>
            <span className="text-ink">free</span>{' '}
            {layout.overflow ? '—' : `${B(layout.freeBytes)} (${100 - usedPct}%)`}
          </span>
        </div>

        <p className="mt-2 text-label leading-relaxed text-ink-dim">
          {layout.overflow ? (
            <>These {layout.tuples.length} rows do not fit a {B(pageBytes)} page — a real engine
            would spill onto another. Raise the size.</>
          ) : (
            <>
              About <span className="text-ink tabular-nums">{layout.moreRowsFit}</span> more rows of
              this size would fit here. The pipeline caps a page at{' '}
              {DEFAULT_ENGINE_OPTIONS.rowsPerPage} rows so the contents stay readable (§7); a real
              4 KB page holds a hundred or more.
            </>
          )}
        </p>
      </div>

      <div className={`${panelSurface} overflow-auto p-0`}>
        <table className="w-full border-collapse text-left font-mono text-label">
          <thead>
            <tr className="border-b border-edge bg-surface-2 text-ink-dim">
              <th className="px-3 py-2 font-medium tabular-nums">slot</th>
              <th className="px-3 py-2 font-medium tabular-nums">offset</th>
              <th className="px-3 py-2 font-medium tabular-nums">bytes</th>
              {USERS.columns.map((c) => (
                <th key={c} className="px-3 py-2 font-medium tracking-[0.06em] uppercase">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {layout.tuples.length === 0 && (
              <tr>
                <td colSpan={3 + USERS.columns.length} className="px-3 py-6 text-center text-ink-dim">
                  This page holds no rows.
                </td>
              </tr>
            )}
            {layout.tuples.map((t) => {
              const on = selected === t.slot;
              return (
                <tr
                  key={t.slot}
                  aria-selected={on}
                  onClick={() => { setSelected((cur) => (cur === t.slot ? null : t.slot)); }}
                  className={`cursor-pointer border-b border-edge/40 ${
                    on ? 'bg-hit/15' : 'hover:bg-surface-4'
                  }`}
                >
                  <td className="px-3 py-1.5 tabular-nums text-ink-dim">#{t.slot}</td>
                  <td className="px-3 py-1.5 tabular-nums text-ink-dim">{t.offset}</td>
                  <td className="px-3 py-1.5 tabular-nums">
                    {t.length}
                    <span className="text-ink-dim/70"> ({t.headerBytes}+{t.length - t.headerBytes})</span>
                  </td>
                  {t.fields.map((f) => (
                    <td key={f.column} className="px-3 py-1.5">
                      {f.value}
                      <span className="text-ink-dim/60"> {f.bytes}B</span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Every stage that reads a row goes through a page like this — see it in motion in the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>{' '}
        or against a replacement policy in the{' '}
        <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
          buffer pool sandbox
        </Link>
        .
      </p>
    </div>
  );
}

function countBytes(layout: ReturnType<typeof layOutPage>): number {
  return layout.tuples.reduce((n, t) => n + t.length, 0);
}

function Seg({
  grow,
  min,
  className,
  children,
}: {
  grow: number;
  min: number;
  className: string;
  children: React.ReactNode;
}) {
  if (grow <= 0) return null;
  return (
    <div
      style={{ flexGrow: grow, minWidth: min }}
      className={`flex items-center justify-center px-1 text-center text-label ${className}`}
    >
      {children}
    </div>
  );
}
