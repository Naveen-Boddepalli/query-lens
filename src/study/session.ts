import type { PerfSummary } from '../perf/inp.ts';
import type { StudyArm, StudyPack } from './pack.ts';
import { MAX_ANSWER, RESULT_VERSION } from './result.ts';
import type { StudyResult } from './result.ts';

/**
 * plan.md §25.4 A2 — one participant's session as a pure state machine.
 *
 * `consent → material → test → done`, driven by wall-clock timestamps rather
 * than a counter, so a throttled background tab, a reload or a closed laptop
 * lid cannot make a session longer or shorter: the time left is always
 * `start + allowance − now`. Every transition is a pure function of
 * `(session, now)` — the page only calls them — so the whole protocol is
 * unit-testable without a DOM or a clock.
 *
 * Persisted in `localStorage` (try/catch, degrade to "no saved session", the
 * `learnProgress.ts` discipline) so a reload mid-test resumes rather than
 * restarts. It never leaves the browser; `clearSession` is the participant's
 * "delete this from my machine".
 */

export type Phase = 'consent' | 'material' | 'test' | 'done';

const PHASES: readonly Phase[] = ['consent', 'material', 'test', 'done'];

export interface Session {
  v: 1;
  /** The pack code this session belongs to; a different link is a different session. */
  code: string;
  // Copied out of the validated pack so the transitions below stay pure.
  study: string;
  pid: string;
  arm: StudyArm;
  materialSeconds: number;
  testSeconds: number;
  questionIds: string[];

  phase: Phase;
  /** Milliseconds since the epoch; `null` until that phase begins. */
  consentAt: number | null;
  materialStartedAt: number | null;
  testStartedAt: number | null;
  finishedAt: number | null;
  timedOut: boolean;
  answers: Record<string, string>;
  /**
   * plan.md §25.4 A6 — the participant ticked the *optional* box to have this
   * device's interaction timing (INP) recorded and included in the result code.
   * Separate from consent to the study itself: declining changes nothing else.
   */
  perfOptIn: boolean;
  /** Filled in asynchronously once the session is done (compression is async). */
  resultCode: string | null;
}

export function newSession(code: string, pack: StudyPack): Session {
  return {
    v: 1,
    code,
    study: pack.study,
    pid: pack.pid,
    arm: pack.arm,
    materialSeconds: pack.material.seconds,
    testSeconds: pack.test.seconds,
    questionIds: pack.test.questions.map((q) => q.id),
    phase: 'consent',
    consentAt: null,
    materialStartedAt: null,
    testStartedAt: null,
    finishedAt: null,
    timedOut: false,
    answers: {},
    perfOptIn: false,
    resultCode: null,
  };
}

/** Whole seconds remaining (rounded up, floored at 0) from `startedAt` for `total` seconds. */
export function secondsLeft(now: number, startedAt: number, total: number): number {
  return Math.max(0, Math.ceil((startedAt + total * 1000 - now) / 1000));
}

/** `m:ss`, or `mm:ss` — for the countdown. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

export function materialLeft(s: Session, now: number): number {
  return s.materialStartedAt === null ? s.materialSeconds : secondsLeft(now, s.materialStartedAt, s.materialSeconds);
}

export function testLeft(s: Session, now: number): number {
  return s.testStartedAt === null ? s.testSeconds : secondsLeft(now, s.testStartedAt, s.testSeconds);
}

/** The participant agreed: the material clock starts now. `perfOptIn` is the separate, optional box. */
export function agree(s: Session, now: number, perfOptIn = false): Session {
  if (s.phase !== 'consent') return s;
  return { ...s, phase: 'material', consentAt: now, materialStartedAt: now, perfOptIn };
}

/** Both arms get the same fixed time with the material — the point of a control. */
export function canStartTest(s: Session, now: number): boolean {
  return s.phase === 'material' && materialLeft(s, now) === 0;
}

export function startTest(s: Session, now: number): Session {
  if (!canStartTest(s, now)) return s;
  return { ...s, phase: 'test', testStartedAt: now };
}

