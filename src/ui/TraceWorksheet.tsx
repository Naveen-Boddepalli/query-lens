import { BUILD_SHA } from '../buildInfo.ts';
import { REPLACEMENT_POLICY_LABELS } from '../engine/index.ts';
import type { DatasetId, ReplacementPolicyName, StepEvent } from '../engine/index.ts';

/**
 * plan.md §22.6: the current query and its whole trace as a paper worksheet,
 * for a room without laptops (and the §9 study's control-group artefact).
 *
 * On screen this is `display: none` (`.print-only`); `@media print` in
 * `src/index.css` reveals the one `[data-print]` region and strips the rest.
 * It carries no interactivity — a printed page has nowhere to click — just the
 * query, the run's settings, and a numbered list of every step's narration,
 * with the predict-then-reveal steps marked so a printed worksheet can be
 * worked through in order.
 */
export function TraceWorksheet({
  sql,
  policy,
  predictOn,
  dataset,
  events,
  rowCount,
}: {
  sql: string;
  policy: ReplacementPolicyName;
  predictOn: boolean;
  dataset: DatasetId;
  events: readonly StepEvent[];
  rowCount: number;
}) {
  return (
    // `display: none` on screen already keeps this out of the a11y tree; it
    // becomes a real document only under `@media print`.
    <div data-print className="print-only">
      <h1 className="text-heading font-semibold">QueryLens trace worksheet</h1>

      <pre className="mt-2 font-mono text-body whitespace-pre-wrap">{sql.trim()}</pre>

      <p className="mt-2 text-label">
        table <strong>{dataset}</strong> · {REPLACEMENT_POLICY_LABELS[policy]} ·{' '}
        prediction {predictOn ? 'on' : 'off'} · {events.length} step
        {events.length === 1 ? '' : 's'}
        {events.length > 0 && ` · ${rowCount} row${rowCount === 1 ? '' : 's'} returned`}
      </p>

      {events.length === 0 ? (
        <p className="mt-4 text-body">This query did not run — there is no trace to work through.</p>
      ) : (
        <ol className="mt-4 space-y-1.5">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3 text-body leading-relaxed">
              <span className="shrink-0 font-mono text-label tabular-nums">
                {String(e.id).padStart(3, '0')}
              </span>
              <span className="shrink-0 font-mono text-label uppercase">{e.stage}</span>
              <span className="min-w-0">
                {e.label}
                {predictOn && e.predictable && <strong> — predict first</strong>}
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-6 text-label">querylens · build {BUILD_SHA} · printed {new Date().toISOString().slice(0, 10)}</p>
    </div>
  );
}
