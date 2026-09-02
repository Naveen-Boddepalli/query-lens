/**
 * Rule-based rewrites. Deterministic, no cost model — plan.md §7.3 defers cost
 * estimates to v1, and inventing costs we cannot justify would be exactly the
 * kind of plausible-but-false detail §12 warns about.
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
 * Fold `Filter` into the scan beneath it.
 *
 * In a single-table query the filter already sits directly above the scan, so
 * there is nothing to push it *past*. The real move is pushing it *into* the
 * scan: the scan then discards non-matching rows as it reads them, instead of
 * materialising every row for a separate operator to throw away.
 */
const predicatePushdown: Rule = (plan) => {
  if (plan.op !== 'Project') return null;
  const filter = plan.child;
  if (filter.op !== 'Filter') return null;
  const scan = filter.child;
  if (scan.op !== 'SeqScan' || scan.filter) return null;

  const pushed: Plan = { op: 'SeqScan', table: scan.table, filter: filter.predicate };
  const root: Plan = { op: 'Project', columns: plan.columns, child: pushed };

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
const indexSelection: Rule = (plan, table) => {
  if (plan.op !== 'Project') return null;
  const scan = plan.child;
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
  const root: Plan = { op: 'Project', columns: plan.columns, child: indexScan };

  return {
    rule: 'index-selection',
    label: residual
      ? `\`${indexed}\` is indexed, so the equality becomes an index lookup. The rest of the predicate cannot be answered by the index and is rechecked on each row the index returns.`
      : `\`${indexed}\` is indexed and the predicate is an equality on it, so the scan becomes a B+Tree lookup — three pages instead of the whole table.`,
    plan: root,
    changed: new Set<Plan>([indexScan]),
    prompt: indexSelectionPrompt(indexed, key),
  };
};

const RULES: Rule[] = [predicatePushdown, indexSelection];

/** Applies every rule that fires, in order. Returns each step for animation. */
export function optimize(plan: Plan, table: Table): Rewrite[] {
  const steps: Rewrite[] = [];
  let current = plan;

  for (const rule of RULES) {
    const rewrite = rule(current, table);
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
  return plan.op === 'Filter' || plan.op === 'Project' ? scanPredicate(plan.child) : undefined;
}
