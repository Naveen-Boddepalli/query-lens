/**
 * Runs a settings challenge: reads the numbers the player chose, checks they are ones the tool accepts, runs the
 * tool's own driver on them and applies the challenge's check — a pure predicate over what the driver made, as the
 * query and script challenges' checks are over what the engine did.
 *
 * The checks are one module per tool (`settings/*.ts`), each importing only that tool's driver, and this file loads
 * the one a challenge needs when it needs it: opening a sort challenge fetches the sort, not the isolation engines
 * the matrix challenge runs. What is left here imports no driver, which is why the view's own chunk is small.
 *
 * Each driver is called the way its tool's page calls it (same demo data, same seed), so the numbers a player reads
 * here are the numbers the tool shows for the same settings; `__tests__/settingsChallenges.test.ts` holds that, and
 * holds every check against its known solution and the near-misses it must reject.
 */

import type { ChallengeOutcome } from './outcome.ts';
import type { SettingsChallenge, SettingsTool } from './settingsChallenges.tsx';
import type { Checkers, Values } from './settings/shared.ts';

export type SettingsRun = ChallengeOutcome;

/**
 * One loader per tool. Written out, one literal import each, so the bundler sees every module and makes a chunk of it;
 * typed over `SettingsTool` so a tool added to the list without a checker module is a type error, not a runtime one.
 */
const LOADERS: Record<SettingsTool, () => Promise<{ CHECKERS: Checkers }>> = {
  sort: () => import('./settings/sort.ts'),
  'hash-join': () => import('./settings/hash-join.ts'),
  'join-order': () => import('./settings/join-order.ts'),
  histograms: () => import('./settings/histograms.ts'),
  page: () => import('./settings/page.ts'),
  'hash-index': () => import('./settings/hash-index.ts'),
  lsm: () => import('./settings/lsm.ts'),
  columnar: () => import('./settings/columnar.ts'),
  'latch-crabbing': () => import('./settings/latch-crabbing.ts'),
  'vector-index': () => import('./settings/vector-index.ts'),
  'buffer-pool': () => import('./settings/buffer-pool.ts'),
  planner: () => import('./settings/planner.ts'),
  btree: () => import('./settings/btree.ts'),
  isolation: () => import('./settings/isolation.ts'),
};

const loaded = new Map<SettingsTool, Promise<Checkers>>();

/** A tool's checks, fetched once. A failed fetch is forgotten, so the next try asks again. */
export function loadCheckers(tool: SettingsTool): Promise<Checkers> {
  let promise = loaded.get(tool);
  if (!promise) {
    promise = LOADERS[tool]().then((m) => m.CHECKERS);
    promise.catch(() => { loaded.delete(tool); });
    loaded.set(tool, promise);
  }
  return promise;
}

/** The tools that have checks, as the tests walk them. */
export const SETTINGS_TOOLS = Object.keys(LOADERS) as SettingsTool[];

function problemWith(message: string): SettingsRun {
  return { problem: message, passed: false, facts: [], tables: [], toolHref: null };
}

/** Reads the form's text into numbers and options, or says which one is not something the tool accepts. */
export function readValues(challenge: SettingsChallenge, raw: Readonly<Record<string, string>>): Values | string {
  const out: Values = {};
  for (const control of challenge.controls) {
    const text = (raw[control.key] ?? '').trim();
    if (control.kind === 'select') {
      if (!control.options.some((o) => o.value === text)) return `Choose a value for ${control.label}.`;
      out[control.key] = text;
      continue;
    }
    if (control.kind === 'text') {
      if (text === '') return `${control.label} cannot be empty.`;
      if (text.length > control.max) return `${control.label} is at most ${String(control.max)} characters.`;
      out[control.key] = text;
      continue;
    }
    if (control.kind === 'checks') {
      const picked = text === '' ? [] : text.split(',');
      if (!picked.every((p) => control.options.some((o) => o.value === p))) return `Choose ${control.label} from the list.`;
      out[control.key] = picked.join(',');
      continue;
    }
    const value = Number(text);
    if (text === '' || !Number.isInteger(value) || value < control.min || value > control.max) {
      return `${control.label} must be a whole number from ${String(control.min)} to ${String(control.max)}.`;
    }
    out[control.key] = value;
  }
  return out;
}

/** The run itself, given the tool's checks: read the form, apply the challenge's check, shape the outcome. */
export function runWith(
  checkers: Checkers,
  challenge: SettingsChallenge,
  raw: Readonly<Record<string, string>>,
): SettingsRun {
  const checker = checkers[challenge.id];
  if (!checker) throw new Error(`settings challenge ${challenge.id} has no check in the ${challenge.tool} module`);
  const values = readValues(challenge, raw);
  if (typeof values === 'string') return problemWith(values);
  const verdict = checker(values);
  if (verdict.problem !== undefined) return problemWith(verdict.problem);
  return {
    problem: null,
    passed: verdict.passed,
    facts: verdict.facts,
    tables: verdict.tables ?? [],
    toolHref: verdict.toolHref,
  };
}

/** What the view calls: loads the challenge's own tool, then runs. A tool that will not load is said in words. */
export async function runSettings(
  challenge: SettingsChallenge,
  raw: Readonly<Record<string, string>>,
): Promise<SettingsRun> {
  let checkers: Checkers;
  try {
    checkers = await loadCheckers(challenge.tool);
  } catch {
    return problemWith('The checker for this tool could not be loaded. Check the connection and run it again.');
  }
  return runWith(checkers, challenge, raw);
}
