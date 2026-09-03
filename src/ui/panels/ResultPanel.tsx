import type { Row } from '../../engine/index.ts';

export function ResultPanel({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="text-body text-ink-dim">No rows yet — run the query to the end.</p>;
  }
  const columns = Object.keys(rows[0]!);

  return (
    // Scrolls inside the fixed-height stage panel: a result set can be any
    // size, and the playback controls below must not move to accommodate it.
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-left font-mono text-label">
        <thead>
          {/* Sticky, so the columns stay readable while scrolling a long result. */}
          <tr className="sticky top-0 z-10 border-b border-edge bg-surface-2 text-ink-dim">
            {columns.map((c) => (
              <th key={c} className="bg-surface-2 px-2 py-1.5 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            /* plan.md §16.2 item 4, neutral rule. A row is not a control, so no
               `cursor-pointer` — but a result set is the one place in the app
               where the reader's eye has to travel a long horizontal line
               without losing it, and a row highlight is the oldest fix there is
               for that. */
            <tr key={i} className="cell border-b border-edge/50 hover:bg-surface-4">
              {columns.map((c) => (
                <td key={c} className="px-2 py-1.5">{String(row[c] ?? 'NULL')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
