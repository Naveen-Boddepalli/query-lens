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

export type Op = '=' | '<' | '>' | '<=' | '>=';

export type Pred =
  | { k: 'cmp'; ref: Ref; op: Op; lit: SqlValue }
  | { k: 'colcmp'; a: Ref; op: Op; b: Ref }
  /** Two literals — the optimizer's constant-folding rule exists for these. */
  | { k: 'litcmp'; a: SqlValue; op: Op; b: SqlValue }
  | { k: 'between'; ref: Ref; lo: SqlValue; hi: SqlValue };

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
      where: Pred[];
      order?: OrderSpec;
      limit?: number;
    }
  | {
      kind: 'aggregate';
      table: string;
      group: Ref[];
      /** Which group columns appear in the SELECT list (all of them, or a subset). */
      shownGroup: Ref[];
      aggs: AggItem[];
      where: Pred[];
      limit?: number;
    }
  | {
      kind: 'join';
      left: string;
      right: string;
      on: { l: Ref; r: Ref };
      proj: Ref[];
      where: Pred[];
      limit?: number;
    }
  | { kind: 'insert'; table: string; columns?: string[]; values: SqlValue[] }
  | { kind: 'update'; table: string; set: { col: string; value: SqlValue }[]; where: Pred[] }
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

function renderPred(p: Pred): string {
  switch (p.k) {
    case 'cmp':
      return `${renderRef(p.ref)} ${p.op} ${renderLiteral(p.lit)}`;
    case 'colcmp':
      return `${renderRef(p.a)} ${p.op} ${renderRef(p.b)}`;
    case 'litcmp':
      return `${renderLiteral(p.a)} ${p.op} ${renderLiteral(p.b)}`;
    case 'between':
      return `${renderRef(p.ref)} BETWEEN ${renderLiteral(p.lo)} AND ${renderLiteral(p.hi)}`;
  }
}

const renderWhere = (where: readonly Pred[]): string =>
  where.length === 0 ? '' : ` WHERE ${where.map(renderPred).join(' AND ')}`;

const renderAgg = (a: AggItem): string => `${a.fn}(${a.arg === '*' ? '*' : renderRef(a.arg)})`;

/** The SELECT-list items of a read query, in output order — also the keys QueryLens names its result columns by. */
export function outputKeys(q: ReadQuery, tables: readonly TableSpec[]): string[] {
  switch (q.kind) {
    case 'select':
      return q.proj === '*'
        ? (tables.find((t) => t.name === q.table)?.columns.map((c) => c.name) ?? [])
        : q.proj.map(renderRef);
    case 'aggregate':
      return [...q.shownGroup.map(renderRef), ...q.aggs.map(renderAgg)];
    case 'join':
      return q.proj.map(renderRef);
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
  const limit = (n: number | undefined) => (n === undefined ? '' : ` LIMIT ${n}`);
  switch (q.kind) {
    case 'select': {
      const list = q.proj === '*' ? '*' : q.proj.map(renderRef).join(', ');
      const order = q.order
        ? ` ORDER BY ${renderRef(q.order.ref)} ${q.order.dir.toUpperCase()}${
            dialect === 'sqlite' ? (q.order.dir === 'asc' ? ' NULLS LAST' : ' NULLS FIRST') : ''
          }`
        : '';
      return `SELECT ${list} FROM ${q.table}${renderWhere(q.where)}${order}${limit(q.limit)}`;
    }
    case 'aggregate': {
      const items = [...q.shownGroup.map(renderRef), ...q.aggs.map(renderAgg)].join(', ');
      const group = q.group.length > 0 ? ` GROUP BY ${q.group.map(renderRef).join(', ')}` : '';
      return `SELECT ${items} FROM ${q.table}${renderWhere(q.where)}${group}${limit(q.limit)}`;
    }
    case 'join':
      return `SELECT ${q.proj.map(renderRef).join(', ')} FROM ${q.left} JOIN ${q.right} ON ${renderRef(q.on.l)} = ${renderRef(q.on.r)}${renderWhere(q.where)}${limit(q.limit)}`;
    case 'insert': {
      const cols = q.columns ? ` (${q.columns.join(', ')})` : '';
      return `INSERT INTO ${q.table}${cols} VALUES (${q.values.map(renderLiteral).join(', ')})`;
    }
    case 'update':
      return `UPDATE ${q.table} SET ${q.set.map((s) => `${s.col} = ${renderLiteral(s.value)}`).join(', ')}${renderWhere(q.where)}`;
    case 'delete':
      return `DELETE FROM ${q.table}${renderWhere(q.where)}`;
  }
}
