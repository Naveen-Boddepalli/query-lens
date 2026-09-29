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

import type { DeleteStatement, Expr, JoinClause, SelectStatement, UpdateStatement } from '../parser/index.ts';
import { exprToSql } from '../parser/print.ts';
import { aggregateKeyOf, columnKey, selectItemArgColumn, selectItemKey, walkExpr } from '../parser/index.ts';
import type { AggregateSpec, Plan, ProjectList } from './plan.ts';
import type { JoinAlgorithm, Table } from '../types.ts';
import { indexNameOf, joinIndexFor } from '../index/spec.ts';

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
    ast.having !== undefined ||
    (ast.select.kind === 'columns' && ast.select.items.some((item) => item.kind === 'aggregate'))
  );
}

/**
 * Every aggregate the query needs computed per group: the SELECT list's, then any
 * that only a HAVING predicate mentions (`SELECT dept … HAVING COUNT(*) > 2` needs a
 * count nobody selected), each once, keyed by its canonical text.
 */
export function aggregateSpecsOf(ast: SelectStatement): AggregateSpec[] {
  const specs = new Map<string, AggregateSpec>();
  if (ast.select.kind === 'columns') {
    for (const item of ast.select.items) {
      if (item.kind !== 'aggregate') continue;
      const key = selectItemKey(item);
      specs.set(key, { key, fn: item.fn, column: selectItemArgColumn(item) });
    }
  }
  if (ast.having) {
    walkExpr(ast.having, (e) => {
      if (e.kind !== 'aggregate') return;
      const key = aggregateKeyOf(e.fn, e.arg);
      if (!specs.has(key)) specs.set(key, { key, fn: e.fn, column: e.arg.kind === 'star' ? null : columnKey(e.arg) });
    });
  }
  return [...specs.values()];
}

/**
 * Builds the aggregate node — `HashAggregate` by default, or `SortAggregate`
 * when `strategy` says so — for a `SELECT` that groups or aggregates. Shared
 * with `emit.ts`'s progressive plan-tree narration, so the two never drift
 * on how a `SelectItem` becomes an `AggregateSpec`. Nothing in the pipeline
 * picks `strategy` on its own; it defaults to `'hash'` (the shipped
 * behaviour) and only `/compare`'s third mode ever passes `'sort'`, via
 * `EngineOptions.aggregateStrategy` (plan.md §22.2).
 */
export function buildAggregatePlan(
  ast: SelectStatement,
  child: Plan,
  strategy: 'hash' | 'sort' = 'hash',
): Plan {
  const groupBy = ast.groupBy?.columns.map((c) => c.name) ?? [];
  const aggregates = aggregateSpecsOf(ast);
  return { op: strategy === 'sort' ? 'SortAggregate' : 'HashAggregate', groupBy, aggregates, child };
}

/**
 * The algorithm a `JOIN` will actually run. Three of them work on any pair of tables; `index-nested-loop`
 * (plan.md §25.4 B4) needs the inner table to have a B+Tree on the join column, so without one it cannot run
 * and the join is an ordinary `nested-loop` — never an error, and never silent: `emit.ts` says so in the plan.
 */
export function effectiveJoinAlgorithm(
  requested: JoinAlgorithm,
  joinTable: Table | undefined,
  rightColumn: string,
): JoinAlgorithm {
  if (requested !== 'index-nested-loop') return requested;
  // An index whose *leading* column is the join column will do — a composite one that starts with it is entered
  // through that one-column leftmost prefix.
  return joinTable && joinIndexFor(joinTable, rightColumn) ? requested : 'nested-loop';
}

/**
 * Builds the `Join` node for a `FROM t1 JOIN t2 ON ...` — a bare `SeqScan` on
 * each side (v1 never pushes a predicate into either, plan.md §22.2) and the
 * ON equality's two columns resolved to `left`'s side and `right`'s side,
 * whichever order they were written in. The parser's `checkJoinOn` already
 * guarantees both `on` operands are qualified columns; the `kind` check
 * below is just how the type system is told what that check already ensures.
 * Shared with `emit.ts`'s progressive plan-tree narration, like
 * `buildAggregatePlan` already is, so the two never drift. `algorithm`
 * defaults to `'nested-loop'` (the shipped behaviour); only `/compare`'s
 * join mode ever passes another, via `EngineOptions.joinStrategy`. The
 * `index-nested-loop` algorithm replaces the inner scan with an `IndexProbe`,
 * and needs `joinTable` to know the index exists (see `effectiveJoinAlgorithm`).
 */
