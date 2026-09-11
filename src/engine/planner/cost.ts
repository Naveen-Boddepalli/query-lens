/**
 * A first cost model: cardinality and page-count *estimates*, annotated onto
 * plan nodes (plan.md §7.3, §22.2).
 *
 * Every number here is a textbook heuristic, and each carries a `basis` string
 * naming the rule of thumb it came from — an equality is `1 / ndistinct`, an
 * open range is linear over the column's min–max, an `AND` multiplies its parts
 * and assumes they are independent. plan.md §12 is explicit that an invented
 * figure with a decimal point is worse than an honest guess, so the estimate is
 * always shown next to the count the executor actually produced: the optimiser
 * is guessing, and the UI says so.
 *
 * Pure and synchronous, on the same rules as the rest of `src/engine`.
 */

import type { CompareOp, Expr } from '../parser/index.ts';
import type { Row, SqlValue, Table } from '../types.ts';
import type { Plan } from './plan.ts';

/** Default selectivity for an open range with no usable min/max (Selinger et al., 1979). */
export const OPEN_RANGE_SELECTIVITY = 1 / 3;
/** Default equality selectivity when a column has no distinct-value stats. */
export const NO_STATS_EQ_SELECTIVITY = 0.1;
/** B+Tree fan-out — `DEFAULT_MAX_KEYS` in src/engine/index/btree.ts. */
const FANOUT = 4;

export interface CostEstimate {
  /** Estimated rows *out* of this node. */
  estRows: number;
  /** Estimated page reads this node drives. */
  estPages: number;
  /** The heuristic in a few words, shown on the node so the number is legible. */
  basis: string;
}

/** Per-node estimates for one plan tree, keyed by node identity. */
export type PlanCost = Map<Plan, CostEstimate>;

function ndistinct(rows: readonly Row[], column: string): number {
  const seen = new Set<SqlValue>();
  for (const row of rows) seen.add(row[column] ?? null);
  return Math.max(seen.size, 1);
}

function columnName(expr: Expr): string | null {
  if (expr.kind !== 'compare') return null;
  if (expr.left.kind === 'column') return expr.left.name;
  if (expr.right.kind === 'column') return expr.right.name;
  return null;
}

function literalValue(expr: Expr): SqlValue | null {
  if (expr.kind !== 'compare') return null;
  if (expr.left.kind === 'literal') return expr.left.value;
  if (expr.right.kind === 'literal') return expr.right.value;
  return null;
}

interface Selectivity {
  fraction: number;
  /** Terse enough to sit on a plan node. */
  basis: string;
}

function equalitySelectivity(column: string | null, table: Table): Selectivity {
  if (!column || !table.columns.includes(column)) {
    return { fraction: NO_STATS_EQ_SELECTIVITY, basis: '0.1 default' };
  }
  const distinct = ndistinct(table.rows, column);
  return { fraction: 1 / distinct, basis: `1/${String(distinct)} on ${column}` };
}

function rangeSelectivity(
  column: string | null,
  op: Exclude<CompareOp, '='>,
  literal: SqlValue | null,
  table: Table,
): Selectivity {
  const fallback: Selectivity = { fraction: OPEN_RANGE_SELECTIVITY, basis: '⅓ default' };
  if (!column || typeof literal !== 'number') return fallback;

  const values = table.rows
    .map((row) => row[column])
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return fallback;

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return fallback;

  const above = (max - literal) / (max - min);
  const fraction = Math.min(1, Math.max(0, op === '>' ? above : 1 - above));
  return { fraction, basis: `~${String(Math.round(fraction * 100))}% by range` };
}

/** Selectivity of a predicate, with the heuristic that produced it. */
export function selectivityOf(expr: Expr, table: Table): Selectivity {
  switch (expr.kind) {
    case 'and': {
      const left = selectivityOf(expr.left, table);
      const right = selectivityOf(expr.right, table);
      return {
        fraction: left.fraction * right.fraction,
        basis: `${left.basis} × ${right.basis}`,
      };
    }
    case 'compare':
      return expr.op === '='
        ? equalitySelectivity(columnName(expr), table)
        : rangeSelectivity(columnName(expr), expr.op, literalValue(expr), table);
    default:
      return { fraction: 1, basis: 'no predicate' };
  }
}

const clampRows = (value: number): number => Math.max(0, Math.round(value));

/** Estimated B+Tree levels for a bulk-loaded index over `rowCount` rows. */
export function estimateIndexLevels(rowCount: number): number {
  let nodes = Math.max(1, Math.ceil(rowCount / FANOUT));
  let levels = 1;
  while (nodes > 1) {
    nodes = Math.ceil(nodes / (FANOUT + 1));
    levels += 1;
  }
  return levels;
}

function estimateNode(plan: Plan, table: Table, rowsPerPage: number, into: PlanCost): CostEstimate {
  const rowCount = table.rows.length;
  const heapPages = Math.max(1, Math.ceil(rowCount / rowsPerPage));

  let estimate: CostEstimate;
  switch (plan.op) {
    case 'SeqScan': {
      if (plan.filter) {
        const { fraction, basis } = selectivityOf(plan.filter, table);
        estimate = { estRows: clampRows(rowCount * fraction), estPages: heapPages, basis };
      } else {
        estimate = { estRows: rowCount, estPages: heapPages, basis: 'every row' };
      }
      break;
    }
    case 'IndexScan': {
      const distinct = ndistinct(table.rows, plan.column);
      let fraction = 1 / distinct;
      let basis = `1/${String(distinct)} on ${plan.column}`;
      if (plan.residual) {
        const residual = selectivityOf(plan.residual, table);
        fraction *= residual.fraction;
        basis += ` + recheck ${residual.basis}`;
      }
      const levels = estimateIndexLevels(rowCount);
      estimate = {
        estRows: Math.max(clampRows(rowCount * fraction), plan.residual ? 0 : 1),
        estPages: levels + 1,
        basis,
      };
      break;
    }
    case 'Filter': {
      const child = estimateNode(plan.child, table, rowsPerPage, into);
      const { fraction, basis } = selectivityOf(plan.predicate, table);
      estimate = { estRows: clampRows(child.estRows * fraction), estPages: child.estPages, basis };
      break;
    }
    case 'Project': {
      const child = estimateNode(plan.child, table, rowsPerPage, into);
      estimate = { estRows: child.estRows, estPages: child.estPages, basis: child.basis };
      break;
    }
  }

  into.set(plan, estimate);
  return estimate;
}

/** Per-node estimates for a plan tree. */
export function estimatePlan(plan: Plan, table: Table, rowsPerPage: number): PlanCost {
  const cost: PlanCost = new Map();
  estimateNode(plan, table, rowsPerPage, cost);
  return cost;
}

/** The estimate for the plan's root node — the query's estimated output. */
export function rootEstimate(plan: Plan, table: Table, rowsPerPage: number): CostEstimate {
  return estimateNode(plan, table, rowsPerPage, new Map());
}
