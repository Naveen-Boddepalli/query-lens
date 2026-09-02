/**
 * The engine entry point, and the whole of the engine's public surface.
 *
 *   pure · synchronous · no DOM · no React · fully serializable output
 *
 * Kept worker-ready on purpose (plan.md §5) but deliberately run on the main
 * thread in v0: step-back needs the full event history regardless, so once the
 * UI holds the whole array a worker boundary buys nothing.
 */

import { emitParseEvents, parse } from './parser/index.ts';
import { emitPlanEvents } from './planner/index.ts';
import { buildHeap, createBufferPool } from './storage/index.ts';
import { buildIndex, pageCountFor } from './index/index.ts';
import { execute } from './exec/index.ts';
import { createTracer } from './trace.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { Database, EngineOptions, RunResult } from './types.ts';

export function runQuery(
  sql: string,
  db: Database,
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): RunResult {
  const { emit, drain } = createTracer();

  const parsed = parse(sql);
  if (!parsed.ok) {
    return { events: drain(), rows: [], error: parsed.error };
  }

  const table = db.tables[parsed.ast.from.name];
  if (!table) {
    const known = Object.keys(db.tables);
    return {
      events: drain(),
      rows: [],
      error: {
        message: `There is no table called \`${parsed.ast.from.name}\`.`,
        hint: known.length === 1 ? `The only table is \`${known[0]}\`.` : `Tables: ${known.join(', ')}.`,
        from: parsed.ast.from.span.from,
        to: parsed.ast.from.span.to,
      },
    };
  }

  const unknownColumn = referencedColumns(parsed.ast).find(
    (c) => !table.columns.includes(c.name),
  );
  if (unknownColumn) {
    return {
      events: drain(),
      rows: [],
      error: {
        message: `\`${table.name}\` has no column called \`${unknownColumn.name}\`.`,
        hint: `Columns: ${table.columns.join(', ')}.`,
        from: unknownColumn.span.from,
        to: unknownColumn.span.to,
      },
    };
  }

  emitParseEvents(emit, parsed.ast);
  const plan = emitPlanEvents(emit, parsed.ast, table);

  // Building the heap and the index is setup, not execution — it emits nothing.
  // The trace describes running your query, not preparing the database.
  const heap = buildHeap(table, options.rowsPerPage);
  const tree = table.indexedColumn ? buildIndex(heap, table.indexedColumn) : null;
  const pool = createBufferPool(pageCountFor(heap, tree), options, emit);

  const rows = execute(plan, { emit, pool, heap, tree, table, options });

  return { events: drain(), rows };
}

function referencedColumns(ast: import('./parser/index.ts').SelectStatement) {
  const refs: { name: string; span: { from: number; to: number } }[] = [];
  if (ast.select.kind === 'columns') refs.push(...ast.select.names);
  if (ast.where) {
    const stack = [ast.where];
    while (stack.length > 0) {
      const e = stack.pop()!;
      if (e.kind === 'column') refs.push({ name: e.name, span: e.span });
      if (e.kind === 'compare' || e.kind === 'and') stack.push(e.left, e.right);
    }
  }
  return refs;
}
