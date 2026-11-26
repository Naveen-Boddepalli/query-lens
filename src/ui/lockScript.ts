/**
 * A sequence of lock requests and releases on the locks sandbox (`/tools/locks`), as text and as a run.
 *
 * The sandbox used to hold only its current state, so a visit could not be sent to anyone and a lesson could not
 * open it on the situation it was about. A script is the whole of it: each step is a line — `T1 shared 0`,
 * `T2 exclusive 1`, `T1 release shared 0` — folded over an empty lock table by the same `request` and `release` the
 * page applies one click at a time. The lines are also what the locks challenges are written in, and what a link
 * carries. Decoding is total: a pasted link is a stranger's input, so anything that is not a short list of
 * well-formed lines decodes to nothing rather than throwing.
 */

import { emptyState, release, request } from './lockSimulation.ts';
import type { LockMode, SimState } from './lockSimulation.ts';

export const LOCK_TRANSACTIONS = ['T1', 'T2'] as const;
export type LockTransaction = (typeof LOCK_TRANSACTIONS)[number];

/** The numbered pages the sandbox has. */
export const LOCK_PAGES = [0, 1, 2, 3] as const;

/** A script, like a schedule, is a bounded input: a size limit, not a security boundary. */
export const MAX_LOCK_STEPS = 40;

export interface LockStep {
  op: 'request' | 'release';
  transaction: LockTransaction;
  page: number;
  mode: LockMode;
}

const MODES: Record<string, LockMode> = {
  shared: 'shared',
  s: 'shared',
  exclusive: 'exclusive',
  x: 'exclusive',
  // The intention modes (plan.md §27.5 T2), by name or by their letters.
  'intention-shared': 'intention-shared',
  is: 'intention-shared',
  'intention-exclusive': 'intention-exclusive',
  ix: 'intention-exclusive',
  'shared-intention-exclusive': 'shared-intention-exclusive',
  six: 'shared-intention-exclusive',
};

/** `T1 shared 0`, `t2 x 1`, `T1 ix 2` or `T1 release shared 0`; null for anything else. */
export function parseLockStep(text: string): LockStep | null {
  const m = /^(t[12])\s+(?:(release|unlock)\s+)?(shared-intention-exclusive|intention-shared|intention-exclusive|shared|exclusive|six|is|ix|s|x)\s+([0-3])$/i.exec(
    text.trim(),
  );
  if (!m) return null;
  return {
    op: m[2] === undefined ? 'request' : 'release',
    transaction: m[1]!.toUpperCase() as LockTransaction,
    mode: MODES[m[3]!.toLowerCase()]!,
    page: Number(m[4]),
  };
}

export function formatLockStep(step: LockStep): string {
  return `${step.transaction} ${step.op === 'release' ? 'release ' : ''}${step.mode} ${String(step.page)}`;
}

/** What one step did: the kind of outcome, and the words the sandbox narrates it in. */
export interface LockEntry {
  step: LockStep;
  kind: 'granted' | 'already-held' | 'blocked' | 'deadlock' | 'transaction-aborted' | 'released' | 'not-held';
  lines: string[];
  /** For `deadlock`: the transaction that was aborted. */
  victim?: string;
}

export interface LockRun {
  state: SimState;
  entries: LockEntry[];
}

/** Folds `steps` over an empty lock table, the way the page applies them one at a time. */
export function runLockSteps(steps: readonly LockStep[]): LockRun {
  let state = emptyState();
  const entries: LockEntry[] = [];
  for (const step of steps.slice(0, MAX_LOCK_STEPS)) {
    if (step.op === 'request') {
      const outcome = request(state, step.transaction, step.page, step.mode);
      state = outcome.state;
      entries.push({
        step,
        kind: outcome.kind,
        lines: outcome.narration,
        ...(outcome.victim === undefined ? {} : { victim: outcome.victim }),
      });
    } else {
      const outcome = release(state, step.transaction, step.page, step.mode);
      const held = outcome.state !== state;
      state = outcome.state;
      entries.push({ step, kind: held ? 'released' : 'not-held', lines: outcome.narration });
    }
  }
  return { state, entries };
}

export function encodeLockSteps(steps: readonly LockStep[]): string {
  return JSON.stringify(steps.map(formatLockStep));
}

export function decodeLockSteps(raw: string | null): LockStep[] | null {
  if (raw === null || raw.length === 0 || raw.length > 4_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_LOCK_STEPS) return null;
  const steps: LockStep[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length > 40) return null;
    const step = parseLockStep(item);
    if (!step) return null;
    steps.push(step);
  }
  return steps;
}
