import type { Scorecard } from '../scorecard.ts';
import type { TraceDiff } from '../traceDiff.ts';

const LABELS: Record<keyof Scorecard, string> = {
  steps: 'trace steps',
  diskReads: 'disk reads',
  hits: 'buffer hits',
  evictions: 'evictions',
  btreeReads: 'B+Tree node reads',
  locks: 'locks acquired',
  rows: 'rows returned',
  usedIndex: 'index used',
};

/** What changed since this same query last ran, in `/compare`'s own terms. */
export function TraceDiffNote({ diff }: { diff: TraceDiff }) {
  const unchanged = diff.changes.length === 0 && !diff.planChanged;
  return (
    <section aria-label="Since your last run" className="rounded-xl border border-edge bg-surface-2 p-3 text-label text-ink-dim shadow-e1">
      <h2 className="mb-1 font-medium tracking-[0.12em] uppercase">Since your last run</h2>
      {unchanged ? (
        <p>Nothing measurable has changed since your last run.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {diff.changes.map((c) => (
            <li key={c.key}>
              {LABELS[c.key]}: <span className="tabular-nums text-ink">{c.before} → {c.after}</span>
            </li>
          ))}
          {diff.planChanged && (
            <li>
              plan changed: <span className="font-mono text-ink">{diff.planBefore || 'nothing planned'}</span> →{' '}
              <span className="font-mono text-ink">{diff.planAfter || 'nothing planned'}</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
