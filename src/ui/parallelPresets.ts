import { DATASETS } from '../engine/datasets.ts';
import { DISPATCHES, PARALLEL_LIMITS, runParallel } from '../engine/parallel.ts';
import type { Dispatch, ParallelOptions, ParallelResult } from '../engine/parallel.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../engine/types.ts';

/**
 * plan.md §27.5 P1: what `/tools/parallel` runs and how its link reads — the queries on the transactions preset, the
 * dispatchers' names, and the one call into the engine that the page, its lesson and its challenge all make, so the
 * numbers each quotes are the numbers the page shows.
 */

export interface ParallelQuery {
  id: string;
  label: string;
  sql: string;
  /** What is uneven about it, if anything. */
  about: string;
}

export const PARALLEL_QUERIES: readonly ParallelQuery[] = [
  {
    id: 'grouped',
    label: 'Totals by status',
    sql: 'SELECT status, COUNT(*), SUM(amount) FROM transactions GROUP BY status',
    about: 'Every row counts, so every page is as much work as the next.',
  },
  {
    id: 'corner',
    label: 'One corner',
    sql: 'SELECT COUNT(*), SUM(amount) FROM transactions WHERE id <= 600',
    about: 'Only the first 600 rows match, and they sit on the first 150 of 750 pages: all the aggregating is there.',
  },
];

export const DISPATCH_LABELS: Record<Dispatch, string> = {
  static: 'Static ranges',
  shared: 'Shared queue',
  stealing: 'Work stealing',
};

export const PARALLEL_DEFAULTS = { query: 'grouped', workers: 4, dispatch: 'stealing' as Dispatch, morselPages: 16, speeds: [1, 1, 1, 3] };

const DB = DATASETS.transactions.make();

/** One run on the transactions preset, as the page makes it. */
export function parallelRun(queryId: string, workers: number, dispatch: Dispatch, morselPages: number, speeds: readonly number[]): ParallelResult {
  const query = PARALLEL_QUERIES.find((q) => q.id === queryId) ?? PARALLEL_QUERIES[0]!;
  const options: ParallelOptions = { workers, dispatch, morselPages, speeds, rowsPerPage: DEFAULT_ENGINE_OPTIONS.rowsPerPage };
  const result = runParallel(query.sql, DB, options);
  if (!result.ok) throw new Error(`unreachable: a preset parallel query must run — ${result.error}`);
  return result;
}

/** `?q=…&w=…&d=…&m=…&s=…`, the page's own link for a run. */
export function parallelHref(queryId: string, workers: number, dispatch: Dispatch, morselPages: number, speeds: readonly number[]): string {
  const p = new URLSearchParams();
  p.set('q', queryId);
  p.set('w', String(workers));
  p.set('d', dispatch);
  p.set('m', String(morselPages));
  p.set('s', speeds.slice(0, workers).join(''));
  return `/tools/parallel?${p.toString()}`;
}

export const isDispatch = (raw: string | null): raw is Dispatch => DISPATCHES.includes(raw as Dispatch);

/** A speed profile from its link form, `1113`: one digit per worker, each within the limits, or null. */
export function parseSpeeds(raw: string | null, workers: number): number[] | null {
  if (raw === null || !/^[0-9]+$/.test(raw) || raw.length !== workers) return null;
  const speeds = [...raw].map(Number);
  return speeds.every((s) => s >= PARALLEL_LIMITS.minSpeed && s <= PARALLEL_LIMITS.maxSpeed) ? speeds : null;
}
