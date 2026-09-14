import { useEffect, useRef, useState } from 'react';
import type { Row, SqlValue, Table } from '../engine/index.ts';
import { parseSeedCsv } from './parseCsv.ts';
import { btnGhost, btnPrimary, btnSecondary, inputField } from './primitives.ts';

/**
 * "Construct their own input data sets" is named explicitly in the condition
 * that beat both text and a conventional animation in the HalVis studies
 * (RESEARCH.md §1). The dataset is an in-memory array, so this is cheap — and
 * changing it changes every number downstream.
 */
export interface DataEditorProps {
  table: Table;
  onApply: (rows: Row[]) => void;
  /** Omit for a table with no "original seed" to revert to (plan.md §22.7's schema editor) — hides the Reset button rather than showing one with nothing to do. */
  onReset?: () => void;
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
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  function importCsv() {
    const result = parseSeedCsv(csv, table);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    setRows(result.rows);
    setImporting(false);
    setImportError(null);
    setCsv('');
  }

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
    // The onClick below dismisses on a backdrop click. jsx-a11y is right in
    // general and wrong here: it is a mouse-only shortcut for something
    // keyboard users already have two better routes to — Escape, handled
    // natively by showModal(), and a focusable Close button that focus lands on
    // when the dialog opens. Satisfying the rule would bind a second, redundant
    // Escape handler and make the component worse.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialog}
      aria-label="Edit seed data"
      onClose={onClose}
      // Clicking the backdrop targets the dialog itself; anything inside it
      // targets a child. Cheap dismissal without a second overlay element.
      onClick={(e) => { if (e.target === dialog.current) close(); }}
      className="max-h-[85dvh] w-[min(48rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-edge bg-surface p-0 text-ink shadow-e3 backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-surface-2/40 px-4 py-3">
          <h2 className="text-heading font-semibold">Seed data · {table.name}</h2>
          <p className="text-label text-ink-dim">
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {table.indexedColumns && table.indexedColumns.length > 0 && ` · indexed on ${table.indexedColumns.join(', ')}`}
          </p>
          <button type="button" onClick={close} className={`ml-auto ${btnGhost}`}>
            Close
          </button>
        </header>

        {importing && (
          <div className="border-b border-edge bg-surface-2/40 px-4 py-3">
            <label htmlFor="csv-import" className="text-label text-ink-dim">
              Paste CSV — <code className="font-mono">{table.columns.join(',')}</code>, one row per
              line. A header row is optional; an empty field is NULL.
            </label>
            <textarea
              id="csv-import"
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setImportError(null); }}
              rows={4}
              spellCheck={false}
              className={`${inputField} mt-1 w-full resize-y font-mono`}
              placeholder={`${table.columns.join(',')}\n${table.columns.map((c) => (typeof table.rows[0]?.[c] === 'number' ? '0' : 'x')).join(',')}`}
            />
            {importError && (
              <p role="alert" className="mt-1 text-label text-evict">{importError}</p>
            )}
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={importCsv} className={btnPrimary} disabled={csv.trim() === ''}>
                Replace rows
              </button>
              <button
                type="button"
                onClick={() => { setImporting(false); setImportError(null); }}
                className={btnGhost}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left font-mono text-label">
            <thead className="sticky top-0 bg-surface-2/95 backdrop-blur-sm">
              <tr className="border-b border-edge text-ink-dim">
                <th className="w-8 px-2 py-1.5" />
                {table.columns.map((column) => (
                  <th key={column} className="px-2 py-1.5 font-medium">
                    {column}
                    {table.indexedColumns?.includes(column) && (
                      <span className="ml-1 text-label text-accent">idx</span>
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
                        className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 transition hover:border-edge focus:border-accent focus:bg-surface-3 focus:outline-none"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-edge bg-surface-2/40 px-4 py-3">
          <button type="button" onClick={addRow} className={btnSecondary}>
            + Add row
          </button>
          <button
            type="button"
            onClick={() => { setImporting((v) => !v); setImportError(null); }}
            aria-expanded={importing}
            className={btnSecondary}
          >
            Import CSV
          </button>
          {onReset && (
            <button type="button" onClick={() => { close(); onReset(); }} className={btnGhost}>
              Reset to seed
            </button>
          )}
          <p className="ml-auto max-w-xs text-label text-ink-dim">
            Fewer rows means fewer pages, and the buffer pool may stop evicting entirely.
          </p>
          <button
            type="button"
            // close() before the callback, so focus lands back on the button
            // that opened this rather than on <body> after the unmount.
            onClick={() => { close(); onApply(rows); }}
            className={btnPrimary}
          >
            Apply &amp; re-run
          </button>
        </footer>
      </div>
    </dialog>
  );
}
