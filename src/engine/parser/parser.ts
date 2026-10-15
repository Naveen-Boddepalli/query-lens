/**
 * Recursive-descent parser for the v0 SQL subset (plan.md §4):
 *
 *   statement     := explain | analyze | select | delete | insert | update
 *   explain       := EXPLAIN [ANALYZE] select
 *   analyze       := ANALYZE identifier [';'] EOF
 *   select        := SELECT [DISTINCT] selectList FROM identifier [join]* [WHERE expr]
 *                     [GROUP BY identifier (',' identifier)*] [HAVING expr]
 *                     [ORDER BY identifier [ASC|DESC]] [LIMIT number [OFFSET number]] [';'] EOF
 *   join          := [INNER | LEFT [OUTER]] JOIN identifier ON qualifiedColumn '=' qualifiedColumn
 *   delete        := DELETE FROM identifier [WHERE expr] [';'] EOF
 *   insert        := INSERT INTO identifier [columnList] VALUES valueList [';'] EOF
 *   update        := UPDATE identifier SET assignment (',' assignment)* [WHERE expr] [';'] EOF
 *   assignment    := identifier '=' expr
 *   columnList    := '(' identifier (',' identifier)* ')'
 *   valueList     := '(' value (',' value)* ')'
 *   value         := an expr built from literals only — number | string | NULL | TRUE | FALSE,
 *                    negated or combined with arithmetic, folded to one value at parse time
 *   selectList    := '*' | selectItem (',' selectItem)*
 *   selectItem    := aggregateCall | expr [AS identifier]
 *   aggregateCall := ('COUNT'|'SUM'|'AVG'|'MIN'|'MAX') '(' ('*' | qualifiedColumn) ')'
 *   expr          := orExpr
 *   orExpr        := andExpr (OR andExpr)*
 *   andExpr       := notExpr (AND notExpr)*
 *   notExpr       := NOT notExpr | predicate
 *   predicate     := operand ( compareOp operand
 *                            | [NOT] BETWEEN operand AND operand
 *                            | IS [NOT] NULL
 *                            | [NOT] IN '(' (operand (',' operand)* | inSubquery) ')'
 *                            | [NOT] LIKE operand )?
 *   inSubquery    := SELECT identifier FROM identifier [WHERE expr]
 *   compareOp     := '=' | '<>' | '!=' | '<' | '>' | '<=' | '>='
 *   operand       := additive
 *   additive      := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/' | '%') unary)*
 *   unary         := '-' unary | primary
 *   primary       := qualifiedColumn | number | string | NULL | TRUE | FALSE | '(' expr ')'
 *                    | aggregateCall              -- only inside HAVING
 *   qualifiedColumn := identifier ['.' identifier]
 *
 * `GROUP BY` and `ORDER BY` are mutually exclusive — the parser rejects a
 * query with both, so despite both appearing under `select` above, no query
 * this grammar accepts ever has both clauses at once (see `checkGroupingValidity`).
 *
 * `[join]` is a bare or `INNER JOIN` (an implicit inner join), or `LEFT [OUTER] JOIN` (plan.md §25.4 C3) —
 * `RIGHT`/`FULL`/`CROSS` stay out of scope. Zero or more may chain (plan.md §25.4 C3 slice b), left-deep: each
 * one's `ON` names the table it introduces plus *some* table the query already knows — `FROM`'s, or an earlier
 * `JOIN`'s — never a fresh third table on both sides, and never repeats a table name (no aliasing, so two same-named
 * tables could never be told apart). None of this combines with `GROUP BY`, `ORDER BY`, or an aggregate
 * `selectItem` — each rejected at parse time (`checkJoinValidity`). A `qualifiedColumn`'s `table` half is required
 * on every column reference once any `join` is present (there is no ambiguity resolution — v0 asks the query to say
 * which table), and validated against the tables the query actually names.
 *
 * `inSubquery` (plan.md §25.4 C3 slice c, closing C3) is the one shape `IN` accepts besides a literal list —
 * always exactly one plain column, no `JOIN`/`GROUP BY`/`HAVING`/`ORDER BY`/`LIMIT`/`DISTINCT`/aggregate, and
 * always uncorrelated (its own `WHERE`, if any, can only name a column on its own `FROM` table — the same rule
 * that already applies to a bare non-`JOIN` query). `runQuery.ts`'s `resolveStatementSubqueries` runs it exactly once,
 * before the outer query is planned, replacing it with the literal-list shape everything downstream already knew.
 *
 * Hand-written rather than generated: the error messages are half the teaching
 * value, and they need to name the v0 scope explicitly.
 *
 * `parse` stays the SELECT-only entry point every existing caller (the
 * Playground, the standalone tools, the CLI) already expects. `parseStatement`
 * is the broader one `runQuery.ts` needs now that `DELETE`, `INSERT` and
 * `UPDATE` are real — the four share every helper below; nothing about
 * SELECT parsing changed.
 */

import type { QueryError, SqlValue } from '../types.ts';
import type {
  AggregateArg,
  AggregateFn,
  AnalyzeStatement,
  CompareOp,
  DeleteStatement,
  ExplainStatement,
  Expr,
  GroupByClause,
  InSubquery,
  InsertStatement,
  JoinClause,
  SelectItem,
  SelectList,
  SelectStatement,
  Span,
  Statement,
  TableRef,
  UpdateAssignment,
  UpdateStatement,
} from './ast.ts';
import { selectItemKey, walkExpr } from './ast.ts';
import { exprToSql } from './print.ts';
import { arithmetic, negate } from '../value.ts';
import { TokenizeError, tokenize } from './tokenizer.ts';
import type { Token } from './tokenizer.ts';

class ParseError extends Error {
  from: number;
  to: number;
  hint?: string;

  constructor(message: string, at: { from: number; to: number }, hint?: string) {
    super(message);
    this.name = 'ParseError';
    this.from = at.from;
    this.to = Math.max(at.to, at.from + 1);
    if (hint !== undefined) this.hint = hint;
  }
}

/** Keywords that tokenise cleanly but land outside the v0 subset. */
const OUT_OF_SCOPE: Record<string, string> = {
  RIGHT: 'RIGHT JOIN is not in the v0 subset — write it the other way round: swap the two tables and use a LEFT JOIN.',
  FULL: 'FULL (OUTER) JOIN is not in the v0 subset — an inner or a LEFT JOIN only.',
  CROSS: 'CROSS JOIN is not in the v0 subset — JOIN ... ON needs an equality.',
  USING: 'USING is not in the v0 subset — write the equality out: JOIN t ON a.x = t.y.',
  DISTINCT: 'DISTINCT applies to the whole SELECT list — write `SELECT DISTINCT a, b …`. Inside an aggregate, `COUNT(DISTINCT x)` is not supported yet.',
  UNION: 'UNION is not in the v0 subset.',
  CREATE: 'QueryLens only runs SELECT, DELETE, INSERT and UPDATE. Edit the seed data to change the table.',
  DROP: 'QueryLens only runs SELECT, DELETE, INSERT and UPDATE. Edit the seed data to change the table.',
};

const describe = (t: Token): string =>
  t.type === 'eof' ? 'the end of the query' : `\`${t.value}\``;

/* -------------------------------------------------------------------------- */
/* Shared cursor + grammar pieces — every statement form parses through these */
/* -------------------------------------------------------------------------- */

