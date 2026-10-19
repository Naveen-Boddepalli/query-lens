/**
 * AST → canonical logical plan, built bottom-up:
 *
 *   Limit n                          -- only when there is a LIMIT
 *     └─ Project [columns]
 *          └─ Sort key [ASC|DESC]    -- only when there is an ORDER BY
 *               └─ Having / Aggregate     -- only when the query groups
 *                    └─ Filter (predicate)     -- only when there is a WHERE
 *                         └─ SeqScan table
 *
 * This is the *unoptimised* shape on purpose. It is a direct, obvious
 * translation of the query text, which is what makes the optimizer's rewrite
 * legible when the two are shown side by side.
 */

import type { DeleteStatement, Expr, JoinClause, SelectStatement, SemiJoinClause, UpdateStatement } from '../parser/index.ts';
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
 * count nobody selected), then an ORDER BY's (`… ORDER BY SUM(amount) DESC`, plan.md
 * §26 Feature 1 slice a), each once, keyed by its canonical text.
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
  const sortBy = ast.orderBy?.aggregate;
  if (sortBy && !specs.has(ast.orderBy!.column)) {
    specs.set(ast.orderBy!.column, { key: ast.orderBy!.column, fn: sortBy.fn, column: sortBy.arg.kind === 'star' ? null : columnKey(sortBy.arg) });
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
  // A joined row is keyed `table.column` (plan.md §26 Feature 1, slice c), so a qualified group column's key is that.
  const groupBy = ast.groupBy?.columns.map(columnKey) ?? [];
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
  joinType?: JoinClause['joinType'],
): JoinAlgorithm {
  // A cross join has no key: nested-loop is the only way to pair every row with every row (plan.md §27.5 S4).
  if (joinType === 'cross') return 'nested-loop';
  if (requested !== 'index-nested-loop') return requested;
  // RIGHT and FULL keep the inner rows nothing matched — which a probe never visits, so it gives way to a nested-loop.
  if (joinType === 'right' || joinType === 'full') return 'nested-loop';
  // An index whose *leading* column is the join column will do — a composite one that starts with it is entered
  // through that one-column leftmost prefix.
  return joinTable && joinIndexFor(joinTable, rightColumn) ? requested : 'nested-loop';
}

/**
 * Builds the whole `Join` chain for `FROM t1 JOIN t2 ON … [JOIN t3 ON …]…` (plan.md §25.4 C3 slice b) — left-deep,
 * one `Join` node per clause, each nesting the previous one as its `left`. A bare `SeqScan` starts the fold, and
 * each step adds a bare `SeqScan` (or, for `index-nested-loop`, an `IndexProbe`) on the one table its own clause
 * introduces — v1 never pushes a predicate into any scan here, plan.md §22.2 — with the ON equality's two columns
 * resolved to whichever side is the new table and whichever is a table already in the chain, whichever order they
 * were written in. `checkJoinOn`/`checkJoinChain` already guarantee this at parse time; the `kind` check below is
 * just how the type system is told what that already ensures. Shared with `emit.ts`'s progressive plan-tree
 * narration, like `buildAggregatePlan` already is, so the two never drift. `algorithm` defaults to `'nested-loop'`
 * (the shipped behaviour); only `/compare`'s join mode ever passes another, via `EngineOptions.joinStrategy` — the
 * same one for every step, though `index-nested-loop` still falls back per step (see `effectiveJoinAlgorithm`)
 * whenever that step's own table has no usable index. For a single join this is exactly the old two-table shape.
 */
export function buildJoinPlan(
  joins: readonly JoinClause[],
  fromTable: string,
  algorithm: JoinAlgorithm = 'nested-loop',
  joinTables?: Record<string, Table>,
): Plan {
  let plan: Plan = { op: 'SeqScan', table: fromTable };
  let previous = fromTable;
  for (const join of joins) {
    // A cross join (plan.md §27.5 S4) has no ON: every row of the chain so far with every row of its table.
    if (!join.on) {
      plan = {
        op: 'Join',
        algorithm: 'nested-loop',
        joinType: 'cross',
        left: plan,
        right: { op: 'SeqScan', table: join.table.name },
        leftTable: previous,
        rightTable: join.table.name,
        leftColumn: '',
        rightColumn: '',
      };
      previous = join.table.name;
      continue;
    }
    const { left, right } = join.on;
    if (left.kind !== 'column' || right.kind !== 'column') {
      throw new Error('unreachable: checkJoinOn guarantees a JOIN ON is column = column');
    }
    const newTable = join.table.name;
    // checkJoinChain already guarantees exactly one side names newTable and the other a table already in scope.
    const newTableIsLeftOperand = left.table === newTable;
    const rightColumn = newTableIsLeftOperand ? left.name : right.name;
    const leftColumn = newTableIsLeftOperand ? right.name : left.name;
    const leftTable = (newTableIsLeftOperand ? right.table : left.table)!;
    const joinTable = joinTables?.[newTable];
    const effective = effectiveJoinAlgorithm(algorithm, joinTable, rightColumn, join.joinType);
    plan = {
      op: 'Join',
      algorithm: effective,
      ...(join.joinType ? { joinType: join.joinType } : {}),
      left: plan,
      right:
        effective === 'index-nested-loop'
          ? {
              op: 'IndexProbe',
              table: newTable,
              // The index's name: the join column itself for a plain index, the composite's columns joined for one that leads with it.
              column: indexNameOf(joinIndexFor(joinTable!, rightColumn)!.columns),
              outerTable: leftTable,
              outerColumn: leftColumn,
            }
          : { op: 'SeqScan', table: newTable },
      leftTable,
      rightTable: newTable,
      leftColumn,
      rightColumn,
    };
    previous = newTable;
  }
  return plan;
}

