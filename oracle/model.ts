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
  /** Columns QueryLens builds a B+Tree on — unique or not (plan.md §25.4 B3a). */
  indexed: string[];
  /** Composite indexes, each a list of columns in key order (plan.md §25.4 B3b). */
  composite?: string[][];
  /**
   * Columns with a UNIQUE index in QueryLens (plan.md §25.4 B3c). Only ever ones the session cannot make repeat
   * (`id` and `k` start unique, INSERT numbers them from a serial, and UPDATE never sets them here); a statement that
   * *does* violate one is `unique.test.ts`'s business, against SQLite's own UNIQUE INDEX.
   */
  unique?: string[];
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
  /**
   * `ref [NOT] IN (SELECT col FROM table [WHERE …])` (plan.md §25.4 C3 slice c): uncorrelated by construction — the
   * subquery's own predicates name only its own table's columns, unqualified, so neither engine can read them as
   * the outer query's.
   */
  | { k: 'insub'; ref: Ref; neg: boolean; sub: SubSelect }
  /** `(P) IS [NOT] NULL` — a predicate in a value's place, the shape that asks whether P was UNKNOWN. */
  | { k: 'pnull'; p: Pred; neg: boolean }
  /**
   * `[NOT] EXISTS (SELECT * FROM table WHERE …)` (plan.md §27.5 S1). Only ever a whole element of a SELECT's `where`
   * list — the one place QueryLens runs one — never inside `and` / `or` / `not`. Every ref in it is qualified.
   */
  | { k: 'exists'; neg: boolean; sub: ExistsSub }
  | { k: 'not'; p: Pred }
  | { k: 'and'; a: Pred; b: Pred }
  | { k: 'or'; a: Pred; b: Pred };

/** The one subquery shape both engines share with QueryLens's own limits: one plain column of one table. */
export interface SubSelect {
  table: string;
  col: string;
  where: Pred[];
}

/**
 * An `EXISTS` subquery: correlated through `key` (`inner = outer`, the equality QueryLens joins on) when it has one,
 * with `where` its further conditions — on its own table, or (with a key) naming the outer query's too. Without a key
 * nothing in it names the outer query: uncorrelated.
 */
export interface ExistsSub {
  table: string;
  key?: { inner: Ref; outer: Ref };
  where: Pred[];
}

/** One step of a left-deep join chain: `[LEFT] JOIN table ON l = r`, where one side names `table`. */
export interface JoinStep {
  table: string;
  /** `right`, `full` and `cross` since plan.md §27.5 S4. A cross join has no ON: its `on` is only the key a WHERE may state. */
  type: 'inner' | 'left' | 'right' | 'full' | 'cross';
  on: { l: Ref; r: Ref };
  /** A cross join written `FROM a, b`, as a textbook writes one. */
  comma?: boolean;
  /** A cross join whose `on` is added to WHERE — the shape QueryLens's `product-to-join` rule turns into a join. */
  keyInWhere?: boolean;
}

/** One SELECT of a compound query (plan.md §27.5 S3): plain columns of one table, filtered, maybe DISTINCT. */
export interface MemberSelect {
  table: string;
  proj: Ref[];
  where: Pred[];
  distinct?: boolean;
}

export type AggFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
export interface AggItem {
  fn: AggFn;
  arg: Ref | '*';
  /** `COUNT(DISTINCT x)` (plan.md §27.5 S5): only ever on a column argument. */
  distinct?: boolean;
}

export interface OrderSpec {
  ref: Ref;
  dir: 'asc' | 'desc';
}

/** An aggregate query's ORDER BY (plan.md §26 Feature 1, slice a): a grouped column, or an aggregate, selected or not. */
export interface GroupOrderSpec {
  by: { k: 'col'; ref: Ref } | { k: 'agg'; agg: AggItem };
  dir: 'asc' | 'desc';
}