interface Cursor {
  /**
   * True only while a HAVING predicate is being parsed (plan.md §25.4 B2): an aggregate call is a value
   * there — the group's `COUNT(*)` — and an error anywhere else, where it would have no group to read.
   */
  allowAggregates: boolean;
  peek: () => Token;
  /** `n` tokens past the current one (`peekAt(0)` is `peek()`); the EOF token once past the end. */
  peekAt: (n: number) => Token;
  next: () => Token;
  atEnd: () => boolean;
  guardScope: (token: Token) => void;
  expectKeyword: (word: string, what: string) => Token;
  expectIdentifier: (what: string) => Token;
}

function makeCursor(tokens: Token[]): Cursor {
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const peekAt = (n: number): Token => tokens[Math.min(pos + n, tokens.length - 1)]!;
  const next = (): Token => tokens[pos++]!;
  const atEnd = (): boolean => peek().type === 'eof';

  function guardScope(token: Token): void {
    if (token.type === 'dot') {
      throw new ParseError(
        'Unexpected `.` here.',
        token,
        'A qualified name is `table.column` — exactly one dot, right after the table name.',
      );
    }
    const reason = token.type === 'keyword' ? OUT_OF_SCOPE[token.upper] : undefined;
    if (reason) {
      throw new ParseError(`\`${token.value.toUpperCase()}\` is not supported yet.`, token, reason);
    }
  }

  function expectKeyword(word: string, what: string): Token {
    const token = peek();
    if (token.type === 'keyword' && token.upper === word) return next();
    guardScope(token);
    throw new ParseError(`Expected \`${word}\` ${what}, found ${describe(token)}.`, token);
  }

  function expectIdentifier(what: string): Token {
    const token = peek();
    if (token.type === 'identifier') return next();
    guardScope(token);
    throw new ParseError(`Expected ${what}, found ${describe(token)}.`, token);
  }

  return { allowAggregates: false, peek, peekAt, next, atEnd, guardScope, expectKeyword, expectIdentifier };
}

/** The v0 aggregate functions. Not tokenizer keywords — they parse as identifiers, recognised by name here. */
export const AGGREGATE_FNS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

/**
 * `identifier ['.' identifier]` — `first` is the identifier token already
 * consumed by the caller; this only looks for an optional `.column` after it.
 * Shared by every place a column reference can appear: a `selectItem`, an
 * `operand`, and an aggregate's argument.
 */
function parseQualifiedColumnTail(
  c: Cursor,
  first: Token,
): { name: string; table?: string; from: number; to: number } {
  if (c.peek().type !== 'dot') {
    return { name: first.value, from: first.from, to: first.to };
  }
  c.next(); // '.'
  const col = c.expectIdentifier('a column name after the table qualifier');
  return { table: first.value, name: col.value, from: first.from, to: col.to };
}

/**
 * One SELECT item: an aggregate call — `COUNT(*)`, `SUM(age)` — or any
 * expression: a plain column, `price * qty`, `age > 30`. An expression may be
 * named with `AS`; a bare column with no alias stays a plain `column` item.
 */
function parseSelectItem(c: Cursor): SelectItem {
  const token = c.peek();
  const upper = token.value.toUpperCase();

  if (token.type === 'identifier' && AGGREGATE_FNS.has(upper) && c.peekAt(1).type === 'lparen') {
    c.next(); // the function name
    c.next(); // '('
    return parseAggregateCall(c, token, upper);
  }

  const expr = parseExpr(c, true);
  let alias: string | undefined;
  let end = expr.span.to;
  if (isKeyword(c.peek(), 'AS')) {
    c.next();
    const name = c.expectIdentifier('a name for the column after AS');
    alias = name.value;
    end = name.to;
  }

  if (expr.kind === 'column' && alias === undefined) {
    return {
      kind: 'column',
      name: expr.name,
      ...(expr.table === undefined ? {} : { table: expr.table }),
      span: expr.span,
    };
  }
  return { kind: 'expression', expr, ...(alias === undefined ? {} : { alias }), span: { from: expr.span.from, to: end } };
}

/** The argument and closing parenthesis of an aggregate call, after `FN(` has been consumed. */
function parseAggregateArgs(c: Cursor, upper: string): { arg: AggregateArg; close: Token } {
  const argToken = c.peek();
  let arg: AggregateArg;
  if (argToken.type === 'star') {
    c.next();
    if (upper !== 'COUNT') {
      throw new ParseError(
        `\`${upper}(*)\` is not supported — \`*\` only works with COUNT.`,
        argToken,
        `Give ${upper} a column to aggregate, e.g. ${upper}(age).`,
      );
    }
    arg = { kind: 'star', span: { from: argToken.from, to: argToken.to } };
  } else {
    if (isKeyword(argToken, 'DISTINCT')) {
      throw new ParseError(
        '`COUNT(DISTINCT …)` is not supported yet.',
        argToken,
        '`SELECT DISTINCT` is supported; inside an aggregate it is not — count the distinct rows another way.',
      );
    }
    const colToken = c.expectIdentifier(`a column name, or \`*\` for COUNT`);
    const ref = parseQualifiedColumnTail(c, colToken);
    arg = {
      kind: 'column',
      name: ref.name,
      ...(ref.table === undefined ? {} : { table: ref.table }),
      span: { from: ref.from, to: ref.to },
    };
  }

  const close = c.peek();
  if (close.type !== 'rparen') {
    c.guardScope(close);
    throw new ParseError(`Expected \`)\` after the aggregate's argument, found ${describe(close)}.`, close);
  }
  c.next();
  return { arg, close };
}

/** The part of an aggregate SELECT item after `FN(`. */
function parseAggregateCall(c: Cursor, token: Token, upper: string): SelectItem {
  const { arg, close } = parseAggregateArgs(c, upper);

  const after = c.peek();
  if ((after.type === 'operator' && ['+', '-', '/', '%'].includes(after.value)) || after.type === 'star') {
    throw new ParseError(
      'Arithmetic on an aggregate is not supported yet.',
      after,
      `Compute \`${upper}(...)\` on its own; do the arithmetic on plain columns.`,
    );
  }
  if (isKeyword(after, 'AS')) {
    throw new ParseError(
      '`AS` is not supported on an aggregate yet.',
      after,
      'An aggregate is named by its own text, like `COUNT(*)`. `AS` works on plain columns and computed ones.',
    );
  }

  return { kind: 'aggregate', fn: upper as AggregateFn, arg, span: { from: token.from, to: close.to } };
}

function parseSelectList(c: Cursor): SelectList {
  const first = c.peek();

  if (first.type === 'star') {
    c.next();
    return { kind: 'star', span: { from: first.from, to: first.to } };
  }

  const items: SelectItem[] = [];
  for (;;) {
    items.push(parseSelectItem(c));
    if (c.peek().type !== 'comma') break;
    c.next();
  }
  const last = items[items.length - 1]!;
  return { kind: 'columns', items, span: { from: first.from, to: last.span.to } };
}