/**
 * One correlated `[NOT] EXISTS` as a semi-join or anti-join on top of `plan` (plan.md §27.5 S1) — the outer query's
 * rows so far on the left, a scan (or, for `index-nested-loop`, a probe) of the subquery's table on the right, joined
 * on the correlation equality. The subquery's own conditions on its own table filter that scan as it reads — they
 * are its `WHERE`, not the outer query's — so a probe, which has nowhere to put them, gives way to a nested-loop the
 * way `effectiveJoinAlgorithm` already does without an index. Anything naming both tables is the join's `residual`.
 * Shared with `emit.ts`'s narration, like `buildJoinPlan`.
 */
export function buildSemiJoin(
  plan: Plan,
  sj: SemiJoinClause,
  algorithm: JoinAlgorithm = 'nested-loop',
  joinTables?: Record<string, Table>,
): Extract<Plan, { op: 'Join' }> {
  const innerTable = joinTables?.[sj.table.name];
  const requested = sj.innerFilter && algorithm === 'index-nested-loop' ? 'nested-loop' : algorithm;
  const effective = effectiveJoinAlgorithm(requested, innerTable, sj.innerColumn);
  return {
    op: 'Join',
    algorithm: effective,
    joinType: sj.kind,
    left: plan,
    right:
      effective === 'index-nested-loop'
        ? {
            op: 'IndexProbe',
            table: sj.table.name,
            column: indexNameOf(joinIndexFor(innerTable!, sj.innerColumn)!.columns),
            outerTable: sj.outerTable,
            outerColumn: sj.outerColumn,
          }
        : { op: 'SeqScan', table: sj.table.name, ...(sj.innerFilter ? { filter: sj.innerFilter } : {}) },
    leftTable: sj.outerTable,
    rightTable: sj.table.name,
    leftColumn: sj.outerColumn,
    rightColumn: sj.innerColumn,
    ...(sj.residual ? { residual: sj.residual } : {}),
  };
}

/** `plan` with every semi- and anti-join `ast` carries stacked on top, in source order (plan.md §27.5 S1). */
export function withSemiJoins(
  plan: Plan,
  ast: SelectStatement,
  algorithm: JoinAlgorithm = 'nested-loop',
  joinTables?: Record<string, Table>,
): Plan {
  return (ast.semiJoins ?? []).reduce<Plan>((below, sj) => buildSemiJoin(below, sj, algorithm, joinTables), plan);
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
  joinTables?: Record<string, Table>,
): Plan {
  const joined: Plan =
    ast.joins && ast.joins.length > 0
      ? buildJoinPlan(ast.joins, ast.from.name, joinStrategy, joinTables)
      : { op: 'SeqScan', table: ast.from.name };
  // A correlated EXISTS is a semi-join on top of every JOIN (plan.md §27.5 S1): it only keeps or drops rows.
  const scan = withSemiJoins(joined, ast, joinStrategy, joinTables);

  const filtered: Plan = ast.where
    ? { op: 'Filter', predicate: ast.where, child: scan }
    : scan;

  const aggregated: Plan = isAggregateQuery(ast)
    ? buildAggregatePlan(ast, filtered, aggregateStrategy)
    : filtered;

  // HAVING runs after the aggregate, on the groups it produced.
  const having: Plan = ast.having ? { op: 'Having', predicate: ast.having, child: aggregated } : aggregated;

  // ORDER BY runs after grouping (plan.md §26 Feature 1, slice a): above an aggregate it sorts the groups, by a
  // grouped column or an aggregate's key, which is what the aggregate's output rows are keyed by.
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
