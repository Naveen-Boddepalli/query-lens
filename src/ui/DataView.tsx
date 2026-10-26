import { useState } from 'react';
import type { ReactNode } from 'react';
import { btnGhost } from './primitives.ts';

/**
 * plan.md §H6, "a data-table view for every new panel": the same numbers a diagram shows, as a real table a screen
 * reader can walk cell by cell. `DataView` puts a toggle over a visual; the visual stays the default.
 */
export interface TableColumn<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  keyOf: (row: Row, index: number) => string;
}

export function DataTable<Row>({ caption, columns, rows, keyOf }: DataTableProps<Row>) {
  return (
    // A scrollable region has to be reachable from the keyboard, and a table of plain text has nothing focusable in it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
      <table className="w-full border-collapse text-label">
        <caption className="mb-2 text-left text-ink-dim">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className="border-b border-edge px-2 py-1.5 text-left font-medium text-ink">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={keyOf(row, i)} className="border-b border-edge/50">
              {columns.map((c) => (
                <td key={c.header} className="px-2 py-1.5 align-top font-mono tabular-nums text-ink-dim">
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface DataViewProps<Row> extends DataTableProps<Row> {
  children: ReactNode;
}

export function DataView<Row>({ children, ...table }: DataViewProps<Row>) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => { setAsTable((v) => !v); }}
          className={`${btnGhost} ${asTable ? 'border-accent bg-accent-soft text-ink' : ''}`}
        >
          {asTable ? 'Show as diagram' : 'Show as table'}
        </button>
      </div>
      {asTable ? <DataTable {...table} /> : children}
    </div>
  );
}