/** `GROUP BY col [, col ...]`, if present. */
function parseGroupBy(c: Cursor): GroupByClause | undefined {
  if (!(c.peek().type === 'keyword' && c.peek().upper === 'GROUP')) return undefined;
  const groupToken = c.next();
  c.expectKeyword('BY', 'after GROUP');

  const columns: { name: string; span: Span }[] = [];
  for (;;) {
    const token = c.expectIdentifier('a column name to group by');
    columns.push({ name: token.value, span: { from: token.from, to: token.to } });
    if (c.peek().type !== 'comma') break;
    c.next();
  }
  const last = columns[columns.length - 1]!;
  return { columns, span: { from: groupToken.from, to: last.span.to } };
}

/**
 * Standard SQL's rule: a plain column in the SELECT list must be one the
 * query groups by, or wrapped in an aggregate — otherwise which of the many
 * rows in a group would it come from is not defined. Applies whether or not
 * `GROUP BY` is written at all: `SELECT dept, COUNT(*) FROM t` is invalid for
 * the same reason `SELECT dept, COUNT(*) FROM t GROUP BY status` is.
 */
function checkGroupingValidity(select: SelectList, groupBy: GroupByClause | undefined): void {
  if (select.kind === 'star') {
    if (groupBy) {
      throw new ParseError(
        '`SELECT *` cannot be combined with GROUP BY.',
        groupBy.span,
        'Name the columns you want — each one either grouped or wrapped in an aggregate.',
      );
    }
    return;
  }

  const hasAggregate = select.items.some((item) => item.kind === 'aggregate');
  if (!hasAggregate && !groupBy) return;

  const computed = select.items.find((item) => item.kind === 'expression');
  if (computed) {
    throw new ParseError(
      `\`${selectItemKey(computed)}\` is a computed column, which cannot be combined with GROUP BY or an aggregate yet.`,
      computed.span,
      'Aggregate plain columns, or compute the expression in a query without GROUP BY.',
    );
  }

  const groupNames = new Set(groupBy?.columns.map((c) => c.name) ?? []);
  const ungrouped = select.items.find((item) => item.kind === 'column' && !groupNames.has(item.name));
  if (ungrouped) {
    throw new ParseError(
      `\`${(ungrouped as Extract<SelectItem, { kind: 'column' }>).name}\` is not aggregated${
        groupBy ? ' and is not in the GROUP BY list' : ''
      }.`,
      ungrouped.span,
      groupBy
        ? 'Every plain column in the SELECT list must be one you GROUP BY, or wrapped in an aggregate like COUNT(...).'
        : 'Mixing a plain column with an aggregate needs a GROUP BY — add one, or wrap the column in an aggregate too.',
    );
  }
}

/**
 * A HAVING predicate filters *groups*, so what it may mention is what a group
 * has: the grouped columns and aggregates. A plain column that is neither is as
 * undefined here as it is in the SELECT list — which of a group's many rows
 * would it come from? And HAVING only means something where there are groups:
 * with `GROUP BY`, or an aggregate that collapses the table into one.
 */
function checkHavingValidity(
  having: Expr,
  select: SelectList,
  groupBy: GroupByClause | undefined,
  havingToken: Token,
): void {
  let hasAggregate = select.kind === 'columns' && select.items.some((item) => item.kind === 'aggregate');
  const columns: Extract<Expr, { kind: 'column' }>[] = [];
  walkExpr(having, (e) => {
    if (e.kind === 'aggregate') hasAggregate = true;
    if (e.kind === 'column') columns.push(e);
  });

  if (!groupBy && !hasAggregate) {
    throw new ParseError(
      'HAVING needs GROUP BY or an aggregate.',
      havingToken,
      'HAVING filters groups. To filter individual rows, use WHERE.',
    );
  }

  const groupNames = new Set(groupBy?.columns.map((c) => c.name) ?? []);
  const ungrouped = columns.find((col) => !groupNames.has(col.name));
  if (ungrouped) {
    throw new ParseError(
      `\`${ungrouped.name}\` is not aggregated and is not in the GROUP BY list.`,
      ungrouped.span,
      groupBy
        ? 'A HAVING predicate may test grouped columns and aggregates like COUNT(*) — not a plain column.'
        : 'Without a GROUP BY the whole table is one group, so HAVING can only test aggregates.',
    );
  }
}

function parseTableRef(c: Cursor): TableRef {
  const token = c.expectIdentifier('a table name');
  return { name: token.value, span: { from: token.from, to: token.to } };
}

/** `[INNER | LEFT [OUTER]] JOIN identifier ON qualifiedColumn '=' qualifiedColumn`, if present (plan.md §25.4 C3). */
function parseJoin(c: Cursor): JoinClause | undefined {
  const first = c.peek();
  const isLeft = isKeyword(first, 'LEFT');
  const isInner = isKeyword(first, 'INNER');
  if (!isLeft && !isInner && !isKeyword(first, 'JOIN')) return undefined;

  let joinType: JoinClause['joinType'];
  if (isLeft) {
    c.next();
    if (isKeyword(c.peek(), 'OUTER')) c.next();
    joinType = 'left';
  } else if (isInner) {
    c.next();
  }
  c.expectKeyword('JOIN', isLeft || isInner ? 'after LEFT/INNER' : 'to begin a join');
  const table = parseTableRef(c);
  c.expectKeyword('ON', 'after the joined table name');
  const on = parseComparison(c);
  checkJoinOn(on);
  return { table, on, ...(joinType ? { joinType } : {}), span: { from: first.from, to: on.span.to } };
}

/** `ON` is always a single equality between one qualified column from each side — an equi-join. */
function checkJoinOn(on: Extract<Expr, { kind: 'compare' }>): void {
  if (on.op !== '=') {
    throw new ParseError(
      'JOIN ... ON only supports an equality between two columns.',
      on.span,
      'v0 joins are equi-joins: `table.column = table.column`.',
    );
  }
  if (on.left.kind !== 'column' || on.left.table === undefined) {
    throw new ParseError(
      'The left side of ON must be a qualified column, like `authors.id`.',
      on.left.span,
      'Every column in a JOIN needs its table name, so it is never ambiguous which side it comes from.',
    );
  }
  if (on.right.kind !== 'column' || on.right.table === undefined) {
    throw new ParseError(
      'The right side of ON must be a qualified column, like `posts.authorId`.',
      on.right.span,
      'Every column in a JOIN needs its table name, so it is never ambiguous which side it comes from.',
    );
  }
}

/**
 * Where a `JOIN` sits in the chain (plan.md §25.4 C3 slice b): `checkJoinOn` already guarantees `on`'s two operands
 * are qualified columns, but not *which* tables they name. This checks the one thing that actually depends on the
 * chain built so far — one side must be the table this `JOIN` introduces, and the other must already be in scope
 * (`FROM`, or an earlier `JOIN`) — closing a gap the single-join grammar never had to close itself (a single join's
 * `ON` was never actually checked against `FROM`'s and its own table name; `buildJoinPlan` just assumed it).
 */
