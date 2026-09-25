import type { SqlValue } from '../types.ts';
import type { ArithOp } from '../value.ts';
import { exprToSql } from './print.ts';

export interface Span {
  from: number;
  to: number;
}

/**
 * The comparison operators. plan.md §4, widened by §23.1's leaf-chaining range
 * scans: `BETWEEN lo AND hi` is not its own operator — the parser desugars it
 * to `col >= lo AND col <= hi` at parse time, so `<=`/`>=` are the only new
 * surface there. `<>` is not-equal (`!=` is accepted and normalised to it,
 * plan.md §25.4 B1): never an index equality or range, so it is a filter.
 */
export type CompareOp = '=' | '<>' | '<' | '>' | '<=' | '>=';

/**
 * `table` is set only by a qualified reference (`authors.id`) — v0 requires
 * one whenever a query joins two tables (plan.md §22.2), so a bare `column`
 * reference alone can never be ambiguous. A single-table query may still
 * qualify redundantly (`SELECT users.id FROM users`), validated against the
 * one table in scope.
 *
 * A predicate is a tree of these (plan.md §25.4 B1). `and`, `or` and `not`
 * combine truth values under SQL's three-valued logic — `null` from `evaluate.ts`
 * is UNKNOWN, and only TRUE passes a filter. `isNull` is the one test that is
 * never UNKNOWN; `in` and `like` are UNKNOWN when their operand is NULL.
 */
export type Expr =
  | { kind: 'column'; name: string; table?: string; span: Span }
  | { kind: 'literal'; value: SqlValue; raw: string; span: Span }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr; span: Span }
  | { kind: 'and'; left: Expr; right: Expr; span: Span }
  | { kind: 'or'; left: Expr; right: Expr; span: Span }
  | { kind: 'not'; operand: Expr; span: Span }
  /** `x IS NULL` / `x IS NOT NULL` (`negated`). TRUE or FALSE, never UNKNOWN. */
  | { kind: 'isNull'; operand: Expr; negated: boolean; span: Span }
  /** `x [NOT] IN (a, b, …)` — `items` are literals or columns, never a subquery (§25.10). */
  | { kind: 'in'; operand: Expr; items: Expr[]; negated: boolean; span: Span }
  /** `x [NOT] LIKE 'pattern'` — `%` any run, `_` one character, case-sensitive, no escape character. */
  | { kind: 'like'; operand: Expr; pattern: Expr; negated: boolean; span: Span }
  /**
   * `a + b`, `a - b`, `a * b`, `a / b`, `a % b` (plan.md §25.4 B1b) — a *value*,
   * not a truth value: NULL in, NULL out; `x / 0` is NULL; whole-number `/`
   * truncates. See `value.ts`. A comparison, `SELECT` item or `SET` value can hold one.
   */
  | { kind: 'arith'; op: ArithOp; left: Expr; right: Expr; span: Span }
  /** Unary minus on anything that is not a plain numeric literal (`-5` is folded to a literal at parse time). */
  | { kind: 'neg'; operand: Expr; span: Span };

/** The aggregate functions v0 supports (plan.md §22.2). */
export type AggregateFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

/** One entry of a SELECT list: a plain column, or an aggregate call over one. */
export type SelectItem =
  | { kind: 'column'; name: string; table?: string; span: Span }
  /**
   * A computed column (plan.md §25.4 B1b): `price * qty`, `age > 30`, or a
   * plain column given an `AS` alias. Its result column is named by `alias`,
   * or by the expression's own canonical SQL text. Not combinable with
   * `GROUP BY` or an aggregate yet.
   */
  | { kind: 'expression'; expr: Expr; alias?: string; span: Span }
  | {
      kind: 'aggregate';
      fn: AggregateFn;
      /** `*` only appears on `COUNT` — every other function needs a real column. */
      arg: { kind: 'star'; span: Span } | { kind: 'column'; name: string; table?: string; span: Span };
      span: Span;
    };

/** A qualified reference's row key — `authors.id` — or the bare name when unqualified. */
export function columnKey(ref: { name: string; table?: string }): string {
  return ref.table ? `${ref.table}.${ref.name}` : ref.name;
}

/** The row key an aggregate reads, or `null` for `COUNT(*)`. */
export function selectItemArgColumn(item: Extract<SelectItem, { kind: 'aggregate' }>): string | null {
  return item.arg.kind === 'star' ? null : columnKey(item.arg);
}

/** Canonical display key for a SELECT item — its own name, or e.g. `COUNT(*)`, `SUM(age)`. */
export function selectItemKey(item: SelectItem): string {
  if (item.kind === 'column') return columnKey(item);
  if (item.kind === 'expression') return item.alias ?? exprToSql(item.expr);
  return `${item.fn}(${item.arg.kind === 'star' ? '*' : columnKey(item.arg)})`;
}

export type SelectList =
  | { kind: 'star'; span: Span }
  | { kind: 'columns'; items: SelectItem[]; span: Span };

export interface TableRef {
  name: string;
  span: Span;
}

/**
 * `JOIN table ON t1.col = t2.col` (plan.md §22.2). Exactly one join, an
 * implicit inner join (bare `JOIN`, no `LEFT`/`RIGHT`/`FULL` yet), and `on`
 * is always a single equality between one qualified column from each side —
 * checked at parse time (`checkJoinOn`), so the planner never has to. v1 of
 * JOIN does not combine with `GROUP BY`, `ORDER BY` or an aggregate SELECT
 * item — each checked at parse time too, the same way `GROUP BY`/`ORDER BY`
 * already exclude each other.
 */
