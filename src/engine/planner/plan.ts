/**
 * The logical plan. v0 keeps one representation rather than separate logical
 * and physical trees: the scan node carries its own access method, which is
 * what the optimizer actually chooses (plan.md §7.2–7.4).
 */

import type { PlanNode, SqlValue } from '../types.ts';
import { exprToSql } from '../parser/print.ts';
import type { AggregateFn, CompareOp, Expr } from '../parser/index.ts';
import type { PlanCost } from './cost.ts';

/**
 * What a `Project` keeps. `columns` reads named values straight off the row;
 * `expressions` (plan.md §25.4 B1b) *computes* each — `key` names the result
 * column, `sql` is how it is shown on the plan node (`n * 2 AS double`).
 */
export type ProjectList =
  | { kind: 'star' }
  | { kind: 'columns'; names: string[] }
  | { kind: 'expressions'; items: { key: string; expr: Expr; sql: string }[] };

/** One side of an `IndexRangeScan`'s bound — `inclusive` is `<=`/`>=` vs `<`/`>`. */
export interface RangeBound {
  value: SqlValue;
  inclusive: boolean;
}

/** One aggregate a `HashAggregate` computes, keyed by its canonical SQL text (e.g. `COUNT(*)`). */
export interface AggregateSpec {
  key: string;
  fn: AggregateFn;
  /** The column it reads, or `null` only for `COUNT(*)`. */
  column: string | null;
}

export type Plan =
  | { op: 'SeqScan'; table: string; filter?: Expr }
  /**
   * `FROM t1 JOIN t2 ON t1.a = t2.b` (plan.md §22.2), always the bottom of
   * the tree — `left`/`right` are always a bare `SeqScan` in v1 (no
   * predicate pushdown into either side yet, so both are always full scans).
   * `leftColumn`/`rightColumn` are the ON equality's two columns, resolved
   * once at build time to `left`'s side and `right`'s side respectively —
   * the parser's `checkJoinOn` already guarantees the ON clause is exactly
   * one equality between a qualified column on each side, whichever order
   * it was written in, so no consumer here has to re-figure out which
   * column belongs to which table. Three algorithms now, the same pair
   * `HashAggregate`/`SortAggregate` already are for `GROUP BY`, plus a third:
   * `nested-loop` rescans `right` whole per row of `left`; `hash` builds an
   * in-memory hash table over `right` once and probes it with `left`
   * streamed; `sort-merge` sorts both sides on the join key (each side its
   * own call into `externalMergeSort`, spilling through the real buffer pool
   * exactly as `ORDER BY`'s `Sort` does) and then merges the two sorted
   * lists in one pass.
   */
  | {
      op: 'Join';
      algorithm: 'nested-loop' | 'hash' | 'sort-merge';
      left: Plan;
      right: Plan;
      leftTable: string;
      rightTable: string;
      leftColumn: string;
      rightColumn: string;
    }
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
       * `>`, `<`, `>=`, `<=` (or a `BETWEEN`, desugared to both a `low` and a
       * `high`) on an indexed column (plan.md §23.1) — descend the B+Tree
       * once to the leaf the lower bound would start at (or the leftmost
       * leaf, with no lower bound), then walk the leaf sibling chain
       * horizontally rather than rescanning the whole table. Always touches
       * the heap — no index-only variant yet, unlike `IndexOnlyScan`; that
       * combination is its own follow-on.
       */
      op: 'IndexRangeScan';
      table: string;
      column: string;
      /** Absent means "no lower bound" — start at the tree's leftmost leaf. */
      low?: RangeBound;
      /** Absent means "no upper bound" — walk until the leaf chain ends. */
      high?: RangeBound;
      /** Conjuncts the range could not satisfy, re-checked per row. */
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
   * `HAVING` (plan.md §25.4 B2): a filter on the *groups* the aggregate produced —
   * `Project → Having → HashAggregate → Filter → …`. Like `Filter` it evaluates a
   * predicate per row, but the rows are groups and its aggregate operands read the
   * values the aggregate node already computed. A separate op so the rewrite rules
   * (which push WHERE *below* the aggregate) never confuse the two.
   */
  | { op: 'Having'; predicate: Expr; child: Plan }
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
  /**
   * `SELECT DISTINCT` (plan.md §25.4 B2), above the `Project`, below any `Limit`.
   * `HashDistinct` streams: it remembers every row it has passed in a hash set and
   * drops a repeat — so a `LIMIT` above it can stop early. `SortDistinct` cannot: it
   * sorts every row (spilling through the buffer pool, exactly as `ORDER BY` does)
   * so equal rows are neighbours, then keeps one of each run. `sortKey` is the
   * `ORDER BY` column it must sort *by first*, so the result comes out in that order.
   * Which one runs follows `EngineOptions.aggregateStrategy` — the same seam
   * `GROUP BY` uses, which is what lets `/compare` set them side by side.
   */
  | { op: 'HashDistinct'; child: Plan }
  | { op: 'SortDistinct'; sortKey?: { column: string; direction: 'asc' | 'desc' }; child: Plan }
  /** `LIMIT n`, always the outermost node when present: `Limit → Project → …`. */
  | { op: 'Limit'; count: number; /** Rows skipped first (`OFFSET m`); absent means none. */ offset?: number; child: Plan };

export function childOf(plan: Plan): Plan | undefined {
  return plan.op === 'Filter' ||
    plan.op === 'Having' ||
    plan.op === 'HashDistinct' ||
    plan.op === 'SortDistinct' ||
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
/** Whether the plan has a `SortDistinct` — which reserves a spill block of its own, after every other sort's. */
export function findSortDistinct(plan: Plan): Extract<Plan, { op: 'SortDistinct' }> | null {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'SortDistinct') return node;
    node = childOf(node);
  }
  return null;
}

