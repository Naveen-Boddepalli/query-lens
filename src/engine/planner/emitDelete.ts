import type { Emit } from '../trace.ts';
import type { Table } from '../types.ts';
import type { DeleteStatement } from '../parser/index.ts';
import { buildDeletePlan } from './buildPlan.ts';
import { estimatePlan } from './cost.ts';
import { optimize } from './optimize.ts';
import { exprToSql, toPlanDisplay } from './plan.ts';
import type { Plan } from './plan.ts';

/** Strips the throwaway `Project *` wrapper `emitDeletePlanEvents` builds around a delete's scan. */
function unwrap(plan: Plan): Plan {
  return plan.op === 'Project' ? plan.child : plan;
}

/**
 * Emits the plan/optimize stages for a `DELETE`, and returns the final access
 * plan (`SeqScan` or `IndexScan`, whichever the optimizer chose) the executor
 * uses to find the rows to remove.
 *
 * Reuses the exact same `predicate-pushdown` / `index-selection` rules a
 * `SELECT` uses — they are written against `Project → …`, so the scan is
 * wrapped in a throwaway `Project *` for the optimizer's sake, and every tree
 * shown to the reader has that wrapper stripped again: nothing about a
 * `DELETE` cares what columns a `Project` would keep.
 */
export function emitDeletePlanEvents(
  emit: Emit,
  ast: DeleteStatement,
  table: Table,
  rowsPerPage: number,
): Plan {
  const display = (plan: Plan, changed?: ReadonlySet<Plan>) =>
    toPlanDisplay(unwrap(plan), changed, estimatePlan(unwrap(plan), table, rowsPerPage));

  const scan: Plan = { op: 'SeqScan', table: ast.from.name };
  emit(
    `Start at the bottom: every plan begins by reading a table, so the base of the tree is a sequential scan of \`${ast.from.name}\`.`,
    { stage: 'plan', planTree: display(scan) },
  );

  let current: Plan = scan;
  if (ast.where) {
    current = { op: 'Filter', predicate: ast.where, child: current };
    emit(
      `The WHERE clause becomes a Filter sitting above the scan: \`${exprToSql(ast.where)}\` — the rows it passes are the rows DELETE removes.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  const canonical = buildDeletePlan(ast);
  const wrapped: Plan = { op: 'Project', columns: { kind: 'star' }, child: canonical };
  let optimisedWrapped: Plan = wrapped;
  let before: Plan = wrapped;

  for (const step of optimize(wrapped, table)) {
    emit(
      step.label,
      {
        stage: 'optimize',
        rule: step.rule,
        before: display(before),
        after: display(step.plan, step.changed),
      },
      step.prompt ? { predictable: step.prompt } : undefined,
    );
    before = step.plan;
    optimisedWrapped = step.plan;
  }

  if (optimisedWrapped === wrapped) {
    emit(
      'No rewrite rule fires on this plan — the optimizer leaves it exactly as written.',
      {
        stage: 'optimize',
        rule: 'none',
        before: display(wrapped),
        after: display(wrapped),
      },
    );
  }

  return unwrap(optimisedWrapped);
}
