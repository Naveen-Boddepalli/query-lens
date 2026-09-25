/**
 * The oracle's query model (plan.md §25.4 A1).
 *
 * A generated statement is a small structured value rather than a string, for
 * three reasons: `fast-check` can shrink a structure (it cannot shrink text
 * into *valid* text), the comparison logic needs to know what the statement
 * is (a `LIMIT` without `ORDER BY` has no defined rows; an aggregate has no
 * defined order), and the same value renders for both engines — QueryLens and
 * SQLite — so the two are always asked the identical question.
 *
 * Every construct here is in the *intersection* of the two dialects with the
 * same defined meaning. Where they legitimately differ the case is not
 * generated; it is written down in `ledger.ts` and pinned by a test there.
 */

import type { Row, SqlValue } from '../src/engine/types.ts';

export type ColType = 'int' | 'text' | 'real';

export interface ColSpec {
  name: string;
  type: ColType;
}

export interface TableSpec {
  name: string;
  columns: ColSpec[];
  rows: Row[];
  /** Columns QueryLens builds a B+Tree on. Only ever *unique* columns until plan.md §25.4 B3. */
  indexed: string[];
}

/** A column reference. `table` is set exactly when the query has a JOIN (the parser requires it there). */
export interface Ref {
  name: string;
  type: ColType;
  table?: string;
}

export type Op = '=' | '<>' | '<' | '>' | '<=' | '>=';

/** Arithmetic (plan.md §25.4 B1b). Fully parenthesised when rendered, so no precedence is left to chance. */
export type ArithOp = '+' | '-' | '*' | '/' | '%';
export type Arith =
  | { k: 'col'; ref: Ref }
  | { k: 'lit'; v: number }
  | { k: 'bin'; op: ArithOp; a: Arith; b: Arith }
  | { k: 'neg'; a: Arith };

export function renderArith(a: Arith): string {
  switch (a.k) {
    case 'col':
      return renderRef(a.ref);
    case 'lit':
      return String(a.v);
    case 'bin':
      return `(${renderArith(a.a)} ${a.op} ${renderArith(a.b)})`;
    case 'neg':
      return `-(${renderArith(a.a)})`;
  }
}

/**
 * A predicate. Leaves compare or test a column; `and` / `or` / `not` nest them
 * (plan.md §25.4 B1a). A query's `where` is a *list* of predicates joined by
 * AND, so a top-level `or` is one element and is rendered parenthesised.
 */
export type Pred =
  | { k: 'cmp'; ref: Ref; op: Op; lit: SqlValue }
  /** An arithmetic expression compared with a literal: `(n * 2) + 1 > 5`. */
  | { k: 'acmp'; e: Arith; op: Op; lit: SqlValue }
  /** A column against *constant* arithmetic: `id = 2 + 3` — folded once, then an index lookup. */
  | { k: 'ccmp'; ref: Ref; op: Op; e: Arith }
  | { k: 'colcmp'; a: Ref; op: Op; b: Ref }
  /** Two literals — the optimizer's constant-folding rule exists for these. */
  | { k: 'litcmp'; a: SqlValue; op: Op; b: SqlValue }
  | { k: 'between'; ref: Ref; lo: SqlValue; hi: SqlValue; neg?: boolean }
  /** An aggregate compared with a literal — only meaningful in a HAVING (plan.md §25.4 B2). */
  | { k: 'hagg'; agg: AggItem; op: Op; lit: SqlValue }
  | { k: 'isnull'; ref: Ref; neg: boolean }
  | { k: 'in'; ref: Ref; list: SqlValue[]; neg: boolean }
  | { k: 'like'; ref: Ref; pattern: string; neg: boolean }
  | { k: 'not'; p: Pred }
  | { k: 'and'; a: Pred; b: Pred }
  | { k: 'or'; a: Pred; b: Pred };

export type AggFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
export interface AggItem {
  fn: AggFn;
  arg: Ref | '*';
}

export interface OrderSpec {
  ref: Ref;
  dir: 'asc' | 'desc';
}

