import type { Row } from '../types.ts';
import { buildOperator } from './operators.ts';
import type { ExecContext } from './operators.ts';
import type { Plan } from '../planner/index.ts';

/** Pulls the operator tree to exhaustion and emits the result. */
export function execute(plan: Plan, ctx: ExecContext): Row[] {
  const root = buildOperator(plan, ctx);
  const rows: Row[] = [];

  root.open();
  for (;;) {
    const row = root.next();
    if (!row) break;
    rows.push(row);
  }
  root.close();

  const { hits, misses, evictions } = ctx.pool.stats;
  ctx.emit(
    `${rows.length} row${rows.length === 1 ? '' : 's'} returned, from ${misses} disk read${
      misses === 1 ? '' : 's'
    }, ${hits} buffer hit${hits === 1 ? '' : 's'} and ${evictions} eviction${
      evictions === 1 ? '' : 's'
    }.`,
    { stage: 'result', rows },
  );

  return rows;
}
