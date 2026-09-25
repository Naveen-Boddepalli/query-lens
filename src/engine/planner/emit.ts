import type { Emit } from '../trace.ts';
import type { Table } from '../types.ts';
import type { SelectStatement } from '../parser/index.ts';
import { buildAggregatePlan, buildJoinPlan, buildPlan, isAggregateQuery, projectListFor } from './buildPlan.ts';
import { estimatePlan, rootEstimate } from './cost.ts';
import { optimize } from './optimize.ts';
import { exprToSql, toPlanDisplay } from './plan.ts';
import type { Plan, ProjectList } from './plan.ts';

/**
 * Emits the planner and optimizer stages, and returns the final plan for the
 * executor to run. The plan is built bottom-up one operator at a time so the
 * tree can be watched growing, the same way the AST was.
 *
 * Every emitted tree carries the cost model's per-node estimates (plan.md
 * §22.2), which is also why `rowsPerPage` is threaded down: a scan's estimated
 * page count depends on it. `joinTable` is the `JOIN`'d table's own data,
 * needed only so the cost model can estimate that side of a `Join` too —
 * `undefined` for every query without one.
 */
export function emitPlanEvents(
  emit: Emit,
  ast: SelectStatement,
  table: Table,
  rowsPerPage: number,
  aggregateStrategy: 'hash' | 'sort' = 'hash',
  joinTable?: Table,
  joinStrategy: 'nested-loop' | 'hash' | 'sort-merge' = 'nested-loop',
): Plan {
  const otherTables = joinTable ? { [joinTable.name]: joinTable } : undefined;
  const display = (plan: Plan, changed?: ReadonlySet<Plan>) =>
    toPlanDisplay(plan, changed, estimatePlan(plan, table, rowsPerPage, otherTables));

  const leftScan: Plan = { op: 'SeqScan', table: ast.from.name };
  emit(
    `Start at the bottom: every plan begins by reading a table, so the base of the tree is a sequential scan of \`${ast.from.name}\`.`,
    { stage: 'plan', planTree: display(leftScan) },
  );

  let current: Plan = leftScan;

  if (ast.join) {
    current = buildJoinPlan(ast.join, ast.from.name, joinStrategy);
    const join = current.op === 'Join' ? current : undefined;
    const mechanism =
      joinStrategy === 'hash'
        ? `it builds an in-memory hash table over all of \`${ast.join.table.name}\`, keyed on \`${join?.rightColumn}\`, once — then probes it with each \`${ast.from.name}\` row's \`${join?.leftColumn}\`, reading \`${ast.join.table.name}\` exactly once regardless of how many rows \`${ast.from.name}\` has`
        : joinStrategy === 'sort-merge'
          ? `it sorts both \`${ast.from.name}\` and \`${ast.join.table.name}\` on the join key, then merges the two sorted lists in a single pass — no per-row rescan and no table held in memory, at the cost of sorting both sides first`
          : `for every row \`${ast.from.name}\` produces, it rescans all of \`${ast.join.table.name}\` looking for a match on \`${join?.leftColumn}\` = \`${join?.rightColumn}\` — nested-loop, the simplest join algorithm, and the most expensive once neither side has an index to speed the inner scan up`;
    emit(
      `JOIN adds a second scan of \`${ast.join.table.name}\` and a Join above both: ${mechanism}.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  if (ast.where) {
    current = { op: 'Filter', predicate: ast.where, child: current };
    emit(
      `The WHERE clause becomes a Filter sitting above the scan: \`${exprToSql(ast.where)}\`.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  if (isAggregateQuery(ast)) {
    current = buildAggregatePlan(ast, current, aggregateStrategy);
    const groupBy = ast.groupBy?.columns.map((c) => c.name) ?? [];
    const aggregateLabels =
      current.op === 'HashAggregate' || current.op === 'SortAggregate'
        ? current.aggregates.map((a) => a.key).join(', ')
        : '';
    const nodeName = aggregateStrategy === 'sort' ? 'SortAggregate' : 'HashAggregate';
    const mechanism =
      aggregateStrategy === 'sort'
        ? `by sorting on ${groupBy.join(', ') || 'nothing'} first — spilling through the buffer pool exactly as ORDER BY's Sort does — then collapsing runs of equal keys in one pass`
        : 'with a hash table keyed on the group';
    emit(
      groupBy.length > 0
        ? `GROUP BY becomes a ${nodeName} above that: rows are grouped by ${groupBy.join(', ')}${
            aggregateLabels ? `, computing ${aggregateLabels} per group` : ''
          }, ${mechanism}. Like Sort, it cannot produce a row until it has seen every one — the last group is not known to be complete until the input runs out.`
        : `${aggregateLabels} becomes a ${nodeName} above that: with no GROUP BY, the whole table is one group, so it collapses every row into one${
            aggregateStrategy === 'sort' ? ', sorting first even though there is only ever one group to produce' : ''
          }. Like Sort, it cannot produce a row until it has seen all of them.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  if (ast.having) {
    current = { op: 'Having', predicate: ast.having, child: current };
    emit(
      `HAVING becomes a Having filter above the aggregate: \`${exprToSql(ast.having)}\` is tested on each finished group, after its aggregates are computed. That is the difference from WHERE, which filters rows *before* they are grouped and so can never mention an aggregate.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  if (ast.orderBy) {
    current = {
      op: 'Sort',
      column: ast.orderBy.column,
      direction: ast.orderBy.direction,
      child: current,
    };
    emit(
      `ORDER BY becomes a Sort above that: every row, ordered by \`${ast.orderBy.column}\` ${
        ast.orderBy.direction === 'asc' ? 'ascending' : 'descending'
      }. Unlike everything below it, Sort cannot produce a row until it has seen all of them.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  const columns: ProjectList = projectListFor(ast.select);

  current = { op: 'Project', columns, child: current };
  emit(
    columns.kind === 'star'
      ? 'The SELECT list becomes a Project on top. `*` keeps every column, so it passes rows through unchanged.'
      : columns.kind === 'columns'
        ? `The SELECT list becomes a Project on top, keeping ${columns.names.join(', ')}.`
        : `The SELECT list becomes a Project on top that *computes* each item for every row: ${columns.items
            .map((i) => `\`${i.sql}\``)
            .join(', ')}. Arithmetic on a NULL is NULL, and dividing by zero gives NULL.`,
    { stage: 'plan', planTree: display(current) },
  );

  if (ast.limit !== undefined) {
    const count = ast.limit.value;
    const offset = ast.limit.offset ?? 0;
    current = { op: 'Limit', count, ...(offset > 0 ? { offset } : {}), child: current };
    emit(
      offset > 0
        ? `LIMIT ... OFFSET becomes a Limit on top: it discards the first ${plural(offset, 'row')} that come through, then passes ${plural(count, 'row')} and stops. The discarded rows are still produced by everything beneath — an OFFSET saves the client nothing, only the network.`
        : `LIMIT becomes a Limit on top: it stops pulling rows once ${plural(count, 'row')} ${
            count === 1 ? 'has' : 'have'
          } come through — whatever is beneath it is never asked for the rest.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  // The canonical plan is a direct translation of the query text. Everything
  // below is the optimizer earning its keep.
  const canonical = buildPlan(ast, aggregateStrategy, joinStrategy);
  let optimised = canonical;
  let before = canonical;

  for (const step of optimize(canonical, table)) {
    emit(
      step.rule === 'index-selection' ||
        step.rule === 'range-index-selection' ||
        step.rule === 'index-only-scan'
        ? withCostJustification(step.label, step.plan)
        : step.label,
      {
        stage: 'optimize',
        rule: step.rule,
        before: display(before),
        after: display(step.plan, step.changed),
      },
      step.prompt ? { predictable: step.prompt } : undefined,
    );
    before = step.plan;
    optimised = step.plan;
  }

  if (optimised === canonical) {
    const rows = rootEstimate(canonical, table, rowsPerPage, otherTables).estRows;
    const note = ast.join
      ? `No rewrite rule reaches into a JOIN yet — ${joinStrategy === 'hash' ? 'a hash join over two full scans' : 'nested-loop over two full scans'} is what runs.`
      : ast.where
        ? `The cost model estimates about ${plural(rows, 'row')} out of ${String(table.rows.length)}, and no access path beats reading the table.`
        : 'With no WHERE there is nothing to narrow the scan — every row is returned.';
    emit(
      `No rewrite rule fires on this plan — the optimizer leaves it exactly as written. ${note}`,
      {
        stage: 'optimize',
        rule: 'none',
        before: display(canonical),
        after: display(canonical),
      },
    );
  }

  return optimised;

  /** Appends the scan-vs-index page estimate that makes the rewrite a decision, not a reflex. */
  function withCostJustification(label: string, chosen: Plan): string {
    const scanPages = Math.max(1, Math.ceil(table.rows.length / rowsPerPage));
    const rows = rootEstimate(canonical, table, rowsPerPage, otherTables).estRows;
    const indexPages = rootEstimate(chosen, table, rowsPerPage, otherTables).estPages;
    return `${label} Estimated cost decides it: the sequential scan reads all ${String(scanPages)} pages to return about ${plural(rows, 'row')}; the index lookup reads about ${String(indexPages)}.`;
  }
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
