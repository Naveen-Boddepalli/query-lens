/**
 * Resolves an `IN (subquery)` predicate (plan.md §25.4 C3 slice c, closing C3) exactly once, before the query
 * that names it is planned — the one place `runQuery.ts`'s SELECT, DELETE and UPDATE paths all share.
 *
 * `mapChildren` (`parser/ast.ts`) rebuilds every `Expr` kind from its children; this walks the tree with it and,
 * at any `in` node that carries a `subquery`, turns the subquery into `items` — which needs a real sub-run of the
 * engine, not a pure tree transform.
 */

import { mapChildren } from './parser/ast.ts';
import type { DeleteStatement, Expr, InSubquery, SelectItem, SelectStatement, UpdateStatement } from './parser/ast.ts';
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

/**
 * `resolveOne`, recursively, for every `IN (subquery)` anywhere in `expr` — through every child an `Expr` can have
 * (`mapChildren`), not only `AND`/`OR`/`NOT`. A predicate can sit in a value's place: `(x IN (SELECT …)) IS NULL`,
 * `(x IN (SELECT …)) = TRUE`, or an `IN` whose own operand is one. Walking only the boolean connectives left those
 * unresolved, and an unresolved `IN` reads as an empty list — the SQLite oracle found that (plan.md §25.4 A1).
 */
function resolveInSubqueries(
  expr: Expr,
  sql: string,
  run: (sql: string) => RunResult,
): { ok: true; expr: Expr } | { ok: false; error: QueryError } {
  let error: QueryError | undefined;
  const resolved = mapChildren(expr, (child) => {
    if (error) return child;
    const out = resolveInSubqueries(child, sql, run);
    if (!out.ok) {
      error = out.error;
      return child;
    }
    return out.expr;
  });
  if (error) return { ok: false, error };
  if (resolved.kind === 'in' && resolved.subquery) return resolveOne(resolved, resolved.subquery, sql, run);
  return { ok: true, expr: resolved };
}

type Resolved<T> = { ok: true; value: T } | { ok: false; error: QueryError };

/** `resolveInSubqueries` over a list, in order, stopping at the first error. */
function resolveEach<T>(
  items: readonly T[],
  f: (item: T) => { ok: true; expr: Expr } | { ok: false; error: QueryError } | null,
  rebuild: (item: T, expr: Expr) => T,
): Resolved<T[]> {
  const out: T[] = [];
  for (const item of items) {
    const r = f(item);
    if (r && !r.ok) return r;
    out.push(r ? rebuild(item, r.expr) : item);
  }
  return { ok: true, value: out };
}

type Statement = SelectStatement | DeleteStatement | UpdateStatement;

/**
 * `ast`, with every `IN (subquery)` it holds resolved — or the first error one of them hit. Everywhere the grammar
 * lets an expression appear: `WHERE` (all three statements), and for a `SELECT` its `HAVING` and its computed
 * columns, for an `UPDATE` each `SET` value. Each subquery runs exactly once, in source order.
 */
export function resolveStatementSubqueries<S extends Statement>(
  ast: S,
  sql: string,
  run: (sql: string) => RunResult,
): Resolved<S> {
  // `resolveStatement` rebuilds the statement it is given field for field, so its kind — and `S` — is unchanged.
  return resolveStatement(ast, sql, run) as Resolved<S>;
}

function resolveStatement(ast: Statement, sql: string, run: (sql: string) => RunResult): Resolved<Statement> {
  const resolve = (e: Expr) => resolveInSubqueries(e, sql, run);
  let where = ast.where;
  if (where) {
    const r = resolve(where);
    if (!r.ok) return r;
    where = r.expr;
  }
  const withWhere = where ? { where } : {};
  switch (ast.kind) {
    case 'delete':
      return { ok: true, value: { ...ast, ...withWhere } };
    case 'select': {
      let list = ast.select;
      if (list.kind === 'columns') {
        const items = resolveEach(
          list.items,
          (item) => (item.kind === 'expression' ? resolve(item.expr) : null),
          (item, expr): SelectItem => (item.kind === 'expression' ? { ...item, expr } : item),
        );
        if (!items.ok) return items;
        list = { ...list, items: items.value };
      }
      let having = ast.having;
      if (having) {
        const r = resolve(having);
        if (!r.ok) return r;
        having = r.expr;
      }
      return { ok: true, value: { ...ast, ...withWhere, select: list, ...(having ? { having } : {}) } };
    }
    case 'update': {
      const assignments = resolveEach(ast.set.assignments, (a) => resolve(a.value), (a, value) => ({ ...a, value }));
      if (!assignments.ok) return assignments;
      return { ok: true, value: { ...ast, ...withWhere, set: { ...ast.set, assignments: assignments.value } } };
    }
  }
}
