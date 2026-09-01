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

export type SelectList =
  | { kind: 'star'; span: Span }
  | { kind: 'columns'; names: { name: string; span: Span }[]; span: Span };

export interface TableRef {
  name: string;
  span: Span;
}

export interface SelectStatement {
  kind: 'select';
  select: SelectList;
  from: TableRef;
  where?: Expr;
  span: Span;
}

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
