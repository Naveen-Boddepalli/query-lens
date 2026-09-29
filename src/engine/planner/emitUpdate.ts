import type { Emit } from '../trace.ts';
import type { Table } from '../types.ts';
import type { UpdateStatement } from '../parser/index.ts';
import { buildUpdatePlan } from './buildPlan.ts';
import { estimatePlan } from './cost.ts';
import { optimize, WRITE_PATH_RULES } from './optimize.ts';
import { exprToSql, subqueryResolutionNotes, toPlanDisplay } from './plan.ts';
import type { Plan } from './plan.ts';

/** Strips the throwaway `Project *` wrapper `emitUpdatePlanEvents` builds around an update's scan. */
function unwrap(plan: Plan): Plan {
  return plan.op === 'Project' ? plan.child : plan;
}

/**
 * Emits the plan/optimize stages for an `UPDATE`, and returns the final
 * access plan (`SeqScan` or `IndexScan`) the executor uses to find the rows
 * to modify — the mirror of `emitDeletePlanEvents`, since only the WHERE
 * clause is planned; the SET clause has nothing for a plan or an optimizer
 * rule to act on. Uses `WRITE_PATH_RULES` for the same reason
 * `emitDeletePlanEvents` does — see its own doc comment.
 */
export function emitUpdatePlanEvents(
  emit: Emit,
  ast: UpdateStatement,
  table: Table,
  rowsPerPage: number,
): Plan {
  const display = (plan: Plan, changed?: ReadonlySet<Plan>) =>
    toPlanDisplay(unwrap(plan), changed, estimatePlan(unwrap(plan), table, rowsPerPage));

  const scan: Plan = { op: 'SeqScan', table: ast.table.name };
  emit(
    `Start at the bottom: every plan begins by reading a table, so the base of the tree is a sequential scan of \`${ast.table.name}\`.`,
    { stage: 'plan', planTree: display(scan) },
  );

  let current: Plan = scan;
  if (ast.where) {
    current = { op: 'Filter', predicate: ast.where, child: current };
    const subqueryNotes = subqueryResolutionNotes(ast.where);
    emit(
      `The WHERE clause becomes a Filter sitting above the scan: \`${exprToSql(ast.where)}\` — the rows it passes are the rows UPDATE modifies.${
        subqueryNotes.length > 0 ? ` ${subqueryNotes.map((n) => `${n[0]!.toUpperCase()}${n.slice(1)}.`).join(' ')}` : ''
      }`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  const canonical = buildUpdatePlan(ast);
  const wrapped: Plan = { op: 'Project', columns: { kind: 'star' }, child: canonical };
  let optimisedWrapped: Plan = wrapped;
  let before: Plan = wrapped;

  for (const step of optimize(wrapped, table, WRITE_PATH_RULES)) {
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