export function needsSortSpill(plan: Plan): boolean {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'Sort' || node.op === 'SortAggregate') return true;
    node = childOf(node);
  }
  return false;
}

/**
 * The `Join` node, when it runs the `sort-merge` algorithm — `runQuery.ts`
 * needs this before the buffer pool exists too, to reserve scratch page ids
 * for *both* sides' own internal sort (each is its own `externalMergeSort`
 * call, plan.md §22.2). `childOf` stops at a `Join` (its own two children are
 * always a bare `SeqScan`, never a `Sort`), so this and `needsSortSpill`
 * never both fire on the same plan — `ORDER BY`/`GROUP BY` still can't
 * combine with `JOIN` at all.
 */
export function findSortMergeJoin(plan: Plan): Extract<Plan, { op: 'Join' }> | null {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'Join' && node.algorithm === 'sort-merge') return node;
    node = childOf(node);
  }
  return null;
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

/**
 * `col = literal` against the given column, in either operand order.
 *
 * A NULL literal is never a key: `col = NULL` is UNKNOWN for every row, so it
 * matches nothing whatever the index holds — and NULLs are not in the tree at
 * all (`buildIndex`). Returning `undefined` leaves the comparison where it
 * belongs, in the filter, which says UNKNOWN and rejects every row. (Found by
 * the SQLite oracle, plan.md §25.4 A1; the same rule guards `rangeOn`.)
 */
export function equalityOn(expr: Expr, column: string): SqlValue | undefined {
  if (expr.kind !== 'compare' || expr.op !== '=') return undefined;
  if (expr.left.kind === 'column' && expr.left.name === column && expr.right.kind === 'literal') {
    return expr.right.value ?? undefined;
  }
  if (expr.right.kind === 'column' && expr.right.name === column && expr.left.kind === 'literal') {
    return expr.left.value ?? undefined;
  }
  return undefined;
}

/** The operators an index range can answer: everything but `=` (its own rule) and `<>` (an index cannot narrow "not this"). */
type RangeOp = Exclude<CompareOp, '=' | '<>'>;

const FLIPPED_COMPARE_OP: Record<RangeOp, RangeOp> = {
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
};

/**
 * `col OP literal` against the given column, for `OP` in `<`, `>`, `<=`,
 * `>=` — in either operand order, with the operator flipped when the column
 * is on the right (`30 < age` reads as `age > 30`). `rangeIndexSelection`'s
 * sibling to `equalityOn`, above.
 */
export function rangeOn(
  expr: Expr,
  column: string,
): { op: RangeOp; value: SqlValue } | undefined {
  if (expr.kind !== 'compare' || expr.op === '=' || expr.op === '<>') return undefined;
  if (expr.left.kind === 'column' && expr.left.name === column && expr.right.kind === 'literal') {
    return expr.right.value === null ? undefined : { op: expr.op, value: expr.right.value };
  }
  if (expr.right.kind === 'column' && expr.right.name === column && expr.left.kind === 'literal') {
    return expr.left.value === null ? undefined : { op: FLIPPED_COMPARE_OP[expr.op], value: expr.left.value };
  }
  return undefined;
}

/** `age ≥ 30`, `age < 50`, or `age between 20 and 40` — an `IndexRangeScan`'s bounds, in words. */
export function formatRangeBounds(column: string, low?: RangeBound, high?: RangeBound): string {
  if (low && high) return `\`${column}\` between ${format(low.value)} and ${format(high.value)}`;
  if (low) return `\`${column}\` ${low.inclusive ? '≥' : '>'} ${format(low.value)}`;
  if (high) return `\`${column}\` ${high.inclusive ? '≤' : '<'} ${format(high.value)}`;
  return `\`${column}\``;
}

/** Re-exported: the printer lives beside the AST (`parser/print.ts`) so `selectItemKey` can use it. */
export { exprToSql } from '../parser/print.ts';

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
    case 'Join':
      return {
        id,
        op: 'Join',
        label: `Join (${plan.algorithm}) ${plan.leftTable} × ${plan.rightTable}`,
        detail: `on: ${plan.leftTable}.${plan.leftColumn} = ${plan.rightTable}.${plan.rightColumn}`,
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: [
          convert(plan.left, `${id}.0`, changed, estimates),
          convert(plan.right, `${id}.1`, changed, estimates),
        ],
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
    case 'IndexRangeScan':
      return {
        id,
        op: 'IndexRangeScan',
        label: `IndexRangeScan ${plan.table}.${plan.column}`,
        detail: plan.residual
          ? `range: ${formatRangeBounds(plan.column, plan.low, plan.high)} · recheck: ${exprToSql(plan.residual)}`
          : `range: ${formatRangeBounds(plan.column, plan.low, plan.high)}`,
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
    case 'Having':
      return {
        id,
        op: 'Having',
        label: 'Having',
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
        detail:
          plan.columns.kind === 'star'
            ? '*'
            : plan.columns.kind === 'columns'
              ? plan.columns.names.join(', ')
              : plan.columns.items.map((i) => i.sql).join(', '),
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
    case 'HashDistinct':
    case 'SortDistinct':
      return {
        id,
        op: plan.op,
        label: plan.op,
        detail: plan.op === 'SortDistinct' && plan.sortKey ? `DISTINCT, sorted by ${plan.sortKey.column} ${plan.sortKey.direction.toUpperCase()}` : 'DISTINCT',
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: kid(plan.child),
      };
    case 'Limit':
      return {
        id,
        op: 'Limit',
        label: `Limit ${String(plan.count)}`,
        ...(plan.offset ? { detail: `offset ${String(plan.offset)}` } : {}),
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
