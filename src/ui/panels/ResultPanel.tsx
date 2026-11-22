import type { Row } from '../../engine/index.ts';
import { ScrollRegion } from '../ScrollRegion.tsx';

export function ResultPanel({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="text-body text-ink-dim">No rows yet — run the query to the end.</p>;
  }

  const columns = Object.keys(rows[0]!);

  return (
    <ScrollRegion label="Query result" cue={false} className="h-full overflow-auto rounded-xl border border-edge shadow-e1">
      <table className="w-full border-collapse text-left font-mono text-label">
        <thead>
          <tr className="sticky top-0 z-10 border-b border-edge bg-surface-2/95 text-ink-dim backdrop-blur-sm">
            {columns.map((c) => (
              <th
                key={c}
                className="px-3 py-2 font-medium tracking-[0.06em] uppercase"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
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
  );
}
