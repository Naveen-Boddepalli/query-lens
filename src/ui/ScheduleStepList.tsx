import type { ScheduleStepResult } from '../engine/schedule.ts';
import { card, pill } from './primitives.ts';

/** A schedule's records in the order things happened, each with what it did, saw, and was told. Read-only. */

const PHASE_NOTE: Partial<Record<ScheduleStepResult['phase'], string>> = {
  blocked: 'waits for a lock',
  queued: 'waits behind its session',
  resumed: 'resumed',
  victim: 'rolled back',
};

export function StepList({ steps }: { steps: ScheduleStepResult[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, at) => {
        const note = PHASE_NOTE[step.phase];
        return (
          <li key={`${String(at)}-${String(step.index)}-${step.phase}`} className={`${card} ${step.anomalies.length > 0 ? 'border-evict/60' : ''}`}>
            <div className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
              <span className="tabular-nums">{step.index + 1}.</span>
              <span className={pill}>{step.session}</span>
              {note && <span className="rounded-full border border-edge px-2 py-0.5 text-ink">{note}</span>}
            </div>
            <code className="mt-1 block break-words font-mono text-label text-ink">{step.sql}</code>
            {step.error && <p className="mt-1 text-label text-evict">{step.error}</p>}
            {step.kind === 'statement' && step.run && !step.run.write && !step.error && step.rows.length > 0 && step.rows.length <= 3 && (
              <p className="mt-1 font-mono text-label text-ink">{step.rows.map((r) => JSON.stringify(r)).join(' ')}</p>
            )}
            {step.kind === 'statement' && step.run && !step.run.write && !step.error && step.rows.length > 3 && (
              <p className="mt-1 text-label text-ink-dim">{step.rows.length} rows, including {step.rows.slice(0, 2).map((r) => JSON.stringify(r)).join(' ')}</p>
            )}
            <ul className="mt-1 space-y-0.5 text-label text-ink-dim">
              {step.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
