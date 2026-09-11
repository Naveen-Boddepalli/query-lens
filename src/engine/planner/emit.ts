import type { Emit } from '../trace.ts';
import type { Table } from '../types.ts';
import type { SelectStatement } from '../parser/index.ts';
import { buildPlan } from './buildPlan.ts';
import { estimatePlan, rootEstimate } from './cost.ts';
import { optimize } from './optimize.ts';
import { exprToSql, toPlanDisplay } from './plan.ts';
import type { Plan, ProjectList } from './plan.ts';

/**
 * Emits the planner and optimizer stages, and returns the final plan for the
 * executor to run. The plan is built bottom-up one operator at a time so the
 * tree can be watched growing, the same way the AST was.
 *
 * Every emitted tree carries the cost model's per-node estimates (plan.md
 * §22.2), which is also why `rowsPerPage` is threaded down: a scan's estimated
 * page count depends on it.
 */
export function emitPlanEvents(
  emit: Emit,
  ast: SelectStatement,
  table: Table,
  rowsPerPage: number,
): Plan {
  const display = (plan: Plan, changed?: ReadonlySet<Plan>) =>
    toPlanDisplay(plan, changed, estimatePlan(plan, table, rowsPerPage));

  const scan: Plan = { op: 'SeqScan', table: ast.from.name };
  emit(
    `Start at the bottom: every plan begins by reading a table, so the base of the tree is a sequential scan of \`${ast.from.name}\`.`,
    { stage: 'plan', planTree: display(scan) },
  );

  let current: Plan = scan;

  if (ast.where) {
    current = { op: 'Filter', predicate: ast.where, child: current };
    emit(
      `The WHERE clause becomes a Filter sitting above the scan: \`${exprToSql(ast.where)}\`.`,
      { stage: 'plan', planTree: display(current) },
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
    { stage: 'plan', planTree: display(current) },
  );

  // The canonical plan is a direct translation of the query text. Everything
  // below is the optimizer earning its keep.
  const canonical = buildPlan(ast);
  let optimised = canonical;
  let before = canonical;

  for (const step of optimize(canonical, table)) {
    emit(
      step.rule === 'index-selection' ? withCostJustification(step.label, step.plan) : step.label,
      {
        stage: 'optimize',
        rule: step.rule,
        before: display(before),
        after: display(step.plan, step.changed),
      },
      step.prompt ? { predictable: step.prompt } : undefined,
    );
    before = step.plan;
    optimised = step.plan;
  }

  if (optimised === canonical) {
    const rows = rootEstimate(canonical, table, rowsPerPage).estRows;
    const note = ast.where
      ? `The cost model estimates about ${plural(rows, 'row')} out of ${String(table.rows.length)}, and no access path beats reading the table.`
      : 'With no WHERE there is nothing to narrow the scan — every row is returned.';
    emit(
      `No rewrite rule fires on this plan — the optimizer leaves it exactly as written. ${note}`,
      {
        stage: 'optimize',
        rule: 'none',
        before: display(canonical),
        after: display(canonical),
      },
    );
  }

  return optimised;

  /** Appends the scan-vs-index page estimate that makes the rewrite a decision, not a reflex. */
  function withCostJustification(label: string, chosen: Plan): string {
    const scanPages = Math.max(1, Math.ceil(table.rows.length / rowsPerPage));
    const rows = rootEstimate(canonical, table, rowsPerPage).estRows;
    const indexPages = rootEstimate(chosen, table, rowsPerPage).estPages;
    return `${label} Estimated cost decides it: the sequential scan reads all ${String(scanPages)} pages to return about ${plural(rows, 'row')}; the index lookup reads about ${String(indexPages)}.`;
  }
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
