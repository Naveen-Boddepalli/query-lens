import type { Row } from '../types.ts';
import { resultPrompt } from '../predict.ts';
import { rootEstimate } from '../planner/cost.ts';
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
  const otherTables = ctx.joinRight ? { [ctx.joinRight.table.name]: ctx.joinRight.table } : undefined;
  const estimate = rootEstimate(plan, ctx.table, ctx.options.rowsPerPage, otherTables);
  const reconcile =
    estimate.estRows === rows.length
      ? ` The cost model guessed ~${estimate.estRows} — on the nose (${estimate.basis}).`
      : ` The cost model guessed ~${estimate.estRows} (${estimate.basis}); the count is exact, the estimate is a heuristic.`;
  ctx.emit(
    `${rows.length} row${rows.length === 1 ? '' : 's'} returned, from ${misses} disk read${
      misses === 1 ? '' : 's'
    }, ${hits} buffer hit${hits === 1 ? '' : 's'} and ${evictions} eviction${
      evictions === 1 ? '' : 's'
    }.${reconcile}`,
    { stage: 'result', rows },
    (() => {
      const prompt = resultPrompt(rows.length, ctx.table.rows.length);
      return prompt ? { predictable: prompt } : undefined;
    })(),
  );

  return rows;
}
