/**
 * Predicate evaluation with SQL's three-valued logic.
 *
 * A comparison against NULL is UNKNOWN, not false — and only TRUE passes a
 * filter. That distinction is the reason `WHERE age > 30` and
 * `WHERE NOT (age <= 30)` do not partition a table with NULLs, which is a
 * genuine and commonly-missed piece of SQL semantics, so it is modelled rather
 * than flattened to booleans.
 */

import type { Expr } from '../parser/index.ts';
import type { Row, SqlValue } from '../types.ts';

/** null means UNKNOWN. */
export type Truth = boolean | null;

export function evaluateValue(expr: Expr, row: Row): SqlValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'column':
      return row[expr.name] ?? null;
    case 'compare':
    case 'and': {
      const truth = evaluatePredicate(expr, row);
      return truth;
    }
  }
}

/** Exported for `operators.ts`'s `HashAggregate` — MIN/MAX order values the same way a `<`/`>` predicate does. */
export function compare(op: '=' | '<' | '>', left: SqlValue, right: SqlValue): Truth {
  if (left === null || right === null) return null; // UNKNOWN

  if (typeof left === 'number' && typeof right === 'number') {
    return op === '=' ? left === right : op === '<' ? left < right : left > right;
  }

  const a = typeof left === 'boolean' ? String(Number(left)) : String(left);
  const b = typeof right === 'boolean' ? String(Number(right)) : String(right);
  return op === '=' ? a === b : op === '<' ? a < b : a > b;
}

export function evaluatePredicate(expr: Expr, row: Row): Truth {
  switch (expr.kind) {
    case 'compare':
      return compare(expr.op, evaluateValue(expr.left, row), evaluateValue(expr.right, row));

    case 'and': {
      const left = evaluatePredicate(expr.left, row);
      const right = evaluatePredicate(expr.right, row);
      // FALSE dominates: FALSE AND UNKNOWN is FALSE, not UNKNOWN.
      if (left === false || right === false) return false;
      if (left === null || right === null) return null;
      return true;
    }

    case 'literal':
      return expr.value === null ? null : Boolean(expr.value);

    case 'column': {
      const value = row[expr.name] ?? null;
      return value === null ? null : Boolean(value);
    }
  }
}

/** Only TRUE passes a WHERE clause. UNKNOWN does not. */
export function passes(expr: Expr | undefined, row: Row): boolean {
  if (!expr) return true;
  return evaluatePredicate(expr, row) === true;
}
