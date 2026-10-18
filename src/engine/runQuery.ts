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
  emitCompoundParseEvents,
  emitDeleteParseEvents,
  emitInsertParseEvents,
  emitParseEvents,
  emitUpdateParseEvents,
  parseStatement,
} from './parser/index.ts';
import type { CompoundStatement, InsertStatement, SelectStatement, Statement, TableRef } from './parser/index.ts';
import { analyzeTable, statsToRows } from './stats.ts';
import {
  emitCompoundPlanEvents,
  emitDeletePlanEvents,
  emitPlanEvents,
  emitUpdatePlanEvents,
  findIndexNestedLoopJoins,
  findSort,
  findSortAggregate,
  findSortDistinct,
  isReorderableChain,
  joinsIn,
  projectListFor,
  reorderJoinsIfCheaper,
} from './planner/index.ts';
import type { CompoundMember, Plan } from './planner/index.ts';
import { buildHeap, createBufferPool } from './storage/index.ts';
import { controlKindOf } from './transactionControl.ts';
import { buildIndexes, describeUniqueKey, findIndexSpec, indexSpecsOf, pageCountFor } from './index/index.ts';
import type { BPlusTree } from './index/index.ts';
import type { Heap } from './storage/index.ts';
import { walkExpr } from './parser/index.ts';
import { execute } from './exec/index.ts';
import type { ExecContext } from './exec/operators.ts';
import { executeDelete } from './exec/delete.ts';
import { executeInsert } from './exec/insert.ts';
import { executeUpdate } from './exec/update.ts';
import { UniqueViolation } from './exec/unique.ts';
import { sortTempPageCount } from './exec/sort.ts';
import { createLockManager } from './locks/index.ts';
import { explainResult } from './explain.ts';
import { resolveStatementSubqueries } from './subquery.ts';
import { existsNodesIn, resolveExists } from './exists.ts';
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
  /**
   * The pages this statement reads, in order — the future the `optimal` policy evicts by. `runQuery` records it
   * itself, by running the statement once first; a caller never needs to pass it.
   */
  rehearsedReferences?: readonly number[];
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

/** "There is no table called X", pointing at the reference that named it. */
function noSuchTable(ref: TableRef, db: Database): QueryError {
  const known = Object.keys(db.tables);
  return {
    message: `There is no table called \`${ref.name}\`.`,
    hint: known.length === 1 ? `The only table is \`${known[0]}\`.` : `Tables: ${known.join(', ')}.`,
    from: ref.span.from,
    to: ref.span.to,
  };
}

/**
 * Every table a SELECT reads besides its `FROM` table, by name — each `JOIN`'s (plan.md §25.4 C3 slice b) and each
 * `EXISTS` subquery's (§27.5 S1), since a correlated one is joined like the rest — or the first that does not exist.
 */
function partnerTablesOf(ast: SelectStatement, db: Database): { ok: true; tables: Record<string, Table> } | { ok: false; error: QueryError } {
  const tables: Record<string, Table> = {};
  for (const ref of [...(ast.joins ?? []).map((j) => j.table), ...existsNodesIn(ast.where).map((e) => e.subquery.from)]) {
    const t = db.tables[ref.name];
    if (!t) return { ok: false, error: noSuchTable(ref, db) };
    tables[ref.name] = t;
  }
  return { ok: true, tables };
}

/** The first column a statement names that its table does not have, as the error to report — or `null`. */
function unknownColumnError(ast: Exclude<Statement, { kind: 'explain' | 'compound' }>, db: Database, table: Table): QueryError | null {
  const unknownColumn = referencedColumns(ast).find((c) => {
    const named = c.table ? db.tables[c.table] : table;
    return !named || !named.columns.includes(c.name);
  });
  if (!unknownColumn) return null;
  const named = (unknownColumn.table ? db.tables[unknownColumn.table] : table)!;
  return {
    message: `\`${named.name}\` has no column called \`${unknownColumn.name}\`.`,
    hint: `Columns: ${named.columns.join(', ')}.`,
    from: unknownColumn.span.from,
    to: unknownColumn.span.to,
  };
}