export type Query =
  | {
      kind: 'select';
      table: string;
      proj: Ref[] | '*';
      /** Computed columns appended after `proj`, each named by its alias (`AS x0`). */
      computed?: { e: Arith; alias: string }[];
      where: Pred[];
      order?: OrderSpec;
      limit?: number;
      /** `OFFSET m`, only ever beside a `limit` (plan.md §25.4 B1c). */
      offset?: number;
    }
  | {
      kind: 'aggregate';
      table: string;
      group: Ref[];
      /** Which group columns appear in the SELECT list (all of them, or a subset). */
      shownGroup: Ref[];
      aggs: AggItem[];
      where: Pred[];
      /** `HAVING`, a predicate over the groups (plan.md §25.4 B2). Absent when there is none. */
      having?: Pred;
      limit?: number;
      offset?: number;
    }
  | {
      kind: 'join';
      left: string;
      right: string;
      on: { l: Ref; r: Ref };
      proj: Ref[];
      computed?: { e: Arith; alias: string }[];
      where: Pred[];
      limit?: number;
      offset?: number;
    }
  | { kind: 'insert'; table: string; columns?: string[]; values: SqlValue[] }
  | { kind: 'update'; table: string; set: { col: string; value: SqlValue; expr?: Arith }[]; where: Pred[] }
  | { kind: 'delete'; table: string; where: Pred[] };

export type WriteQuery = Extract<Query, { kind: 'insert' | 'update' | 'delete' }>;
export type ReadQuery = Exclude<Query, WriteQuery>;

export const isWrite = (q: Query): q is WriteQuery =>
  q.kind === 'insert' || q.kind === 'update' || q.kind === 'delete';

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

export function renderRef(ref: Ref): string {
  return ref.table ? `${ref.table}.${ref.name}` : ref.name;
}

export function renderLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

export function renderPred(p: Pred): string {
  switch (p.k) {
    case 'cmp':
      return `${renderRef(p.ref)} ${p.op} ${renderLiteral(p.lit)}`;
    case 'acmp':
      return `${renderArith(p.e)} ${p.op} ${renderLiteral(p.lit)}`;
    case 'ccmp':
      return `${renderRef(p.ref)} ${p.op} ${renderArith(p.e)}`;
    case 'colcmp':
      return `${renderRef(p.a)} ${p.op} ${renderRef(p.b)}`;
    case 'litcmp':
      return `${renderLiteral(p.a)} ${p.op} ${renderLiteral(p.b)}`;
    case 'between':
      return `${renderRef(p.ref)} ${p.neg ? 'NOT ' : ''}BETWEEN ${renderLiteral(p.lo)} AND ${renderLiteral(p.hi)}`;
    case 'hagg':
      return `${renderAgg(p.agg)} ${p.op} ${renderLiteral(p.lit)}`;
    case 'isnull':
      return `${renderRef(p.ref)} IS ${p.neg ? 'NOT ' : ''}NULL`;
    case 'in':
      return `${renderRef(p.ref)} ${p.neg ? 'NOT ' : ''}IN (${p.list.map(renderLiteral).join(', ')})`;
    case 'like':
      return `${renderRef(p.ref)} ${p.neg ? 'NOT ' : ''}LIKE ${renderLiteral(p.pattern)}`;
    // Compound predicates are always parenthesised: the text never relies on precedence to mean what it says.
    case 'not':
      return `NOT (${renderPred(p.p)})`;
    case 'and':
      return `(${renderPred(p.a)} AND ${renderPred(p.b)})`;
    case 'or':
      return `(${renderPred(p.a)} OR ${renderPred(p.b)})`;
  }
}

const renderComputed = (computed: { e: Arith; alias: string }[] | undefined): string[] =>
  (computed ?? []).map((c) => `${renderArith(c.e)} AS ${c.alias}`);

/** Depth-first over a predicate tree. */
export function walkPred(p: Pred, visit: (p: Pred) => void): void {
  visit(p);
  if (p.k === 'not') walkPred(p.p, visit);
  else if (p.k === 'and' || p.k === 'or') {
    walkPred(p.a, visit);
    walkPred(p.b, visit);
  }
}

