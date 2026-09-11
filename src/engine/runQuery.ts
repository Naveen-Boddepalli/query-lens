/**
 * The engine entry point, and the whole of the engine's public surface.
 *
 *   pure · synchronous · no DOM · no React · fully serializable output
 *
 * Kept worker-ready on purpose (plan.md §5) but deliberately run on the main
 * thread in v0: step-back needs the full event history regardless, so once the
 * UI holds the whole array a worker boundary buys nothing.
 */

import {
  emitDeleteParseEvents,
  emitInsertParseEvents,
  emitParseEvents,
  emitUpdateParseEvents,
  parseStatement,
} from './parser/index.ts';
import type { InsertStatement, Statement } from './parser/index.ts';
import {
  emitDeletePlanEvents,
  emitPlanEvents,
  emitUpdatePlanEvents,
  findSort,
} from './planner/index.ts';
import { buildHeap, createBufferPool } from './storage/index.ts';
import { buildIndex, pageCountFor } from './index/index.ts';
import { execute } from './exec/index.ts';
import { executeDelete } from './exec/delete.ts';
import { executeInsert } from './exec/insert.ts';
import { executeUpdate } from './exec/update.ts';
import { sortTempPageCount } from './exec/sort.ts';
import { createLockManager } from './locks/index.ts';
import { createTracer } from './trace.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { Database, EngineOptions, Row, RunResult, Table } from './types.ts';

export function runQuery(
  sql: string,
  db: Database,
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): RunResult {
  const { emit, drain } = createTracer();

  const parsed = parseStatement(sql);
  if (!parsed.ok) {
    return { events: drain(), rows: [], error: parsed.error };
  }
  const ast = parsed.ast;
  const tableRef = ast.kind === 'insert' ? ast.into : ast.kind === 'update' ? ast.table : ast.from;

  const table = db.tables[tableRef.name];
  if (!table) {
    const known = Object.keys(db.tables);
    return {
      events: drain(),
      rows: [],
      error: {
        message: `There is no table called \`${tableRef.name}\`.`,
        hint: known.length === 1 ? `The only table is \`${known[0]}\`.` : `Tables: ${known.join(', ')}.`,
        from: tableRef.span.from,
        to: tableRef.span.to,
      },
    };
  }

  const unknownColumn = referencedColumns(ast).find((c) => !table.columns.includes(c.name));
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

  if (ast.kind === 'insert' && !ast.columns && ast.values.items.length !== table.columns.length) {
    return {
      events: drain(),
      rows: [],
      error: {
        message: `\`${table.name}\` has ${table.columns.length} column${
          table.columns.length === 1 ? '' : 's'
        }, but this INSERT gives ${ast.values.items.length} value${ast.values.items.length === 1 ? '' : 's'}.`,
        hint: `Columns: ${table.columns.join(', ')}. Name the columns you're setting if you don't want to supply all of them, e.g. INSERT INTO ${table.name} (${table.columns[0]}) VALUES (...).`,
        from: ast.values.span.from,
        to: ast.values.span.to,
      },
    };
  }

  const heap = buildHeap(table, options.rowsPerPage);
  const tree = table.indexedColumn ? buildIndex(heap, table.indexedColumn) : null;
  const locks = createLockManager(emit);

  if (ast.kind === 'insert') {
    emitInsertParseEvents(emit, ast);
    const row = buildInsertRow(ast, table);

    const lastPage = heap.pages[heap.pages.length - 1]!;
    const insertNeedsNewPage = lastPage.rows.length >= options.rowsPerPage;
    const pool = createBufferPool(pageCountFor(heap, tree) + (insertNeedsNewPage ? 1 : 0), options, emit);

    const { row: inserted } = executeInsert(row, { emit, pool, locks, heap, tree, table, options });
    const rows = [...table.rows, inserted];

    emit(
      `1 row inserted, from ${pool.stats.misses} disk read${pool.stats.misses === 1 ? '' : 's'} and ${
        pool.stats.writes
      } write${pool.stats.writes === 1 ? '' : 's'}. ${table.name} now has ${rows.length} row${
        rows.length === 1 ? '' : 's'
      }.`,
      { stage: 'result', rows: [inserted] },
    );

    return {
      events: drain(),
      rows: [inserted],
      write: { kind: 'insert', table: table.name, insertedCount: 1, rows },
    };
  }

  if (ast.kind === 'delete') {
    emitDeleteParseEvents(emit, ast);
    const plan = emitDeletePlanEvents(emit, ast, table, options.rowsPerPage);
    const pool = createBufferPool(pageCountFor(heap, tree), options, emit);

    const { deleted } = executeDelete(plan, { emit, pool, locks, heap, tree, table, options });
    const removed = new Set(deleted);
    const rows = table.rows.filter((r) => !removed.has(r));

    emit(
      `${deleted.length} row${deleted.length === 1 ? '' : 's'} deleted, from ${pool.stats.misses} disk read${
        pool.stats.misses === 1 ? '' : 's'
      } and ${pool.stats.evictions} eviction${pool.stats.evictions === 1 ? '' : 's'}. ${table.name} now has ${
        rows.length
      } row${rows.length === 1 ? '' : 's'}.`,
      { stage: 'result', rows: deleted },
    );

    return {
      events: drain(),
      rows: deleted,
      write: { kind: 'delete', table: table.name, deletedCount: deleted.length, rows },
    };
  }

  if (ast.kind === 'update') {
    emitUpdateParseEvents(emit, ast);
    const plan = emitUpdatePlanEvents(emit, ast, table, options.rowsPerPage);
    const pool = createBufferPool(pageCountFor(heap, tree), options, emit);

    const { before, after } = executeUpdate(plan, ast.set.assignments, {
      emit,
      pool,
      locks,
      heap,
      tree,
      table,
      options,
    });
    const replacements = new Map(before.map((row, i) => [row, after[i]!]));
    const rows = table.rows.map((r) => replacements.get(r) ?? r);

    emit(
      `${after.length} row${after.length === 1 ? '' : 's'} updated, from ${pool.stats.misses} disk read${
        pool.stats.misses === 1 ? '' : 's'
      } and ${pool.stats.evictions} eviction${pool.stats.evictions === 1 ? '' : 's'}.`,
      { stage: 'result', rows: after },
    );

    return {
      events: drain(),
      rows: after,
      write: { kind: 'update', table: table.name, updatedCount: after.length, rows },
    };
  }

  emitParseEvents(emit, ast);
  const plan = emitPlanEvents(emit, ast, table, options.rowsPerPage);

  // A Sort's spill needs its own page ids, reserved up front — sized against
  // the whole table (the worst case; a WHERE clause can only shrink what
  // actually reaches Sort) so the reservation is never too small to discover
  // only at runtime.
  const sortTemp = findSort(plan)
    ? sortTempPageCount(table.rows.length, options.rowsPerPage, options.bufferFrames)
    : 0;
  const pool = createBufferPool(pageCountFor(heap, tree) + sortTemp, options, emit);

  const rows = execute(plan, { emit, pool, locks, heap, tree, table, options });

  return { events: drain(), rows };
}

