import { DATASETS } from '../engine/datasets.ts';
import { finalPlan } from '../engine/explain.ts';
import { PARALLEL_LIMITS, runParallel, scaling } from '../engine/parallel.ts';
import type { Dispatch, Scaling } from '../engine/parallel.ts';
import { runQuery } from '../engine/runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../engine/types.ts';
import type { PlanNode } from '../engine/types.ts';

/** plan.md §27.5 P3: the queries `/compare`'s serial-against-parallel mode runs, and the comparison it shows. */

export interface CompareQuery {
  id: string;
  label: string;
  sql: string;
}

export const PARALLEL_COMPARE_QUERIES: readonly CompareQuery[] = [
  { id: 'status', label: 'By status (2 groups)', sql: 'SELECT status, COUNT(*), SUM(amount) FROM transactions GROUP BY status' },
  { id: 'account', label: 'By account (40 groups)', sql: 'SELECT account, COUNT(*), SUM(amount) FROM transactions GROUP BY account' },
  { id: 'id', label: 'By id (3,000 groups)', sql: 'SELECT id, COUNT(*) FROM transactions GROUP BY id' },
];

export const COMPARE_DB = DATASETS.transactions.make();

function planLine(node: PlanNode | null): string {
  if (!node) return '';
  const below = (node.children ?? []).map(planLine).filter((x) => x.length > 0);
  return below.length === 0 ? node.label : `${node.label} ← ${below.join(', ')}`;
}

/** The comparison for one query, as the page and its challenge read it. */
export function parallelComparison(queryId: string, dispatch: Dispatch, morselPages: number): { serial: { ticks: number; plan: string; rows: number }; scaling: Scaling } {
  const query = PARALLEL_COMPARE_QUERIES.find((q) => q.id === queryId) ?? PARALLEL_COMPARE_QUERIES[0]!;
  const run = runQuery(query.sql, COMPARE_DB, DEFAULT_ENGINE_OPTIONS);
  const one = runParallel(query.sql, COMPARE_DB, { workers: 1, dispatch, morselPages, speeds: [1], rowsPerPage: DEFAULT_ENGINE_OPTIONS.rowsPerPage });
  const s = scaling(query.sql, COMPARE_DB, { dispatch, morselPages, rowsPerPage: DEFAULT_ENGINE_OPTIONS.rowsPerPage }, PARALLEL_LIMITS.maxWorkers);
  if (!one.ok || 'ok' in s) throw new Error('unreachable: a compare query must run in parallel');
  return { serial: { ticks: one.serialTicks, plan: planLine(finalPlan(run.events)), rows: run.rows.length }, scaling: s };
}