export function setAnswer(s: Session, id: string, text: string): Session {
  if (s.phase !== 'test' || !s.questionIds.includes(id)) return s;
  return { ...s, answers: { ...s.answers, [id]: text.slice(0, MAX_ANSWER) } };
}

export function finish(s: Session, at: number, timedOut: boolean): Session {
  if (s.phase !== 'test') return s;
  return { ...s, phase: 'done', finishedAt: at, timedOut };
}

/**
 * Advance a session across a deadline — called on load and every second.
 * Finishing is stamped at the *deadline*, not at `now`, so a session that was
 * reopened long after its clock ran out still records the time it really had.
 */
export function tick(s: Session, now: number): Session {
  if (s.phase === 'test' && s.testStartedAt !== null && testLeft(s, now) === 0) {
    return finish(s, s.testStartedAt + s.testSeconds * 1000, true);
  }
  return s;
}

/**
 * `perf` is the timing captured when the session ended (plan.md §25.4 A6); it is
 * used only for a participant who opted in, so a summary passed for someone who
 * did not can never leak into their code.
 */
export function toResult(s: Session, build: string, perf?: PerfSummary | null): StudyResult | null {
  if (s.phase !== 'done' || s.consentAt === null || s.testStartedAt === null || s.finishedAt === null) return null;
  return {
    v: RESULT_VERSION,
    study: s.study,
    pid: s.pid,
    arm: s.arm,
    startedAt: new Date(s.consentAt).toISOString(),
    finishedAt: new Date(s.finishedAt).toISOString(),
    materialSeconds: s.materialSeconds,
    testSeconds: s.testSeconds,
    testUsedSeconds: Math.min(s.testSeconds, Math.max(0, Math.round((s.finishedAt - s.testStartedAt) / 1000))),
    timedOut: s.timedOut,
    answers: s.questionIds.map((id) => ({ id, text: s.answers[id] ?? '' })),
    build,
    ...(s.perfOptIn && perf ? { perf } : {}),
  };
}

/* ----- persistence ------------------------------------------------------- */

const KEY = 'querylens:study';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const nullableTime = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x));

/** A stored session is the participant's own data, but still parsed defensively. */
export function parseSession(raw: unknown): Session | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const { code, study, pid, arm, materialSeconds, testSeconds, questionIds, phase } = raw;
  if (
    typeof code !== 'string' || typeof study !== 'string' || typeof pid !== 'string' ||
    (arm !== 'app' && arm !== 'text') ||
    typeof materialSeconds !== 'number' || typeof testSeconds !== 'number' ||
    !Array.isArray(questionIds) ||
    typeof phase !== 'string' || !PHASES.includes(phase as Phase) ||
    !nullableTime(raw.consentAt) || !nullableTime(raw.materialStartedAt) ||
    !nullableTime(raw.testStartedAt) || !nullableTime(raw.finishedAt) ||
    typeof raw.timedOut !== 'boolean' || !isRecord(raw.answers) ||
    (raw.resultCode !== null && typeof raw.resultCode !== 'string')
  ) {
    return null;
  }
  const ids = questionIds.filter((q): q is string => typeof q === 'string');
  if (ids.length !== questionIds.length) return null;
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.answers)) if (typeof v === 'string') answers[k] = v.slice(0, MAX_ANSWER);
  return {
    v: 1, code, study, pid, arm, materialSeconds, testSeconds,
    questionIds: ids,
    phase: phase as Phase,
    consentAt: raw.consentAt, materialStartedAt: raw.materialStartedAt,
    testStartedAt: raw.testStartedAt, finishedAt: raw.finishedAt,
    timedOut: raw.timedOut, answers,
    // Sessions saved before A6 have no such field: they did not opt in.
    perfOptIn: raw.perfOptIn === true,
    resultCode: raw.resultCode,
  };
}

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeSession(s: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage is blocked: the session still runs, it just will not survive a reload.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
