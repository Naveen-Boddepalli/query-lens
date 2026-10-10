/**
 * A schedule as a share URL (plan.md §25.4 D1): the interleaving *is* the input, so the whole experiment — who ran
 * what, in what order — travels in one query parameter, the same way a Playground moment does.
 *
 * Encoded as JSON, `[["A","BEGIN"],["B","SELECT …"],…]`, and left to `URLSearchParams` to percent-encode: SQL is full
 * of characters (`;`, `:`, quotes) that a hand-rolled separator would have to escape. Decoding is total — a pasted link
 * is untrusted input, so anything that is not a short list of well-formed steps decodes to nothing rather than throwing.
 */

import { MAX_SCHEDULE_STEPS } from '../engine/schedule.ts';
import type { ScheduleStep } from '../engine/schedule.ts';

export const SESSIONS = ['A', 'B'] as const;
export type SessionName = (typeof SESSIONS)[number];

/** Long enough for any statement the tool's presets use, short enough that a link cannot be abused as storage. */
export const MAX_STATEMENT_LENGTH = 400;

export function encodeSchedule(steps: readonly ScheduleStep[]): string {
  return JSON.stringify(steps.map((s) => [s.session, s.sql]));
}

export function decodeSchedule(raw: string | null): ScheduleStep[] | null {
  if (raw === null || raw.length === 0 || raw.length > 20_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SCHEDULE_STEPS) return null;
  const steps: ScheduleStep[] = [];
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [session, sql] = item as unknown[];
    if (session !== 'A' && session !== 'B') return null;
    if (typeof sql !== 'string' || sql.length === 0 || sql.length > MAX_STATEMENT_LENGTH) return null;
    steps.push({ session, sql });
  }
  return steps;
}