function checkJoinChain(join: JoinClause, known: ReadonlySet<string>): void {
  const { left, right } = join.on;
  if (left.kind !== 'column' || right.kind !== 'column') return; // unreachable: checkJoinOn already guarantees this
  const newTable = join.table.name;
  if (known.has(newTable)) {
    throw new ParseError(
      `\`${newTable}\` is already in this query.`,
      join.table.span,
      'Joining the same table twice needs an alias, which v0 does not have — give the table a different name in a copy of the data instead.',
    );
  }
  const leftIsNew = left.table === newTable;
  const rightIsNew = right.table === newTable;
  if (!leftIsNew && !rightIsNew) {
    throw new ParseError(
      `Neither side of ON names \`${newTable}\` — the table this JOIN introduces.`,
      join.on.span,
      `One side of ON must be a column on \`${newTable}\`; the other, on a table already in the query (${[...known].join(', ')}).`,
    );
  }
  if (leftIsNew && rightIsNew) {
    throw new ParseError(
      `Both sides of ON name \`${newTable}\` — a JOIN needs one column from the table it introduces and one from a table already in the query.`,
      join.on.span,
    );
  }
  const otherTable = (leftIsNew ? right.table : left.table)!;
  if (!known.has(otherTable)) {
    throw new ParseError(
      `There is no table called \`${otherTable}\` yet in this query.`,
      join.on.span,
      `\`${otherTable}\` has to be named in FROM or an earlier JOIN before this ON clause can reference it. Known so far: ${[...known].join(', ')}.`,
    );
  }
}

/** Every column reference anywhere in the SELECT list or WHERE, in source order. */
function collectColumnRefs(select: SelectList, where: Expr | undefined): Extract<Expr, { kind: 'column' }>[] {
  const refs: Extract<Expr, { kind: 'column' }>[] = [];
  if (select.kind === 'columns') {
    for (const item of select.items) {
      if (item.kind === 'column') refs.push(item);
      else if (item.kind === 'expression') walkExpr(item.expr, (e) => { if (e.kind === 'column') refs.push(e); });
      else if (item.arg.kind === 'column') refs.push(item.arg);
    }
  }
  if (where) walkExpr(where, (e) => { if (e.kind === 'column') refs.push(e); });
  return refs;
}

/**
 * Two checks, both about column qualifiers: a `join` combined with an
 * aggregate SELECT item is not supported yet (v1 restriction), and every
 * column reference's `table` — required at all once a `join` is present, so
 * no reference can ever be ambiguous between the tables — must actually
 * name a table this query knows about (`FROM` or any `JOIN`).
 */
function checkJoinValidity(
  select: SelectList,
  joins: JoinClause[],
  where: Expr | undefined,
  from: TableRef,
): void {
  const hasJoin = joins.length > 0;
  if (hasJoin && select.kind === 'columns') {
    const aggregate = select.items.find((item): item is Extract<SelectItem, { kind: 'aggregate' }> =>
      item.kind === 'aggregate',
    );
    if (aggregate) {
      throw new ParseError(
        'An aggregate function is not supported yet in a query with JOIN.',
        aggregate.span,
        'JOIN queries return plain rows for now — aggregate the result in a later version.',
      );
    }
  }

  const known = [from.name, ...joins.map((j) => j.table.name)];
  const knownSet = new Set(known);
  for (const ref of collectColumnRefs(select, where)) {
    if (hasJoin && ref.table === undefined) {
      throw new ParseError(
        `\`${ref.name}\` needs a table name now that this query joins ${String(known.length)} tables.`,
        ref.span,
        `Write ${known.map((t) => `\`${t}.${ref.name}\``).join(' or ')}, whichever table it is actually on.`,
      );
    }
    if (!hasJoin && ref.table !== undefined) {
      // A single-table query's rows are never qualified — `authors.id` would
      // look up a key that does not exist, since the row is just `{id, ...}`.
      // Rather than special-case a self-qualification that happens to name
      // the one table right, v0 asks for the plain name instead.
      throw new ParseError(
        `\`${ref.table}.${ref.name}\` does not need a table name — this query only has one table.`,
        ref.span,
        `Write \`${ref.name}\` on its own.`,
      );
    }
    if (hasJoin && ref.table !== undefined && !knownSet.has(ref.table)) {
      throw new ParseError(
        `There is no table called \`${ref.table}\` in this query.`,
        ref.span,
        `This query only knows about ${known.map((t) => `\`${t}\``).join(', ')}.`,
      );
    }
  }
}

const isKeyword = (t: Token, ...words: string[]): boolean => t.type === 'keyword' && words.includes(t.upper);

/** A literal, a column, or a parenthesised expression — the leaves every expression is built from. */
function parsePrimary(c: Cursor): Expr {
  const token = c.peek();

  if (token.type === 'identifier' && AGGREGATE_FNS.has(token.value.toUpperCase()) && c.peekAt(1).type === 'lparen') {
    if (!c.allowAggregates) {
      throw new ParseError(
        `\`${token.value.toUpperCase()}(…)\` cannot be used here.`,
        token,
        'An aggregate has no group to read in a WHERE clause — WHERE filters rows *before* they are grouped. Put it in HAVING, which filters the groups.',
      );
    }
    c.next();
    c.next(); // '('
    const upper = token.value.toUpperCase();
    const { arg, close } = parseAggregateArgs(c, upper);
    return { kind: 'aggregate', fn: upper as AggregateFn, arg, span: { from: token.from, to: close.to } };
  }
  if (token.type === 'identifier') {
    c.next();
    const ref = parseQualifiedColumnTail(c, token);
    return {
      kind: 'column',
      name: ref.name,
      ...(ref.table === undefined ? {} : { table: ref.table }),
      span: { from: ref.from, to: ref.to },
    };
  }
  if (token.type === 'number') {
    c.next();
    return {
      kind: 'literal',
      value: Number(token.value),
      raw: token.value,
      span: { from: token.from, to: token.to },
    };
  }
  if (token.type === 'string') {
    c.next();
    return {
      kind: 'literal',
      value: token.value,
      raw: `'${token.value}'`,
      span: { from: token.from, to: token.to },
    };
  }
  if (token.type === 'keyword' && ['NULL', 'TRUE', 'FALSE'].includes(token.upper)) {
    c.next();
    const value = token.upper === 'NULL' ? null : token.upper === 'TRUE';
    return {
      kind: 'literal',
      value,
      raw: token.upper,
      span: { from: token.from, to: token.to },
    };
  }
  if (token.type === 'lparen') {
    c.next();
    // Inside parentheses a bare value is fine — `(a + 1) * 2`; the caller decides whether it is a valid predicate.
    const inner = parseExpr(c, true);
    const close = c.peek();
    if (close.type !== 'rparen') {
      c.guardScope(close);
      throw new ParseError(`Expected \`)\` to close the parenthesis, found ${describe(close)}.`, close);
    }
    c.next();
    // The span takes in the parentheses, so the editor highlights what was actually written.
    return { ...inner, span: { from: token.from, to: close.to } };
  }

  if (isKeyword(token, 'SELECT')) {
    throw new ParseError(
      'A subquery is not supported here.',
      token,
      'v2 has no subqueries yet — write the values out, or join the two tables.',
    );
  }
  c.guardScope(token);
  throw new ParseError(`Expected a column name or a value, found ${describe(token)}.`, token);
}

const numericLiteral = (e: Expr): e is Extract<Expr, { kind: 'literal' }> & { value: number } =>
  e.kind === 'literal' && typeof e.value === 'number';