function referencedColumns(ast: Statement): { name: string; span: { from: number; to: number } }[] {
  const refs: { name: string; span: { from: number; to: number } }[] = [];
  if (ast.kind === 'select' && ast.select.kind === 'columns') refs.push(...ast.select.names);
  if (ast.kind !== 'insert' && ast.where) {
    const stack = [ast.where];
    while (stack.length > 0) {
      const e = stack.pop()!;
      if (e.kind === 'column') refs.push({ name: e.name, span: e.span });
      if (e.kind === 'compare' || e.kind === 'and') stack.push(e.left, e.right);
    }
  }
  if (ast.kind === 'select' && ast.orderBy) refs.push({ name: ast.orderBy.column, span: ast.orderBy.span });
  if (ast.kind === 'insert' && ast.columns) refs.push(...ast.columns.names);
  if (ast.kind === 'update') {
    refs.push(...ast.set.assignments.map((a) => ({ name: a.column, span: a.columnSpan })));
  }
  return refs;
}

/** Builds the new row: every table column defaults to `null`, then the given values overwrite it. */
function buildInsertRow(ast: InsertStatement, table: Table): Row {
  const row: Row = {};
  for (const column of table.columns) row[column] = null;

  const names = ast.columns ? ast.columns.names.map((c) => c.name) : table.columns;
  names.forEach((name, i) => {
    row[name] = ast.values.items[i]!.value;
  });

  return row;
}
