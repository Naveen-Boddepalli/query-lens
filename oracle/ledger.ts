/**
 * The divergence ledger (plan.md §25.4 A1).
 *
 * Where QueryLens and SQLite legitimately answer differently, the difference is
 * written down *here*, as a runnable entry, instead of being `skip`ped in a
 * test. `ledger.test.ts` runs every entry against both engines and asserts:
 *
 *   1. QueryLens still returns the recorded answer,
 *   2. SQLite still returns the recorded answer,
 *   3. and they still differ.
 *
 * (3) is the point. When someone closes a gap the test fails and says "this
 * entry is stale — delete it", so the ledger can only ever list differences
 * that are real, and `src/pages/DocsContent/reference/answers.mdx` (checked for
 * drift against this list) never claims one that has been fixed.
 *
 * `kind` says why the difference exists:
 *   'design'  deliberate — QueryLens chose a PostgreSQL-shaped or simpler rule
 *   'gap'     a known limitation the plan intends to close
 */

import type { SqlValue } from '../src/engine/types.ts';
import type { TableSpec } from './model.ts';

/** Raw JS values, *not* normalised — a ledger entry may be exactly about `true` vs `1`. */
export type Raw = SqlValue;

export type Outcome = { rows: Raw[][] } | { error: string };

export interface Divergence {
  /** Stable slug; the docs page carries the same id. */
  id: string;
  title: string;
  kind: 'design' | 'gap';
  /** One sentence each — the docs page shows these. */
  querylens: string;
  sqlite: string;
  /** Tables both engines start from. */
  tables: TableSpec[];
  /** Statements run in order; the last one is a read whose answer is compared. */
  steps: string[];
  /** The names to read QueryLens's result columns by, in order. Ignored when it is an error. */
  columns: string[];
  expect: { querylens: Outcome; sqlite: Outcome };
}

const t = (columns: TableSpec['columns'], rows: TableSpec['rows']): TableSpec[] => [
  { name: 't', columns, rows, indexed: [] },
];

export const LEDGER: Divergence[] = [
  {
    id: 'order-by-null-placement',
    title: 'Where NULLs sort',
    kind: 'design',
    querylens: 'NULLs sort last ascending and first descending — PostgreSQL’s default.',
    sqlite: 'NULLs sort first ascending and last descending.',
    tables: t([{ name: 'n', type: 'int' }], [{ n: 2 }, { n: null }, { n: 1 }]),
    steps: ['SELECT n FROM t ORDER BY n'],
    columns: ['n'],
    expect: { querylens: { rows: [[1], [2], [null]] }, sqlite: { rows: [[null], [1], [2]] } },
  },
  {
    id: 'mixed-type-comparison',
    title: 'Comparing a number with a string',
    kind: 'gap',
    querylens: 'If either side is not a number, both are compared as text — so `n < \'50\'` puts 100 before 50.',
    sqlite: 'A numeric column applies numeric affinity to the string, so `n < \'50\'` compares as numbers.',
    tables: t([{ name: 'n', type: 'int' }], [{ n: 9 }, { n: 10 }, { n: 100 }]),
    steps: ["SELECT n FROM t WHERE n < '50'"],
    columns: ['n'],
    expect: { querylens: { rows: [[10], [100]] }, sqlite: { rows: [[9], [10]] } },
  },
  {
    id: 'column-types-not-enforced',
    title: 'Columns have no declared type',
    kind: 'gap',
    querylens: 'A value is stored exactly as written: inserting the string `\'5\'` into a number column keeps a string.',
    sqlite: 'The column’s INTEGER affinity converts `\'5\'` to the number 5 on the way in.',
    tables: t([{ name: 'n', type: 'int' }], []),
    steps: ["INSERT INTO t (n) VALUES ('5')", 'SELECT n FROM t'],
    columns: ['n'],
    expect: { querylens: { rows: [['5']] }, sqlite: { rows: [[5]] } },
  },
  {
    id: 'sum-avg-over-text',
    title: 'SUM and AVG over a text column',
    kind: 'design',
    querylens: 'There is nothing numeric to add, so the result is NULL.',
    sqlite: 'Text is coerced to 0, so the result is 0 — silently.',
    tables: t([{ name: 's', type: 'text' }], [{ s: 'a' }, { s: 'b' }]),
    steps: ['SELECT SUM(s), AVG(s) FROM t'],
    columns: ['SUM(s)', 'AVG(s)'],
    expect: { querylens: { rows: [[null, null]] }, sqlite: { rows: [[0, 0]] } },
  },
  {
    id: 'boolean-values',
    title: 'TRUE and FALSE',
    kind: 'design',
    querylens: 'A boolean stays a boolean: `TRUE` comes back as `true`.',
    sqlite: 'There is no boolean type; `TRUE` is the integer 1.',
    tables: t([{ name: 'b', type: 'int' }], []),
    steps: ['INSERT INTO t (b) VALUES (TRUE)', 'SELECT b FROM t'],
    columns: ['b'],
    expect: { querylens: { rows: [[true]] }, sqlite: { rows: [[1]] } },
  },
  {
    id: 'text-order-above-the-bmp',
    title: 'Ordering text beyond the Basic Multilingual Plane',
    kind: 'design',
    querylens: 'Strings compare by UTF-16 code unit (JavaScript’s rule), so an emoji sorts *before* U+FFFD.',
    sqlite: 'BINARY collation compares UTF-8 bytes, so the emoji sorts *after* U+FFFD.',
    tables: t([{ name: 's', type: 'text' }], [{ s: '�' }, { s: '😀' }]),
    steps: ['SELECT s FROM t ORDER BY s'],
    columns: ['s'],
    expect: { querylens: { rows: [['😀'], ['�']] }, sqlite: { rows: [['�'], ['😀']] } },
  },
  {
    id: 'identifier-case',
    title: 'Are column names case-sensitive?',
    kind: 'design',
    querylens: 'Yes — `N` is not `n`, and the error says which columns exist.',
    sqlite: 'No — identifiers match without regard to case.',
    tables: t([{ name: 'n', type: 'int' }], [{ n: 1 }]),
    steps: ['SELECT N FROM t'],
    columns: ['N'],
    expect: { querylens: { error: 'no column called `N`' }, sqlite: { rows: [[1]] } },
  },
];