/** `-x`. A minus in front of a numeric literal is folded into the literal, so `id = -5` is still an index equality. */
function parseUnary(c: Cursor): Expr {
  const token = c.peek();
  if (token.type === 'operator' && token.value === '-') {
    c.next();
    const operand = parseUnary(c);
    const span = { from: token.from, to: operand.span.to };
    if (numericLiteral(operand)) {
      return { kind: 'literal', value: negate(operand.value) ?? 0, raw: operand.raw.startsWith('-') ? operand.raw.slice(1) : `-${operand.raw}`, span };
    }
    return { kind: 'neg', operand, span };
  }
  if (token.type === 'operator' && token.value === '+') {
    c.next(); // unary plus changes nothing
    return parseUnary(c);
  }
  return parsePrimary(c);
}

function parseMultiplicative(c: Cursor): Expr {
  let left = parseUnary(c);
  for (;;) {
    const t = c.peek();
    const isMul = t.type === 'star' || (t.type === 'operator' && (t.value === '/' || t.value === '%'));
    if (!isMul) return left;
    c.next();
    const right = parseUnary(c);
    left = { kind: 'arith', op: t.value as '*' | '/' | '%', left, right, span: { from: left.span.from, to: right.span.to } };
  }
}

/** The operand of a comparison or a test: `+ -` over `* / %` over unary minus over a primary. */
function parseOperand(c: Cursor): Expr {
  let left = parseMultiplicative(c);
  for (;;) {
    const t = c.peek();
    if (!(t.type === 'operator' && (t.value === '+' || t.value === '-'))) return left;
    c.next();
    const right = parseMultiplicative(c);
    left = { kind: 'arith', op: t.value, left, right, span: { from: left.span.from, to: right.span.to } };
  }
}

const COMPARE_OPS = ['=', '<>', '!=', '<', '>', '<=', '>='];

/** `left op operand`, given `left` already parsed — shared by `parseComparison` and the plain (non-BETWEEN) half of `parsePredicate`. */
function finishComparison(c: Cursor, left: Expr): Extract<Expr, { kind: 'compare' }> {
  const opToken = c.peek();

  if (opToken.type !== 'operator') {
    c.guardScope(opToken);
    throw new ParseError(
      `Expected \`=\`, \`<>\`, \`<\`, \`>\`, \`<=\`, \`>=\`, \`BETWEEN\`, \`IN\`, \`LIKE\` or \`IS\`, found ${describe(opToken)}.`,
      opToken,
    );
  }
  if (!COMPARE_OPS.includes(opToken.value)) {
    throw new ParseError(
      `\`${opToken.value}\` is not supported yet.`,
      opToken,
      'QueryLens compares with `=`, `<>`, `<`, `>`, `<=`, `>=`, and also has BETWEEN, IN, LIKE and IS NULL.',
    );
  }
  c.next();

  const right = parseOperand(c);
  // `a < b < c` is legal in some engines and means something nobody intends; say what to write instead.
  const again = c.peek();
  if (again.type === 'operator' && COMPARE_OPS.includes(again.value)) {
    throw new ParseError(
      'A comparison compares two things — it cannot be chained.',
      again,
      'Write `a < b AND b < c`, or use `b BETWEEN a AND c`.',
    );
  }
  return {
    kind: 'compare',
    op: (opToken.value === '!=' ? '<>' : opToken.value) as CompareOp,
    left,
    right,
    span: { from: left.span.from, to: right.span.to },
  };
}

/** Used only by `JOIN ... ON`, which needs exactly one equality — no BETWEEN there. */
function parseComparison(c: Cursor): Extract<Expr, { kind: 'compare' }> {
  return finishComparison(c, parseOperand(c));
}

/** True for a node that is a truth value on its own, so `WHERE (a = 1 OR b = 2)` needs no operator after it. */
const isBooleanNode = (e: Expr): boolean =>
  e.kind !== 'column' && e.kind !== 'literal' && e.kind !== 'arith' && e.kind !== 'neg';

/**
 * One predicate: an operand followed by whatever it is being tested against.
 *
 * `x BETWEEN lo AND hi` desugars to `x >= lo AND x <= hi` right here, rather
 * than adding a `between` `Expr` kind — the two comparisons that come out are
 * indistinguishable from ones written by hand, so `index-selection`'s range
 * rule, the cost model's selectivity estimate, `evaluate.ts`, and every other
 * conjunct-walking piece of the engine all handle a `BETWEEN` for free.
 * `NOT BETWEEN` is that, wrapped in `not`.
 */
function parsePredicate(c: Cursor, bare = false): Expr {
  const left = parseOperand(c);
  const first = c.peek();

  // No test follows. A parenthesised predicate is already a truth value — `(a = 1 OR b = 2)` — and where a
  // *value* is wanted (a SELECT item, a SET value, inside parentheses) a bare column or sum is one too.
  if ((isBooleanNode(left) || bare) && !(first.type === 'operator' || isKeyword(first, 'IS', 'NOT', 'IN', 'LIKE', 'BETWEEN'))) {
    return left;
  }

  if (isKeyword(first, 'IS')) {
    c.next();
    const negated = isKeyword(c.peek(), 'NOT') ? (c.next(), true) : false;
    const nullToken = c.expectKeyword('NULL', 'after IS' + (negated ? ' NOT' : ''));
    return { kind: 'isNull', operand: left, negated, span: { from: left.span.from, to: nullToken.to } };
  }

  const negated = isKeyword(first, 'NOT') && isKeyword(c.peekAt(1), 'BETWEEN', 'IN', 'LIKE');
  if (negated) c.next();
  const word = c.peek();

  if (isKeyword(word, 'BETWEEN')) {
    c.next();
    const low = parseOperand(c);
    c.expectKeyword('AND', 'between the two bounds of a BETWEEN range');
    const high = parseOperand(c);
    const between: Expr = {
      kind: 'and',
      left: { kind: 'compare', op: '>=', left, right: low, span: { from: left.span.from, to: low.span.to } },
      right: { kind: 'compare', op: '<=', left, right: high, span: { from: left.span.from, to: high.span.to } },
      span: { from: left.span.from, to: high.span.to },
    };
    return negated ? { kind: 'not', operand: between, span: between.span } : between;
  }

  if (isKeyword(word, 'IN')) {
    c.next();
    const open = c.peek();
    if (open.type !== 'lparen') {
      c.guardScope(open);
      throw new ParseError(`Expected \`(\` after IN, found ${describe(open)}.`, open, 'IN takes a list of values: `x IN (1, 2, 3)`.');
    }
    // `IN (SELECT …)` (plan.md §25.4 C3 slice c) vs. `IN (1, 2, 3)` — both start with `(`, so the token right after
    // it is the only thing that tells them apart.
    if (isKeyword(c.peekAt(1), 'SELECT')) {
      c.next(); // '('
      const { subquery, close } = parseInSubquery(c);
      return { kind: 'in', operand: left, items: [], subquery, negated, span: { from: left.span.from, to: close.to } };
    }
    const list = parseParenList(c, 'IN list', parseOperand);
    return { kind: 'in', operand: left, items: list.items, negated, span: { from: left.span.from, to: list.to } };
  }

  if (isKeyword(word, 'LIKE')) {
    c.next();
    const pattern = parseOperand(c);
    return { kind: 'like', operand: left, pattern, negated, span: { from: left.span.from, to: pattern.span.to } };
  }

  return finishComparison(c, left);
}