/**
 * Each `sort-merge` Join's own two-block scratch reservation (one per side, since each sorts independently), in chain
 * order from `pageBase`. A join's worst-case left input is the FROM table itself; a later step's is the product of every
 * earlier table's row count, counting an empty table as one row (a LEFT JOIN onto it still passes every left row
 * through, NULL-padded). A semi- or anti-join (plan.md §27.5 S1) passes each left row at most once, so it never grows
 * what comes next. Returns the reservations and the first page id past them.
 */
function reserveSortMergeBases(
  plan: Plan,
  fromRows: number,
  joinTables: Record<string, Table>,
  options: EngineOptions,
  pageBase: number,
): { bases: Map<Plan, { leftBase: number; rightBase: number }>; end: number } {
  const bases = new Map<Plan, { leftBase: number; rightBase: number }>();
  let next = pageBase;
  let worstCaseLeftRows = fromRows;
  for (const j of joinsIn(plan)) {
    const jTable = joinTables[j.rightTable]!;
    if (j.algorithm === 'sort-merge') {
      const leftBase = next;
      next += sortTempPageCount(worstCaseLeftRows, options.rowsPerPage, options.bufferFrames);
      const rightBase = next;
      next += sortTempPageCount(jTable.rows.length, options.rowsPerPage, options.bufferFrames);
      bases.set(j, { leftBase, rightBase });
    }
    if (j.joinType !== 'semi' && j.joinType !== 'anti') worstCaseLeftRows *= Math.max(1, jTable.rows.length);
  }
  return { bases, end: next };
}