export interface JoinClause {
  table: TableRef;
  on: Extract<Expr, { kind: 'compare' }>;
  span: Span;
}

/**
 * `GROUP BY col [, col ...]` (plan.md §22.2). No `HAVING` — v0 doesn't have
 * it (same scope line as always: the plumbing to filter *after* aggregation
 * is a different predicate evaluator, not this one).
 */
export interface GroupByClause {
  columns: { name: string; span: Span }[];
  span: Span;
}

export interface SelectStatement {
  kind: 'select';
  select: SelectList;
  from: TableRef;
  join?: JoinClause;
  where?: Expr;
  groupBy?: GroupByClause;
  /**
   * `ORDER BY column [ASC|DESC]` — v0 sorts on one column, and not together
   * with `GROUP BY` (checked at parse time; `groupBy` and `orderBy` are
   * mutually exclusive on every `SelectStatement` this parser produces).
   */
  orderBy?: OrderByClause;
  /** `LIMIT n [OFFSET m]` — non-negative whole numbers, checked at parse time. */
  limit?: LimitClause;
  span: Span;
}

export interface LimitClause {
  value: number;
  /**
   * `OFFSET m` (plan.md §25.4 B1c): skip the first `m` rows of the (ordered)
   * result before the `LIMIT` counts. Only ever present beside a `LIMIT`, as in
   * SQLite. The span of the whole clause takes it in.
   */
  offset?: number;
  span: Span;
}

export interface OrderByClause {
  column: string;
  direction: 'asc' | 'desc';
  /** Span of the column name, for the "no column called X" check. */
  span: Span;
}

/**
 * `DELETE FROM table [WHERE expr]` (plan.md §22.2, the write path). Shares
 * `TableRef`/`Expr` with `SelectStatement` — a delete's WHERE is the same
 * predicate grammar, found the same way.
 */
export interface DeleteStatement {
  kind: 'delete';
  from: TableRef;
  where?: Expr;
  span: Span;
}

/**
 * `INSERT INTO table [(col, col, ...)] VALUES (value, value, ...)` (plan.md
 * §22.2, the write path's second statement). Values are literals only — v0
 * has no expressions or subqueries in a `VALUES` list — and there is exactly
 * one row per statement. Omitting the column list means every column, in
 * table order, same as standard SQL.
 */
export interface InsertColumnList {
  names: { name: string; span: Span }[];
  span: Span;
}

export interface InsertValues {
  items: Extract<Expr, { kind: 'literal' }>[];
  span: Span;
}

export interface InsertStatement {
  kind: 'insert';
  into: TableRef;
  /** Explicit column list, if given. Omitted means every column, in table order. */
  columns?: InsertColumnList;
  values: InsertValues;
  span: Span;
}

/**
 * `UPDATE table SET col = value [, col = value ...] [WHERE expr]` (plan.md
 * §22.2, the write path's third and last statement). Assignment values are
 * literals only, same as `INSERT`'s `VALUES` — no expressions, no reading
 * one column to set another.
 */
export interface UpdateAssignment {
  column: string;
  columnSpan: Span;
  /**
   * Any expression (plan.md §25.4 B1b) — `SET n = n + 1` reads the row *as it
   * was before this statement*, for every assignment in the list.
   */
  value: Expr;
}

export interface UpdateStatement {
  kind: 'update';
  table: TableRef;
  set: { assignments: UpdateAssignment[]; span: Span };
  where?: Expr;
  span: Span;
}

/** Every statement form `parseStatement` can produce. `parse` stays SELECT-only. */
export type Statement = SelectStatement | DeleteStatement | InsertStatement | UpdateStatement;

/** The direct sub-expressions of a node, in source order. */
export function childrenOf(expr: Expr): Expr[] {
  switch (expr.kind) {
    case 'column':
    case 'literal':
      return [];
    case 'compare':
    case 'and':
    case 'or':
    case 'arith':
      return [expr.left, expr.right];
    case 'not':
    case 'isNull':
    case 'neg':
      return [expr.operand];
    case 'in':
      return [expr.operand, ...expr.items];
    case 'like':
      return [expr.operand, expr.pattern];
  }
}

/** `expr` with `f` applied to each direct sub-expression — the rebuild half of `childrenOf`. */
export function mapChildren(expr: Expr, f: (child: Expr) => Expr): Expr {
  switch (expr.kind) {
    case 'column':
    case 'literal':
      return expr;
    case 'compare':
    case 'and':
    case 'or':
    case 'arith':
      return { ...expr, left: f(expr.left), right: f(expr.right) };
    case 'not':
    case 'isNull':
    case 'neg':
      return { ...expr, operand: f(expr.operand) };
    case 'in':
      return { ...expr, operand: f(expr.operand), items: expr.items.map(f) };
    case 'like':
      return { ...expr, operand: f(expr.operand), pattern: f(expr.pattern) };
  }
}

/** Depth-first walk, parents before children. */
export function walkExpr(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  for (const child of childrenOf(expr)) walkExpr(child, visit);
}

/** Every column name referenced anywhere in a predicate. */
export function columnsIn(expr: Expr): string[] {
  const names: string[] = [];
  walkExpr(expr, (e) => {
    if (e.kind === 'column') names.push(e.name);
  });
  return names;
}
