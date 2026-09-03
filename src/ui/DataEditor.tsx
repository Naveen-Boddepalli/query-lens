import { useEffect, useRef, useState } from 'react';
import type { Row, SqlValue, Table } from '../engine/index.ts';

/**
 * "Construct their own input data sets" is named explicitly in the condition
 * that beat both text and a conventional animation in the HalVis studies
 * (RESEARCH.md §1). The dataset is an in-memory array, so this is cheap — and
 * changing it changes every number downstream.
 */
export interface DataEditorProps {
  table: Table;
  onApply: (rows: Row[]) => void;
  onReset: () => void;
  onClose: () => void;
}

/** Keeps a column's original type: "42" in a number column stays a number. */
function coerce(raw: string, previous: SqlValue): SqlValue {
  if (raw === '') return null;
  if (typeof previous === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (typeof previous === 'boolean') return raw === 'true';
  return raw;
}

export function DataEditor({ table, onApply, onReset, onClose }: DataEditorProps) {
  const [rows, setRows] = useState<Row[]>(() => table.rows.map((r) => ({ ...r })));
  const dialog = useRef<HTMLDialogElement>(null);

  /**
   * plan.md §15.1 item 3. The hand-rolled overlay this replaces had three
   * measured defects — focus never entered it, Escape did not close it, and
   * Tab reached the page behind. `showModal()` fixes all three (it moves focus
   * in, closes on Escape, and makes everything outside inert), returns focus
   * to the trigger on close, and deletes the code that tried to fake it.
   *
   * The component only mounts while open, so mounting is the open event.
   */
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  // Route every dismissal through close() so the native `close` event is the
  // single place onClose fires — Escape and the button then behave identically.
  const close = () => { dialog.current?.close(); };

  const edit = (index: number, column: string, raw: string) => {
    setRows((current) =>
      current.map((row, i) =>
        i === index ? { ...row, [column]: coerce(raw, row[column] ?? null) } : row,
      ),
    );
  };

  const addRow = () => {
    setRows((current) => {
      const template = current[current.length - 1] ?? {};
      const blank: Row = {};
      for (const column of table.columns) {
        const previous = template[column];
        blank[column] = typeof previous === 'number' ? Number(previous) + 1 : '';
      }
      return [...current, blank];
    });
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  };

  return (
    <dialog
      ref={dialog}
      aria-label="Edit seed data"
      onClose={onClose}
      // Clicking the backdrop targets the dialog itself; anything inside it
      // targets a child. Cheap dismissal without a second overlay element.
      onClick={(e) => { if (e.target === dialog.current) close(); }}
      className="max-h-[85dvh] w-[min(48rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge bg-surface p-0 text-ink backdrop:bg-black/60"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold">Seed data · {table.name}</h2>
          <p className="text-xs text-ink-dim">
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {table.indexedColumn && ` · indexed on ${table.indexedColumn}`}
          </p>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent/70"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left font-mono text-xs">
            <thead className="sticky top-0 bg-surface-2">
              <tr className="border-b border-edge text-ink-dim">
                <th className="w-8 px-2 py-1.5" />
                {table.columns.map((column) => (
                  <th key={column} className="px-2 py-1.5 font-medium">
                    {column}
                    {column === table.indexedColumn && (
                      <span className="ml-1 text-3xs text-accent">idx</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-edge/40">
                  <td className="px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => { removeRow(i); }}
                      aria-label={`Delete row ${String(i + 1)}`}
                      className="rounded px-1 text-ink-dim hover:text-evict"
                    >
                      ×
                    </button>
                  </td>
                  {table.columns.map((column) => (
                    <td key={column} className="px-1 py-0.5">
                      <input
                        value={String(row[column] ?? '')}
                        onChange={(e) => { edit(i, column, e.target.value); }}
                        aria-label={`${column} row ${String(i + 1)}`}
                        className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 hover:border-edge focus:border-accent focus:outline-none"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-edge px-4 py-3">
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-edge px-2.5 py-1.5 text-xs hover:border-accent/70"
          >
            + Add row
          </button>
          <button
            type="button"
            onClick={() => { close(); onReset(); }}
            className="rounded-md border border-edge px-2.5 py-1.5 text-xs text-ink-dim hover:border-accent/70"
          >
            Reset to seed
          </button>
          <p className="ml-auto text-2xs text-ink-dim">
            Fewer rows means fewer pages, and the buffer pool may stop evicting entirely.
          </p>
          <button
            type="button"
            // close() before the callback, so focus lands back on the button
            // that opened this rather than on <body> after the unmount.
            onClick={() => { close(); onApply(rows); }}
            className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-xs font-medium hover:bg-accent/25"
          >
            Apply &amp; re-run
          </button>
        </footer>
      </div>
    </dialog>
  );
}
