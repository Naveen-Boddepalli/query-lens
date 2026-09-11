/**
 * The logical plan. v0 keeps one representation rather than separate logical
 * and physical trees: the scan node carries its own access method, which is
 * what the optimizer actually chooses (plan.md §7.2–7.4).
 */

import type { PlanNode, SqlValue } from '../types.ts';
import type { AggregateFn, Expr } from '../parser/index.ts';
import type { PlanCost } from './cost.ts';

export type ProjectList = { kind: 'star' } | { kind: 'columns'; names: string[] };

/** One aggregate a `HashAggregate` computes, keyed by its canonical SQL text (e.g. `COUNT(*)`). */
export interface AggregateSpec {
  key: string;
  fn: AggregateFn;
  /** The column it reads, or `null` only for `COUNT(*)`. */
  column: string | null;
}

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
  | {
      /**
       * An equality lookup whose result never touches the heap: every column
       * the query needs is `column` itself, which the leaf already holds as
       * the key. No `residual` — a leftover conjunct would need a column the
       * leaf does not have, so `index-only-scan` never fires with one
       * (plan.md §22.2 — the third point on the lookup-vs-scan line, after a
       * full scan and an ordinary index lookup that still fetches the row).
       */
      op: 'IndexOnlyScan';
      table: string;
      column: string;
      key: SqlValue;
    }
  | { op: 'Filter'; predicate: Expr; child: Plan }
  /**
   * `GROUP BY` / aggregate functions, between Filter and Sort or Project:
   * `Project → HashAggregate → Filter → …`. Builds one group per distinct
   * combination of `groupBy` values (or a single group over everything when
   * `groupBy` is empty) with a hash table keyed on that combination — the
   * default strategy; `SortAggregate` below is the point of comparison
   * plan.md §22.2 names, now that it exists.
   */
  | { op: 'HashAggregate'; groupBy: string[]; aggregates: AggregateSpec[]; child: Plan }
  /**
   * The second aggregate strategy (plan.md §22.2): the same `groupBy` /
   * `aggregates` a `HashAggregate` computes, but by sorting the input on the
   * `groupBy` columns first — spilling through the real buffer pool exactly
   * as `Sort` does — and then collapsing runs of equal keys in one pass,
   * rather than building a hash table. Same output, same row count; the
   * difference `/compare`'s third mode shows is entirely in the I/O.
   */
  | { op: 'SortAggregate'; groupBy: string[]; aggregates: AggregateSpec[]; child: Plan }
  /** `ORDER BY column [ASC|DESC]`, between Filter and Project: `Project → Sort → Filter → …`. */
  | { op: 'Sort'; column: string; direction: 'asc' | 'desc'; child: Plan }
  | { op: 'Project'; columns: ProjectList; child: Plan }
  /** `LIMIT n`, always the outermost node when present: `Limit → Project → …`. */
  | { op: 'Limit'; count: number; child: Plan };

export function childOf(plan: Plan): Plan | undefined {
  return plan.op === 'Filter' ||
    plan.op === 'HashAggregate' ||
    plan.op === 'SortAggregate' ||
    plan.op === 'Sort' ||
    plan.op === 'Project' ||
    plan.op === 'Limit'
    ? plan.child
    : undefined;
}

/**
 * The `Sort` node, wherever it sits in the chain — `runQuery.ts` needs to
 * know before the buffer pool exists, to reserve its spill's page ids. v0's
 * plan is always a single chain (no joins yet), so walking `childOf` visits
 * every node.
 */
export function findSort(plan: Plan): Extract<Plan, { op: 'Sort' }> | null {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'Sort') return node;
    node = childOf(node);
  }
  return null;
}

/**
 * Whether `plan` contains a node whose executor spills through the buffer
 * pool via `externalMergeSort` — `Sort` itself, or a `SortAggregate` (which
 * runs the same algorithm internally to order its groups). `runQuery.ts`
 * needs this before the buffer pool exists, to reserve the spill's page ids;
 * `Sort` and `SortAggregate` never both appear in one plan (`ORDER BY` and
 * `GROUP BY` are mutually exclusive), but the check does not depend on that.
 */
export function needsSortSpill(plan: Plan): boolean {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'Sort' || node.op === 'SortAggregate') return true;
    node = childOf(node);
  }
  return false;
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
 *
 * `estimates` is optional per-node cost (plan.md §22.2). When supplied, each
 * node carries `estRows` and the heuristic behind it; the pipeline always
 * passes it, callers that only want the tree shape can leave it out.
 */
export function toPlanDisplay(
  plan: Plan,
  changed: ReadonlySet<Plan> = new Set(),
  estimates?: PlanCost,
): PlanNode {
  return convert(plan, 'p', changed, estimates);
}

function convert(
  plan: Plan,
  id: string,
  changed: ReadonlySet<Plan>,
  estimates: PlanCost | undefined,
): PlanNode {
  const highlight = changed.has(plan);
  const kid = (child: Plan) => [convert(child, `${id}.0`, changed, estimates)];
  const estimate = estimates?.get(plan);
  const cost = estimate
    ? { estRows: estimate.estRows, estBasis: estimate.basis }
    : {};

  switch (plan.op) {
    case 'SeqScan':
      return {
        id,
        op: 'SeqScan',
        label: `SeqScan ${plan.table}`,
        ...(plan.filter ? { detail: `filter: ${exprToSql(plan.filter)}` } : {}),
        ...(highlight ? { highlight } : {}),
        ...cost,
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
        ...cost,
      };
    case 'IndexOnlyScan':
      return {
        id,
        op: 'IndexOnlyScan',
        label: `IndexOnlyScan ${plan.table}.${plan.column}`,
        detail: `key: ${plan.column} = ${format(plan.key)} · never touches the heap`,
        ...(highlight ? { highlight } : {}),
        ...cost,
      };
    case 'Filter':
      return {
        id,
        op: 'Filter',
        label: 'Filter',
        detail: exprToSql(plan.predicate),
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
    case 'HashAggregate':
    case 'SortAggregate':
      return {
        id,
        op: plan.op,
        label: plan.op,
        detail:
          plan.groupBy.length > 0
            ? `GROUP BY ${plan.groupBy.join(', ')}${
                plan.aggregates.length > 0 ? `; ${plan.aggregates.map((a) => a.key).join(', ')}` : ''
              }`
            : plan.aggregates.map((a) => a.key).join(', '),
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
    case 'Sort':
      return {
        id,
        op: 'Sort',
        label: 'Sort',
        detail: `${plan.column} ${plan.direction === 'asc' ? 'ASC' : 'DESC'}`,
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
    case 'Project':
      return {
        id,
        op: 'Project',
        label: 'Project',
        detail: plan.columns.kind === 'star' ? '*' : plan.columns.names.join(', '),
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
    case 'Limit':
      return {
        id,
        op: 'Limit',
        label: `Limit ${String(plan.count)}`,
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
  }
}

function format(value: SqlValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value}'` : String(value);
}