export function buildJoinPlan(
  join: JoinClause,
  fromTable: string,
  algorithm: JoinAlgorithm = 'nested-loop',
  joinTable?: Table,
): Plan {
  const { left, right } = join.on;
  if (left.kind !== 'column' || right.kind !== 'column') {
    throw new Error('unreachable: checkJoinOn guarantees a JOIN ON is column = column');
  }
  const leftColumn = left.table === fromTable ? left.name : right.name;
  const rightColumn = left.table === join.table.name ? left.name : right.name;
  const effective = effectiveJoinAlgorithm(algorithm, joinTable, rightColumn);
  return {
    op: 'Join',
    algorithm: effective,
    ...(join.joinType ? { joinType: join.joinType } : {}),
    left: { op: 'SeqScan', table: fromTable },
    right:
      effective === 'index-nested-loop'
        ? {
            op: 'IndexProbe',
            table: join.table.name,
            // The index's name: the join column itself for a plain index, the composite's columns joined for one that leads with it.
            column: indexNameOf(joinIndexFor(joinTable!, rightColumn)!.columns),
            outerTable: fromTable,
            outerColumn: leftColumn,
          }
        : { op: 'SeqScan', table: join.table.name },
    leftTable: fromTable,
    rightTable: join.table.name,
    leftColumn,
    rightColumn,
  };
}

/**
 * The `Project` list for a SELECT list. Plain columns and aggregates are read
 * off the row by name; as soon as any item is *computed* (plan.md §25.4 B1b) the
 * whole list becomes expressions — each item is then evaluated, a plain column
 * just being the simplest expression. Shared with `emit.ts`'s narration so the
 * two never disagree.
 */
export function projectListFor(select: SelectStatement['select']): ProjectList {
  if (select.kind === 'star') return { kind: 'star' };
  if (!select.items.some((item) => item.kind === 'expression')) {
    return { kind: 'columns', names: select.items.map(selectItemKey) };
  }
  return {
    kind: 'expressions',
    items: select.items.map((item) => {
      const expr: Expr =
        item.kind === 'expression'
          ? item.expr
          : { kind: 'column', name: item.kind === 'column' ? item.name : selectItemKey(item), ...(item.kind === 'column' && item.table ? { table: item.table } : {}), span: item.span };
      const key = selectItemKey(item);
      return { key, expr, sql: item.kind === 'expression' && item.alias ? `${exprToSql(item.expr)} AS ${item.alias}` : key };
    }),
  };
}

/**
 * The `DISTINCT` node above the projection (plan.md §25.4 B2): a `HashDistinct` by
 * default, a `SortDistinct` when `aggregateStrategy` says `'sort'` — the same
 * option `GROUP BY` reads, so `/compare` can force each side. A sort-based one
 * also needs the query's `ORDER BY` column (the parser has checked it is in the
 * select list): it sorts on that first, so the order the caller asked for survives.
 * Shared with `emit.ts`'s narration.
 */
export function distinctNodeFor(ast: SelectStatement, child: Plan, strategy: 'hash' | 'sort'): Plan {
  if (strategy !== 'sort') return { op: 'HashDistinct', child };
  return {
    op: 'SortDistinct',
    ...(ast.orderBy ? { sortKey: { column: ast.orderBy.column, direction: ast.orderBy.direction } } : {}),
    child,
  };
}

export function buildPlan(
  ast: SelectStatement,
  aggregateStrategy: 'hash' | 'sort' = 'hash',
  joinStrategy: JoinAlgorithm = 'nested-loop',
  joinTable?: Table,
): Plan {
  const scan: Plan = ast.join
    ? buildJoinPlan(ast.join, ast.from.name, joinStrategy, joinTable)
    : { op: 'SeqScan', table: ast.from.name };

  const filtered: Plan = ast.where
    ? { op: 'Filter', predicate: ast.where, child: scan }
    : scan;

  const aggregated: Plan = isAggregateQuery(ast)
    ? buildAggregatePlan(ast, filtered, aggregateStrategy)
    : filtered;

  // HAVING runs after the aggregate, on the groups it produced.
  const having: Plan = ast.having ? { op: 'Having', predicate: ast.having, child: aggregated } : aggregated;

  // ORDER BY and GROUP BY are mutually exclusive (the parser enforces this),
  // so Sort only ever sits above the filtered scan, never above an aggregate.
  const sorted: Plan = ast.orderBy
    ? { op: 'Sort', column: ast.orderBy.column, direction: ast.orderBy.direction, child: having }
    : having;

  const columns = projectListFor(ast.select);

  const projected: Plan = { op: 'Project', columns, child: sorted };
  const distinct = ast.distinct ? distinctNodeFor(ast, projected, aggregateStrategy) : projected;

  return ast.limit === undefined
    ? distinct
    : { op: 'Limit', count: ast.limit.value, ...(ast.limit.offset ? { offset: ast.limit.offset } : {}), child: distinct };
}