/**
 * `SELECT column FROM table [WHERE expr]` — the whole grammar `IN`'s subquery form accepts (plan.md §25.4 C3
 * slice c), starting right after the `(` `parsePredicate`'s IN branch already consumed. Deliberately much smaller
 * than `parseSelectBody`: a subquery here is always uncorrelated and collapses to a set of one column's values,
 * so `*`/an aggregate/a computed column, `JOIN`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT` and `DISTINCT` are all
 * rejected outright rather than parsed and later restricted — none of them could change *which* values end up in
 * that set. `checkJoinValidity` (with no `JOIN`) does the same "no table name needed" check on `where`'s columns
 * that any other single-table query already gets, which is also what makes this uncorrelated: there is no path
 * for a column here to name a table the outer query knows about.
 */
function parseInSubquery(c: Cursor): { subquery: InSubquery; close: Token } {
  const selectToken = c.expectKeyword('SELECT', 'to begin the subquery');
  if (isKeyword(c.peek(), 'DISTINCT')) {
    throw new ParseError(
      'DISTINCT is not needed inside an IN subquery.',
      c.peek(),
      "IN already treats the subquery's rows as a set of values — a repeat makes no difference either way.",
    );
  }
  const first = c.peek();
  if (first.type === 'star') {
    throw new ParseError(
      '`SELECT *` is not supported inside an IN subquery.',
      first,
      'Name the one column IN needs to compare against.',
    );
  }
  if (first.type === 'identifier' && AGGREGATE_FNS.has(first.value.toUpperCase()) && c.peekAt(1).type === 'lparen') {
    throw new ParseError(
      'An aggregate is not supported yet inside an IN subquery.',
      first,
      'Select the plain column IN needs to compare against instead.',
    );
  }
  const colToken = c.expectIdentifier('the one column IN needs to compare against');
  const tail = parseQualifiedColumnTail(c, colToken);
  const columnItem: SelectItem = {
    kind: 'column',
    name: tail.name,
    ...(tail.table === undefined ? {} : { table: tail.table }),
    span: { from: tail.from, to: tail.to },
  };
  if (c.peek().type === 'comma') {
    throw new ParseError(
      'An IN subquery can only select one column.',
      c.peek(),
      'IN compares against a single value per row — select just the column you need.',
    );
  }
  c.expectKeyword('FROM', "after the subquery's column");
  const from = parseTableRef(c);
  const afterFrom = c.peek();
  if (isKeyword(afterFrom, 'JOIN') || isKeyword(afterFrom, 'LEFT') || isKeyword(afterFrom, 'INNER')) {
    throw new ParseError(
      'JOIN is not supported yet inside an IN subquery.',
      afterFrom,
      'Query the one table IN needs, or join the tables outside the subquery instead.',
    );
  }
  const where = parseOptionalWhere(c);
  const after = c.peek();
  if (isKeyword(after, 'GROUP')) {
    throw new ParseError(
      'GROUP BY is not supported inside an IN subquery.',
      after,
      'Select the plain column IN needs to compare against instead.',
    );
  }
  if (isKeyword(after, 'ORDER')) {
    throw new ParseError(
      'ORDER BY makes no difference inside an IN subquery.',
      after,
      'IN treats the result as a set of values — order never matters here. Drop it.',
    );
  }
  if (isKeyword(after, 'LIMIT')) {
    throw new ParseError(
      'LIMIT is not supported yet inside an IN subquery.',
      after,
      'IN needs every matching value, not just some of them.',
    );
  }
  checkJoinValidity({ kind: 'columns', items: [columnItem], span: columnItem.span }, [], where, from);

  const close = c.peek();
  if (close.type !== 'rparen') {
    c.guardScope(close);
    throw new ParseError(`Expected \`)\` to close the subquery, found ${describe(close)}.`, close);
  }
  c.next();

  return {
    subquery: {
      column: { name: tail.name, span: { from: tail.from, to: tail.to } },
      from,
      ...(where ? { where } : {}),
      span: { from: selectToken.from, to: close.from },
    },
    close,
  };
}

function parseNotExpr(c: Cursor, bare = false): Expr {
  const token = c.peek();
  if (isKeyword(token, 'NOT')) {
    c.next();
    const operand = parseNotExpr(c);
    return { kind: 'not', operand, span: { from: token.from, to: operand.span.to } };
  }
  return parsePredicate(c, bare);
}

function parseAndExpr(c: Cursor, bare = false): Expr {
  let left = parseNotExpr(c, bare);
  while (isKeyword(c.peek(), 'AND')) {
    c.next();
    const right = parseNotExpr(c);
    left = { kind: 'and', left, right, span: { from: left.span.from, to: right.span.to } };
  }
  return left;
}

/**
 * `OR` binds loosest, then `AND`, then `NOT` — so `a OR b AND c` is `a OR (b AND c)`.
 * `bare` says a lone value (a column, `a + 1`) is acceptable as the whole
 * expression — true for SELECT items, `SET` values and inside parentheses,
 * false for a `WHERE`, where a bare column is not a predicate.
 */
function parseExpr(c: Cursor, bare = false): Expr {
  let left = parseAndExpr(c, bare);
  while (isKeyword(c.peek(), 'OR')) {
    c.next();
    const right = parseAndExpr(c);
    left = { kind: 'or', left, right, span: { from: left.span.from, to: right.span.to } };
  }
  return left;
}

/** `WHERE expr`, if present. Shared by every statement form that allows one. */
function parseOptionalWhere(c: Cursor): Expr | undefined {
  if (c.peek().type === 'keyword' && c.peek().upper === 'WHERE') {
    c.next();
    return parseExpr(c);
  }
  return undefined;
}

/** The value of an expression built only from literals, or `undefined` if it depends on anything else. */
function constantValue(expr: Expr): { value: SqlValue } | undefined {
  if (expr.kind === 'literal') return { value: expr.value };
  if (expr.kind === 'neg') {
    const inner = constantValue(expr.operand);
    return inner && { value: negate(inner.value) };
  }
  if (expr.kind === 'arith') {
    const left = constantValue(expr.left);
    const right = constantValue(expr.right);
    return left && right && { value: arithmetic(expr.op, left.value, right.value) };
  }
  return undefined;
}

/**
 * A value for an INSERT's VALUES list: a literal, or arithmetic over literals
 * (`-5`, `2 * 3`), folded to one literal here — the row a statement writes is
 * known before it runs, so there is nothing to compute later. A column
 * reference is rejected: an INSERT has no row to read it from.
 */
function parseLiteralValue(c: Cursor): Extract<Expr, { kind: 'literal' }> {
  const token = c.peek();
  if (token.type === 'rparen' || token.type === 'comma' || token.type === 'eof') {
    throw new ParseError(`Expected a value, found ${describe(token)}.`, token);
  }
  const expr = parseExpr(c, true);
  const folded = constantValue(expr);
  if (folded) {
    // A lone literal keeps its source text; a folded expression is shown as what it computes.
    const raw = expr.kind === 'literal' ? expr.raw : exprToSql(expr);
    return { kind: 'literal', value: folded.value, raw, span: expr.span };
  }

  let column: Extract<Expr, { kind: 'column' }> | undefined;
  walkExpr(expr, (e) => { if (!column && e.kind === 'column') column = e; });
  if (column) {
    throw new ParseError(
      `Expected a value, found \`${column.name}\`.`,
      column.span,
      'INSERT takes literal values, or arithmetic on them (`-5`, `2 * 3`) — no column references.',
    );
  }
  c.guardScope(token);
  throw new ParseError(`Expected a value, found ${describe(token)}.`, token);
}

