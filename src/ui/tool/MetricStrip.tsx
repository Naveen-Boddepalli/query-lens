import type { ReactNode } from 'react';
import { metricLabel, metricValue } from '../primitives.ts';

export interface Metric {
  label: string;
  value: ReactNode;
  /** A qualifier under the value ("of 25 steps"). */
  sub?: ReactNode;
  /** Colours the value with a result token: a hit is good, a miss costs, an eviction loses something. */
  tone?: 'hit' | 'miss' | 'evict';
}

const TONE: Record<NonNullable<Metric['tone']>, string> = { hit: 'text-hit!', miss: 'text-miss!', evict: 'text-evict!' };

/**
 * One readout style for every tool (§4.3), replacing the four hand-built KPI cards and their uppercase mono labels.
 * A description list in one bordered strip: two columns on a phone, as many as fit from there.
 */
export function MetricStrip({ items, label = 'Readout' }: { items: readonly Metric[]; label?: string }) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-edge bg-edge shadow-e1 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]"
    >
      {items.map((m) => (
        <div key={m.label} className="flex min-w-0 flex-col gap-0.5 bg-surface-2 px-4 py-3">
          <dt className={metricLabel}>{m.label}</dt>
          <dd className={`${metricValue} ${m.tone ? TONE[m.tone] : ''}`}>{m.value}</dd>
          {m.sub !== undefined && <dd className="text-label text-ink-dim/80">{m.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}
