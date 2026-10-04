import { finalPlan } from '../engine/index.ts';
import type { PlanNode, RunResult } from '../engine/index.ts';
import { scoreOf } from './scorecard.ts';
import type { Scorecard } from './scorecard.ts';

/**
 * plan.md §G6 "trace diff": what changed since this query last ran. The numbers are `/compare`'s own scorecard, so
 * the two views cannot disagree about what a run cost. The plan is compared by its operator shape, not its text, so
 * a change in which index or join algorithm was picked shows up even when the row count did not move.
 *
 * Last-run summaries live in `localStorage`, per viewer, keyed by the SQL text. That is a per-viewer convenience:
 * nothing reaches a server, and every read and write tolerates storage being unavailable or full.
 */

export interface StoredRun {
  score: Scorecard;
  signature: string;
}

export interface MetricChange {
  key: keyof Scorecard;
  before: number;
  after: number;
}

export interface TraceDiff {
  changes: MetricChange[];
  planBefore: string;
  planAfter: string;
  planChanged: boolean;
}

/** The numeric scorecard fields a diff can report. `usedIndex` is a flag, so it is reported through the plan instead. */
const DIFF_KEYS: readonly (keyof Scorecard)[] = ['steps', 'diskReads', 'hits', 'evictions', 'btreeReads', 'locks', 'rows'];

const STORAGE_KEY = 'querylens.lastRun.v1';
const MAX_STORED_QUERIES = 20;

function operatorsOf(node: PlanNode, out: string[]): void {
  out.push(node.table === undefined ? node.op : `${node.op} ${node.table}`);
  for (const child of node.children ?? []) operatorsOf(child, out);
}

/** The optimizer's final plan as a preorder list of operators, joined by arrows. Empty when nothing was planned. */
export function planSignature(result: RunResult): string {
  const plan = finalPlan(result.events);
  if (!plan) return '';
  const ops: string[] = [];
  operatorsOf(plan, ops);
  return ops.join(' > ');
}

export function summarize(result: RunResult): StoredRun {
  return { score: scoreOf(result), signature: planSignature(result) };
}

export function diffRuns(before: StoredRun, after: StoredRun): TraceDiff {
  const changes: MetricChange[] = [];
  for (const key of DIFF_KEYS) {
    const b = before.score[key] as number;
    const a = after.score[key] as number;
    if (a !== b) changes.push({ key, before: b, after: a });
  }
  return {
    changes,
    planBefore: before.signature,
    planAfter: after.signature,
    planChanged: before.signature !== after.signature,
  };
}

function isStoredRun(value: unknown): value is StoredRun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<StoredRun>;
  if (typeof v.signature !== 'string' || typeof v.score !== 'object' || v.score === null) return false;
  const score: Partial<Record<keyof Scorecard, unknown>> = v.score;
  return DIFF_KEYS.every((k) => typeof score[k] === 'number');
}

/** Every stored run, keyed by SQL text. An unreadable, corrupt or unavailable store reads as empty. */
export function readLastRuns(): Record<string, StoredRun> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, StoredRun> = {};
    for (const [sql, run] of Object.entries(parsed)) if (isStoredRun(run)) out[sql] = run;
    return out;
  } catch {
    return {};
  }
}

/** Records a run, moving its query to the most recent position and dropping the oldest beyond the cap. */
export function writeLastRun(sql: string, run: StoredRun): void {
  try {
    const runs = readLastRuns();
    delete runs[sql];
    runs[sql] = run;
    const keys = Object.keys(runs);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_STORED_QUERIES))) delete runs[old];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch {
    // Storage full or disabled: the diff simply does not persist this run.
  }
}
