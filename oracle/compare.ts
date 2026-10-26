/**
 * Result comparison for the oracle. SQL results are *multisets* unless an
 * `ORDER BY` says otherwise, so the default comparison ignores row order; and
 * floating-point aggregates are compared to a tolerance, not bit-for-bit.
 */

import type { SqlValue } from '../src/engine/types.ts';

export type Cell = string | number | null;
export type Tuple = Cell[];

/** Booleans do not exist in SQLite (TRUE is 1); fold them so a comparison never fails on that alone. */
export function cell(v: SqlValue | undefined): Cell {
  if (v === undefined || v === null) return null;
  return typeof v === 'boolean' ? Number(v) : v;
}

const round = (n: number): number => Number(n.toFixed(9));

/** Canonical text for a tuple — equal tuples (to tolerance) produce equal text. */
function key(t: Tuple): string {
  return JSON.stringify(t.map((c) => (typeof c === 'number' ? round(c) : c)));
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}

const show = (rows: readonly Tuple[], max = 6): string =>
  `${rows.length} row${rows.length === 1 ? '' : 's'} ${JSON.stringify(rows.slice(0, max))}${rows.length > max ? ' …' : ''}`;

function counts(rows: readonly Tuple[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}

/** `null` when equal, otherwise a description of the first difference. */
export function multisetDiff(actual: readonly Tuple[], expected: readonly Tuple[]): string | null {
  if (actual.length !== expected.length) {
    return `row count differs — QueryLens ${show(actual)} vs expected ${show(expected)}`;
  }
  const want = counts(expected);
  for (const [k, n] of counts(actual)) {
    if (want.get(k) !== n) return `row ${k} appears ${n}× in QueryLens but ${want.get(k) ?? 0}× expected (${show(actual)} vs ${show(expected)})`;
  }
  return null;
}

/** Every row of `sub` appears in `whole` at least as often (a `LIMIT` picks *some* rows of the full result). */
export function subMultisetDiff(sub: readonly Tuple[], whole: readonly Tuple[]): string | null {
  const have = counts(whole);
  for (const [k, n] of counts(sub)) {
    if ((have.get(k) ?? 0) < n) return `row ${k} returned ${n}× but the unlimited result has it ${have.get(k) ?? 0}×`;
  }
  return null;
}

export function sequenceDiff(actual: readonly Cell[], expected: readonly Cell[]): string | null {
  if (actual.length !== expected.length) {
    return `sequence length differs — ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`;
  }
  for (let i = 0; i < actual.length; i++) {
    if (!cellsEqual(actual[i], expected[i])) {
      return `position ${i} differs — ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`;
    }
  }
  return null;
}
