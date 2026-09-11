/**
 * Recursive-descent parser for the v0 SQL subset (plan.md §4):
 *
 *   statement  := select [';'] EOF
 *   select     := SELECT selectList FROM identifier [WHERE expr] [LIMIT number]
 *   selectList := '*' | identifier (',' identifier)*
 *   expr       := comparison (AND comparison)*
 *   comparison := operand ('=' | '<' | '>') operand
 *   operand    := identifier | number | string | NULL | TRUE | FALSE
 *
 * Hand-written rather than generated: the error messages are half the teaching
 * value, and they need to name the v0 scope explicitly.
 */

import type { QueryError } from '../types.ts';
import type { CompareOp, Expr, SelectList, SelectStatement, Span, TableRef } from './ast.ts';
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
  ORDER: 'ORDER BY is not in the v0 subset.',
  HAVING: 'HAVING is not in the v0 subset.',
  OFFSET: 'OFFSET is not in the v0 subset — LIMIT on its own is.',
  DISTINCT: 'DISTINCT is not in the v0 subset.',
  UNION: 'UNION is not in the v0 subset.',
  OR: 'v0 supports AND only. Combine predicates with AND.',
  NOT: 'v0 supports =, < and > only, combined with AND.',
  INSERT: 'QueryLens only runs SELECT — it visualises reads, not writes.',
  UPDATE: 'QueryLens only runs SELECT — it visualises reads, not writes.',
  DELETE: 'QueryLens only runs SELECT — it visualises reads, not writes.',
  CREATE: 'QueryLens only runs SELECT. Edit the seed data to change the table.',
  DROP: 'QueryLens only runs SELECT. Edit the seed data to change the table.',
};

const describe = (t: Token): string =>
  t.type === 'eof' ? 'the end of the query' : `\`${t.value}\``;

export type ParseOutcome =
  | { ok: true; ast: SelectStatement }
  | { ok: false; error: QueryError };

export function parse(sql: string): ParseOutcome {
  try {
    return { ok: true, ast: parseOrThrow(sql) };
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

function parseOrThrow(sql: string): SelectStatement {
  const tokens = tokenize(sql);
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

  function parseSelectList(): SelectList {
    const first = peek();

    if (first.type === 'star') {
      next();
      return { kind: 'star', span: { from: first.from, to: first.to } };
    }

    const names: { name: string; span: Span }[] = [];
    for (;;) {
      const token = expectIdentifier('a column name or `*`');
      names.push({ name: token.value, span: { from: token.from, to: token.to } });
      if (peek().type !== 'comma') break;
      next();
    }
    const last = names[names.length - 1]!;
    return { kind: 'columns', names, span: { from: first.from, to: last.span.to } };
  }

  function parseTableRef(): TableRef {
    const token = expectIdentifier('a table name');
    return { name: token.value, span: { from: token.from, to: token.to } };
  }

  function parseOperand(): Expr {
    const token = peek();

    if (token.type === 'identifier') {
      next();
      return { kind: 'column', name: token.value, span: { from: token.from, to: token.to } };
    }
    if (token.type === 'number') {
      next();
      return {
        kind: 'literal',
        value: Number(token.value),
        raw: token.value,
        span: { from: token.from, to: token.to },
      };
    }
    if (token.type === 'string') {
      next();
      return {
        kind: 'literal',
        value: token.value,
        raw: `'${token.value}'`,
        span: { from: token.from, to: token.to },
      };
    }
    if (token.type === 'keyword' && ['NULL', 'TRUE', 'FALSE'].includes(token.upper)) {
      next();
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

    guardScope(token);
    throw new ParseError(
      `Expected a column name or a value, found ${describe(token)}.`,
      token,
    );
  }

  function parseComparison(): Expr {
    const left = parseOperand();
    const opToken = peek();

    if (opToken.type !== 'operator') {
      guardScope(opToken);
      throw new ParseError(
        `Expected \`=\`, \`<\` or \`>\`, found ${describe(opToken)}.`,
        opToken,
      );
    }
    if (!['=', '<', '>'].includes(opToken.value)) {
      throw new ParseError(
        `\`${opToken.value}\` is not supported yet.`,
        opToken,
        'v0 supports `=`, `<` and `>`.',
      );
    }
    next();

    const right = parseOperand();
    return {
      kind: 'compare',
      op: opToken.value as CompareOp,
      left,
      right,
      span: { from: left.span.from, to: right.span.to },
    };
  }

  function parseExpr(): Expr {
    let left = parseComparison();
    while (peek().type === 'keyword' && peek().upper === 'AND') {
      next();
      const right = parseComparison();
      left = {
        kind: 'and',
        left,
        right,
        span: { from: left.span.from, to: right.span.to },
      };
    }
    return left;
  }

  // --- statement ---------------------------------------------------------

  if (atEnd()) {
    throw new ParseError('Nothing to run — the query is empty.', peek());
  }

  const selectToken = expectKeyword('SELECT', 'to begin the query');
  const select = parseSelectList();
  expectKeyword('FROM', 'after the column list');
  const from = parseTableRef();

  let where: Expr | undefined;
  if (peek().type === 'keyword' && peek().upper === 'WHERE') {
    next();
    where = parseExpr();
  }

  const limitToken = peek().type === 'keyword' && peek().upper === 'LIMIT' ? next() : undefined;
  let limit: SelectStatement['limit'];
  if (limitToken) {
    const token = peek();
    if (token.type !== 'number' || token.value.includes('.')) {
      guardScope(token);
      throw new ParseError(
        `Expected a whole number after LIMIT, found ${describe(token)}.`,
        token,
      );
    }
    next();
    limit = { value: Number(token.value), span: { from: limitToken.from, to: token.to } };
  }

  if (peek().type === 'semicolon') next();

  if (!atEnd()) {
    const token = peek();
    guardScope(token);
    throw new ParseError(`Unexpected ${describe(token)} after the end of the query.`, token);
  }

  const end = limit?.span.to ?? where?.span.to ?? from.span.to;
  return {
    kind: 'select',
    select,
    from,
    ...(where === undefined ? {} : { where }),
    ...(limit === undefined ? {} : { limit }),
    span: { from: selectToken.from, to: end },
  };
}
