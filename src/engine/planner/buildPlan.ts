/**
 * AST → canonical logical plan, built bottom-up:
 *
 *   Limit n                          -- only when there is a LIMIT
 *     └─ Project [columns]
 *          └─ Sort column [ASC|DESC] -- only when there is an ORDER BY
 *               └─ Filter (predicate)     -- only when there is a WHERE
 *                    └─ SeqScan table
 *
 * This is the *unoptimised* shape on purpose. It is a direct, obvious
 * translation of the query text, which is what makes the optimizer's rewrite
 * legible when the two are shown side by side.
 */

import type { DeleteStatement, SelectItem, SelectStatement, UpdateStatement } from '../parser/index.ts';
import { selectItemArgColumn, selectItemKey } from '../parser/index.ts';
import type { AggregateSpec, Plan, ProjectList } from './plan.ts';

/**
 * A `DELETE`'s canonical plan is just the scan that finds the rows to
 * remove — `Filter → SeqScan`, or a bare `SeqScan` with no `WHERE`. No
 * `Project`: a delete produces no columns for a client to read.
 */
export function buildDeletePlan(ast: DeleteStatement): Plan {
  const scan: Plan = { op: 'SeqScan', table: ast.from.name };
  return ast.where ? { op: 'Filter', predicate: ast.where, child: scan } : scan;
}

/**
 * An `UPDATE`'s canonical plan is the same shape as a `DELETE`'s — the scan
 * that finds the rows to modify. The SET clause plays no part in planning:
 * it only takes effect once execution has already found a row.
 */
export function buildUpdatePlan(ast: UpdateStatement): Plan {
  const scan: Plan = { op: 'SeqScan', table: ast.table.name };
  return ast.where ? { op: 'Filter', predicate: ast.where, child: scan } : scan;
}

/** Whether this SELECT needs a `HashAggregate`: it has `GROUP BY`, or any aggregate call in its list. */
export function isAggregateQuery(ast: SelectStatement): boolean {
  return (
    ast.groupBy !== undefined ||
    (ast.select.kind === 'columns' && ast.select.items.some((item) => item.kind === 'aggregate'))
  );
}

/**
 * Builds the `HashAggregate` node for a `SELECT` that groups or aggregates.
 * Shared with `emit.ts`'s progressive plan-tree narration, so the two never
 * drift on how a `SelectItem` becomes an `AggregateSpec`.
 */
export function buildAggregatePlan(ast: SelectStatement, child: Plan): Plan {
  const groupBy = ast.groupBy?.columns.map((c) => c.name) ?? [];
  const aggregates: AggregateSpec[] =
    ast.select.kind === 'columns'
      ? ast.select.items
          .filter((item): item is Extract<SelectItem, { kind: 'aggregate' }> => item.kind === 'aggregate')
          .map((item) => ({ key: selectItemKey(item), fn: item.fn, column: selectItemArgColumn(item) }))
      : [];
  return { op: 'HashAggregate', groupBy, aggregates, child };
}

export function buildPlan(ast: SelectStatement): Plan {
  const scan: Plan = { op: 'SeqScan', table: ast.from.name };

  const filtered: Plan = ast.where
    ? { op: 'Filter', predicate: ast.where, child: scan }
    : scan;

  const aggregated: Plan = isAggregateQuery(ast) ? buildAggregatePlan(ast, filtered) : filtered;

  // ORDER BY and GROUP BY are mutually exclusive (the parser enforces this),
  // so Sort only ever sits above the filtered scan, never above an aggregate.
  const sorted: Plan = ast.orderBy
    ? { op: 'Sort', column: ast.orderBy.column, direction: ast.orderBy.direction, child: aggregated }
    : aggregated;

  const columns: ProjectList =
    ast.select.kind === 'star'
      ? { kind: 'star' }
      : { kind: 'columns', names: ast.select.items.map(selectItemKey) };

  const projected: Plan = { op: 'Project', columns, child: sorted };

  return ast.limit === undefined
    ? projected
    : { op: 'Limit', count: ast.limit.value, child: projected };
}
