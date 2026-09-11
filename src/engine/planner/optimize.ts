/**
 * Rule-based rewrites. Deterministic, and the rules themselves consult no cost
 * model: index selection fires whenever an equality on the indexed column is
 * present, not when a cheaper plan is costed. The cost *estimates* live in
 * `cost.ts` and are annotated onto the trees by `emit.ts` — they justify the
 * rewrite in the narration without the rule depending on a number §12 would
 * call plausible-but-false.
 *
 * Rules run in order, each on the output of the last, and each produces one
 * `optimize` event carrying the before and after trees.
 */

import type { PredictionPrompt, Table } from '../types.ts';
import { indexSelectionPrompt } from '../predict.ts';
import type { Expr } from '../parser/index.ts';
import { conjoin, conjuncts, equalityOn } from './plan.ts';
import type { Plan } from './plan.ts';

export interface Rewrite {
  rule: string;
  /** Narration for the step. */
  label: string;
  plan: Plan;
  /** The Plan objects this rule produced, for highlighting. */
  changed: Set<Plan>;
  /** Asked before the rewrite is revealed. */
  prompt?: PredictionPrompt;
}

type Rule = (plan: Plan, table: Table) => Rewrite | null;

/**
 * `LIMIT` wraps the whole plan (`buildPlan.ts`), outside `Project` — but
 * neither rewrite below cares about it. Stripping it here, and rewrapping the
 * result, means `predicatePushdown` and `indexSelection` stay written against
 * `Project → … → scan`, whether or not a `LIMIT` sits above it.
 */
function unwrapLimit(plan: Plan): { limit: number | null; rest: Plan } {
  return plan.op === 'Limit' ? { limit: plan.count, rest: plan.child } : { limit: null, rest: plan };
}
function rewrapLimit(limit: number | null, plan: Plan): Plan {
  return limit === null ? plan : { op: 'Limit', count: limit, child: plan };
}

/**
 * Same idea for `Sort`, which sits directly under `Project` when `ORDER BY`
 * is present. Neither rewrite touches row order, so both work underneath it
 * exactly as they do without it.
 */
type SortSpec = { column: string; direction: 'asc' | 'desc' };
function unwrapSort(plan: Plan): { sort: SortSpec | null; rest: Plan } {
  return plan.op === 'Sort'
    ? { sort: { column: plan.column, direction: plan.direction }, rest: plan.child }
    : { sort: null, rest: plan };
}
function rewrapSort(sort: SortSpec | null, plan: Plan): Plan {
  return sort === null ? plan : { op: 'Sort', column: sort.column, direction: sort.direction, child: plan };
}

/**
 * Fold `Filter` into the scan beneath it.
 *
 * In a single-table query the filter already sits directly above the scan, so
 * there is nothing to push it *past*. The real move is pushing it *into* the
 * scan: the scan then discards non-matching rows as it reads them, instead of
 * materialising every row for a separate operator to throw away.
 */
const predicatePushdown: Rule = (input) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowProject } = unwrapSort(plan.child);
  if (belowProject.op !== 'Filter') return null;
  const scan = belowProject.child;
  if (scan.op !== 'SeqScan' || scan.filter) return null;

  const pushed: Plan = { op: 'SeqScan', table: scan.table, filter: belowProject.predicate };
  const root = rewrapLimit(
    limit,
    { op: 'Project', columns: plan.columns, child: rewrapSort(sort, pushed) },
  );

  return {
    rule: 'predicate-pushdown',
    label:
      'Predicate pushdown: the filter moves into the scan, so rows are discarded as they are read rather than materialised and then thrown away.',
    plan: root,
    changed: new Set<Plan>([pushed]),
  };
};

/**
 * Swap a `SeqScan` for an `IndexScan` when one conjunct is an equality on the
 * indexed column. Conjuncts the index cannot answer stay behind as a recheck —
 * the index narrows the search, it does not verify the whole predicate.
 */
const indexSelection: Rule = (input, table) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: scan } = unwrapSort(plan.child);
  if (scan.op !== 'SeqScan' || !scan.filter) return null;

  const indexed = table.indexedColumn;
  if (!indexed) return null;

  const parts = conjuncts(scan.filter);
  const matchIndex = parts.findIndex((p) => equalityOn(p, indexed) !== undefined);
  if (matchIndex === -1) return null;

  const key = equalityOn(parts[matchIndex]!, indexed)!;
  const residual = conjoin(parts.filter((_, i) => i !== matchIndex));

  const indexScan: Plan = {
    op: 'IndexScan',
    table: scan.table,
    column: indexed,
    key,
    ...(residual ? { residual } : {}),
  };
  const root = rewrapLimit(
    limit,
    { op: 'Project', columns: plan.columns, child: rewrapSort(sort, indexScan) },
  );

  return {
    rule: 'index-selection',
    label: residual
      ? `\`${indexed}\` is indexed, so the equality becomes an index lookup. The rest of the predicate cannot be answered by the index and is rechecked on each row the index returns.`
      : `\`${indexed}\` is indexed and the predicate is an equality on it, so the scan becomes a B+Tree lookup — a handful of pages instead of the whole table.`,
    plan: root,
    changed: new Set<Plan>([indexScan]),
    prompt: indexSelectionPrompt(indexed, key),
  };
};

const RULES: { name: string; apply: Rule }[] = [
  { name: 'predicate-pushdown', apply: predicatePushdown },
  { name: 'index-selection', apply: indexSelection },
];

/** Every rewrite rule's name, in the order the optimizer runs them. */
export const OPTIMIZER_RULES: readonly string[] = RULES.map((r) => r.name);

/**
 * Applies every enabled rule that fires, in order. Returns each step for
 * animation.
 *
 * `enabled` defaults to all rules — the pipeline (`emit.ts`) never passes it.
 * `/tools/planner` (plan.md §22.3) passes a subset so a rule can be toggled
 * off and its effect on the plan watched.
 */
export function optimize(
  plan: Plan,
  table: Table,
  enabled: ReadonlySet<string> = new Set(OPTIMIZER_RULES),
): Rewrite[] {
  const steps: Rewrite[] = [];
  let current = plan;

  for (const { name, apply } of RULES) {
    if (!enabled.has(name)) continue;
    const rewrite = apply(current, table);
    if (!rewrite) continue;
    steps.push(rewrite);
    current = rewrite.plan;
  }

  return steps;
}

/** The predicate a scan will evaluate, whatever form it ended up in. */
export function scanPredicate(plan: Plan): Expr | undefined {
  if (plan.op === 'SeqScan') return plan.filter;
  if (plan.op === 'IndexScan') return plan.residual;
  return plan.op === 'Filter' || plan.op === 'Sort' || plan.op === 'Project' || plan.op === 'Limit'
    ? scanPredicate(plan.child)
    : undefined;
}
