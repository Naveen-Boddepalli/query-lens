/**
 * A schedule's lanes as rows (plan.md §H6): one row per record the run made, the same facts as the lanes, in reading
 * order, for a screen reader to walk and for anyone who would rather scan a column than a grid.
 */

import type { ScheduleStepResult } from '../engine/schedule.ts';
import type { TableColumn } from './DataView.tsx';

export interface ScheduleRow {
  /** The step's place in the schedule that was written, which is not always the order things happened. */
  n: number;
  session: string;
  statement: string;
  happened: string;
  result: string;
  flagged: string;
}

const PHASE: Record<ScheduleStepResult['phase'], string> = {
  ran: 'ran',
  queued: 'waits behind its session',
  blocked: 'blocked on a lock',
  resumed: 'resumed',
  victim: 'rolled back',
};

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

export function scheduleRows(steps: readonly ScheduleStepResult[]): ScheduleRow[] {
  return steps.map((s): ScheduleRow => {
    let result = '';
    if (s.error) result = s.error;
    else if (s.kind === 'statement' && s.run && !s.run.write && s.phase !== 'queued' && s.phase !== 'blocked') {
      result = `${plural(s.rows.length, 'row')} returned`;
    } else if (s.notes.length > 0) result = s.notes[0]!;
    return {
      n: s.index + 1,
      session: s.session,
      statement: s.sql,
      happened:
        s.phase === 'blocked' && s.waitingOn && s.waitingOn.length > 0
          ? `blocked on a lock held by ${s.waitingOn.join(' and ')}`
          : PHASE[s.phase],
      result,
      flagged: s.anomalies.length === 0 ? '—' : [...new Set(s.anomalies.map((a) => a.kind))].join(', '),
    };
  });
}

export const SCHEDULE_COLUMNS: readonly TableColumn<ScheduleRow>[] = [
  { header: 'Step', cell: (r) => r.n },
  { header: 'Session', cell: (r) => r.session },
  { header: 'Statement', cell: (r) => r.statement },
  { header: 'What happened', cell: (r) => r.happened },
  { header: 'Result', cell: (r) => r.result },
  { header: 'Flagged', cell: (r) => r.flagged },
];
