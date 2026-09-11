import type { SqlValue } from '../types.ts';

export interface Span {
  from: number;
  to: number;
}

/** The comparison operators v0 supports. plan.md §4. */
export type CompareOp = '=' | '<' | '>';

export type Expr =
  | { kind: 'column'; name: string; span: Span }
  | { kind: 'literal'; value: SqlValue; raw: string; span: Span }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr; span: Span }
  | { kind: 'and'; left: Expr; right: Expr; span: Span };

/** The aggregate functions v0 supports (plan.md §22.2). */
export type AggregateFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

/** One entry of a SELECT list: a plain column, or an aggregate call over one. */
export type SelectItem =
  | { kind: 'column'; name: string; span: Span }
  | {
      kind: 'aggregate';
      fn: AggregateFn;
      /** `*` only appears on `COUNT` — every other function needs a real column. */
      arg: { kind: 'star'; span: Span } | { kind: 'column'; name: string; span: Span };
      span: Span;
    };

/** The column an aggregate reads, or `null` for `COUNT(*)`. */
export function selectItemArgColumn(item: Extract<SelectItem, { kind: 'aggregate' }>): string | null {
  return item.arg.kind === 'star' ? null : item.arg.name;
}

/** Canonical display key for a SELECT item — its own name, or e.g. `COUNT(*)`, `SUM(age)`. */
export function selectItemKey(item: SelectItem): string {
  if (item.kind === 'column') return item.name;
  return `${item.fn}(${item.arg.kind === 'star' ? '*' : item.arg.name})`;
}

export type SelectList =
  | { kind: 'star'; span: Span }
  | { kind: 'columns'; items: SelectItem[]; span: Span };

export interface TableRef {
  name: string;
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
  where?: Expr;
  groupBy?: GroupByClause;
  /**
   * `ORDER BY column [ASC|DESC]` — v0 sorts on one column, and not together
   * with `GROUP BY` (checked at parse time; `groupBy` and `orderBy` are
   * mutually exclusive on every `SelectStatement` this parser produces).
   */
  orderBy?: OrderByClause;
  /** `LIMIT n` — a non-negative whole number, checked at parse time. */
  limit?: LimitClause;
  span: Span;
}

export interface LimitClause {
  value: number;
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
  value: Extract<Expr, { kind: 'literal' }>;
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

/** Depth-first walk, parents before children. */
export function walkExpr(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  if (expr.kind === 'compare' || expr.kind === 'and') {
    walkExpr(expr.left, visit);
    walkExpr(expr.right, visit);
  }
}

/** Every column name referenced anywhere in a predicate. */
export function columnsIn(expr: Expr): string[] {
  const names: string[] = [];
  walkExpr(expr, (e) => {
    if (e.kind === 'column') names.push(e.name);
  });
  return names;
}
