import { useState } from 'react';
import type { Row } from '../../engine/index.ts';
import { ScrollRegion } from '../ScrollRegion.tsx';

export function ResultPanel({ rows }: { rows: Row[] }) {
  const [page, setPage] = useState(0);

  if (rows.length === 0) {
    return <p className="text-body text-ink-dim">No rows yet — run the query to the end.</p>;
  }

  const columns = Object.keys(rows[0]!);
  const max = Math.ceil(rows.length / 8) - 1;
  const p = Math.min(page, Math.max(0, max));
  const slice = max > 0 ? rows.slice(p * 8, p * 8 + 8) : rows;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-edge shadow-e1">
      {max > 0 && (
        <div className="flex justify-between border-b border-edge px-3 py-1 font-mono text-label text-ink-dim">
          <span>{rows.length} rows</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setPage(p - 1); }}
              disabled={p === 0}
              className="hover:text-ink disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <span>{p + 1}/{max + 1}</span>
            <button
              type="button"
              onClick={() => { setPage(p + 1); }}
              disabled={p >= max}
              className="hover:text-ink disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <ScrollRegion label="Query result" className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left font-mono text-label">
          <thead className="sticky top-0 z-10 border-b border-edge bg-surface-2/95 text-ink-dim backdrop-blur-sm">
            <tr>
              {columns.map((c) => (
                <th key={c} className="px-3 py-2 font-medium tracking-[0.06em] uppercase">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((row, i) => (
              <tr
                key={i}
                className="cell border-b border-edge/40 odd:bg-surface-2/40 hover:bg-surface-4"
              >
                {columns.map((c) => (
                  <td key={c} className="px-3 py-1.5">{String(row[c] ?? 'NULL')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
