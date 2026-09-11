/**
 * Recursive-descent parser for the v0 SQL subset (plan.md §4):
 *
 *   statement  := select | delete
 *   select     := SELECT selectList FROM identifier [WHERE expr]
 *                 [ORDER BY identifier [ASC|DESC]] [LIMIT number] [';'] EOF
 *   delete     := DELETE FROM identifier [WHERE expr] [';'] EOF
 *   selectList := '*' | identifier (',' identifier)*
 *   expr       := comparison (AND comparison)*
 *   comparison := operand ('=' | '<' | '>') operand
 *   operand    := identifier | number | string | NULL | TRUE | FALSE
 *
 * Hand-written rather than generated: the error messages are half the teaching
 * value, and they need to name the v0 scope explicitly.
 *
 * `parse` stays the SELECT-only entry point every existing caller (the
 * Playground, the standalone tools, the CLI) already expects. `parseStatement`
 * is the broader one `runQuery.ts` needs now that `DELETE` is real — the two
 * share every helper below; nothing about SELECT parsing changed.
 */

import type { QueryError } from '../types.ts';
import type {
  CompareOp,
  DeleteStatement,
  Expr,
  SelectList,
  SelectStatement,
  Span,
  Statement,
  TableRef,
} from './ast.ts';
import { TokenizeError, tokenize } from './tokenizer.ts';
import type { Token } from './tokenizer.ts';

class ParseError extends Error {
  from: number;
  to: number;
  hint?: string;

  constructor(message: string, token: Token, hint?: string) {
    super(message);
    this.name = 'ParseError';
    this.from = token.from;
    this.to = Math.max(token.to, token.from + 1);
    if (hint !== undefined) this.hint = hint;
  }
}

/** Keywords that tokenise cleanly but land outside the v0 subset. */
const OUT_OF_SCOPE: Record<string, string> = {
  JOIN: 'Joins arrive in v1 — v0 reads a single table.',
  INNER: 'Joins arrive in v1 — v0 reads a single table.',
  LEFT: 'Joins arrive in v1 — v0 reads a single table.',
  RIGHT: 'Joins arrive in v1 — v0 reads a single table.',
  FULL: 'Joins arrive in v1 — v0 reads a single table.',
  CROSS: 'Joins arrive in v1 — v0 reads a single table.',
  GROUP: 'GROUP BY is not in the v0 subset.',
  HAVING: 'HAVING is not in the v0 subset.',
  OFFSET: 'OFFSET is not in the v0 subset — LIMIT on its own is.',
  DISTINCT: 'DISTINCT is not in the v0 subset.',
  UNION: 'UNION is not in the v0 subset.',
  OR: 'v0 supports AND only. Combine predicates with AND.',
  NOT: 'v0 supports =, < and > only, combined with AND.',
  INSERT: 'INSERT is not in the v0 write path yet — DELETE is.',
  UPDATE: 'UPDATE is not in the v0 write path yet — DELETE is.',
  CREATE: 'QueryLens only runs SELECT and DELETE. Edit the seed data to change the table.',
  DROP: 'QueryLens only runs SELECT and DELETE. Edit the seed data to change the table.',
};

const describe = (t: Token): string =>
  t.type === 'eof' ? 'the end of the query' : `\`${t.value}\``;

/* -------------------------------------------------------------------------- */
/* Shared cursor + grammar pieces — every statement form parses through these */
/* -------------------------------------------------------------------------- */

interface Cursor {
  peek: () => Token;
  next: () => Token;
  atEnd: () => boolean;
  guardScope: (token: Token) => void;
  expectKeyword: (word: string, what: string) => Token;
  expectIdentifier: (what: string) => Token;
}

