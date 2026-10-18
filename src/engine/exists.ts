/**
 * `[NOT] EXISTS (subquery)` (plan.md §27.5 S1), made ready to plan — the step `runQuery.ts`'s SELECT path takes right
 * after `IN (subquery)` is resolved, and before `emitPlanEvents` builds anything.
 *
 * The parser has already checked the shape: each `EXISTS` is a part of `WHERE` joined by `AND` (or one under `NOT`),
 * its table is not one the outer query has, and every column in its `WHERE` names its table. What is left is the
 * question every engine's planner asks of a subquery — *is it correlated?*
 *
 * - **Uncorrelated** (nothing in it names an outer table): its answer is the same for every outer row, so it runs
 *   exactly once, as its own sub-run of the engine — `SELECT * FROM t WHERE … LIMIT 1`, since one row settles it —
 *   and the node keeps what it found in `resolved`. PostgreSQL calls this an InitPlan.
 * - **Correlated** through an equality between one of its own columns and an outer one: it becomes a semi-join
 *   (`EXISTS`) or an anti-join (`NOT EXISTS`) — a `SemiJoinClause` that `buildPlan.ts` puts at the end of the join
 *   chain — and leaves `WHERE`. Running it "again for every outer row" is then just one of the join's algorithms
 *   (nested-loop); the others are the unnested forms a cost-based optimizer chooses between.
 * - **Correlated only through something else** (`posts.likes > authors.karma`, with no equality): refused, with the
 *   reason — v3 runs a correlated subquery as a join on one equality.
 */

import { conjoin, conjuncts } from './planner/plan.ts';
import { mapChildren, walkExpr } from './parser/ast.ts';
import type { Expr, SelectStatement, SemiJoinClause } from './parser/ast.ts';
import { exprToSql } from './parser/print.ts';
import type { QueryError, RunResult } from './types.ts';

type Resolved<T> = { ok: true; value: T } | { ok: false; error: QueryError };

/** The `EXISTS` a part of `WHERE` is, and whether a `NOT` is around it; `null` for any other part. */
export function existsPart(part: Expr): { node: Extract<Expr, { kind: 'exists' }>; negated: boolean } | null {
  if (part.kind === 'exists') return { node: part, negated: false };
  if (part.kind === 'not' && part.operand.kind === 'exists') return { node: part.operand, negated: true };
  return null;
}

/** Every `EXISTS` in `where`, in source order — for the table and column checks `runQuery.ts` makes before planning. */
export function existsNodesIn(where: Expr | undefined): Extract<Expr, { kind: 'exists' }>[] {
  const found: Extract<Expr, { kind: 'exists' }>[] = [];
  if (where) walkExpr(where, (e) => { if (e.kind === 'exists') found.push(e); });
  return found;
}

/** The tables an expression's (always qualified, inside a subquery) columns name. */
function tablesNamedBy(expr: Expr): Set<string> {
  const tables = new Set<string>();
  walkExpr(expr, (e) => {
    if (e.kind === 'column' && e.table !== undefined) tables.add(e.table);
  });
  return tables;
}

/** `expr` with every column's table name dropped — how a scan of one table reads its own unqualified rows. */
function unqualified(expr: Expr): Expr {
  if (expr.kind === 'column') {
    const { table: _table, ...rest } = expr;
    return rest;
  }
  return mapChildren(expr, unqualified);
}

/** `inner.col = outer.col`, in either order — the equality a correlated subquery can be joined on. */
function correlationKey(part: Expr, inner: string): { innerColumn: string; outerTable: string; outerColumn: string } | null {
  if (part.kind !== 'compare' || part.op !== '=' || part.left.kind !== 'column' || part.right.kind !== 'column') return null;
  const { left, right } = part;
  if (left.table === inner && right.table !== undefined && right.table !== inner) {
    return { innerColumn: left.name, outerTable: right.table, outerColumn: right.name };
  }
  if (right.table === inner && left.table !== undefined && left.table !== inner) {
    return { innerColumn: right.name, outerTable: left.table, outerColumn: left.name };
  }
  return null;
}

/**
 * `ast` with every `[NOT] EXISTS` in its `WHERE` resolved: each correlated one moved out of `WHERE` into
 * `semiJoins`, each uncorrelated one run once and marked with its answer — or the first error one of them hit.
 * `run` runs SQL on the same database and options (`runQuery` itself, from `runQuery.ts`). A query with no `EXISTS`
 * comes back exactly as it went in.
 */
export function resolveExists(ast: SelectStatement, run: (sql: string) => RunResult): Resolved<SelectStatement> {
  if (!ast.where || existsNodesIn(ast.where).length === 0) return { ok: true, value: ast };

  const kept: Expr[] = [];
  const semiJoins: SemiJoinClause[] = [];
  for (const part of conjuncts(ast.where)) {
    const found = existsPart(part);
    if (!found) {
      kept.push(part);
      continue;
    }
    const { node, negated } = found;
    const inner = node.subquery.from.name;
    const subParts = node.subquery.where ? conjuncts(node.subquery.where) : [];
    const correlated = subParts.some((p) => [...tablesNamedBy(p)].some((t) => t !== inner));

    if (!correlated) {
      const where = node.subquery.where ? ` WHERE ${exprToSql(unqualified(node.subquery.where))}` : '';
      const result = run(`SELECT * FROM ${inner}${where} LIMIT 1`);
      if (result.error) {
        return {
          ok: false,
          error: { message: `The EXISTS subquery failed: ${result.error.message}`, from: node.span.from, to: node.span.to },
        };
      }
      const resolved: Expr = { ...node, resolved: result.rows.length > 0 };
      kept.push(negated ? { kind: 'not', operand: resolved, span: part.span } : resolved);
      continue;
    }

    const keyAt = subParts.findIndex((p) => correlationKey(p, inner) !== null);
    if (keyAt < 0) {
      const outer = [...new Set(subParts.flatMap((p) => [...tablesNamedBy(p)].filter((t) => t !== inner)))];
      return {
        ok: false,
        error: {
          message: `This EXISTS subquery refers to ${outer.map((t) => `\`${t}\``).join(' and ')} without an equality QueryLens can join on.`,
          hint: `A correlated subquery runs here as a semi-join on one equality between a column of \`${inner}\` and a column of the outer query — add one, such as \`${inner}.column = ${outer[0] ?? 'outer'}.column\`.`,
          from: node.span.from,
          to: node.span.to,
        },
      };
    }
    const key = correlationKey(subParts[keyAt]!, inner)!;
    const own: Expr[] = [];
    const both: Expr[] = [];
    subParts.forEach((p, i) => {
      if (i === keyAt) return;
      const tables = tablesNamedBy(p);
      if ([...tables].every((t) => t === inner)) own.push(p);
      else both.push(p);
    });
    const innerFilter = conjoin(own);
    const residual = conjoin(both);
    semiJoins.push({
      kind: negated ? 'anti' : 'semi',
      table: node.subquery.from,
      outerTable: key.outerTable,
      outerColumn: key.outerColumn,
      innerColumn: key.innerColumn,
      ...(innerFilter ? { innerFilter: unqualified(innerFilter) } : {}),
      ...(residual ? { residual } : {}),
      source: part,
    });
  }

  const where = conjoin(kept);
  const { where: _where, ...rest } = ast;
  return {
    ok: true,
    value: { ...rest, ...(where ? { where } : {}), ...(semiJoins.length > 0 ? { semiJoins: [...(ast.semiJoins ?? []), ...semiJoins] } : {}) },
  };
}