/** `( item (',' item)* )` — shared by INSERT's column list and its VALUES list. */
function parseParenList<T>(
  c: Cursor,
  what: string,
  parseItem: (c: Cursor) => T,
): { items: T[]; from: number; to: number } {
  const open = c.peek();
  if (open.type !== 'lparen') {
    c.guardScope(open);
    throw new ParseError(`Expected \`(\` before the ${what}, found ${describe(open)}.`, open);
  }
  c.next();

  const items: T[] = [parseItem(c)];
  while (c.peek().type === 'comma') {
    c.next();
    items.push(parseItem(c));
  }

  const close = c.peek();
  if (close.type !== 'rparen') {
    c.guardScope(close);
    throw new ParseError(`Expected \`)\` after the ${what}, found ${describe(close)}.`, close);
  }
  c.next();

  return { items, from: open.from, to: close.to };
}

/** Trailing `;` (optional) then EOF, or a "trailing junk" error naming why. */
function expectStatementEnd(c: Cursor): void {
  if (c.peek().type === 'semicolon') c.next();
  if (!c.atEnd()) {
    const token = c.peek();
    c.guardScope(token);
    throw new ParseError(`Unexpected ${describe(token)} after the end of the query.`, token);
  }
}

/* -------------------------------------------------------------------------- */
/* SELECT                                                                      */
/* -------------------------------------------------------------------------- */

function parseSelectBody(c: Cursor): SelectStatement {
  const selectToken = c.expectKeyword('SELECT', 'to begin the query');
  const distinct = isKeyword(c.peek(), 'DISTINCT') ? (c.next(), true) : false;
  const select = parseSelectList(c);
  c.expectKeyword('FROM', 'after the column list');
  const from = parseTableRef(c);
  const joins: JoinClause[] = [];
  const known = new Set([from.name]);
  for (;;) {
    const join = parseJoin(c);
    if (!join) break;
    checkJoinChain(join, known);
    known.add(join.table.name);
    joins.push(join);
  }
  const hasJoin = joins.length > 0;
  const where = parseOptionalWhere(c);
  const groupBy = parseGroupBy(c);
  if (hasJoin && groupBy) {
    throw new ParseError(
      'GROUP BY is not supported yet in a query with JOIN.',
      groupBy.span,
      'JOIN queries return plain rows for now — group the result in a later version.',
    );
  }
  checkGroupingValidity(select, groupBy);
  checkJoinValidity(select, joins, where, from);

  let having: Expr | undefined;
  if (isKeyword(c.peek(), 'HAVING')) {
    const havingToken = c.next();
    if (hasJoin) {
      throw new ParseError(
        'HAVING is not supported yet in a query with JOIN.',
        havingToken,
        'JOIN queries return plain rows for now — group and filter the result in a later version.',
      );
    }
    c.allowAggregates = true;
    try {
      having = parseExpr(c);
    } finally {
      c.allowAggregates = false;
    }
    checkHavingValidity(having, select, groupBy, havingToken);
  }

  let orderBy: SelectStatement['orderBy'];
  if (c.peek().type === 'keyword' && c.peek().upper === 'ORDER') {
    if (groupBy) {
      throw new ParseError(
        'ORDER BY with GROUP BY is not supported yet.',
        c.peek(),
        'GROUP BY on its own still works — sort the grouped results yourself for now.',
      );
    }
    if (hasJoin) {
      throw new ParseError(
        'ORDER BY is not supported yet in a query with JOIN.',
        c.peek(),
        'JOIN queries return plain rows for now — sort the result in a later version.',
      );
    }
    const orderToken = c.next();
    c.expectKeyword('BY', 'after ORDER');
    const col = c.expectIdentifier('a column name to sort by');
    // SELECT DISTINCT returns each row once, so a row has no single value of a column that is not in the list
    // to sort it by — PostgreSQL's rule, and the only one that keeps DISTINCT's answer well defined.
    if (distinct && select.kind === 'columns' && !select.items.some((item) => selectItemKey(item) === col.value)) {
      throw new ParseError(
        `For SELECT DISTINCT, ORDER BY \`${col.value}\` must appear in the select list.`,
        col,
        'Add it to the list, or drop DISTINCT: each distinct row stands for many source rows, so a column that is not selected has no one value to sort it by.',
      );
    }
    let direction: 'asc' | 'desc' = 'asc';
    let end = col.to;
    if (c.peek().type === 'keyword' && (c.peek().upper === 'ASC' || c.peek().upper === 'DESC')) {
      const dir = c.next();
      direction = dir.upper === 'ASC' ? 'asc' : 'desc';
      end = dir.to;
    }
    // Spans the whole clause including the keyword, like LIMIT — unlike
    // WHERE, whose span is its Expr's own and never includes "WHERE" itself.
    orderBy = { column: col.value, direction, span: { from: orderToken.from, to: end } };
  }

  const limitToken = c.peek().type === 'keyword' && c.peek().upper === 'LIMIT' ? c.next() : undefined;
  let limit: SelectStatement['limit'];
  if (limitToken) {
    const token = c.peek();
    if (token.type !== 'number' || token.value.includes('.')) {
      c.guardScope(token);
      throw new ParseError(`Expected a whole number after LIMIT, found ${describe(token)}.`, token);
    }
    c.next();
    limit = { value: Number(token.value), span: { from: limitToken.from, to: token.to } };

    // `OFFSET m` rides on a LIMIT (plan.md §25.4 B1c) — SQLite's rule; an OFFSET alone is rejected below.
    if (isKeyword(c.peek(), 'OFFSET')) {
      c.next();
      const skip = c.peek();
      if (skip.type !== 'number' || skip.value.includes('.')) {
        c.guardScope(skip);
        throw new ParseError(`Expected a whole number after OFFSET, found ${describe(skip)}.`, skip);
      }
      c.next();
      limit = { ...limit, offset: Number(skip.value), span: { from: limitToken.from, to: skip.to } };
    }
  }
  if (!limit && isKeyword(c.peek(), 'OFFSET')) {
    throw new ParseError(
      'OFFSET needs a LIMIT before it.',
      c.peek(),
      'Write `LIMIT n OFFSET m` — skip m rows, then return the next n.',
    );
  }

  expectStatementEnd(c);

  const end =
    limit?.span.to ??
    orderBy?.span.to ??
    having?.span.to ??
    groupBy?.span.to ??
    where?.span.to ??
    joins.at(-1)?.span.to ??
    from.span.to;
  return {
    kind: 'select',
    select,
    ...(distinct ? { distinct } : {}),
    from,
    ...(hasJoin ? { joins } : {}),
    ...(where === undefined ? {} : { where }),
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(having === undefined ? {} : { having }),
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(limit === undefined ? {} : { limit }),
    span: { from: selectToken.from, to: end },
  };
}

export type ParseOutcome = { ok: true; ast: SelectStatement } | { ok: false; error: QueryError };

/** The SELECT-only entry point — every existing caller's contract, unchanged. */
export function parse(sql: string): ParseOutcome {
  return runParse(sql, (c) => {
    if (c.atEnd()) throw new ParseError('Nothing to run — the query is empty.', c.peek());
    return parseSelectBody(c);
  });
}

