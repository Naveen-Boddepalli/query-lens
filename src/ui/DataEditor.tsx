import { useState } from 'react';
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit seed data"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-edge bg-surface">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold">Seed data · {table.name}</h2>
          <p className="text-xs text-ink-dim">
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {table.indexedColumn && ` · indexed on ${table.indexedColumn}`}
          </p>
          <button
            type="button"
            onClick={onClose}
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
                      <span className="ml-1 text-[9px] text-accent">idx</span>
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
            onClick={onReset}
            className="rounded-md border border-edge px-2.5 py-1.5 text-xs text-ink-dim hover:border-accent/70"
          >
            Reset to seed
          </button>
          <p className="ml-auto text-[11px] text-ink-dim">
            Fewer rows means fewer pages, and the buffer pool may stop evicting entirely.
          </p>
          <button
            type="button"
            onClick={() => { onApply(rows); }}
            className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-xs font-medium hover:bg-accent/25"
          >
            Apply &amp; re-run
          </button>
        </footer>
      </div>
    </div>
  );
}