/** The most rows a SELECT's own sorts can meet: its table's, times every joined table's (an empty one counted as one). */
function worstCaseRowsOf(ast: SelectStatement, table: Table, joinTables: Record<string, Table>): number {
  return (ast.joins ?? []).reduce((product, j) => product * Math.max(1, joinTables[j.table.name]!.rows.length), table.rows.length);
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
  // Bélády's optimal policy (plan.md §26 Feature 2) evicts the page whose next use is farthest away, so it needs the
  // future. A query's page reads are decided by its plan, not by the pool — the same query reads the same pages in
  // the same order under any policy — so run it once (as FIFO) to record them, then run it for real with that record
  // as the future. Without it `optimal` would quietly act as FIFO while its narration claimed otherwise. Nothing here
  // changes `db` (a write's new rows are returned, not stored), so the rehearsal leaves nothing behind.
  if (options.policy === 'optimal' && hooks.rehearsedReferences === undefined) {
    const rehearsal = runQuery(sql, db, { ...options, policy: 'fifo' });
    const references = rehearsal.events.flatMap((e) =>
      e.stage === 'buffer' && (e.action === 'hit' || e.action === 'miss') ? [e.pageId] : [],
    );
    return runQuery(sql, db, options, { ...hooks, rehearsedReferences: references });
  }

  const { emit, drain } = createTracer();
  const poolFor = (pageCount: number) =>
    createBufferPool(pageCount, options, emit, hooks.rehearsedReferences, 'query');

  // `BEGIN`, `COMMIT` and `ROLLBACK` mean nothing to a single statement: say where they do (plan.md §25.4 D1).
  if (controlKindOf(sql) !== null) {
    return {
      events: drain(),
      rows: [],
      error: {
        message: '`BEGIN`, `COMMIT` and `ROLLBACK` need two sessions to mean anything, and the Playground runs one statement at a time.',
        hint: 'Open Transaction schedules (/tools/schedule), where two sessions share a table and you choose the interleaving.',
      },
    };
  }

  const parsed = parseStatement(sql);
  if (!parsed.ok) {
    return { events: drain(), rows: [], error: parsed.error };
  }
  const parsedAst = parsed.ast;
  // EXPLAIN [ANALYZE] SELECT (plan.md §25.4 B6): the inner query, run and then reported as a plan.
  if (parsedAst.kind === 'explain') {
    return explainResult(sql, parsedAst, (inner) => runQuery(inner, db, options, hooks));
  }
  // UNION / INTERSECT / EXCEPT (plan.md §27.5 S3): several SELECTs, each run as one, combined above them.
  if (parsedAst.kind === 'compound') {
    return runCompound(sql, parsedAst, db, options, { emit, drain, poolFor });
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
  if (!table) return { events: drain(), rows: [], error: noSuchTable(tableRef, db) };

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
  // FROM/INTO table above, so all of them go through the same "no table called X" shape. So is every EXISTS
  // subquery's table (plan.md §27.5 S1): a correlated one is joined like the rest.
  const joins = ast.kind === 'select' ? (ast.joins ?? []) : [];
  const partners = ast.kind === 'select' ? partnerTablesOf(ast, db) : { ok: true as const, tables: {} };
  if (!partners.ok) return { events: drain(), rows: [], error: partners.error };
  const joinTables: Record<string, Table> = partners.tables;

  const unknownColumn = unknownColumnError(ast, db, table);
  if (unknownColumn) return { events: drain(), rows: [], error: unknownColumn };

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
    const pool = poolFor(pageCountFor(heap, trees) + (insertNeedsNewPage ? 1 : 0));

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
    // Any `IN (subquery)` (plan.md §25.4 C3 slice c) runs exactly once here, before planning — the parse-stage
    // narration above already showed the query exactly as written.
    const resolved = resolveStatementSubqueries(ast, sql, (s) => runQuery(s, db, options));
    if (!resolved.ok) return { events: drain(), rows: [], error: resolved.error };
    const deleteAst = resolved.value;
    const plan = emitDeletePlanEvents(emit, deleteAst, table, options.rowsPerPage);
    const pool = poolFor(pageCountFor(heap, trees));

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
    // Any `IN (subquery)` — in the WHERE clause or a SET value (plan.md §25.4 C3 slice c) — runs exactly once here,
    // before planning; the parse-stage narration above already showed the query exactly as written.
    const resolved = resolveStatementSubqueries(ast, sql, (s) => runQuery(s, db, options));
    if (!resolved.ok) return { events: drain(), rows: [], error: resolved.error };
    const updateAst = resolved.value;
    const plan = emitUpdatePlanEvents(emit, updateAst, table, options.rowsPerPage);
    const pool = poolFor(pageCountFor(heap, trees));

    let changed: ReturnType<typeof executeUpdate>;
    try {
      changed = executeUpdate(plan, updateAst.set.assignments, { emit, pool, locks, heap, trees, table, options });
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
  // Any `IN (subquery)` — in WHERE, HAVING or a computed column (plan.md §25.4 C3 slice c) — runs exactly once
  // here, before planning; the parse-stage narration above already showed the query exactly as written.
  const resolvedSubqueries = resolveStatementSubqueries(ast, sql, (s) => runQuery(s, db, options));
  if (!resolvedSubqueries.ok) return { events: drain(), rows: [], error: resolvedSubqueries.error };
  // Then every EXISTS (plan.md §27.5 S1): a correlated one leaves WHERE to become a semi- or anti-join, an
  // uncorrelated one runs once here, like an IN subquery.
  const resolvedExists = resolveExists(resolvedSubqueries.value, (s) => runQuery(s, db, options));
  if (!resolvedExists.ok) return { events: drain(), rows: [], error: resolvedExists.error };
  const selectAst = resolvedExists.value;
  const semiTables = (selectAst.semiJoins ?? []).map((sj) => sj.table.name);
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
  // The partners every Join reads: each JOIN's table, then each semi-joined subquery table (plan.md §27.5 S1).
  const partnerNames = [...joins.map((j) => j.table.name), ...semiTables];
  for (const name of partnerNames) {
    const jHeap = buildHeap(joinTables[name]!, options.rowsPerPage, pageBase);
    joinHeaps[name] = jHeap;
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

  // Every `sort-merge` Join in the chain needs its own two-block reservation — one per side, since each sorts
  // independently — placed in chain order (the innermost join's scratch first, mirroring the order joins actually
  // execute in) right after every table's heap and any probe index. A single join's worst-case left input is just
  // the FROM table itself (`table.rows.length`, unchanged from before chains existed); a later step's worst case is
  // the product of every earlier table's row count, since no join can ever produce more rows than that — counting an
  // empty table as one row, because a LEFT JOIN onto it still passes every left row through, NULL-padded.
  const reserved = reserveSortMergeBases(plan, table.rows.length, joinTables, options, pageBase);
  const sortMergeBases = reserved.bases;
  pageBase = reserved.end;

  // Every other sort the plan runs gets its own block of scratch page ids after those, in the order the sorts run —
  // a SortAggregate's own sort, then ORDER BY's Sort above it (plan.md §26 Feature 1), then a sort-based DISTINCT
  // above the projection (plan.md §25.4 B2) — so no two sorts ever share a page id. Each is sized for the most rows
  // that can reach it: the whole table (a WHERE clause can only shrink it), or after a JOIN every joined table's
  // product (an empty one counted as one row, for a LEFT JOIN's padding). Not capped: a block is only a range of ids,
  // and the pool does not count a read or write past its last page — a cap once let a big join's sort spill there
  // unseen. With one sort and no join this is exactly the block each sort always had, after the heap and indexes.
  const worstCaseRows = worstCaseRowsOf(selectAst, table, joinTables);
  const spillFor = (present: boolean) =>
    present ? sortTempPageCount(worstCaseRows, options.rowsPerPage, options.bufferFrames) : 0;
  const aggregateSortBase = pageBase;
  const sortBase = aggregateSortBase + spillFor(findSortAggregate(plan) !== null);
  const distinctBase = sortBase + spillFor(findSort(plan) !== null);
  const pool = poolFor(distinctBase + spillFor(findSortDistinct(plan) !== null));

  const rows = execute(plan, {
    emit,
    pool,
    locks,
    heap,
    trees,
    table,
    options,
    aggregateSortBase,
    sortBase,
    distinctBase,
    ...(partnerNames.length > 0
      ? {
          joinPartners: Object.fromEntries(
            partnerNames.map((name) => [
              name,
              { table: joinTables[name]!, heap: joinHeaps[name]!, trees: joinTrees[name] ?? {} },
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

function referencedColumns(ast: Exclude<Statement, { kind: 'explain' | 'compound' }>): ColumnRef[] {
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
    // An EXISTS subquery is a scope of its own (plan.md §27.5 S1), which `walkExpr` does not enter; its columns are
    // all qualified, so each is checked against the table it names.
    for (const node of existsNodesIn(ast.where)) {
      if (!node.subquery.where) continue;
      walkExpr(node.subquery.where, (e) => {
        if (e.kind === 'column') push(e);
      });
    }
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
  // An aggregate key (`SUM(amount)`) is not a column; the column it reads is.
  if (ast.kind === 'select' && ast.orderBy?.aggregate) {
    if (ast.orderBy.aggregate.arg.kind === 'column') push(ast.orderBy.aggregate.arg);
  } else if (ast.kind === 'select' && ast.orderBy) {
    const { column, table, span } = ast.orderBy;
    refs.push(table === undefined ? { name: column, span } : { name: column.slice(table.length + 1), table, span });
  }
  if (ast.kind === 'insert' && ast.columns) refs.push(...ast.columns.names);
  if (ast.kind === 'update') {
    refs.push(...ast.set.assignments.map((a) => ({ name: a.column, span: a.columnSpan })));
    // A SET value can read columns (`SET n = n + 1`), and each must exist.
    for (const a of ast.set.assignments) walkExpr(a.value, (e) => { if (e.kind === 'column') push(e); });
  }
  return refs;
}

/**
 * The columns a SELECT returns, in order — what a compound query matches its members by (plan.md §27.5 S3). A list
 * names its own; `*` is the table's columns, or after a JOIN every table's, qualified, in the order the joined row
 * holds them.
 */
function outputColumnsOf(ast: SelectStatement, table: Table, joinTables: Record<string, Table>): string[] {
  const list = projectListFor(ast.select);
  if (list.kind === 'columns') return list.names;
  if (list.kind === 'expressions') return list.items.map((i) => i.key);
  if (!ast.joins || ast.joins.length === 0) return [...table.columns];
  return [table, ...ast.joins.map((j) => joinTables[j.table.name]!)].flatMap((t) => t.columns.map((c) => `${t.name}.${c}`));
}

/**
 * `SELECT … UNION [ALL] | INTERSECT | EXCEPT SELECT …` (plan.md §27.5 S3). Each member goes through what a SELECT on its
 * own does — a cheaper join order, the table and column checks, its `IN` and `EXISTS` subqueries resolved, then planned
 * and optimized — and the set operations sit above them. Every table any member reads is laid out once, heap then
 * every index, so two SELECTs over one table read the same pages and the second can find them already in the pool.
 * Each member runs in a context of its own (its table, partners and scratch blocks), all sharing the one buffer pool.
 */
function runCompound(
  sql: string,
  compound: CompoundStatement,
  db: Database,
  options: EngineOptions,
  tracer: { emit: ReturnType<typeof createTracer>['emit']; drain: () => RunResult['events']; poolFor: (pages: number) => ReturnType<typeof createBufferPool> },
): RunResult {
  const { emit, drain, poolFor } = tracer;
  const fail = (error: QueryError): RunResult => ({ events: drain(), rows: [], error });
  const operators = [...new Set(compound.ops.map((o) => o.op.toUpperCase()))].join(' / ');

  const prepared: CompoundMember[] = [];
  for (const member of compound.members) {
    const { ast, writtenOrder } = applyCostOrder(member, db, options.rowsPerPage);
    const table = db.tables[ast.from.name];
    if (!table) return fail(noSuchTable(ast.from, db));
    const partners = partnerTablesOf(ast, db);
    if (!partners.ok) return fail(partners.error);
    const unknownColumn = unknownColumnError(ast, db, table);
    if (unknownColumn) return fail(unknownColumn);
    prepared.push({
      ast,
      table,
      joinTables: partners.tables,
      ...(writtenOrder ? { writtenJoinOrder: writtenOrder } : {}),
      columns: outputColumnsOf(ast, table, partners.tables),
    });
  }

  // Rows are matched column by column, by position: every member returns as many columns as the first.
  const width = prepared[0]!.columns.length;
  const odd = prepared.findIndex((m) => m.columns.length !== width);
  if (odd > 0) {
    const span = compound.members[odd]!.span;
    return fail({
      message: `Every SELECT in a ${operators} returns the same number of columns: the first returns ${String(width)}, SELECT ${String(odd + 1)} returns ${String(prepared[odd]!.columns.length)}.`,
      hint: 'Rows are combined column by column, by position — give each SELECT as many columns as the first.',
      from: span.from,
      to: span.to,
    });
  }
  const orderBy = compound.orderBy;
  if (orderBy && !prepared[0]!.columns.includes(orderBy.column)) {
    return fail({
      message: `\`${orderBy.column}\` is not a column of the combined result.`,
      hint: `After ${operators}, ORDER BY names one of the result's columns — the first SELECT's: ${prepared[0]!.columns.map((c) => `\`${c}\``).join(', ')}.`,
      from: orderBy.span.from,
      to: orderBy.span.to,
    });
  }

  emitCompoundParseEvents(emit, compound);

  // Each member's `IN` and `EXISTS` subqueries, resolved as a SELECT on its own resolves them.
  const run = (s: string) => runQuery(s, db, options);
  for (const m of prepared) {
    const inSubqueries = resolveStatementSubqueries(m.ast, sql, run);
    if (!inSubqueries.ok) return fail(inSubqueries.error);
    const exists = resolveExists(inSubqueries.value, run);
    if (!exists.ok) return fail(exists.error);
    m.ast = exists.value;
  }

  const planned = emitCompoundPlanEvents(emit, compound, prepared, options.rowsPerPage, options.aggregateStrategy ?? 'hash', options.joinStrategy);

  // Every table once: its heap, then all its indexes — a FROM table needs them, and an index nested-loop probes one.
  const placed = new Map<string, { table: Table; heap: Heap; trees: Record<string, BPlusTree> }>();
  let pageBase = 0;
  const place = (t: Table): void => {
    if (placed.has(t.name)) return;
    const heap = buildHeap(t, options.rowsPerPage, pageBase);
    const heapEnd = pageBase + heap.pages.length;
    const trees = buildIndexes(heap, indexSpecsOf(t), undefined, heapEnd, options.indexBuild, t.clusteredKey);
    pageBase = Math.max(heapEnd, ...Object.values(trees).map((tree) => tree.nextPageId));
    placed.set(t.name, { table: t, heap, trees });
  };
  for (const m of prepared) {
    place(m.table);
    for (const t of Object.values(m.joinTables)) place(t);
  }

  // Then each member's own scratch blocks — for its sort-merge joins and any sort it runs — sized for its own rows.
  const spill = (rows: number, present: boolean) => (present ? sortTempPageCount(rows, options.rowsPerPage, options.bufferFrames) : 0);
  const memberParts = prepared.map((m, i) => {
    const plan = planned.members[i]!;
    const reserved = reserveSortMergeBases(plan, m.table.rows.length, m.joinTables, options, pageBase);
    pageBase = reserved.end;
    const worst = worstCaseRowsOf(m.ast, m.table, m.joinTables);
    const aggregateSortBase = pageBase;
    pageBase += spill(worst, findSortAggregate(plan) !== null);
    const sortBase = pageBase;
    pageBase += spill(worst, findSort(plan) !== null);
    const distinctBase = pageBase;
    pageBase += spill(worst, findSortDistinct(plan) !== null);
    const partnerNames = [...(m.ast.joins ?? []).map((j) => j.table.name), ...(m.ast.semiJoins ?? []).map((sj) => sj.table.name)];
    return {
      plan,
      from: placed.get(m.table.name)!,
      aggregateSortBase,
      sortBase,
      distinctBase,
      ...(reserved.bases.size > 0 ? { sortMergeBases: reserved.bases } : {}),
      joinPartners: Object.fromEntries(partnerNames.map((name) => [name, placed.get(name)!])),
      worst,
    };
  });

  // The combined result's own sorts — each UNION's DISTINCT, and ORDER BY's Sort — sized for every member's rows.
  const total = memberParts.reduce((sum, part) => sum + part.worst, 0);
  const distinctBases = planned.distincts.map((d) => {
    const base = pageBase;
    pageBase += spill(total, d.op === 'SortDistinct');
    return base;
  });
  const topSortBase = pageBase;
  pageBase += spill(total, findSort(planned.plan) !== null);

  const pool = poolFor(pageBase);
  const locks = createLockManager(emit);
  const first = memberParts[0]!;
  const contexts = new Map<Plan, ExecContext>();
  const top: ExecContext = {
    emit,
    pool,
    locks,
    heap: first.from.heap,
    trees: first.from.trees,
    table: first.from.table,
    options,
    sortBase: topSortBase,
    ...(distinctBases.length > 0 ? { distinctBase: distinctBases.at(-1)! } : {}),
    // Every table, for the result's estimate; the members' own partners are in their own contexts.
    joinPartners: Object.fromEntries(placed),
    members: contexts,
  };
  for (const part of memberParts) {
    contexts.set(part.plan, {
      emit,
      pool,
      locks,
      heap: part.from.heap,
      trees: part.from.trees,
      table: part.from.table,
      options,
      aggregateSortBase: part.aggregateSortBase,
      sortBase: part.sortBase,
      distinctBase: part.distinctBase,
      ...(Object.keys(part.joinPartners).length > 0 ? { joinPartners: part.joinPartners } : {}),
      ...(part.sortMergeBases ? { sortMergeBases: part.sortMergeBases } : {}),
    });
  }
  planned.distincts.forEach((d, i) => contexts.set(d, { ...top, distinctBase: distinctBases[i]! }));

  // No "how many rows" prompt: its options are framed as a share of one table, and a compound reads several.
  const rows = execute(planned.plan, top, null);
  return { events: drain(), rows };
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
