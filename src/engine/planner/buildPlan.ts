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

import type { DeleteStatement, SelectStatement, UpdateStatement } from '../parser/index.ts';
import type { Plan, ProjectList } from './plan.ts';

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

export function buildPlan(ast: SelectStatement): Plan {
  const scan: Plan = { op: 'SeqScan', table: ast.from.name };

  const filtered: Plan = ast.where
    ? { op: 'Filter', predicate: ast.where, child: scan }
    : scan;

  const sorted: Plan = ast.orderBy
    ? { op: 'Sort', column: ast.orderBy.column, direction: ast.orderBy.direction, child: filtered }
    : filtered;

  const columns: ProjectList =
    ast.select.kind === 'star'
      ? { kind: 'star' }
      : { kind: 'columns', names: ast.select.names.map((c) => c.name) };

  const projected: Plan = { op: 'Project', columns, child: sorted };

  return ast.limit === undefined
    ? projected
    : { op: 'Limit', count: ast.limit.value, child: projected };
}
