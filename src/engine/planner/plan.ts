/**
 * The logical plan. v0 keeps one representation rather than separate logical
 * and physical trees: the scan node carries its own access method, which is
 * what the optimizer actually chooses (plan.md §7.2–7.4).
 */

import type { JoinAlgorithm, PlanNode, RaInfo, SqlValue } from '../types.ts';
import { columnsOfIndex } from '../index/spec.ts';
import { exprToSql } from '../parser/print.ts';
import { walkExpr } from '../parser/index.ts';
import type { AggregateFn, CompareOp, Expr, SetOperator } from '../parser/index.ts';
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
   * `FROM t1 JOIN t2 ON t1.a = t2.b`, always at the bottom of the tree (plan.md §22.2) — `right` is always a bare
   * `SeqScan` (or, for `index-nested-loop`, an `IndexProbe`) on the one table this `JOIN` clause introduces: no
   * predicate pushdown into it yet, so it is always a full scan or probe, never itself a `Join`. `left` is the same,
   * for a query's only `JOIN` — but a chain of them (plan.md §25.4 C3 slice b, `FROM a JOIN b ON … JOIN c ON …`)
   * nests left-deep, so a later `JOIN`'s `left` is the *previous* `Join` node, not a bare scan; `joinsIn` walks the
   * whole chain. `leftColumn`/`rightColumn` are the ON equality's two columns, resolved once at build time to
   * `left`'s side and `right`'s side respectively — the parser's `checkJoinOn`/`checkJoinChain` already guarantee
   * the ON clause is exactly one equality between a qualified column naming this table and one naming a table
   * already in the chain, whichever order it was written in, so no consumer here has to re-figure out which column
   * belongs to which table (`leftTable`, similarly, need not be `left`'s *only* table once a chain nests — just the
   * one the ON clause's left-hand column actually names). Three algorithms now, the same pair
   * `HashAggregate`/`SortAggregate` already are for `GROUP BY`, plus a third:
   * `nested-loop` rescans `right` whole per row of `left`; `hash` builds an
   * in-memory hash table over `right` once and probes it with `left`
   * streamed; `sort-merge` sorts both sides on the join key (each side its
   * own call into `externalMergeSort`, spilling through the real buffer pool
   * exactly as `ORDER BY`'s `Sort` does) and then merges the two sorted
   * lists in one pass; `index-nested-loop` (plan.md §25.4 B4) never scans
   * `right` at all — `right` is an `IndexProbe`, and each `left` row descends
   * `right`'s own B+Tree on `rightColumn` to find its partners.
   */
  | {
      op: 'Join';
      algorithm: JoinAlgorithm;
      /** `LEFT JOIN` (plan.md §25.4 C3): every row of `left` appears at least once, NULL-padded on `right`'s side
       *  when nothing matched it. Absent means the join's original, still-default shape: an inner join, where an
       *  unmatched `left` row simply does not appear. `semi` and `anti` (plan.md §27.5 S1) are how a correlated
       *  `EXISTS` and `NOT EXISTS` run: a `left` row comes out at most once and unchanged — kept when it has a match on
       *  `right` (semi) or when it has none (anti) — and `right`'s columns never reach the rows above. Always after
       *  every inner and LEFT join in a chain. `right` and `full` (plan.md §27.5 S4) keep `right`'s unmatched rows too,
       *  NULL-padded on every column of `left`'s tables; `cross` pairs every row with every row — no key, so
       *  `leftColumn`/`rightColumn` are empty and only nested-loop can run it. */
      joinType?: 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti';
      /** A semi- or anti-join's further condition on each key-matched pair (plan.md §27.5 S1) — the rest of the
       *  subquery's `WHERE` that names both tables, qualified, read off the two rows merged. */
      residual?: Expr;
      left: Plan;
      right: Plan;
      leftTable: string;
      rightTable: string;
      leftColumn: string;
      rightColumn: string;
    }
  /**
   * The inner side of an `index-nested-loop` `Join` (plan.md §25.4 B4): a lookup
   * on `table`'s B+Tree over `column` whose key is not a constant but *the
   * current outer row's* `outerColumn` — so it runs once per outer row rather
   * than once. Only ever the `right` child of a `Join`, and only when `table`
   * really has an index on `column`.
   */
  | { op: 'IndexProbe'; table: string; column: string; outerTable: string; outerColumn: string }
  | {
      op: 'IndexScan';
      table: string;
      /**
       * The index the lookup goes through, by name (`indexNameOf`) — the indexed column for a plain index, the
       * columns joined by `, ` for a composite one.
       */
      column: string;
      /** The lookup value — for a composite index, the first one (`keys` has them all). */
      key: SqlValue;
      /**
       * A composite index's equality values, for its leading columns in key order — `[1]` or `[1, 'x']` for an index
       * on `(a, b)`: a *leftmost prefix*, so it may be shorter than the index is wide but never skips a column.
       * Absent for a plain index, where `key` is the whole lookup.
       */
      keys?: SqlValue[];
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
      /** The index, by name — see `IndexScan.column`. */
      column: string;
      /**
       * A composite index's equality values for the columns *before* the range one, in key order: with `prefix`
       * `[1]` on an index `(a, b)`, `low`/`high` bound `b` within `a = 1`. Absent (or empty) means the range is on
       * the index's leading column.
       */
      prefix?: SqlValue[];
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
      /** The index, by name — see `IndexScan.column`. A composite index answers any query over *its own* columns. */
      column: string;
      key: SqlValue;
      /** A composite index's leading-column equality values — see `IndexScan.keys`. */
      keys?: SqlValue[];
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
  /**
   * Two inputs combined by a set operator (plan.md §27.5 S3) — each a whole SELECT's plan (a member of a compound
   * query), or for a chain, `left` is the combination so far. `UNION ALL` (`all`) passes every row of `left` and then
   * every row of `right`; a plain `UNION` is that with a `HashDistinct` or `SortDistinct` above it, the same node
   * `SELECT DISTINCT` uses. `INTERSECT` and `EXCEPT` read `right` into a hash set first, then keep each distinct row
   * of `left` that is (or is not) in it — NULLs counting as equal, as in `DISTINCT`. Rows are matched by position:
   * `right`'s columns (`rightColumns`) are renamed to `columns`, the result's, which the first member names.
   */
  | {
      op: 'SetOp';
      kind: SetOperator;
      /** Only for `UNION`: keep every row, repeats included. INTERSECT and EXCEPT always return each row once. */
      all: boolean;
      left: Plan;
      right: Plan;
      columns: string[];
      rightColumns: string[];
      /** Which SELECT of the compound `right` is — 2 for the second — telling this node apart from another in a chain. */
      position: number;
    }
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
 * know before the buffer pool exists, to reserve its spill's page ids. A Sort
 * only ever sits above any `Join` (whose `left`/`right` `childOf` does not
 * enter), so walking `childOf` from the root reaches it.
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
 * The `SortAggregate` node, if the plan has one — it runs `externalMergeSort` internally to order its groups, so
 * `runQuery.ts` reserves it a spill block of its own, before ORDER BY's `Sort` (which runs after it, above it).
 */
export function findSortAggregate(plan: Plan): Extract<Plan, { op: 'SortAggregate' }> | null {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'SortAggregate') return node;
    node = childOf(node);
  }
  return null;
}

/** Whether the plan has a `SortDistinct` — which reserves a spill block of its own, after every other sort's. */
export function findSortDistinct(plan: Plan): Extract<Plan, { op: 'SortDistinct' }> | null {
  let node: Plan | undefined = plan;
  while (node) {
    if (node.op === 'SortDistinct') return node;
    node = childOf(node);
  }
  return null;
}

/**
 * Every `Join` node in `plan`, in source order — the first `JOIN` clause first, the last (outermost in the tree,
 * plan.md §25.4 C3 slice b) last. `childOf` stops at a `Join` (it has `left`/`right`, not `child`), so finding more
 * than the outermost one means recursing into `left` on purpose: a left-deep chain's `right` side is always a base
 * table's own scan or probe, never itself a `Join`, so only `left` is ever worth walking further into. A `Sort` (plan.md
 * §26 Feature 1) always sits above the whole chain, so `findSort` finds it on the way down and this never meets it.
 */
export function joinsIn(plan: Plan): Extract<Plan, { op: 'Join' }>[] {
  let node: Plan | undefined = plan;
  while (node && node.op !== 'Join') node = childOf(node);
  if (!node) return [];
  return [...joinsIn(node.left), node];
}

/**
 * Every `Join` in the chain that runs the `sort-merge` algorithm — `runQuery.ts` needs these before the buffer pool
 * exists, to reserve scratch page ids for each one's own two internal sorts (each side its own `externalMergeSort`
 * call, plan.md §22.2).
 */
export function findSortMergeJoins(plan: Plan): Extract<Plan, { op: 'Join' }>[] {
  return joinsIn(plan).filter((j) => j.algorithm === 'sort-merge');
}

/**
 * Every `Join` in the chain that runs the `index-nested-loop` algorithm — `runQuery.ts` needs these before the
 * buffer pool exists, to build each one's own inner table's B+Tree (plan.md §25.4 B4) and give its pages ids of
 * their own.
 */
export function findIndexNestedLoopJoins(plan: Plan): Extract<Plan, { op: 'Join' }>[] {
  return joinsIn(plan).filter((j) => j.algorithm === 'index-nested-loop');
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
 * What every `IN (subquery)` in `where` resolved to (plan.md §25.4 C3 slice c) — `subquery.ts`'s
 * `resolveStatementSubqueries` already ran each one exactly once, before this plan was even built, and filled its
 * `items` with the real values found; this just says so, once, for the WHERE-clause narration (`emit.ts`,
 * `emitDelete.ts`, `emitUpdate.ts` all share it). Empty when `where` has none — the ordinary case, and the only
 * one before this slice existed at all.
 */
export function subqueryResolutionNotes(where: Expr): string[] {
  const notes: string[] = [];
  walkExpr(where, (e) => {
    if (e.kind === 'in' && e.subquery) {
      const found =
        e.items.length === 0
          ? `finding no values at all — so \`${e.negated ? 'NOT IN' : 'IN'}\` is ${e.negated ? 'TRUE' : 'FALSE'} for every row, even one whose value is NULL`
          : `finding ${e.items.length} distinct value${e.items.length === 1 ? '' : 's'}`;
      notes.push(
        `its subquery \`SELECT ${e.subquery.column.name} FROM ${e.subquery.from.name}${e.subquery.where ? ' WHERE …' : ''}\` already ran once, before this plan was built, ${found}`,
      );
    }
    // An uncorrelated EXISTS (plan.md §27.5 S1): the same answer for every row, so it ran once, like an IN subquery.
    if (e.kind === 'exists' && e.resolved !== undefined) {
      notes.push(
        `its \`EXISTS (SELECT ${e.subquery.select} FROM ${e.subquery.from.name}${e.subquery.where ? ' WHERE …' : ''})\` names nothing from the outer query, so its answer is the same for every row: it already ran once, before this plan was built, stopping at the first row, and ${e.resolved ? `found one — EXISTS is TRUE` : `found none — EXISTS is FALSE`} for every row`,
      );
    }
  });
  return notes;
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

/** The equality values an `IndexScan` / `IndexOnlyScan` looks up, in index-column order — one, unless the index is composite. */
export const lookupKeysOf = (plan: { key: SqlValue; keys?: SqlValue[] }): SqlValue[] => plan.keys ?? [plan.key];

/** An index's name as it reads in a plan label: `id`, or `(lastName, firstName)` for a composite one. */
export const indexLabel = (name: string): string => (columnsOfIndex(name).length > 1 ? `(${name})` : name);

/** `a = 1 AND b = 'x'` — the equalities a lookup on the index `name` makes, for as many leading columns as it has keys. */
export function lookupText(name: string, keys: readonly SqlValue[]): string {
  const columns = columnsOfIndex(name);
  return keys.map((value, i) => `${columns[i] ?? name} = ${format(value)}`).join(' AND ');
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

/** A predicate over `column` for a range bound, as SQL — `age >= 30`. */
function boundSql(column: string, bound: RangeBound, side: 'low' | 'high'): string {
  const op = side === 'low' ? (bound.inclusive ? '>=' : '>') : bound.inclusive ? '<=' : '<';
  return `${column} ${op} ${format(bound.value)}`;
}

/**
 * The relational-algebra reading of a plan node (plan.md §25.4 B5). Physical
 * choices vanish — a sequential scan with a filter and an index lookup both
 * become σ over the relation — which is exactly the point: the algebra says
 * *what* is computed, the plan tree says *how*.
 */
function raOf(plan: Plan): RaInfo {
  switch (plan.op) {
    case 'SeqScan':
      return plan.filter
        ? { symbol: 'σ', sub: exprToSql(plan.filter), rel: plan.table }
        : { symbol: 'rel', rel: plan.table };
    case 'IndexProbe':
      // In algebra the inner side of a join is just the relation; *how* it is reached is the physical plan's business.
      return { symbol: 'rel', rel: plan.table };
    case 'IndexScan':
    case 'IndexOnlyScan': {
      const parts = [lookupText(plan.column, lookupKeysOf(plan))];
      if (plan.op === 'IndexScan' && plan.residual) parts.push(exprToSql(plan.residual));
      return { symbol: 'σ', sub: parts.join(' AND '), rel: plan.table };
    }
    case 'IndexRangeScan': {
      const rangeColumn = columnsOfIndex(plan.column)[plan.prefix?.length ?? 0] ?? plan.column;
      const parts = [
        ...(plan.prefix && plan.prefix.length > 0 ? [lookupText(plan.column, plan.prefix)] : []),
        ...(plan.low ? [boundSql(rangeColumn, plan.low, 'low')] : []),
        ...(plan.high ? [boundSql(rangeColumn, plan.high, 'high')] : []),
        ...(plan.residual ? [exprToSql(plan.residual)] : []),
      ];
      return { symbol: 'σ', sub: parts.join(' AND '), rel: plan.table };
    }
    case 'Filter':
    case 'Having':
      return { symbol: 'σ', sub: exprToSql(plan.predicate) };
    case 'SetOp':
      return { symbol: plan.kind === 'union' ? '∪' : plan.kind === 'intersect' ? '∩' : '−' };
    case 'Join':
      return plan.joinType === 'cross'
        ? { symbol: '×' }
        : {
            symbol: joinSymbol(plan),
            sub: `${plan.leftTable}.${plan.leftColumn} = ${plan.rightTable}.${plan.rightColumn}${plan.residual ? ` AND ${exprToSql(plan.residual)}` : ''}`,
          };
    case 'HashAggregate':
    case 'SortAggregate': {
      const keys = plan.aggregates.map((a) => a.key).join(', ');
      return { symbol: 'γ', sub: plan.groupBy.length > 0 ? `${plan.groupBy.join(', ')}; ${keys}` : keys };
    }
    case 'Sort':
      return { symbol: 'τ', sub: `${plan.column} ${plan.direction === 'asc' ? '↑' : '↓'}` };
    case 'Project':
      return {
        symbol: 'π',
        sub:
          plan.columns.kind === 'star'
            ? '*'
            : plan.columns.kind === 'columns'
              ? plan.columns.names.join(', ')
              : plan.columns.items.map((i) => i.sql).join(', '),
      };
    case 'HashDistinct':
    case 'SortDistinct':
      return { symbol: 'δ' };
    case 'Limit':
      return { symbol: 'λ', sub: plan.offset ? `${String(plan.count)}, offset ${String(plan.offset)}` : String(plan.count) };
  }
}

/**
 * A `Join`'s relational-algebra symbol: ⋈ for an inner join, ⟕ ⟖ ⟗ for the outer joins and × for a cross join (plan.md
 * §27.5 S4 — LEFT's was ⋈ until then, which the algebra does not mean), ⋉ and ▷ for a semi- and an anti-join (S1).
 */
function joinSymbol(plan: Extract<Plan, { op: 'Join' }>): RaInfo['symbol'] {
  switch (plan.joinType) {
    case 'semi':
      return '⋉';
    case 'anti':
      return '▷';
    case 'left':
      return '⟕';
    case 'right':
      return '⟖';
    case 'full':
      return '⟗';
    case 'cross':
      return '×';
    default:
      return '⋈';
  }
}

/** A `Join`'s label word: `Join` for an inner join, otherwise its kind (plan.md §27.5 S4). */
const JOIN_WORD: Record<NonNullable<Extract<Plan, { op: 'Join' }>['joinType']> | 'inner', string> = {
  inner: 'Join',
  left: 'Left join',
  right: 'Right join',
  full: 'Full join',
  cross: 'Cross join',
  semi: 'Semi-join',
  anti: 'Anti-join',
};

function convert(
  plan: Plan,
  id: string,
  changed: ReadonlySet<Plan>,
  estimates: PlanCost | undefined,
): PlanNode {
  return { ...convertBody(plan, id, changed, estimates), ra: raOf(plan) };
}

function convertBody(
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
        table: plan.table,
        ...(highlight ? { highlight } : {}),
        ...cost,
      };
    case 'Join':
      return {
        id,
        op: 'Join',
        label:
          plan.joinType === 'semi' || plan.joinType === 'anti'
            ? `${JOIN_WORD[plan.joinType]} (${plan.algorithm}) ${plan.leftTable} ${joinSymbol(plan)} ${plan.rightTable}`
            : `${JOIN_WORD[plan.joinType ?? 'inner']} (${plan.algorithm}) ${plan.leftTable} × ${plan.rightTable}`,
        detail:
          plan.joinType === 'cross'
            ? 'every pair of rows'
            : `on: ${plan.leftTable}.${plan.leftColumn} = ${plan.rightTable}.${plan.rightColumn}${plan.residual ? ` · and: ${exprToSql(plan.residual)}` : ''}`,
        // `rightTable` is the table this specific `Join` step introduces — unique across a chain, since the parser
        // never allows a query to name the same table twice (plan.md §25.4 C3 slice b) — so it is what disambiguates
        // this node from another `Join` in the same chain for EXPLAIN ANALYZE's actual-row lookup (see `table`'s
        // own doc comment on `PlanNode`), the same way `plan.table` does for a scan below.
        table: plan.rightTable,
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: [
          convert(plan.left, `${id}.0`, changed, estimates),
          convert(plan.right, `${id}.1`, changed, estimates),
        ],
      };
    case 'SetOp':
      return {
        id,
        op: 'SetOp',
        label: plan.kind === 'union' ? 'Union all' : plan.kind === 'intersect' ? 'Intersect (hash)' : 'Except (hash)',
        detail: `columns: ${plan.columns.join(', ')}${plan.rightColumns.some((c, i) => c !== plan.columns[i]) ? ` · SELECT ${String(plan.position)} matched by position: ${plan.rightColumns.join(', ')}` : ''}`,
        table: `SELECT ${String(plan.position)}`,
        ...(highlight ? { highlight } : {}),
        ...cost,
        children: [
          convert(plan.left, `${id}.0`, changed, estimates),
          convert(plan.right, `${id}.1`, changed, estimates),
        ],
      };
    case 'IndexProbe':
      return {
        id,
        op: 'IndexProbe',
        label: `IndexProbe ${plan.table}.${indexLabel(plan.column)}`,
        detail: `key: ${plan.column} = ${plan.outerTable}.${plan.outerColumn} — once per ${plan.outerTable} row`,
        ...(highlight ? { highlight } : {}),
        ...cost,
      };
    case 'IndexScan':
      return {
        id,
        op: 'IndexScan',
        label: `IndexScan ${plan.table}.${indexLabel(plan.column)}`,
        detail: plan.residual
          ? `key: ${lookupText(plan.column, lookupKeysOf(plan))} · recheck: ${exprToSql(plan.residual)}`
          : `key: ${lookupText(plan.column, lookupKeysOf(plan))}`,
        table: plan.table,
        ...(highlight ? { highlight } : {}),
        ...cost,
      };
    case 'IndexOnlyScan':
      return {
        id,
        op: 'IndexOnlyScan',
        label: `IndexOnlyScan ${plan.table}.${indexLabel(plan.column)}`,
        detail: `key: ${lookupText(plan.column, lookupKeysOf(plan))} · never touches the heap`,
        table: plan.table,
        ...(highlight ? { highlight } : {}),
        ...cost,
      };
    case 'IndexRangeScan':
      return {
        id,
        op: 'IndexRangeScan',
        label: `IndexRangeScan ${plan.table}.${indexLabel(plan.column)}`,
        detail: (() => {
          const rangeColumn = columnsOfIndex(plan.column)[plan.prefix?.length ?? 0] ?? plan.column;
          const within = plan.prefix && plan.prefix.length > 0 ? `${lookupText(plan.column, plan.prefix)}, ` : '';
          const range = `range: ${within}${formatRangeBounds(rangeColumn, plan.low, plan.high)}`;
          return plan.residual ? `${range} · recheck: ${exprToSql(plan.residual)}` : range;
        })(),
        table: plan.table,
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