/* -------------------------------------------------------------------------- */
/* DELETE                                                                      */
/* -------------------------------------------------------------------------- */

function parseDeleteBody(c: Cursor): DeleteStatement {
  const deleteToken = c.expectKeyword('DELETE', 'to begin a delete');
  c.expectKeyword('FROM', 'after DELETE');
  const from = parseTableRef(c);
  const where = parseOptionalWhere(c);
  expectStatementEnd(c);

  const end = where?.span.to ?? from.span.to;
  return {
    kind: 'delete',
    from,
    ...(where === undefined ? {} : { where }),
    span: { from: deleteToken.from, to: end },
  };
}

/* -------------------------------------------------------------------------- */
/* INSERT                                                                      */
/* -------------------------------------------------------------------------- */

function parseInsertBody(c: Cursor): InsertStatement {
  const insertToken = c.expectKeyword('INSERT', 'to begin an insert');
  c.expectKeyword('INTO', 'after INSERT');
  const into = parseTableRef(c);

  let columns: InsertStatement['columns'];
  if (c.peek().type === 'lparen') {
    const parsed = parseParenList(c, 'column list', (cc) => {
      const token = cc.expectIdentifier('a column name');
      return { name: token.value, span: { from: token.from, to: token.to } };
    });
    columns = { names: parsed.items, span: { from: parsed.from, to: parsed.to } };
  }

  c.expectKeyword('VALUES', columns ? 'after the column list' : 'after the table name');
  const parsedValues = parseParenList(c, 'value list', parseLiteralValue);
  const values = { items: parsedValues.items, span: { from: parsedValues.from, to: parsedValues.to } };

  if (columns && columns.names.length !== values.items.length) {
    throw new ParseError(
      `${columns.names.length} column${columns.names.length === 1 ? '' : 's'} but ${
        values.items.length
      } value${values.items.length === 1 ? '' : 's'} — INSERT needs exactly one value per column.`,
      values.span,
    );
  }

  expectStatementEnd(c);

  return {
    kind: 'insert',
    into,
    ...(columns === undefined ? {} : { columns }),
    values,
    span: { from: insertToken.from, to: values.span.to },
  };
}

/* -------------------------------------------------------------------------- */
/* UPDATE                                                                      */
/* -------------------------------------------------------------------------- */

function parseAssignment(c: Cursor): UpdateAssignment {
  const column = c.expectIdentifier('a column name');
  const eq = c.peek();
  if (eq.type !== 'operator' || eq.value !== '=') {
    c.guardScope(eq);
    throw new ParseError(`Expected \`=\` after the column name, found ${describe(eq)}.`, eq);
  }
  c.next();
  const value = parseExpr(c, true);
  return { column: column.value, columnSpan: { from: column.from, to: column.to }, value };
}

/** `SET assignment (',' assignment)*` — no parentheses, unlike INSERT's lists. */
function parseSetClause(c: Cursor): UpdateStatement['set'] {
  const first = parseAssignment(c);
  const assignments = [first];
  let last = first;
  while (c.peek().type === 'comma') {
    c.next();
    last = parseAssignment(c);
    assignments.push(last);
  }
  return { assignments, span: { from: first.columnSpan.from, to: last.value.span.to } };
}

function parseUpdateBody(c: Cursor): UpdateStatement {
  const updateToken = c.expectKeyword('UPDATE', 'to begin an update');
  const table = parseTableRef(c);
  c.expectKeyword('SET', 'after the table name');
  const set = parseSetClause(c);
  const where = parseOptionalWhere(c);
  expectStatementEnd(c);

  const end = where?.span.to ?? set.span.to;
  return {
    kind: 'update',
    table,
    set,
    ...(where === undefined ? {} : { where }),
    span: { from: updateToken.from, to: end },
  };
}

/* -------------------------------------------------------------------------- */
/* EXPLAIN                                                                     */
/* -------------------------------------------------------------------------- */

function parseExplainBody(c: Cursor): ExplainStatement {
  const explainToken = c.expectKeyword('EXPLAIN', 'to begin an explain');
  const analyze = isKeyword(c.peek(), 'ANALYZE') ? (c.next(), true) : false;

  const next = c.peek();
  if (next.type === 'eof' || next.type === 'semicolon') {
    throw new ParseError('Nothing to explain.', next.type === 'eof' ? explainToken : next, 'Follow EXPLAIN with a SELECT: `EXPLAIN SELECT * FROM users WHERE id = 5`.');
  }
  if (isKeyword(next, 'DELETE', 'INSERT', 'UPDATE')) {
    throw new ParseError(
      `EXPLAIN${analyze ? ' ANALYZE' : ''} of a ${next.upper} is not supported.`,
      next,
      analyze
        ? 'EXPLAIN ANALYZE runs what it explains, and running a write would perform it. EXPLAIN a SELECT.'
        : 'EXPLAIN takes a SELECT — a write is planned the same way, but not shown yet.',
    );
  }
  if (isKeyword(next, 'EXPLAIN')) {
    throw new ParseError('EXPLAIN cannot be nested.', next, 'One EXPLAIN, then the SELECT.');
  }

  const select = parseSelectBody(c);
  return { kind: 'explain', analyze, select, span: { from: explainToken.from, to: select.span.to } };
}

/* -------------------------------------------------------------------------- */
/* ANALYZE                                                                     */
/* -------------------------------------------------------------------------- */

function parseAnalyzeBody(c: Cursor): AnalyzeStatement {
  const analyzeToken = c.expectKeyword('ANALYZE', 'to begin an analyze');
  const table = parseTableRef(c);
  expectStatementEnd(c);
  return { kind: 'analyze', table, span: { from: analyzeToken.from, to: table.span.to } };
}

export type StatementOutcome = { ok: true; ast: Statement } | { ok: false; error: QueryError };

/**
 * The broader entry point: SELECT, DELETE, INSERT or UPDATE, dispatched on
 * the first keyword. `runQuery.ts` uses this one; every SELECT-only caller
 * keeps using `parse`.
 */
export function parseStatement(sql: string): StatementOutcome {
  return runParse(sql, (c) => {
    if (c.atEnd()) throw new ParseError('Nothing to run — the query is empty.', c.peek());
    const first = c.peek();
    if (first.type === 'keyword' && first.upper === 'EXPLAIN') return parseExplainBody(c);
    if (first.type === 'keyword' && first.upper === 'ANALYZE') return parseAnalyzeBody(c);
    if (first.type === 'keyword' && first.upper === 'DELETE') return parseDeleteBody(c);
    if (first.type === 'keyword' && first.upper === 'INSERT') return parseInsertBody(c);
    if (first.type === 'keyword' && first.upper === 'UPDATE') return parseUpdateBody(c);
    return parseSelectBody(c);
  });
}

/* -------------------------------------------------------------------------- */

function runParse<T>(sql: string, body: (c: Cursor) => T): { ok: true; ast: T } | { ok: false; error: QueryError } {
  try {
    const tokens = tokenize(sql);
    return { ok: true, ast: body(makeCursor(tokens)) };
  } catch (err) {
    if (err instanceof ParseError || err instanceof TokenizeError) {
      return {
        ok: false,
        error: {
          message: err.message,
          from: err.from,
          to: err.to,
          ...(err.hint === undefined ? {} : { hint: err.hint }),
        },
      };
    }
    throw err;
  }
}
