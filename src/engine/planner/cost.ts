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

/**
 * `otherTables` is consulted only by the `Join` case, for whichever side of
 * the join is not `table` itself — every other case estimates against the
 * one table a v0 query without a JOIN ever has. A `Join`'s own two children
 * are always a bare `SeqScan` in v1 (plan.md §22.2: no predicate pushdown
 * into either side yet), so each side's own row/column data is exactly one
 * table's, found by name in `table`/`otherTables` rather than threaded down
 * through every other case that never needs a second table at all.
 */
function estimateNode(
  plan: Plan,
  table: Table,
  rowsPerPage: number,
  into: PlanCost,
  otherTables: Record<string, Table> = {},
): CostEstimate {
  const rowCount = table.rows.length;
  const heapPages = Math.max(1, Math.ceil(rowCount / rowsPerPage));
  const tableNamed = (name: string): Table => (name === table.name ? table : otherTables[name]!);

  let estimate: CostEstimate;
  switch (plan.op) {
    case 'Join': {
      const left = estimateNode(plan.left, tableNamed(plan.leftTable), rowsPerPage, into, otherTables);
      const right = estimateNode(plan.right, tableNamed(plan.rightTable), rowsPerPage, into, otherTables);
      // Foreign-key assumption: each left row matches about 1/ndistinct(right
      // key) of the right table — the same independence heuristic an
      // equality WHERE already makes, just applied to a join key instead of a
      // literal. Row count never depends on the algorithm — only the page
      // cost does.
      const rightDistinct = ndistinct(tableNamed(plan.rightTable).rows, plan.rightColumn);
      const estRows = clampRows((left.estRows * right.estRows) / rightDistinct);
      const rowsBasis = `${String(left.estRows)} × ${String(right.estRows)} / ndistinct(${plan.rightTable}.${plan.rightColumn})`;
      switch (plan.algorithm) {
        case 'hash':
          estimate = {
            // Build the right side into a hash table once, then probe with
            // the left streamed — each side is read exactly once, the
            // honest saving over nested-loop's repeated rescans.
            estRows,
            estPages: left.estPages + right.estPages,
            basis: `${rowsBasis}; hash join reads each side once — build a table on ${plan.rightTable}, probe with ${plan.leftTable}`,
          };
          break;
        case 'sort-merge': {
          // Each side is read once, same as hash — but sorting it first is
          // real spill I/O (mirroring `Sort`'s own `2 * spillPages` "at
          // least run generation" estimate), which hash join's in-memory
          // table never pays. Honest, not flattering: sort-merge is not
          // free just because it avoids nested-loop's rescans.
          const leftSpill = Math.max(1, Math.ceil(left.estRows / rowsPerPage));
          const rightSpill = Math.max(1, Math.ceil(right.estRows / rowsPerPage));
          estimate = {
            estRows,
            estPages: left.estPages + right.estPages + 2 * leftSpill + 2 * rightSpill,
            basis: `${rowsBasis}; sort-merge reads each side once, then sorts both — at least ${String(2 * leftSpill)} spill pages on ${plan.leftTable}, ${String(2 * rightSpill)} on ${plan.rightTable}`,
          };
          break;
        }
        case 'nested-loop':
          estimate = {
            // Nested-loop's own cost is the honest, unflattering number:
            // the outer read once, plus a full rescan of the inner for
            // every outer row — no index taken advantage of yet, since
            // `left`/`right` are always a bare SeqScan in v1.
            estRows,
            estPages: left.estPages + left.estRows * right.estPages,
            basis: `${rowsBasis}; nested-loop rescans ${plan.rightTable} once per ${plan.leftTable} row`,
          };
          break;
      }
      break;
    }
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
    case 'IndexOnlyScan': {
      // Same unique-column assumption as IndexScan (v0 indexes are unique),
      // but the page cost is the honest difference: the tree levels alone,
      // no +1 for a heap page this scan never fetches.
      const distinct = ndistinct(table.rows, plan.column);
      estimate = {
        estRows: 1,
        estPages: estimateIndexLevels(rowCount),
        basis: `1/${String(distinct)} on ${plan.column} — index-only, no heap page`,
      };
      break;
    }
    case 'Filter': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      const { fraction, basis } = selectivityOf(plan.predicate, table);
      estimate = { estRows: clampRows(child.estRows * fraction), estPages: child.estPages, basis };
      break;
    }
    case 'HashAggregate':
    case 'SortAggregate': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      // A hash table adds no I/O of its own — everything happens in memory —
      // but a sort aggregate spills exactly like `Sort` does, on top of
      // whatever the child already costs to read; that extra spill, priced
      // the same way `Sort`'s own case below prices it, is the entire point
      // of comparison `/compare`'s third mode shows (plan.md §22.2).
      const spillPages =
        plan.op === 'SortAggregate' ? 2 * Math.max(1, Math.ceil(child.estRows / rowsPerPage)) : 0;
      if (plan.groupBy.length === 0) {
        // No GROUP BY: the whole input is one group — even zero input rows
        // still produce one, since COUNT(*) of nothing is 0, not absent.
        estimate = {
          estRows: 1,
          estPages: child.estPages + spillPages,
          basis:
            plan.op === 'SortAggregate'
              ? `no GROUP BY — one group, but sorted first anyway (${String(spillPages)} spill pages)`
              : 'no GROUP BY — the whole input is one group',
        };
      } else {
        // Textbook independence assumption, same as an AND's selectivity:
        // the product of each column's distinct-value count, capped at the
        // rows actually going in — there cannot be more groups than rows.
        const groups = plan.groupBy.reduce((product, col) => product * ndistinct(table.rows, col), 1);
        const groupBasis = `${plan.groupBy.map((c) => `ndistinct(${c})`).join(' × ')}, capped at the input`;
        estimate = {
          estRows: Math.max(1, Math.min(child.estRows, clampRows(groups))),
          estPages: child.estPages + spillPages,
          basis:
            plan.op === 'SortAggregate'
              ? `${groupBasis}; sorts ${String(child.estRows)} rows first (${String(spillPages)} spill pages)`
              : groupBasis,
        };
      }
      break;
    }
    case 'Sort': {
      // Row order changes, not row count — but Sort's own I/O is the honest
      // number to surface here: a spill writes and re-reads the data, so its
      // page cost is real disk activity a Filter/Project never adds.
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      const spillPages = Math.max(1, Math.ceil(child.estRows / rowsPerPage));
      estimate = {
        estRows: child.estRows,
        estPages: 2 * spillPages,
        basis: `sorts ${String(child.estRows)} rows; at least ${String(2 * spillPages)} spill pages (run generation alone)`,
      };
      break;
    }
    case 'Project': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      estimate = { estRows: child.estRows, estPages: child.estPages, basis: child.basis };
      break;
    }
    case 'Limit': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      estimate = {
        estRows: Math.min(child.estRows, plan.count),
        estPages: child.estPages,
        basis: `min(${String(child.estRows)}, LIMIT ${String(plan.count)})`,
      };
      break;
    }
  }

  into.set(plan, estimate);
  return estimate;
}

/**
 * Per-node estimates for a plan tree. `otherTables` is the join partner's
 * `Table`, keyed by name — needed only when `plan` contains a `Join`; every
 * other caller (no JOIN in the query) omits it.
 */
export function estimatePlan(
  plan: Plan,
  table: Table,
  rowsPerPage: number,
  otherTables?: Record<string, Table>,
): PlanCost {
  const cost: PlanCost = new Map();
  estimateNode(plan, table, rowsPerPage, cost, otherTables);
  return cost;
}

/** The estimate for the plan's root node — the query's estimated output. */
export function rootEstimate(
  plan: Plan,
  table: Table,
  rowsPerPage: number,
  otherTables?: Record<string, Table>,
): CostEstimate {
  return estimateNode(plan, table, rowsPerPage, new Map(), otherTables);
}
