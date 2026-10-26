/**
 * Arithmetic on `SqlValue`s (plan.md §25.4 B1b) — pure, and free of the parser
 * and the executor so that both can use it: the executor to evaluate
 * `price * qty`, the parser and optimizer to fold `-5` or `2 + 3` into a
 * literal (a folded literal is what lets `WHERE id = 2 + 3` become an index
 * lookup). The rules follow SQLite where it is well-defined, and PostgreSQL
 * where SQLite is permissive — each choice is a ledger entry or a comment.
 */

import type { SqlValue } from './types.ts';

export type ArithOp = '+' | '-' | '*' | '/' | '%';

const NUMERIC_TEXT = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/**
 * A value as a number, or `null` when it is not one.
 *
 * NULL stays NULL. A boolean is 0 or 1. A string that *is* a number (`'5'`,
 * `' 2.5 '`) is that number. Any other string is not a number, so it yields
 * NULL — the arithmetic result is then NULL. SQLite reads such text as 0,
 * silently (ledger: `arithmetic-on-text`); NULL says "this is not a number"
 * without inventing a value.
 */
export function toNumber(value: SqlValue): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return NUMERIC_TEXT.test(value) ? Number(value) : null;
}

/** `-0` is not a value SQL users ever see; keep it out of results and out of `toEqual`. */
const clean = (n: number): number => (n === 0 ? 0 : n);

/**
 * `left op right`. NULL in, NULL out. `x / 0` and `x % 0` are NULL (SQLite's
 * rule — PostgreSQL raises an error, which this engine has no channel for at
 * run time). `/` between two whole numbers is **integer division**, truncating
 * toward zero (`7 / 2` is 3, `-7 / 2` is -3), in both SQLite and PostgreSQL;
 * anything else divides exactly. Numbers here carry no int/real distinction,
 * so a REAL column holding 3.0 divides as the integer 3 — ledger:
 * `division-of-whole-reals`.
 */
export function arithmetic(op: ArithOp, left: SqlValue, right: SqlValue): number | null {
  const a = toNumber(left);
  const b = toNumber(right);
  if (a === null || b === null) return null;
  switch (op) {
    case '+':
      return clean(a + b);
    case '-':
      return clean(a - b);
    case '*':
      return clean(a * b);
    case '/':
      if (b === 0) return null;
      return clean(Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b);
    case '%':
      return b === 0 ? null : clean(a % b);
  }
}

/** Unary minus. NULL stays NULL; a non-number is NULL. */
export function negate(value: SqlValue): number | null {
  const n = toNumber(value);
  return n === null ? null : clean(-n);
}

/**
 * A total order over `SqlValue`, `-1`/`0`/`1`: NULL sorts before everything and equals only NULL, two numbers
 * compare numerically, anything else compares as text (a boolean as `'0'`/`'1'`) — an **index's** order, not SQL's
 * `ORDER BY` (`exec/sort.ts`'s own `compareAsc` sorts NULLs *last*, Postgres's default there, deliberately the
 * opposite rule). Shared by a table's own B+Tree indexes (`index/btree.ts`'s `compareScalar`), a clustered table's
 * physical layout (`storage/page.ts`), and `ANALYZE`'s histogram and correlation statistics (plan.md §25.4 C1) —
 * kept here once so none of the three can quietly drift from another.
 */
export function compareValues(a: SqlValue, b: SqlValue): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = typeof a === 'boolean' ? String(Number(a)) : String(a);
  const sb = typeof b === 'boolean' ? String(Number(b)) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
