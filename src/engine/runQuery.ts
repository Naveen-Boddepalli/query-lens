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
  emitAnalyzeParseEvents,
  emitDeleteParseEvents,
  emitInsertParseEvents,
  emitParseEvents,
  emitUpdateParseEvents,
  parseStatement,
} from './parser/index.ts';
import type { InsertStatement, SelectStatement, Statement } from './parser/index.ts';
import { analyzeTable, statsToRows } from './stats.ts';
import {
  emitDeletePlanEvents,
  emitPlanEvents,
  emitUpdatePlanEvents,
  findIndexNestedLoopJoins,
  findSortDistinct,
  isReorderableChain,
  joinsIn,
  needsSortSpill,
  reorderJoinsIfCheaper,
} from './planner/index.ts';
import type { Plan } from './planner/index.ts';
import { buildHeap, createBufferPool } from './storage/index.ts';
import { buildIndexes, describeUniqueKey, findIndexSpec, indexSpecsOf, pageCountFor } from './index/index.ts';
import type { BPlusTree } from './index/index.ts';
import type { Heap } from './storage/index.ts';
import { walkExpr } from './parser/index.ts';
import { execute } from './exec/index.ts';
import { executeDelete } from './exec/delete.ts';
import { executeInsert } from './exec/insert.ts';
import { executeUpdate } from './exec/update.ts';
import { UniqueViolation } from './exec/unique.ts';
import { sortTempPageCount } from './exec/sort.ts';
import { createLockManager } from './locks/index.ts';
import { explainResult } from './explain.ts';
import { resolveWhereSubqueries } from './subquery.ts';
import { createTracer } from './trace.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { Database, EngineOptions, QueryError, Row, RunResult, Table } from './types.ts';

/** The error a rejected `INSERT` or `UPDATE` reports: which key is taken, by which row, and that nothing changed. */
function uniqueError(violation: UniqueViolation, heap: Heap, span: { from: number; to: number }): QueryError {
  const holder = heap.pages.find((p) => p.pageId === violation.holder.pageId)?.rows[violation.holder.slot];
  return {
    message: `Duplicate key — the UNIQUE index on \`${violation.index}\` already holds ${describeUniqueKey(violation.columns, violation.values)}.`,
    hint: `A UNIQUE index allows one row per key (NULLs excepted: NULL is not equal to NULL).${
      holder ? ` The row that has it: ${JSON.stringify(holder)}.` : ''
    } Use a different value, or change or delete that row first. Nothing was changed.`,
    from: span.from,
    to: span.to,
  };
}

/**
 * A look inside a run that the trace does not give. `afterWrite` receives the indexes a write left behind — the
 * trees `INSERT`/`UPDATE`/`DELETE` just maintained — so a test can check them against the rows (plan.md §25.4 B3):
 * every statement builds its indexes afresh, so nothing later would ever notice one that was maintained wrongly.
 */
export interface RunHooks {
  afterWrite?: (indexes: Record<string, BPlusTree>) => void;
}

/**
 * `ast`, with its `JOIN`s reordered to the cheapest sequence `reorderJoinsIfCheaper` finds, alongside the order it
 * was actually *typed* in (`writtenOrder`) — present only when reordering genuinely changed something, which is
 * also the signal `emitPlanEvents` uses to narrate it. Otherwise `ast` comes back completely unchanged. Tolerant
 * of a table that turns out not to exist: resolving `db.tables` here is a *look*, not the real validation (that
 * happens right after, against whichever `ast` this returns), so a missing name just means "nothing to reorder,"
 * never a different error than the query would have gotten anyway.
 */
function applyCostOrder(
  ast: SelectStatement,
  db: Database,
  rowsPerPage: number,
): { ast: SelectStatement; writtenOrder?: readonly string[] } {
  if (!isReorderableChain(ast)) return { ast };
  const names = [ast.from.name, ...(ast.joins ?? []).map((j) => j.table.name)];
  const tables: Record<string, Table> = {};
  for (const name of names) {
    const t = db.tables[name];
    if (!t) return { ast };
    tables[name] = t;
  }
  const reordered = reorderJoinsIfCheaper(ast, tables, rowsPerPage);
  return reordered ? { ast: { ...ast, from: reordered.from, joins: reordered.joins }, writtenOrder: names } : { ast };
}

