import type { Emit } from '../trace.ts';
import type { JoinAlgorithm, Table } from '../types.ts';
import type { SelectStatement } from '../parser/index.ts';
import { buildAggregatePlan, buildJoinPlan, buildPlan, distinctNodeFor, isAggregateQuery, projectListFor } from './buildPlan.ts';
import { estimatePlan, rootEstimate } from './cost.ts';
import { costOfOrder, joinGraphFromAst, runJoinOrderDP, writtenOrderFromAst } from './joinOrder.ts';
import { leftmostPrefixNote, optimize } from './optimize.ts';
import { exprToSql, joinsIn, subqueryResolutionNotes, toPlanDisplay } from './plan.ts';
import type { Plan, ProjectList } from './plan.ts';

/**
 * Emits the planner and optimizer stages, and returns the final plan for the
 * executor to run. The plan is built bottom-up one operator at a time so the
 * tree can be watched growing, the same way the AST was.
 *
 * Every emitted tree carries the cost model's per-node estimates (plan.md
 * §22.2), which is also why `rowsPerPage` is threaded down: a scan's estimated
 * page count depends on it. `joinTables` is every `JOIN`'d table's own data,
 * keyed by name, needed only so the cost model can estimate that side of each
 * `Join` too — `undefined` for every query without one.
 */
/** Does any node of `plan` read through an index? */
function usesIndex(plan: Plan): boolean {
  if (plan.op === 'IndexScan' || plan.op === 'IndexRangeScan' || plan.op === 'IndexOnlyScan' || plan.op === 'IndexProbe') return true;
  if (plan.op === 'Join') return usesIndex(plan.left) || usesIndex(plan.right);
  return 'child' in plan ? usesIndex(plan.child) : false;
}

/** A join algorithm as a phrase for the "nothing to rewrite" note. */
function describeJoin(algorithm: JoinAlgorithm, outer: string, inner: string): string {
  switch (algorithm) {
    case 'hash':
      return 'a hash join over two full scans';
    case 'sort-merge':
      return 'a sort-merge join over two full scans';
    case 'index-nested-loop':
      return `an index nested-loop join — a full scan of ${outer}, then a B+Tree probe of ${inner} for each row`;
    case 'nested-loop':
      return 'a nested-loop join over two full scans';
  }
}

