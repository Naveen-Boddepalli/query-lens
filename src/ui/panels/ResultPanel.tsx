import type { Row } from '../../engine/index.ts';

export function ResultPanel({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-dim">No rows yet — run the query to the end.</p>;
  }
  const columns = Object.keys(rows[0]!);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left font-mono text-xs">
        <thead>
          <tr className="border-b border-edge text-ink-dim">
            {columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-edge/50">
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
