/**
 * AST → canonical logical plan, built bottom-up:
 *
 *   Limit n                          -- only when there is a LIMIT
 *     └─ Project [columns]
 *          └─ Filter (predicate)     -- only when there is a WHERE
 *               └─ SeqScan table
 *
 * This is the *unoptimised* shape on purpose. It is a direct, obvious
 * translation of the query text, which is what makes the optimizer's rewrite
 * legible when the two are shown side by side.
 */

import type { SelectStatement } from '../parser/index.ts';
import type { Plan, ProjectList } from './plan.ts';

export function buildPlan(ast: SelectStatement): Plan {
  const scan: Plan = { op: 'SeqScan', table: ast.from.name };

  const filtered: Plan = ast.where
    ? { op: 'Filter', predicate: ast.where, child: scan }
    : scan;

  const columns: ProjectList =
    ast.select.kind === 'star'
      ? { kind: 'star' }
      : { kind: 'columns', names: ast.select.names.map((c) => c.name) };

  const projected: Plan = { op: 'Project', columns, child: filtered };

  return ast.limit === undefined
    ? projected
    : { op: 'Limit', count: ast.limit.value, child: projected };
}