/** A disk read is a miss, or a page read ahead of the request (plan.md §25.4 F7) — both cost the same I/O. */
function diskReads(pool: { stats: { misses: number; prefetches: number } }): number {
  return pool.stats.misses + pool.stats.prefetches;
}

export function runQuery(
  sql: string,
  db: Database,
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  hooks: RunHooks = {},
): RunResult {
  const { emit, drain } = createTracer();

  const parsed = parseStatement(sql);
  if (!parsed.ok) {
    return { events: drain(), rows: [], error: parsed.error };
  }
  const parsedAst = parsed.ast;
  // EXPLAIN [ANALYZE] SELECT (plan.md §25.4 B6): the inner query, run and then reported as a plan.
  if (parsedAst.kind === 'explain') {
    return explainResult(sql, parsedAst, (inner) => runQuery(inner, db, options, hooks));
  }
  // A chain of 2+ plain inner JOINs may cost less in a different order (plan.md §25.4 C5 slice 3) — resolved here,
  // before any table is looked up for real, so every later step (table/column validation, the heap, the plan
  // itself) already sees whichever order will actually run. Left exactly as written when it is not eligible (a
  // LEFT JOIN anywhere, fewer than two JOINs), already optimal, or names a table that turns out not to exist —
  // the ordinary "no table called X" error just below is exactly as useful either way. `writtenJoinOrder` is only
  // ever set alongside a real change, and is threaded through to `emitPlanEvents` so the trace can say so.
  const { ast, writtenOrder: writtenJoinOrder } =
    parsedAst.kind === 'select'
      ? applyCostOrder(parsedAst, db, options.rowsPerPage)
      : { ast: parsedAst, writtenOrder: undefined };
  const tableRef = ast.kind === 'insert' ? ast.into : ast.kind === 'update' || ast.kind === 'analyze' ? ast.table : ast.from;

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

  // ANALYZE (plan.md §25.4 C1): a real scan, nothing to plan or optimize, and no join/column checks below apply.
  if (ast.kind === 'analyze') {
    emitAnalyzeParseEvents(emit, ast);
    const stats = analyzeTable(table);
    const rows = statsToRows(stats);
    emit(
      `ANALYZE scanned all ${String(table.rows.length)} row${table.rows.length === 1 ? '' : 's'} of \`${table.name}\` and built statistics for ${String(table.columns.length)} column${table.columns.length === 1 ? '' : 's'}. The next query against \`${table.name}\` reads these instead of scanning the live rows to estimate a plan.`,
      { stage: 'result', rows },
    );
    return { events: drain(), rows, analyze: { table: table.name, stats } };
  }

  // Every JOIN's own table (plan.md §25.4 C3 slice b: 0 or more, left-deep) — resolved here, alongside the
  // FROM/INTO table above, so all of them go through the same "no table called X" shape.
  const joins = ast.kind === 'select' ? (ast.joins ?? []) : [];
  const joinTables: Record<string, Table> = {};
  for (const j of joins) {
    const t = db.tables[j.table.name];
    if (!t) {
      const known = Object.keys(db.tables);
      return {
        events: drain(),
        rows: [],
        error: {
          message: `There is no table called \`${j.table.name}\`.`,
          hint: known.length === 1 ? `The only table is \`${known[0]}\`.` : `Tables: ${known.join(', ')}.`,
          from: j.table.span.from,
          to: j.table.span.to,
        },
      };
    }
    joinTables[j.table.name] = t;
  }

  const unknownColumn = referencedColumns(ast).find((c) => {
    const named = c.table ? db.tables[c.table] : table;
    return !named || !named.columns.includes(c.name);
  });
  if (unknownColumn) {
    const named = (unknownColumn.table ? db.tables[unknownColumn.table] : table)!;
    return {
      events: drain(),
      rows: [],
      error: {
        message: `\`${named.name}\` has no column called \`${unknownColumn.name}\`.`,
        hint: `Columns: ${named.columns.join(', ')}.`,
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
  const trees = buildIndexes(heap, indexSpecsOf(table), undefined, undefined, options.indexBuild, table.clusteredKey);
  const locks = createLockManager(emit);

  if (ast.kind === 'insert') {
    emitInsertParseEvents(emit, ast);
    const row = buildInsertRow(ast, table);

    const lastPage = heap.pages[heap.pages.length - 1]!;
    const insertNeedsNewPage = lastPage.rows.length >= options.rowsPerPage;
    const pool = createBufferPool(pageCountFor(heap, trees) + (insertNeedsNewPage ? 1 : 0), options, emit);

    let inserted: Row;
    try {
      inserted = executeInsert(row, { emit, pool, locks, heap, trees, table, options }).row;
    } catch (e) {
      if (e instanceof UniqueViolation) {
        const error = uniqueError(e, heap, ast.values.span);
        emit(`INSERT is rejected — ${error.message} Nothing was changed.`, { stage: 'result', rows: [] });
        return { events: drain(), rows: [], error };
      }
      throw e;
    }
    hooks.afterWrite?.(trees);
    const rows = [...table.rows, inserted];

    emit(
      `1 row inserted, from ${diskReads(pool)} disk read${diskReads(pool) === 1 ? '' : 's'} and ${
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
    // Any `IN (subquery)` in the WHERE clause (plan.md §25.4 C3 slice c) runs exactly once here, before planning —
    // the parse-stage narration above already showed the query exactly as written.
    const resolved = resolveWhereSubqueries(ast.where, sql, (s) => runQuery(s, db, options));
    if (!resolved.ok) return { events: drain(), rows: [], error: resolved.error };
    const deleteAst = { ...ast, ...(resolved.where ? { where: resolved.where } : {}) };
    const plan = emitDeletePlanEvents(emit, deleteAst, table, options.rowsPerPage);
    const pool = createBufferPool(pageCountFor(heap, trees), options, emit);

    const { deleted } = executeDelete(plan, { emit, pool, locks, heap, trees, table, options });
    hooks.afterWrite?.(trees);
    const removed = new Set(deleted);
    const rows = table.rows.filter((r) => !removed.has(r));

    emit(
      `${deleted.length} row${deleted.length === 1 ? '' : 's'} deleted, from ${diskReads(pool)} disk read${
        diskReads(pool) === 1 ? '' : 's'
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
    // Any `IN (subquery)` in the WHERE clause (plan.md §25.4 C3 slice c) runs exactly once here, before planning —
    // the parse-stage narration above already showed the query exactly as written.
    const resolved = resolveWhereSubqueries(ast.where, sql, (s) => runQuery(s, db, options));
    if (!resolved.ok) return { events: drain(), rows: [], error: resolved.error };
    const updateAst = { ...ast, ...(resolved.where ? { where: resolved.where } : {}) };
    const plan = emitUpdatePlanEvents(emit, updateAst, table, options.rowsPerPage);
    const pool = createBufferPool(pageCountFor(heap, trees), options, emit);

    let changed: ReturnType<typeof executeUpdate>;
    try {
      changed = executeUpdate(plan, ast.set.assignments, { emit, pool, locks, heap, trees, table, options });
    } catch (e) {
      if (e instanceof UniqueViolation) {
        const error = uniqueError(e, heap, ast.set.span);
        emit(`UPDATE is rejected — ${error.message} Nothing was changed.`, { stage: 'result', rows: [] });
        return { events: drain(), rows: [], error };
      }
      throw e;
    }
    const { before, after } = changed;
    hooks.afterWrite?.(trees);
    const replacements = new Map(before.map((row, i) => [row, after[i]!]));
    const rows = table.rows.map((r) => replacements.get(r) ?? r);

    emit(
      `${after.length} row${after.length === 1 ? '' : 's'} updated, from ${diskReads(pool)} disk read${
        diskReads(pool) === 1 ? '' : 's'
      } and ${pool.stats.evictions} eviction${pool.stats.evictions === 1 ? '' : 's'}.`,
      { stage: 'result', rows: after },
    );

    return {
      events: drain(),
      rows: after,
      write: { kind: 'update', table: table.name, updatedCount: after.length, rows },
    };
  }

  // Always the query exactly as typed — `ast` may already be the cost-reordered version by this point (plan.md
  // §25.4 C5 slice 3), but the parse stage narrates source text, never a planning decision; `parsedAst` never was.
  emitParseEvents(emit, parsedAst.kind === 'select' ? parsedAst : ast);
  // Any `IN (subquery)` in the WHERE clause (plan.md §25.4 C3 slice c) runs exactly once here, before planning —
  // the parse-stage narration above already showed the query exactly as written.
  const resolvedWhere = resolveWhereSubqueries(ast.where, sql, (s) => runQuery(s, db, options));
  if (!resolvedWhere.ok) return { events: drain(), rows: [], error: resolvedWhere.error };
  const selectAst = { ...ast, ...(resolvedWhere.where ? { where: resolvedWhere.where } : {}) };
  const plan = emitPlanEvents(
    emit,
    selectAst,
    table,
    options.rowsPerPage,
    options.aggregateStrategy ?? 'hash',
    joinTables,
    options.joinStrategy,
    writtenJoinOrder,
  );

  // Every joined table gets its own heap, its pages numbered right after whatever came before it — so all of them
  // compete for the same buffer frames, the same way a Sort's spill pages do (plan.md §25.4 C3 slice b generalizes
  // this from one join partner to a whole left-deep chain). Nested-loop, hash and sort-merge never consult any
  // side's own index, so there is no B+Tree to build for a join partner unless that particular step runs
  // index-nested-loop (plan.md §25.4 B4) — each one that does gets its one needed index built next, past every
  // heap and every earlier probe index, so nothing collides.
  const joinHeaps: Record<string, Heap> = {};
  let pageBase = pageCountFor(heap, trees);
  for (const j of joins) {
    const jHeap = buildHeap(joinTables[j.table.name]!, options.rowsPerPage, pageBase);
    joinHeaps[j.table.name] = jHeap;
    pageBase += jHeap.pages.length;
  }
  const joinTrees: Record<string, Record<string, BPlusTree>> = {};
  for (const ij of findIndexNestedLoopJoins(plan)) {
    if (ij.right.op !== 'IndexProbe') continue; // unreachable: an index-nested-loop Join's own inner side is always a probe
    const jTable = joinTables[ij.rightTable]!;
    const probeIndex = findIndexSpec(jTable, ij.right.column);
    if (!probeIndex) continue; // unreachable: effectiveJoinAlgorithm already confirmed this index exists
    const jTrees = buildIndexes(joinHeaps[ij.rightTable]!, [probeIndex], undefined, pageBase, options.indexBuild, jTable.clusteredKey);
    joinTrees[ij.rightTable] = jTrees;
    pageBase = pageCountFor(joinHeaps[ij.rightTable]!, jTrees);
  }
  const heapsEnd = pageBase;

  // Every `sort-merge` Join in the chain needs its own two-block reservation — one per side, since each sorts
  // independently — placed in chain order (the innermost join's scratch first, mirroring the order joins actually
  // execute in) right after every table's heap and any probe index. A single join's worst-case left input is just
  // the FROM table itself (`table.rows.length`, unchanged from before chains existed); a later step's worst case is
  // the product of every earlier table's row count, since no join can ever produce more rows than that.
  const sortMergeBases = new Map<Plan, { leftBase: number; rightBase: number }>();
  let worstCaseLeftRows = table.rows.length;
  for (const j of joinsIn(plan)) {
    const jTable = joinTables[j.rightTable]!;
    if (j.algorithm === 'sort-merge') {
      const leftSize = sortTempPageCount(worstCaseLeftRows, options.rowsPerPage, options.bufferFrames);
      const leftBase = pageBase;
      pageBase += leftSize;
      const rightSize = sortTempPageCount(jTable.rows.length, options.rowsPerPage, options.bufferFrames);
      const rightBase = pageBase;
      pageBase += rightSize;
      sortMergeBases.set(j, { leftBase, rightBase });
    }
    worstCaseLeftRows *= jTable.rows.length;
  }

  // A Sort's (or a SortAggregate's own internal sort's) spill needs its own page ids, reserved up front — sized
  // against the whole table (the worst case; a WHERE clause can only shrink what actually reaches it) so the
  // reservation is never too small to discover only at runtime. This and the sort-merge reservation above never
  // both apply: ORDER BY/GROUP BY still can't combine with JOIN at all.
  const sortTemp = needsSortSpill(plan)
    ? sortTempPageCount(table.rows.length, options.rowsPerPage, options.bufferFrames)
    : pageBase - heapsEnd;
  // A sort-based DISTINCT (plan.md §25.4 B2) sorts what the projection produced, which after a JOIN can be as many
  // rows as every joined table's product (capped — these are teaching-sized tables) — and it gets its own block of
  // scratch pages *after* whichever other sort the plan has, so no two sorts share a page id.
  const distinctRows =
    joins.length > 0
      ? Math.min(joins.reduce((product, j) => product * joinTables[j.table.name]!.rows.length, table.rows.length), 20_000)
      : table.rows.length;
  const distinctSpill = findSortDistinct(plan)
    ? sortTempPageCount(distinctRows, options.rowsPerPage, options.bufferFrames)
    : 0;
  const distinctBase = heapsEnd + sortTemp;
  const pool = createBufferPool(distinctBase + distinctSpill, options, emit);

  const rows = execute(plan, {
    emit,
    pool,
    locks,
    heap,
    trees,
    table,
    options,
    distinctBase,
    ...(joins.length > 0
      ? {
          joinPartners: Object.fromEntries(
            joins.map((j) => [
              j.table.name,
              { table: joinTables[j.table.name]!, heap: joinHeaps[j.table.name]!, trees: joinTrees[j.table.name] ?? {} },
            ]),
          ),
        }
      : {}),
    ...(sortMergeBases.size > 0 ? { sortMergeBases } : {}),
  });

  return { events: drain(), rows };
}

interface ColumnRef {
  name: string;
  /** Which table it names, for a qualified reference — only ever set once a query has a JOIN. */
  table?: string;
  span: { from: number; to: number };
}

function referencedColumns(ast: Exclude<Statement, { kind: 'explain' }>): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const push = (ref: { name: string; table?: string; span: { from: number; to: number } }) =>
    refs.push({ name: ref.name, ...(ref.table === undefined ? {} : { table: ref.table }), span: ref.span });

  if (ast.kind === 'select' && ast.select.kind === 'columns') {
    for (const item of ast.select.items) {
      if (item.kind === 'column') push(item);
      else if (item.kind === 'expression') walkExpr(item.expr, (e) => { if (e.kind === 'column') push(e); });
      else if (item.arg.kind === 'column') push(item.arg);
    }
  }
  if (ast.kind !== 'insert' && ast.kind !== 'analyze' && ast.where) {
    walkExpr(ast.where, (e) => {
      if (e.kind === 'column') push(e);
    });
  }
  if (ast.kind === 'select') {
    for (const join of ast.joins ?? []) {
      if (join.on.left.kind === 'column') push(join.on.left);
      if (join.on.right.kind === 'column') push(join.on.right);
    }
  }
  if (ast.kind === 'select' && ast.groupBy) refs.push(...ast.groupBy.columns);
  if (ast.kind === 'select' && ast.having) {
    // A HAVING predicate names grouped columns and aggregate arguments — each must exist.
    walkExpr(ast.having, (e) => {
      if (e.kind === 'column') push(e);
      else if (e.kind === 'aggregate' && e.arg.kind === 'column') push(e.arg);
    });
  }
  if (ast.kind === 'select' && ast.orderBy) refs.push({ name: ast.orderBy.column, span: ast.orderBy.span });
  if (ast.kind === 'insert' && ast.columns) refs.push(...ast.columns.names);
  if (ast.kind === 'update') {
    refs.push(...ast.set.assignments.map((a) => ({ name: a.column, span: a.columnSpan })));
    // A SET value can read columns (`SET n = n + 1`), and each must exist.
    for (const a of ast.set.assignments) walkExpr(a.value, (e) => { if (e.kind === 'column') push(e); });
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
