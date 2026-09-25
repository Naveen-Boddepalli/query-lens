import type { Expr } from './ast.ts';

/**
 * How tightly a node binds, for parenthesising: OR < AND < NOT < a predicate <
 * `+ -` < `* / %` < unary minus < an atom. (plan.md §25.4 B1.)
 */
function precedence(expr: Expr): number {
  switch (expr.kind) {
    case 'or':
      return 1;
    case 'and':
      return 2;
    case 'not':
      return 3;
    case 'compare':
    case 'isNull':
    case 'in':
    case 'like':
      return 4;
    case 'arith':
      return expr.op === '+' || expr.op === '-' ? 5 : 6;
    case 'neg':
      return 7;
    case 'column':
    case 'literal':
      return 8;
  }
}

/**
 * SQL text for `expr`, parenthesised exactly where the tree's shape needs it,
 * so it re-parses to the same tree — and so it can serve as a result column's
 * name (`SELECT price * qty` is a column called `price * qty`).
 */
export function exprToSql(expr: Expr): string {
  const at = (child: Expr, min: number): string =>
    precedence(child) < min ? `(${exprToSql(child)})` : exprToSql(child);
  switch (expr.kind) {
    case 'column':
      return expr.table ? `${expr.table}.${expr.name}` : expr.name;
    case 'literal':
      return expr.raw;
    case 'compare':
      return `${at(expr.left, 5)} ${expr.op} ${at(expr.right, 5)}`;
    case 'and':
      return `${at(expr.left, 2)} AND ${at(expr.right, 3)}`;
    case 'or':
      return `${at(expr.left, 1)} OR ${at(expr.right, 2)}`;
    case 'not':
      return `NOT ${at(expr.operand, 3)}`;
    case 'isNull':
      return `${at(expr.operand, 5)} IS ${expr.negated ? 'NOT ' : ''}NULL`;
    case 'in':
      return `${at(expr.operand, 5)} ${expr.negated ? 'NOT ' : ''}IN (${expr.items.map((i) => at(i, 5)).join(', ')})`;
    case 'like':
      return `${at(expr.operand, 5)} ${expr.negated ? 'NOT ' : ''}LIKE ${at(expr.pattern, 5)}`;
    case 'arith': {
      // Left-associative: the right operand of a same-level operator needs parentheses (`a - (b - c)`).
      const p = precedence(expr);
      return `${at(expr.left, p)} ${expr.op} ${at(expr.right, p + 1)}`;
    }
    case 'neg': {
      // `- -x` would read as a comment, and `-(a + b)` needs its parentheses.
      const inner = expr.operand;
      const wrap = inner.kind === 'neg' || (inner.kind === 'literal' && inner.raw.startsWith('-'));
      return wrap ? `-(${exprToSql(inner)})` : `-${at(inner, 7)}`;
    }
  }
}