export type Query =
  | {
      kind: 'select';
      /** `SELECT DISTINCT` (plan.md §25.4 B2). */
      distinct?: boolean;
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
      distinct?: boolean;
      table: string;
      /** Grouping the rows of a join (plan.md §26 Feature 1, slice c): `table` then these steps; every ref qualified. */
      joins?: JoinStep[];
      group: Ref[];
      /** Which group columns appear in the SELECT list (all of them, or a subset). */
      shownGroup: Ref[];
      aggs: AggItem[];
      where: Pred[];
      /** `HAVING`, a predicate over the groups (plan.md §25.4 B2). Absent when there is none. */
      having?: Pred;
      order?: GroupOrderSpec;
      limit?: number;
      offset?: number;
    }
  | {
      kind: 'join';
      distinct?: boolean;
      left: string;
      /** One step or more, joined left-deep in this order (plan.md §25.4 C3 slices a and b). */
      joins: JoinStep[];
      proj: Ref[];
      computed?: { e: Arith; alias: string }[];
      where: Pred[];
      /** `ORDER BY t.col` over the joined rows (plan.md §26 Feature 1, slice b) — any column of any table in the chain. */
      order?: OrderSpec;
      limit?: number;
      offset?: number;
    }
  | {
      /** `SELECT … UNION [ALL] | INTERSECT | EXCEPT SELECT …` (plan.md §27.5 S3): `ops[i]` joins `members[i + 1]` to everything before it. */
      kind: 'compound';
      members: MemberSelect[];
      ops: { op: 'union' | 'intersect' | 'except'; all: boolean }[];
      /** A column of the result — one the first member projects — to sort the combined rows by. */
      order?: { column: string; dir: 'asc' | 'desc' };
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
    case 'insub':
      return `${renderRef(p.ref)} ${p.neg ? 'NOT ' : ''}IN (${renderSubSelect(p.sub)})`;
    case 'pnull':
      return `(${renderPred(p.p)}) IS ${p.neg ? 'NOT ' : ''}NULL`;
    case 'exists':
      return `${p.neg ? 'NOT ' : ''}EXISTS (${renderExistsSub(p.sub)})`;
    // Compound predicates are always parenthesised: the text never relies on precedence to mean what it says.
    case 'not':
      return `NOT (${renderPred(p.p)})`;
    case 'and':
      return `(${renderPred(p.a)} AND ${renderPred(p.b)})`;
    case 'or':
      return `(${renderPred(p.a)} OR ${renderPred(p.b)})`;
  }
}

export const renderSubSelect = (sub: SubSelect): string => `SELECT ${sub.col} FROM ${sub.table}${renderWhere(sub.where)}`;

/** `SELECT * FROM table WHERE inner = outer AND …` — the correlation key first, as a reader would write it. */
export const renderExistsSub = (sub: ExistsSub): string =>
  `SELECT * FROM ${sub.table}${renderWhere([...(sub.key ? [{ k: 'colcmp', a: sub.key.inner, op: '=', b: sub.key.outer } satisfies Pred] : []), ...sub.where])}`;

const renderComputed = (computed: { e: Arith; alias: string }[] | undefined): string[] =>
  (computed ?? []).map((c) => `${renderArith(c.e)} AS ${c.alias}`);

/** Depth-first over a predicate tree — the outer query's own, not into a subquery's `WHERE` (a separate query). */
export function walkPred(p: Pred, visit: (p: Pred) => void): void {
  visit(p);
  if (p.k === 'not' || p.k === 'pnull') walkPred(p.p, visit);
  else if (p.k === 'and' || p.k === 'or') {
    walkPred(p.a, visit);
    walkPred(p.b, visit);
  }
}

export const renderWhere = (where: readonly Pred[]): string =>
  where.length === 0 ? '' : ` WHERE ${where.map(renderPred).join(' AND ')}`;

export const renderAgg = (a: AggItem): string => `${a.fn}(${a.arg === '*' ? '*' : `${a.distinct ? 'DISTINCT ' : ''}${renderRef(a.arg)}`})`;

/** The key an ORDER BY sorts on, as the SELECT list names it — `null` without one. */
export function orderKeyOf(q: ReadQuery): string | null {
  if (q.kind === 'select') return q.order ? renderRef(q.order.ref) : null;
  if (q.kind === 'aggregate' && q.order) return q.order.by.k === 'col' ? renderRef(q.order.by.ref) : renderAgg(q.order.by.agg);
  if (q.kind === 'join' && q.order) return renderRef(q.order.ref);
  if (q.kind === 'compound' && q.order) return q.order.column;
  return null;
}

