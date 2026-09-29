/**
 * Resolves an `IN (subquery)` predicate (plan.md §25.4 C3 slice c, closing C3) exactly once, before the query
 * that names it is planned — the one place `runQuery.ts`'s SELECT, DELETE and UPDATE paths all share.
 *
 * `mapChildren` (`parser/ast.ts`) already rebuilds every other `Expr` kind from its children, but it does not
 * know how to turn a `subquery` into `items` — that needs a real sub-run of the engine, not a pure tree
 * transform — so this walks the same shape `mapChildren` would (`and`/`or`/`not`, the only kinds that can nest
 * another predicate) by hand, stopping to resolve any `in` node that carries a `subquery`.
 */

import type { Expr, InSubquery } from './parser/ast.ts';
import type { QueryError, Row, RunResult, SqlValue } from './types.ts';

/** Every distinct value `column` holds across `rows`, in first-seen order — `null` counted like any other value. */
function distinctColumnValues(rows: readonly Row[], column: string): SqlValue[] {
  const seen = new Set<string>();
  const values: SqlValue[] = [];
  for (const row of rows) {
    const value = row[column] ?? null;
    const key = value === null ? '\u0000null' : `${typeof value}:${String(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/** A resolved value, as the literal `Expr` an ordinary `IN (1, 2, 3)` would already have held. */
function literalFor(value: SqlValue, span: Expr['span']): Expr {
  return {
    kind: 'literal',
    value,
    raw: value === null ? 'NULL' : typeof value === 'string' ? `'${value}'` : String(value),
    span,
  };
}

/**
 * Runs one `IN`'s subquery for real — its own complete, independent sub-run of the engine (its own buffer pool,
 * its own disk reads), exactly the way `explain.ts`'s `explainResult` already runs an inner query: padding the
 * text with leading spaces rather than slicing them away keeps every character offset the sub-run reports (a
 * parse error's span, say) pointing at the right place in the *outer* query's own editor. Not interleaved into
 * the outer query's own step-by-step trace — the subquery's cost is real and already paid by the time this
 * returns, but it is reported as one resolved fact (`emit.ts`'s WHERE-clause narration names the count), not a
 * second parallel playback.
 */
function resolveOne(
  expr: Extract<Expr, { kind: 'in' }>,
  subquery: InSubquery,
  sql: string,
  run: (sql: string) => RunResult,
): { ok: true; expr: Expr } | { ok: false; error: QueryError } {
  const inner = run(' '.repeat(subquery.span.from) + sql.slice(subquery.span.from, subquery.span.to));
  if (inner.error) {
    return {
      ok: false,
      error: {
        message: `The IN subquery failed: ${inner.error.message}`,
        ...(inner.error.hint ? { hint: inner.error.hint } : {}),
        from: subquery.span.from,
        to: subquery.span.to,
      },
    };
  }
  const values = distinctColumnValues(inner.rows, subquery.column.name);
  const items = values.map((value) => literalFor(value, subquery.span));
  return { ok: true, expr: { ...expr, items } };
}

/** `resolveOne`, recursively, for every `IN (subquery)` anywhere in `expr` — under any nesting of `AND`/`OR`/`NOT`. */
function resolveInSubqueries(
  expr: Expr,
  sql: string,
  run: (sql: string) => RunResult,
): { ok: true; expr: Expr } | { ok: false; error: QueryError } {
  if (expr.kind === 'in' && expr.subquery) return resolveOne(expr, expr.subquery, sql, run);
  if (expr.kind === 'and' || expr.kind === 'or') {
    const left = resolveInSubqueries(expr.left, sql, run);
    if (!left.ok) return left;
    const right = resolveInSubqueries(expr.right, sql, run);
    if (!right.ok) return right;
    return { ok: true, expr: { ...expr, left: left.expr, right: right.expr } };
  }
  if (expr.kind === 'not') {
    const operand = resolveInSubqueries(expr.operand, sql, run);
    if (!operand.ok) return operand;
    return { ok: true, expr: { ...expr, operand: operand.expr } };
  }
  // Every other kind's own children are arithmetic/columns/literals — `parsePredicate`'s grammar never lets a
  // predicate (so never an `IN (subquery)`) nest inside one of those.
  return { ok: true, expr };
}

/** `where`, with every `IN (subquery)` it contains resolved — or the first error one of them hit. `undefined` in, `undefined` out. */
export function resolveWhereSubqueries(
  where: Expr | undefined,
  sql: string,
  run: (sql: string) => RunResult,
): { ok: true; where: Expr | undefined } | { ok: false; error: QueryError } {
  if (!where) return { ok: true, where };
  const resolved = resolveInSubqueries(where, sql, run);
  return resolved.ok ? { ok: true, where: resolved.expr } : resolved;
}
