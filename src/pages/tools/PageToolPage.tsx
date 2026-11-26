import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { buildHeap, createSeedDatabase, DEFAULT_ENGINE_OPTIONS } from '../../engine/index.ts';
import { layOutPage } from '../../ui/slottedPage.ts';
import { inputField } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  MetricStrip,
  StagePanel,
  ToolHeader,
    ToolShell,
} from '../../ui/tool/index.ts';

/**
 * The storage-course standalone (plan.md §22.3): one heap page, laid out to the
 * byte. QueryLens's own `Page` is just a `Row[]` (§7), so `src/ui/slottedPage.ts`
 * *synthesises* the classic slotted layout — a header, a line-pointer array
 * growing forward, tuples packed from the far end backward, free space between —
 * with the seed rows as the payload. The point is to make "rows per page" a
 * real number: four toy rows barely dent a 4 KB page, and the size slider lets
 * you shrink the page until they fill it.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the page and its size in the inspector (one size field, with
 * common sizes as shortcuts into it), the byte totals in the readout, and the page map with its slot table on the stage,
 * where picking a tuple in either picks it out in both.
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
const PRESETS = [['512 B', 512], ['4 KB', 4096], ['8 KB', 8192]] as const;

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
  /** What is typed in the size field while it is not yet a valid size, so a partial entry is not snapped back. */
  const [bytesDraft, setBytesDraft] = useState<string | null>(null);

  const page = HEAP.pages[pageId]!;
  const layout = useMemo(
    () => layOutPage(page.rows, USERS.columns, { pageBytes }),
    [page, pageBytes],
  );

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(pageId));
    params.set('bytes', String(pageBytes));
    return params.toString();
  }, [pageId, pageBytes]);
  useAddressBarQuery(shareQuery);

  const usedPct = Math.min(100, Math.round((layout.usedBytes / pageBytes) * 100));
  const select = (slot: number) => { setSelected((cur) => (cur === slot ? null : slot)); };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="storage"
        header={
          <ToolHeader
            id="page"
            title="Slotted page inspector"
            summary="One heap page laid out to the byte: the header, the slot array, the tuples and the free space between."
            about={
              <p>
                The engine models a page as a list of rows; this draws the physical layout a real engine would write
                to disk, with the <code className="font-mono text-ink">users</code> rows as the payload. Every stage
                that reads a row goes through a page like this. See it in motion in the{' '}
                <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
                  Playground
                </Link>
                , or against a replacement policy in the{' '}
                <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
                  buffer pool sandbox
                </Link>
                .
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`page ${String(pageId)} · ${B(pageBytes)}`}>
            <ControlGroup legend="Page">
              <ControlRow label="Heap page" htmlFor="page-id" stacked>
                <select
                  id="page-id"
                  value={pageId}
                  onChange={(e) => { setPageId(Number(e.target.value)); setSelected(null); }}
                  className={inputField}
                >
                  {HEAP.pages.map((p) => (
                    <option key={p.pageId} value={p.pageId}>
                      Page {p.pageId} · rows {HEAP.firstRowIndex[p.pageId]}–{HEAP.firstRowIndex[p.pageId]! + p.rows.length - 1}
                    </option>
                  ))}
                </select>
              </ControlRow>
              <ControlRow
                label="Page size (bytes)"
                htmlFor="page-bytes"
                stacked
                hint={`${B(MIN_BYTES)} to ${B(MAX_BYTES)}. Shrink it until the rows no longer fit.`}
              >
                <div className="flex flex-col gap-2">
                  <input
                    id="page-bytes"
                    type="number"
                    inputMode="numeric"
                    min={MIN_BYTES}
                    max={MAX_BYTES}
                    step={256}
                    value={bytesDraft ?? pageBytes}
                    aria-describedby={hintIdFor('page-bytes')}
                    onChange={(e) => {
                      setBytesDraft(e.target.value);
                      const n = Number(e.target.value);
                      if (Number.isInteger(n) && n >= MIN_BYTES && n <= MAX_BYTES) setPageBytes(n);
                    }}
                    onBlur={() => { setBytesDraft(null); }}
                    className={`${inputField} w-28 tabular-nums`}
                  />
                  {/* Common sizes, as shortcuts into the one field rather than a second control for the same value. */}
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common page sizes">
                    {PRESETS.map(([label, n]) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={pageBytes === n}
                        onClick={() => { setPageBytes(n); setBytesDraft(null); }}
                        className={`rounded-full border px-2.5 py-0.5 text-label transition duration-150 ease-out ${
                          pageBytes === n ? 'ql-stage-chip-current text-ink' : 'border-edge text-ink-dim hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Page size', value: B(pageBytes) },
              { label: 'Space used', value: `${String(usedPct)}%`, sub: `${B(layout.usedBytes)} allocated` },
              {
                label: 'Free space',
                value: layout.overflow ? 'overflow' : B(layout.freeBytes),
                sub: layout.overflow ? 'the rows exceed the page' : `${String(100 - usedPct)}% left`,
                tone: layout.overflow ? 'evict' : 'hit',
              },
              { label: 'Tuples', value: layout.tuples.length, sub: layout.overflow ? 'more than the page holds' : `about ${String(layout.moreRowsFit)} more fit` },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Page map"
            legend={`${String(usedPct)}% used · ${layout.overflow ? 'overflows' : `${B(layout.freeBytes)} free`}`}
          >
            {/* A proportional strip: header, slot array, free space, then the tuple region, drawn slot 0 rightmost
                because tuples pack from the high end of the page down. Tiny segments keep a minimum width so their
                labels stay legible; the exact ratio is in the table under it. */}
            <div className="mb-2 flex items-baseline justify-between text-label text-ink-dim">
              <span>0</span>
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
                className="min-w-0 overflow-hidden border-l border-dashed border-edge bg-transparent text-ink-dim"
              >
                {/* The first thing to give way on a phone: the label ellipsises before any slot loses its target. */}
                {layout.overflow ? '' : <span className="truncate">free space</span>}
              </Seg>
              <div className="flex flex-1 flex-row-reverse" style={{ flexGrow: countBytes(layout) }}>
                {layout.tuples.map((t) => {
                  const on = selected === t.slot;
                  return (
                    <button
                      key={t.slot}
                      type="button"
                      aria-pressed={on}
                      onClick={() => { select(t.slot); }}
                      style={{ flexGrow: t.length }}
                      className={[
                        'flex min-w-6 items-center justify-center border-l border-edge font-mono text-label transition',
                        on ? 'bg-hit/25 text-ink' : 'bg-hit/10 text-hit hover:bg-hit/20',
                      ].join(' ')}
                      title={`slot ${t.slot} · offset ${t.offset} · ${t.length} B`}
                    >
                      #{t.slot}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-label text-ink-dim">
              <span><span className="text-ink">header</span> {B(layout.headerBytes)}</span>
              <span>
                <span className="text-accent">slot array</span> {layout.tuples.length} × {B(layout.slotBytes)} ={' '}
                {B(layout.slotArrayBytes)}
              </span>
              <span><span className="text-hit">tuples</span> {B(countBytes(layout))}</span>
              <span>
                <span className="text-ink">free</span> {layout.overflow ? '—' : `${B(layout.freeBytes)} (${String(100 - usedPct)}%)`}
              </span>
            </div>

            <h4 className="mt-5 mb-2 text-label font-semibold text-ink">Slots and tuples</h4>
            <div className="overflow-hidden rounded-lg border border-edge">
              <ScrollRegion label="The slots and tuples of the page" className="overflow-x-auto" stickyFirst>
                <table className="w-full border-collapse text-left font-mono text-label whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-edge bg-surface-2 text-ink-dim">
                      <th className="px-3 py-2 font-medium tabular-nums">slot</th>
                      <th className="px-3 py-2 font-medium tabular-nums">offset</th>
                      <th className="px-3 py-2 font-medium tabular-nums">bytes</th>
                      {USERS.columns.map((c) => (
                        <th key={c} className="px-3 py-2 font-medium">{c}</th>
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
                          onClick={() => { select(t.slot); }}
                          className={`cursor-pointer border-b border-edge/40 ${on ? 'bg-hit/15' : 'hover:bg-surface-4'}`}
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
              </ScrollRegion>
            </div>
          </StagePanel>
        }
        narration={
          layout.overflow
            ? `These ${String(layout.tuples.length)} rows do not fit a ${B(pageBytes)} page; a real engine would spill onto another. Raise the size.`
            : `About ${String(layout.moreRowsFit)} more rows of this size would fit here. The pipeline caps a page at ${String(DEFAULT_ENGINE_OPTIONS.rowsPerPage)} rows so the contents stay readable; a real 4 KB page holds a hundred or more.`
        }
      />
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