export const renderWhere = (where: readonly Pred[]): string =>
  where.length === 0 ? '' : ` WHERE ${where.map(renderPred).join(' AND ')}`;

const renderAgg = (a: AggItem): string => `${a.fn}(${a.arg === '*' ? '*' : renderRef(a.arg)})`;

/** The SELECT-list items of a read query, in output order — also the keys QueryLens names its result columns by. */
export function outputKeys(q: ReadQuery, tables: readonly TableSpec[]): string[] {
  const computed = (q.kind === 'select' || q.kind === 'join' ? q.computed : undefined)?.map((c) => c.alias) ?? [];
  switch (q.kind) {
    case 'select':
      return [
        ...(q.proj === '*'
          ? (tables.find((t) => t.name === q.table)?.columns.map((c) => c.name) ?? [])
          : q.proj.map(renderRef)),
        ...computed,
      ];
    case 'aggregate':
      return [...q.shownGroup.map(renderRef), ...q.aggs.map(renderAgg)];
    case 'join':
      return [...q.proj.map(renderRef), ...computed];
  }
}

/**
 * Which engine the text is for. The only difference is `ORDER BY`: QueryLens
 * puts NULLs *last* ascending and *first* descending (PostgreSQL's rule);
 * SQLite's default is the opposite, so it is told explicitly. That default is
 * itself a ledger entry (`ledger.ts`, `order-by-null-placement`) — the
 * differential test pins the *sorting*, the ledger pins the *default*.
 */
export type Dialect = 'querylens' | 'sqlite';

export function renderQuery(q: Query, dialect: Dialect = 'querylens'): string {
  const page = (n: number | undefined, offset: number | undefined) =>
    n === undefined ? '' : ` LIMIT ${n}${offset ? ` OFFSET ${offset}` : ''}`;
  switch (q.kind) {
    case 'select': {
      const list = [q.proj === '*' ? '*' : q.proj.map(renderRef).join(', '), ...renderComputed(q.computed)]
        .filter((x) => x !== '')
        .join(', ');
      const order = q.order
        ? ` ORDER BY ${renderRef(q.order.ref)} ${q.order.dir.toUpperCase()}${
            dialect === 'sqlite' ? (q.order.dir === 'asc' ? ' NULLS LAST' : ' NULLS FIRST') : ''
          }`
        : '';
      return `SELECT ${list} FROM ${q.table}${renderWhere(q.where)}${order}${page(q.limit, q.offset)}`;
    }
    case 'aggregate': {
      const items = [...q.shownGroup.map(renderRef), ...q.aggs.map(renderAgg)].join(', ');
      const group = q.group.length > 0 ? ` GROUP BY ${q.group.map(renderRef).join(', ')}` : '';
      const having = q.having ? ` HAVING ${renderPred(q.having)}` : '';
      return `SELECT ${items} FROM ${q.table}${renderWhere(q.where)}${group}${having}${page(q.limit, q.offset)}`;
    }
    case 'join':
      return `SELECT ${[...q.proj.map(renderRef), ...renderComputed(q.computed)].join(', ')} FROM ${q.left} JOIN ${q.right} ON ${renderRef(q.on.l)} = ${renderRef(q.on.r)}${renderWhere(q.where)}${page(q.limit, q.offset)}`;
    case 'insert': {
      const cols = q.columns ? ` (${q.columns.join(', ')})` : '';
      return `INSERT INTO ${q.table}${cols} VALUES (${q.values.map(renderLiteral).join(', ')})`;
    }
    case 'update':
      return `UPDATE ${q.table} SET ${q.set.map((s) => `${s.col} = ${s.expr ? renderArith(s.expr) : renderLiteral(s.value)}`).join(', ')}${renderWhere(q.where)}`;
    case 'delete':
      return `DELETE FROM ${q.table}${renderWhere(q.where)}`;
  }
}
