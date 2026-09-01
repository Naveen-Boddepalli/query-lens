/**
 * The logical plan. v0 keeps one representation rather than separate logical
 * and physical trees: the scan node carries its own access method, which is
 * what the optimizer actually chooses (plan.md §7.2–7.4).
 */

import type { PlanNode, SqlValue } from '../types.ts';
import type { Expr } from '../parser/index.ts';

export type ProjectList = { kind: 'star' } | { kind: 'columns'; names: string[] };

export type Plan =
  | { op: 'SeqScan'; table: string; filter?: Expr }
  | {
      op: 'IndexScan';
      table: string;
      /** The indexed column the lookup keys on. */
      column: string;
      key: SqlValue;
      /** Conjuncts the index could not satisfy, re-checked per row. */
      residual?: Expr;
    }
  | { op: 'Filter'; predicate: Expr; child: Plan }
  | { op: 'Project'; columns: ProjectList; child: Plan };

export function childOf(plan: Plan): Plan | undefined {
  return plan.op === 'Filter' || plan.op === 'Project' ? plan.child : undefined;
}

/* -------------------------------------------------------------------------- */
/* Predicate helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Flattens an AND tree into its individual comparisons. */
export function conjuncts(expr: Expr): Expr[] {
  return expr.kind === 'and'
    ? [...conjuncts(expr.left), ...conjuncts(expr.right)]
    : [expr];
}

/** Rebuilds a left-associative AND chain. Returns undefined for an empty list. */
export function conjoin(parts: Expr[]): Expr | undefined {
  if (parts.length === 0) return undefined;
  return parts.reduce((left, right) => ({
    kind: 'and',
    left,
    right,
    span: { from: left.span.from, to: right.span.to },
  }));
}

/** `col = literal` against the given column, in either operand order. */
export function equalityOn(expr: Expr, column: string): SqlValue | undefined {
  if (expr.kind !== 'compare' || expr.op !== '=') return undefined;
  if (expr.left.kind === 'column' && expr.left.name === column && expr.right.kind === 'literal') {
    return expr.right.value;
  }
  if (expr.right.kind === 'column' && expr.right.name === column && expr.left.kind === 'literal') {
    return expr.left.value;
  }
  return undefined;
}

export function exprToSql(expr: Expr): string {
  switch (expr.kind) {
    case 'column':
      return expr.name;
    case 'literal':
      return expr.raw;
    case 'compare':
      return `${exprToSql(expr.left)} ${expr.op} ${exprToSql(expr.right)}`;
    case 'and':
      return `${exprToSql(expr.left)} AND ${exprToSql(expr.right)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Display conversion                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `changed` holds the Plan objects a rewrite produced. Identity comparison is
 * exact — no id bookkeeping to drift — and lets the UI highlight precisely
 * what the rule touched.
 */
export function toPlanDisplay(plan: Plan, changed: ReadonlySet<Plan> = new Set()): PlanNode {
  return convert(plan, 'p', changed);
}

function convert(plan: Plan, id: string, changed: ReadonlySet<Plan>): PlanNode {
  const highlight = changed.has(plan);
  const kid = (child: Plan) => [convert(child, `${id}.0`, changed)];

  switch (plan.op) {
    case 'SeqScan':
      return {
        id,
        op: 'SeqScan',
        label: `SeqScan ${plan.table}`,
        ...(plan.filter ? { detail: `filter: ${exprToSql(plan.filter)}` } : {}),
        ...(highlight ? { highlight } : {}),
      };
    case 'IndexScan':
      return {
        id,
        op: 'IndexScan',
        label: `IndexScan ${plan.table}.${plan.column}`,
        detail: plan.residual
          ? `key: ${plan.column} = ${format(plan.key)} · recheck: ${exprToSql(plan.residual)}`
          : `key: ${plan.column} = ${format(plan.key)}`,
        ...(highlight ? { highlight } : {}),
      };
    case 'Filter':
      return {
        id,
        op: 'Filter',
        label: 'Filter',
        detail: exprToSql(plan.predicate),
        ...(highlight ? { highlight } : {}),
        children: kid(plan.child),
      };
    case 'Project':
      return {
        id,
        op: 'Project',
        label: 'Project',
        detail: plan.columns.kind === 'star' ? '*' : plan.columns.names.join(', '),
        ...(highlight ? { highlight } : {}),
        children: kid(plan.child),
      };
  }
}

function format(value: SqlValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value}'` : String(value);
}
