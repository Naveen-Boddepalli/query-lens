import type { PerfSummary } from '../perf/inp.ts';
import { pack, unpack } from './codec.ts';
import type { StudyArm } from './pack.ts';

/**
 * plan.md §25.4 A2 — what a participant hands back: one copyable string.
 *
 * The page never transmits it. The participant pastes it into a message to the
 * researcher, which is what keeps the kit's "no network" true and needs no
 * server. `pnpm study collate` turns a pile of these into a blind scoring sheet.
 *
 * It carries the arm, because the researcher needs it to compare groups — the
 * *blind* step (STUDY.md §3: score without the arm label) is `collate`'s job,
 * which strips it from what the scorer sees.
 */

export const RESULT_VERSION = 1;
/** A recognisable prefix so a code pasted into the wrong place is obvious. */
export const RESULT_PREFIX = 'QLS1.';

export interface StudyResult {
  v: typeof RESULT_VERSION;
  study: string;
  pid: string;
  arm: StudyArm;
  /** ISO time the participant consented. */
  startedAt: string;
  finishedAt: string;
  /** The time the participant was given, and how much of the test they used. */
  materialSeconds: number;
  testSeconds: number;
  testUsedSeconds: number;
  /** True when the clock ended the test rather than the participant. */
  timedOut: boolean;
  answers: { id: string; text: string }[];
  /** The build that ran the session (`<meta name="querylens:build">`). */
  build: string;
  /**
   * plan.md §25.4 A6 — present only when the participant ticked the optional
   * "record how responsive the app felt" box. INP in milliseconds (or `null`
   * where the browser cannot measure it) plus enough device context to read it.
   */
  perf?: PerfSummary;
}

export const MAX_ANSWER = 4000;

export type ResultParse = { ok: true; result: StudyResult } | { ok: false; error: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A `perf` block is a stranger's input like everything else: bounded numbers, or nothing. */
export function parsePerf(raw: unknown): PerfSummary | null {
  if (!isRecord(raw)) return null;
  const { inp, interactions, cores, viewportPx, touch } = raw;
  const inRange = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  if (
    !(inp === null || inRange(inp, 600_000)) ||
    !inRange(interactions, 1_000_000) || !inRange(cores, 4096) || !inRange(viewportPx, 100_000) ||
    typeof touch !== 'boolean'
  ) {
    return null;
  }
  return { inp, interactions: Math.floor(interactions), cores: Math.floor(cores), viewportPx: Math.floor(viewportPx), touch };
}

export function validateResult(raw: unknown): ResultParse {
  if (!isRecord(raw) || raw.v !== RESULT_VERSION) return { ok: false, error: 'not a study result' };
  const text = (k: string, max: number): string | null => {
    const v = raw[k];
    return typeof v === 'string' && v.length <= max ? v : null;
  };
  const num = (k: string): number | null => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  };

  const study = text('study', 40);
  const pid = text('pid', 40);
  const startedAt = text('startedAt', 40);
  const finishedAt = text('finishedAt', 40);
  const build = text('build', 80);
  const materialSeconds = num('materialSeconds');
  const testSeconds = num('testSeconds');
  const testUsedSeconds = num('testUsedSeconds');
  if (
    study === null || pid === null || startedAt === null || finishedAt === null || build === null ||
    materialSeconds === null || testSeconds === null || testUsedSeconds === null ||
    (raw.arm !== 'app' && raw.arm !== 'text') || typeof raw.timedOut !== 'boolean' ||
    !Array.isArray(raw.answers) || raw.answers.length > 8
  ) {
    return { ok: false, error: 'a field is missing or malformed' };
  }
  // Optional, but if it is there it must be well-formed — a half-valid block is worse than none.
  const perf = raw.perf === undefined ? undefined : parsePerf(raw.perf);
  if (perf === null) return { ok: false, error: 'the perf block is malformed' };
  const answers: { id: string; text: string }[] = [];
  for (const a of raw.answers as unknown[]) {
    if (!isRecord(a) || typeof a.id !== 'string' || typeof a.text !== 'string' || a.text.length > MAX_ANSWER) {
      return { ok: false, error: 'an answer is malformed' };
    }
    answers.push({ id: a.id, text: a.text });
  }
  return {
    ok: true,
    result: {
      v: RESULT_VERSION, study, pid, arm: raw.arm, startedAt, finishedAt,
      materialSeconds, testSeconds, testUsedSeconds, timedOut: raw.timedOut, answers, build,
      ...(perf ? { perf } : {}),
    },
  };
}

export async function encodeResult(r: StudyResult): Promise<string> {
  return RESULT_PREFIX + (await pack(r));
}

export async function decodeResult(code: string): Promise<ResultParse> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(RESULT_PREFIX)) return { ok: false, error: `does not start with ${RESULT_PREFIX}` };
  const raw = await unpack(trimmed.slice(RESULT_PREFIX.length));
  if (raw === null) return { ok: false, error: 'damaged or incomplete' };
  return validateResult(raw);
}
