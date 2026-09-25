/**
 * Predicate evaluation with SQL's three-valued logic.
 *
 * A comparison against NULL is UNKNOWN, not false — and only TRUE passes a
 * filter. That distinction is the reason `WHERE age > 30` and
 * `WHERE NOT (age <= 30)` do not partition a table with NULLs, which is a
 * genuine and commonly-missed piece of SQL semantics, so it is modelled rather
 * than flattened to booleans.
 *
 * plan.md §25.4 B1 adds `OR`, `NOT`, `IS [NOT] NULL`, `IN` and `LIKE`, each with
 * its own truth table below. The two that surprise people:
 *
 *   NOT UNKNOWN is UNKNOWN          so `NOT (x = 1)` still rejects the NULL rows
 *   x NOT IN (1, NULL) is never TRUE   because `x <> NULL` is UNKNOWN for every x
 *
 * The tests in `oracle/` (ternary-logic partitioning, and a differential run
 * against SQLite) check these tables against an outside authority.
 */

import { columnKey } from '../parser/index.ts';
import type { CompareOp, Expr } from '../parser/index.ts';
import type { Row, SqlValue } from '../types.ts';

/** null means UNKNOWN. */
export type Truth = boolean | null;

export function evaluateValue(expr: Expr, row: Row): SqlValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'column':
      return row[columnKey(expr)] ?? null;
    default:
      return evaluatePredicate(expr, row);
  }
}

/** Exported for `operators.ts`'s `HashAggregate` — MIN/MAX order values the same way a `<`/`>` predicate does. */
export function compare(op: CompareOp, left: SqlValue, right: SqlValue): Truth {
  if (left === null || right === null) return null; // UNKNOWN

  if (typeof left === 'number' && typeof right === 'number') {
    return compareOrdered(op, left, right);
  }

  const a = typeof left === 'boolean' ? String(Number(left)) : String(left);
  const b = typeof right === 'boolean' ? String(Number(right)) : String(right);
  return compareOrdered(op, a, b);
}

function compareOrdered<T extends number | string>(op: CompareOp, a: T, b: T): boolean {
  switch (op) {
    case '=':
      return a === b;
    case '<>':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
  }
}

/**
 * A canonical string key for `=` comparison, exported for `operators.ts`'s
 * hash join (plan.md §22.2): two non-null values collide under this key
 * exactly when `compare('=', a, b)` above would say `true` — the same
 * coercion, just computed once per value instead of pairwise. Never called
 * on `null` — a NULL join key is filtered out before it would reach this,
 * the same "NULL never matches NULL" rule `compare` itself enforces.
 */
export function equalityKeyOf(value: Exclude<SqlValue, null>): string {
  return typeof value === 'boolean' ? String(Number(value)) : String(value);
}

const textOf = (value: Exclude<SqlValue, null>): string => equalityKeyOf(value);

const likeCache = new Map<string, RegExp>();

/**
 * `LIKE`: `%` matches any run of characters (including none), `_` exactly one,
 * and everything else matches itself. **Case-sensitive**, as in PostgreSQL —
 * SQLite's default is case-insensitive for ASCII, one of the documented
 * differences in `oracle/ledger.ts`. There is no escape character, so a literal
 * `%` or `_` cannot be matched; a pattern is a teaching device here, not a
 * regular expression engine.
 */
export function likeMatches(text: string, pattern: string): boolean {
  let re = likeCache.get(pattern);
  if (!re) {
    const body = [...pattern]
      .map((ch) => (ch === '%' ? '[\\s\\S]*' : ch === '_' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${body}$`, 's');
    likeCache.set(pattern, re);
  }
  return re.test(text);
}

const negate = (t: Truth, negated: boolean): Truth => (negated && t !== null ? !t : t);

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

    case 'or': {
      const left = evaluatePredicate(expr.left, row);
      const right = evaluatePredicate(expr.right, row);
      // TRUE dominates: TRUE OR UNKNOWN is TRUE, not UNKNOWN.
      if (left === true || right === true) return true;
      if (left === null || right === null) return null;
      return false;
    }

    case 'not': {
      const operand = evaluatePredicate(expr.operand, row);
      return operand === null ? null : !operand; // NOT UNKNOWN is UNKNOWN
    }

    case 'isNull': {
      // The one test that is never UNKNOWN — it exists to ask about NULL directly.
      const isNull = evaluateValue(expr.operand, row) === null;
      return expr.negated ? !isNull : isNull;
    }

    case 'in': {
      const value = evaluateValue(expr.operand, row);
      if (value === null) return null; // NULL IN (…) is UNKNOWN, whatever the list holds
      let sawUnknown = false;
      for (const item of expr.items) {
        const equal = compare('=', value, evaluateValue(item, row));
        if (equal === true) return negate(true, expr.negated);
        if (equal === null) sawUnknown = true;
      }
      // Not found: FALSE — unless a NULL in the list left the answer unknown.
      return negate(sawUnknown ? null : false, expr.negated);
    }

    case 'like': {
      const value = evaluateValue(expr.operand, row);
      const pattern = evaluateValue(expr.pattern, row);
      if (value === null || pattern === null) return null;
      return negate(likeMatches(textOf(value), textOf(pattern)), expr.negated);
    }

    case 'literal':
      return expr.value === null ? null : Boolean(expr.value);

    case 'column': {
      const value = row[columnKey(expr)] ?? null;
      return value === null ? null : Boolean(value);
    }
  }
}

/** Only TRUE passes a WHERE clause. UNKNOWN does not. */
export function passes(expr: Expr | undefined, row: Row): boolean {
  if (!expr) return true;
  return evaluatePredicate(expr, row) === true;
}