/** ` ORDER BY key DIR` — with NULL placement spelled out for SQLite, whose default is the opposite of QueryLens's. */
function renderOrder(key: string, dir: 'asc' | 'desc', dialect: Dialect): string {
  return ` ORDER BY ${key} ${dir.toUpperCase()}${dialect === 'sqlite' ? (dir === 'asc' ? ' NULLS LAST' : ' NULLS FIRST') : ''}`;
}

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
    // A compound's columns are named by its first SELECT (plan.md §27.5 S3), in both engines.
    case 'compound':
      return q.members[0].proj.map(renderRef);
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

const JOIN_WORDS: Record<JoinStep['type'], string> = { inner: '', left: 'LEFT ', right: 'RIGHT ', full: 'FULL ', cross: 'CROSS ' };
const renderJoins = (joins: readonly JoinStep[] | undefined): string =>
  (joins ?? [])
    .map((j) =>
      j.type === 'cross'
        ? j.comma
          ? `, ${j.table}`
          : ` CROSS JOIN ${j.table}`
        : ` ${JOIN_WORDS[j.type]}JOIN ${j.table} ON ${renderRef(j.on.l)} = ${renderRef(j.on.r)}`,
    )
    .join('');

/** The keys cross joins with `keyInWhere` state in WHERE instead of ON (plan.md §27.5 S4). */
export const crossKeysOf = (joins: readonly JoinStep[] | undefined): Pred[] =>
  (joins ?? []).flatMap((j) => (j.type === 'cross' && j.keyInWhere ? [{ k: 'colcmp', a: j.on.l, op: '=', b: j.on.r } satisfies Pred] : []));

export function renderQuery(q: Query, dialect: Dialect = 'querylens'): string {
  const page = (n: number | undefined, offset: number | undefined) =>
    n === undefined ? '' : ` LIMIT ${n}${offset ? ` OFFSET ${offset}` : ''}`;
  switch (q.kind) {
    case 'select': {
      const list = [q.proj === '*' ? '*' : q.proj.map(renderRef).join(', '), ...renderComputed(q.computed)]
        .filter((x) => x !== '')
        .join(', ');
      const order = q.order ? renderOrder(renderRef(q.order.ref), q.order.dir, dialect) : '';
      return `SELECT ${q.distinct ? 'DISTINCT ' : ''}${list} FROM ${q.table}${renderWhere(q.where)}${order}${page(q.limit, q.offset)}`;
    }
    case 'aggregate': {
      const items = [...q.shownGroup.map(renderRef), ...q.aggs.map(renderAgg)].join(', ');
      const group = q.group.length > 0 ? ` GROUP BY ${q.group.map(renderRef).join(', ')}` : '';
      const having = q.having ? ` HAVING ${renderPred(q.having)}` : '';
      const order = q.order ? renderOrder(orderKeyOf(q)!, q.order.dir, dialect) : '';
      return `SELECT ${q.distinct ? 'DISTINCT ' : ''}${items} FROM ${q.table}${renderJoins(q.joins)}${renderWhere(q.where)}${group}${having}${order}${page(q.limit, q.offset)}`;
    }
    case 'join': {
      const steps = renderJoins(q.joins);
      const order = q.order ? renderOrder(renderRef(q.order.ref), q.order.dir, dialect) : '';
      return `SELECT ${q.distinct ? 'DISTINCT ' : ''}${[...q.proj.map(renderRef), ...renderComputed(q.computed)].join(', ')} FROM ${q.left}${steps}${renderWhere(q.where)}${order}${page(q.limit, q.offset)}`;
    }
    case 'compound': {
      const member = (m: MemberSelect) => `SELECT ${m.distinct ? 'DISTINCT ' : ''}${m.proj.map(renderRef).join(', ')} FROM ${m.table}${renderWhere(m.where)}`;
      const body = q.members.map((m, i) => (i === 0 ? member(m) : ` ${q.ops[i - 1].op.toUpperCase()}${q.ops[i - 1].all ? ' ALL' : ''} ${member(m)}`)).join('');
      const order = q.order ? renderOrder(q.order.column, q.order.dir, dialect) : '';
      return `${body}${order}${page(q.limit, q.offset)}`;
    }
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
