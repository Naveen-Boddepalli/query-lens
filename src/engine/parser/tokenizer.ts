/**
 * Hand-written tokenizer. Every token carries its character span so the parser
 * can point CodeMirror at the exact text that went wrong.
 */

export type TokenType =
  | 'keyword'
  | 'identifier'
  | 'number'
  | 'string'
  | 'operator'
  | 'star'
  | 'comma'
  | 'lparen'
  | 'rparen'
  | 'semicolon'
  | 'dot'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Raw source text. */
  value: string;
  /** Uppercased value — keywords are case-insensitive. */
  upper: string;
  from: number;
  to: number;
}

/**
 * Includes keywords v0 does NOT support. Recognising them is what lets the
 * parser say "GROUP BY is not supported yet" instead of "unexpected identifier".
 */
export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'AS', 'NULL', 'TRUE', 'FALSE', 'BETWEEN',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ON', 'USING',
  'GROUP', 'ORDER', 'BY', 'ASC', 'DESC', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION',
  'INSERT', 'UPDATE', 'DELETE', 'INTO', 'VALUES', 'SET', 'CREATE', 'DROP',
]);

export class TokenizeError extends Error {
  from: number;
  to: number;
  hint?: string;

  constructor(message: string, from: number, to: number, hint?: string) {
    super(message);
    this.name = 'TokenizeError';
    this.from = from;
    this.to = to;
    if (hint !== undefined) this.hint = hint;
  }
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

const SINGLE: Record<string, TokenType> = {
  '*': 'star',
  // Tokenised, not supported: it lets the parser explain qualified names
  // rather than failing at the character level before it sees the real problem.
  '.': 'dot',
  ',': 'comma',
  '(': 'lparen',
  ')': 'rparen',
  ';': 'semicolon',
  '=': 'operator',
  '<': 'operator',
  '>': 'operator',
};

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const c = sql[i]!;

    if (isSpace(c)) {
      i++;
      continue;
    }

    // -- line comment
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i >= sql.length) {
        throw new TokenizeError('Unterminated block comment.', start, sql.length);
      }
      i += 2;
      continue;
    }

    const start = i;

    if (isIdentStart(c)) {
      while (i < sql.length && isIdentPart(sql[i]!)) i++;
      const value = sql.slice(start, i);
      const upper = value.toUpperCase();
      tokens.push({
        type: KEYWORDS.has(upper) ? 'keyword' : 'identifier',
        value,
        upper,
        from: start,
        to: i,
      });
      continue;
    }

    if (isDigit(c)) {
      while (i < sql.length && isDigit(sql[i]!)) i++;
      if (sql[i] === '.') {
        i++;
        while (i < sql.length && isDigit(sql[i]!)) i++;
      }
      const value = sql.slice(start, i);
      tokens.push({ type: 'number', value, upper: value, from: start, to: i });
      continue;
    }

    if (c === "'") {
      i++;
      let text = '';
      for (;;) {
        if (i >= sql.length) {
          throw new TokenizeError(
            'Unterminated string literal.',
            start,
            sql.length,
            "Add a closing ' quote.",
          );
        }
        if (sql[i] === "'") {
          // '' is an escaped quote inside a string.
          if (sql[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += sql[i];
        i++;
      }
      tokens.push({ type: 'string', value: text, upper: text, from: start, to: i });
      continue;
    }

    // Two-character operators are tokenised so the parser can reject them with
    // a message about v0 scope rather than a confusing character-level error.
    const two = sql.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      i += 2;
      tokens.push({ type: 'operator', value: two, upper: two, from: start, to: i });
      continue;
    }

    const single = SINGLE[c];
    if (single) {
      i++;
      tokens.push({ type: single, value: c, upper: c, from: start, to: i });
      continue;
    }

    throw new TokenizeError(`Unexpected character ${JSON.stringify(c)}.`, start, start + 1);
  }

  tokens.push({ type: 'eof', value: '', upper: '', from: sql.length, to: sql.length });
  return tokens;
}
