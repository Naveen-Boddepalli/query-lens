import type { Emit } from '../trace.ts';
import type { Table } from '../types.ts';
import type { SelectStatement } from '../parser/index.ts';
import { buildPlan } from './buildPlan.ts';
import { optimize } from './optimize.ts';
import { exprToSql, toPlanDisplay } from './plan.ts';
import type { Plan, ProjectList } from './plan.ts';

/**
 * Emits the planner and optimizer stages, and returns the final plan for the
 * executor to run. The plan is built bottom-up one operator at a time so the
 * tree can be watched growing, the same way the AST was.
 */
export function emitPlanEvents(emit: Emit, ast: SelectStatement, table: Table): Plan {
  const scan: Plan = { op: 'SeqScan', table: ast.from.name };
  emit(
    `Start at the bottom: every plan begins by reading a table, so the base of the tree is a sequential scan of \`${ast.from.name}\`.`,
    { stage: 'plan', planTree: toPlanDisplay(scan) },
  );

  let current: Plan = scan;

  if (ast.where) {
    current = { op: 'Filter', predicate: ast.where, child: current };
    emit(
      `The WHERE clause becomes a Filter sitting above the scan: \`${exprToSql(ast.where)}\`.`,
      { stage: 'plan', planTree: toPlanDisplay(current) },
    );
  }

  const columns: ProjectList =
    ast.select.kind === 'star'
      ? { kind: 'star' }
      : { kind: 'columns', names: ast.select.names.map((c) => c.name) };

  current = { op: 'Project', columns, child: current };
  emit(
    columns.kind === 'star'
      ? 'The SELECT list becomes a Project on top. `*` keeps every column, so it passes rows through unchanged.'
      : `The SELECT list becomes a Project on top, keeping ${columns.names.join(', ')}.`,
    { stage: 'plan', planTree: toPlanDisplay(current) },
  );

  // The canonical plan is a direct translation of the query text. Everything
  // below is the optimizer earning its keep.
  const canonical = buildPlan(ast);
  let optimised = canonical;
  let before = canonical;

  for (const step of optimize(canonical, table)) {
    emit(
      step.label,
      {
        stage: 'optimize',
        rule: step.rule,
        before: toPlanDisplay(before),
        after: toPlanDisplay(step.plan, step.changed),
      },
      step.prompt ? { predictable: step.prompt } : undefined,
    );
    before = step.plan;
    optimised = step.plan;
  }

  if (optimised === canonical) {
    emit(
      'No rewrite rule fires on this plan — the optimizer leaves it exactly as written.',
      {
        stage: 'optimize',
        rule: 'none',
        before: toPlanDisplay(canonical),
        after: toPlanDisplay(canonical),
      },
    );
  }

  return optimised;
}