export function emitPlanEvents(
  emit: Emit,
  ast: SelectStatement,
  table: Table,
  rowsPerPage: number,
  aggregateStrategy: 'hash' | 'sort' = 'hash',
  joinTables?: Record<string, Table>,
  joinStrategy: JoinAlgorithm = 'nested-loop',
): Plan {
  // Every table this query names, keyed by name — including `table` itself. A single join only ever needed the
  // *other* one (the recursion's own `table` param always being the right one to check first), but a chain
  // (plan.md §25.4 C3 slice b) re-derives that check at every nesting level against whatever table THAT level's
  // own `Join` node concerns — which is `table` (the original FROM table) again once the recursion reaches the
  // bottom of the chain — so `table.name` has to resolve through this same map at every depth, not just the top.
  const otherTables = joinTables && Object.keys(joinTables).length > 0 ? { ...joinTables, [table.name]: table } : undefined;
  const display = (plan: Plan, changed?: ReadonlySet<Plan>) =>
    toPlanDisplay(plan, changed, estimatePlan(plan, table, rowsPerPage, otherTables));

  const leftScan: Plan = { op: 'SeqScan', table: ast.from.name };
  emit(
    `Start at the bottom: every plan begins by reading a table, so the base of the tree is a sequential scan of \`${ast.from.name}\`.`,
    { stage: 'plan', planTree: display(leftScan) },
  );

  let current: Plan = leftScan;

  const allJoins = ast.joins ?? [];
  for (let i = 0; i < allJoins.length; i++) {
    const join = allJoins[i]!;
    // Rebuilt from scratch each step (cheap — a handful of tables at most) rather than grown incrementally, so this
    // stays the one place that knows how to fold a JOIN chain and never drifts from `buildJoinPlan` itself.
    current = buildJoinPlan(allJoins.slice(0, i + 1), ast.from.name, joinStrategy, joinTables);
    const j = current as Extract<Plan, { op: 'Join' }>;
    const algorithm = j.algorithm;
    // Asked for an index join, but this step's inner table has no index on the join column: say so, and run the plain one.
    const fallback =
      joinStrategy === 'index-nested-loop' && algorithm !== 'index-nested-loop'
        ? `You asked for an index nested-loop join, but \`${join.table.name}\` has no index on \`${j.rightColumn}\` for it to probe — so this runs as an ordinary nested-loop. `
        : '';
    const mechanism =
      algorithm === 'index-nested-loop'
        ? `for every row \`${j.leftTable}\` produces, it descends \`${j.rightTable}\`'s B+Tree on \`${j.rightColumn}\` with that row's \`${j.leftColumn}\` — a few page reads per outer row instead of a rescan of the whole inner table, which is why a small outer over a big indexed inner is where this algorithm wins`
        : algorithm === 'hash'
        ? `it builds an in-memory hash table over all of \`${j.rightTable}\`, keyed on \`${j.rightColumn}\`, once — then probes it with each \`${j.leftTable}\` row's \`${j.leftColumn}\`, reading \`${j.rightTable}\` exactly once regardless of how many rows \`${j.leftTable}\` has`
        : algorithm === 'sort-merge'
          ? `it sorts both \`${j.leftTable}\` and \`${j.rightTable}\` on the join key, then merges the two sorted lists in a single pass — no per-row rescan and no table held in memory, at the cost of sorting both sides first`
          : `for every row \`${j.leftTable}\` produces, it rescans all of \`${j.rightTable}\` looking for a match on \`${j.leftColumn}\` = \`${j.rightColumn}\` — nested-loop, the simplest join algorithm, and the most expensive once neither side has an index to speed the inner scan up`;
    const outer = join.joinType === 'left'
      ? ` This is a LEFT JOIN: every row from \`${j.leftTable}\` survives even when nothing on \`${j.rightTable}\` matches it, with \`${j.rightTable}\`'s columns NULL.`
      : '';
    emit(
      `${fallback}JOIN adds ${algorithm === 'index-nested-loop' ? 'an index probe on' : 'a second scan of'} \`${j.rightTable}\` and a Join above ${i === 0 ? 'that' : 'the chain so far'}: ${mechanism}.${outer}`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  // A second opinion on join *order* (plan.md §25.4 C4), for two or more JOINs only — a single one has no other
  // order to consider. Deliberately informational: this never changes `current` or what actually executes, only
  // what gets said about it — the same "estimate beside the real plan, never a decision" stance C1's stats and
  // C2's q-error already take. `/tools/join-order` is the same search, with the whole subset lattice visible.
  if (allJoins.length >= 2 && joinTables) {
    const allTables: Record<string, Table> = { ...joinTables, [table.name]: table };
    const { nodes, edges } = joinGraphFromAst(ast, allTables, rowsPerPage);
    const dp = runJoinOrderDP(nodes, edges);
    const written = writtenOrderFromAst(ast);
    const writtenCost = costOfOrder(nodes, edges, written);
    const ratio = writtenCost.pages / dp.winner.pages;
    emit(
      ratio >= 1.05
        ? `A cost-based join-order search (a second opinion, not a rewrite — plan.md §25.4 C4) would instead join these ${String(nodes.length)} tables as ${dp.winner.tables.join(' → ')}: an estimated ${String(dp.winner.pages)} pages, against the ${String(writtenCost.pages)} the order actually written above costs — about ${ratio.toFixed(1)}× cheaper. This query still runs in the order it was written; nothing here changes that.`
        : `A cost-based join-order search (plan.md §25.4 C4) agrees with the order written above — among left-deep orderings of these ${String(nodes.length)} tables, this is already about as cheap as it gets.`,
      { stage: 'plan', planTree: display(current) },
    );
  }

  if (ast.where) {
    current = { op: 'Filter', predicate: ast.where, child: current };
    const subqueryNotes = subqueryResolutionNotes(ast.where);
    emit(
      `The WHERE clause becomes a Filter sitting above the scan: \`${exprToSql(ast.where)}\`.${
        subqueryNotes.length > 0 ? ` ${subqueryNotes.map((n) => `${n[0]!.toUpperCase()}${n.slice(1)}.`).join(' ')}` : ''
      }`,
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

  if (ast.distinct) {
    current = distinctNodeFor(ast, current, aggregateStrategy);
    emit(
      aggregateStrategy === 'sort'
        ? `DISTINCT becomes a SortDistinct above the Project: it sorts every projected row${ast.orderBy ? ` (by \`${ast.orderBy.column}\` first, so your ORDER BY survives)` : ''} — spilling through the buffer pool exactly as ORDER BY's Sort does — so equal rows sit next to each other, then keeps one of each run. Like Sort it cannot produce a row until it has seen all of them.`
        : 'DISTINCT becomes a HashDistinct above the Project: it remembers every row it has passed in an in-memory hash set and drops a repeat the moment it sees one. It streams — the first new row comes out immediately, and a LIMIT above it can stop the scan early.',
      { stage: 'plan', planTree: display(current) },
    );
  }

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
  const canonical = buildPlan(ast, aggregateStrategy, joinStrategy, joinTables);
  let optimised = canonical;
  let before = canonical;

  for (const step of optimize(canonical, table, rowsPerPage)) {
    emit(
      (step.rule === 'index-selection' ||
        step.rule === 'range-index-selection' ||
        step.rule === 'index-only-scan') &&
        step.changed.size > 0
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
    const chainJoins = joinsIn(canonical);
    const note =
      chainJoins.length === 1
        ? `No rewrite rule applies to this JOIN — ${describeJoin(chainJoins[0]!.algorithm, chainJoins[0]!.leftTable, chainJoins[0]!.rightTable)} is what runs.`
        : chainJoins.length > 1
          ? `No rewrite rule applies to this chain of ${String(chainJoins.length)} JOINs — ${chainJoins
              .map((j) => `\`${j.leftTable}\` × \`${j.rightTable}\` runs as ${describeJoin(j.algorithm, j.leftTable, j.rightTable)}`)
              .join('; ')}.`
          : ast.where
            ? `The cost model estimates about ${plural(rows, 'row')} out of ${String(table.rows.length)}, and no access path beats reading the table.${
                leftmostPrefixNote(table, ast.where) ? ` ${leftmostPrefixNote(table, ast.where)!}` : ''
              }`
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

  // Rules fired, but none of them could use an index the table has: if that is because a composite index cannot be
  // entered, say so here — the "nothing fired" note above never runs once, say, predicate pushdown has.
  if (optimised !== canonical && allJoins.length === 0 && !usesIndex(optimised)) {
    const unusable = leftmostPrefixNote(table, ast.where);
    if (unusable) {
      emit(`No index is used. ${unusable}`, {
        stage: 'optimize',
        rule: 'none',
        before: display(optimised),
        after: display(optimised),
      });
    }
  }

  return optimised;

  /**
   * Appends the scan-vs-index page estimate that makes an accepted rewrite's cost visible, not just asserted. Only
   * ever called for a step that actually changed the plan: `index-selection` and `range-index-selection` already
   * decline anything that would not be cheaper (plan.md §25.4 C5 — see their own doc comments in `optimize.ts`), and
   * `index-only-scan` only ever narrows an `IndexScan` the gate already accepted, never chosen on its own, so it can
   * only be cheaper still. The comparison below is therefore always a confirmation, never a surprise — a second,
   * independent read of the same numbers `optimize.ts`'s own gate already compared, not a competing judgment.
   */
  function withCostJustification(label: string, chosen: Plan): string {
    const scanPages = Math.max(1, Math.ceil(table.rows.length / rowsPerPage));
    const rows = rootEstimate(canonical, table, rowsPerPage, otherTables).estRows;
    const indexPages = rootEstimate(chosen, table, rowsPerPage, otherTables).estPages;
    const facts = `the sequential scan reads all ${String(scanPages)} pages to return about ${plural(rows, 'row')}; the index lookup reads about ${String(indexPages)}`;
    return `${label} Estimated cost agrees: ${facts}.`;
  }
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