function makeCursor(tokens: Token[]): Cursor {
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const atEnd = (): boolean => peek().type === 'eof';

  function guardScope(token: Token): void {
    if (token.type === 'dot') {
      throw new ParseError(
        'Qualified names like `a.id` are not supported yet.',
        token,
        'They arrive with joins in v1 — v0 reads a single table, so plain column names are enough.',
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

  return { peek, next, atEnd, guardScope, expectKeyword, expectIdentifier };
}

function parseSelectList(c: Cursor): SelectList {
  const first = c.peek();

  if (first.type === 'star') {
    c.next();
    return { kind: 'star', span: { from: first.from, to: first.to } };
  }

  const names: { name: string; span: Span }[] = [];
  for (;;) {
    const token = c.expectIdentifier('a column name or `*`');
    names.push({ name: token.value, span: { from: token.from, to: token.to } });
    if (c.peek().type !== 'comma') break;
    c.next();
  }
  const last = names[names.length - 1]!;
  return { kind: 'columns', names, span: { from: first.from, to: last.span.to } };
}

function parseTableRef(c: Cursor): TableRef {
  const token = c.expectIdentifier('a table name');
  return { name: token.value, span: { from: token.from, to: token.to } };
}

function parseOperand(c: Cursor): Expr {
  const token = c.peek();

  if (token.type === 'identifier') {
    c.next();
    return { kind: 'column', name: token.value, span: { from: token.from, to: token.to } };
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
    throw new ParseError(
      'Parenthesised expressions are not supported yet.',
      token,
      'v0 predicates are a flat chain of comparisons joined by AND.',
    );
  }

  c.guardScope(token);
  throw new ParseError(`Expected a column name or a value, found ${describe(token)}.`, token);
}

function parseComparison(c: Cursor): Expr {
  const left = parseOperand(c);
  const opToken = c.peek();

  if (opToken.type !== 'operator') {
    c.guardScope(opToken);
    throw new ParseError(`Expected \`=\`, \`<\` or \`>\`, found ${describe(opToken)}.`, opToken);
  }
  if (!['=', '<', '>'].includes(opToken.value)) {
    throw new ParseError(`\`${opToken.value}\` is not supported yet.`, opToken, 'v0 supports `=`, `<` and `>`.');
  }
  c.next();

  const right = parseOperand(c);
  return {
    kind: 'compare',
    op: opToken.value as CompareOp,
    left,
    right,
    span: { from: left.span.from, to: right.span.to },
  };
}

function parseExpr(c: Cursor): Expr {
  let left = parseComparison(c);
  while (c.peek().type === 'keyword' && c.peek().upper === 'AND') {
    c.next();
    const right = parseComparison(c);
    left = { kind: 'and', left, right, span: { from: left.span.from, to: right.span.to } };
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
  const select = parseSelectList(c);
  c.expectKeyword('FROM', 'after the column list');
  const from = parseTableRef(c);
  const where = parseOptionalWhere(c);

  let orderBy: SelectStatement['orderBy'];
  if (c.peek().type === 'keyword' && c.peek().upper === 'ORDER') {
    const orderToken = c.next();
    c.expectKeyword('BY', 'after ORDER');
    const col = c.expectIdentifier('a column name to sort by');
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
  }

  expectStatementEnd(c);

  const end = limit?.span.to ?? orderBy?.span.to ?? where?.span.to ?? from.span.to;
  return {
    kind: 'select',
    select,
    from,
    ...(where === undefined ? {} : { where }),
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

export type StatementOutcome = { ok: true; ast: Statement } | { ok: false; error: QueryError };

/**
 * The broader entry point: SELECT or DELETE, dispatched on the first keyword.
 * `runQuery.ts` uses this one; every SELECT-only caller keeps using `parse`.
 */
export function parseStatement(sql: string): StatementOutcome {
  return runParse(sql, (c) => {
    if (c.atEnd()) throw new ParseError('Nothing to run — the query is empty.', c.peek());
    const first = c.peek();
    if (first.type === 'keyword' && first.upper === 'DELETE') return parseDeleteBody(c);
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
