/**
 * Rule-based rewrites. Deterministic, and the rules themselves consult no cost
 * model: index selection fires whenever an equality on the indexed column is
 * present, not when a cheaper plan is costed. The cost *estimates* live in
 * `cost.ts` and are annotated onto the trees by `emit.ts` — they justify the
 * rewrite in the narration without the rule depending on a number §12 would
 * call plausible-but-false.
 *
 * Rules run in order, each on the output of the last, and each produces one
 * `optimize` event carrying the before and after trees.
 */

import type { PredictionPrompt, SqlValue, Table } from '../types.ts';
import { indexSelectionPrompt } from '../predict.ts';
import type { CompareOp, Expr } from '../parser/index.ts';
import { conjoin, conjuncts, equalityOn, exprToSql } from './plan.ts';
import type { Plan } from './plan.ts';
import { ndistinct } from './cost.ts';

export interface Rewrite {
  rule: string;
  /** Narration for the step. */
  label: string;
  plan: Plan;
  /** The Plan objects this rule produced, for highlighting. */
  changed: Set<Plan>;
  /** Asked before the rewrite is revealed. */
  prompt?: PredictionPrompt;
}

type Rule = (plan: Plan, table: Table) => Rewrite | null;

/**
 * `LIMIT` wraps the whole plan (`buildPlan.ts`), outside `Project` — but
 * neither rewrite below cares about it. Stripping it here, and rewrapping the
 * result, means `predicatePushdown` and `indexSelection` stay written against
 * `Project → … → scan`, whether or not a `LIMIT` sits above it.
 */
function unwrapLimit(plan: Plan): { limit: number | null; rest: Plan } {
  return plan.op === 'Limit' ? { limit: plan.count, rest: plan.child } : { limit: null, rest: plan };
}
function rewrapLimit(limit: number | null, plan: Plan): Plan {
  return limit === null ? plan : { op: 'Limit', count: limit, child: plan };
}

/**
 * Same idea for `Sort`, which sits directly under `Project` when `ORDER BY`
 * is present. Neither rewrite touches row order, so both work underneath it
 * exactly as they do without it.
 */
type SortSpec = { column: string; direction: 'asc' | 'desc' };
function unwrapSort(plan: Plan): { sort: SortSpec | null; rest: Plan } {
  return plan.op === 'Sort'
    ? { sort: { column: plan.column, direction: plan.direction }, rest: plan.child }
    : { sort: null, rest: plan };
}
function rewrapSort(sort: SortSpec | null, plan: Plan): Plan {
  return sort === null ? plan : { op: 'Sort', column: sort.column, direction: sort.direction, child: plan };
}

/**
 * Same idea for the aggregate node — `HashAggregate` or `SortAggregate`,
 * whichever strategy built this plan. `Sort` and an aggregate node never both
 * sit above the same `Filter` — `GROUP BY` and `ORDER BY` are mutually
 * exclusive (the parser enforces it) — but unwrapping each independently, in
 * sequence, needs no special case for that: whichever is absent is simply a
 * no-op. WHERE always applies before aggregation in SQL regardless, so
 * pushing a predicate underneath either aggregate strategy is always valid,
 * not a shortcut.
 */
type AggregateNode = Extract<Plan, { op: 'HashAggregate' }> | Extract<Plan, { op: 'SortAggregate' }>;
function unwrapAggregate(plan: Plan): { aggregate: AggregateNode | null; rest: Plan } {
  return plan.op === 'HashAggregate' || plan.op === 'SortAggregate'
    ? { aggregate: plan, rest: plan.child }
    : { aggregate: null, rest: plan };
}
function rewrapAggregate(aggregate: AggregateNode | null, plan: Plan): Plan {
  if (aggregate === null) return plan;
  return aggregate.op === 'HashAggregate'
    ? { op: 'HashAggregate', groupBy: aggregate.groupBy, aggregates: aggregate.aggregates, child: plan }
    : { op: 'SortAggregate', groupBy: aggregate.groupBy, aggregates: aggregate.aggregates, child: plan };
}

/**
 * Statically compares two literals — the same three-valued logic
 * `exec/evaluate.ts`'s `compare` uses at runtime (kept as a small separate
 * copy rather than an import, since `planner/` never depends on `exec/`).
 * NULL on either side is UNKNOWN, not foldable.
 */
function foldLiteralCompare(op: CompareOp, left: SqlValue, right: SqlValue): boolean | null {
  if (left === null || right === null) return null;
  if (typeof left === 'number' && typeof right === 'number') {
    return op === '=' ? left === right : op === '<' ? left < right : left > right;
  }
  const a = typeof left === 'boolean' ? String(Number(left)) : String(left);
  const b = typeof right === 'boolean' ? String(Number(right)) : String(right);
  return op === '=' ? a === b : op === '<' ? a < b : a > b;
}

/**
 * A comparison whose truth value does not depend on the row at all: two
 * literals (`5 > 3`), or the same column compared with itself (`age = age`
 * is always true; `age < age` is always false). Anything else — a column
 * against a literal, or two different columns — depends on the data and
 * cannot be folded. "Same column" checks the table qualifier too: once a
 * JOIN is in play, `authors.id = posts.id` names the *same* column on two
 * *different* tables, and folding that to `true` would be wrong.
 */
function foldComparison(expr: Extract<Expr, { kind: 'compare' }>): 'true' | 'false' | null {
  const { op, left, right } = expr;

  if (left.kind === 'literal' && right.kind === 'literal') {
    const result = foldLiteralCompare(op, left.value, right.value);
    return result === null ? null : result ? 'true' : 'false';
  }

  if (left.kind === 'column' && right.kind === 'column' && left.name === right.name && left.table === right.table) {
    return op === '=' ? 'true' : 'false';
  }

  return null;
}

/**
 * Drops any conjunct that folds to always-true — `X AND true` is just `X`.
 *
 * Deliberately does not act on an always-false conjunct: `X AND false` is
 * `false`, but v0's plan shape has no node for "this scan produces no rows"
 * without inventing one, so a `1 = 2`-shaped clause is left exactly as
 * written. The query still runs correctly either way — this rule only ever
 * removes work that was already redundant, never changes what a query
 * returns.
 */
const constantFolding: Rule = (input) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowSort } = unwrapSort(plan.child);
  const { aggregate, rest: belowProject } = unwrapAggregate(belowSort);
  if (belowProject.op !== 'Filter') return null;

  const parts = conjuncts(belowProject.predicate);
  const alwaysTrue = parts
    .map((p, i) => ({ i, expr: p }))
    .filter(({ expr }) => expr.kind === 'compare' && foldComparison(expr) === 'true');
  if (alwaysTrue.length === 0) return null;

  const dropped = new Set(alwaysTrue.map((f) => f.i));
  const residual = conjoin(parts.filter((_, i) => !dropped.has(i)));

  const rewrittenFilter: Plan = residual
    ? { op: 'Filter', predicate: residual, child: belowProject.child }
    : belowProject.child;
  const root = rewrapLimit(
    limit,
    {
      op: 'Project',
      columns: plan.columns,
      child: rewrapSort(sort, rewrapAggregate(aggregate, rewrittenFilter)),
    },
  );

  const clauses = alwaysTrue.map((f) => `\`${exprToSql(f.expr)}\``).join(', ');
  const verb = alwaysTrue.length === 1 ? 'is' : 'are';
  return {
    rule: 'constant-folding',
    label: residual
      ? `Constant folding: ${clauses} ${verb} always true, whatever the row — it drops out of the predicate, leaving only the part that actually depends on data.`
      : `Constant folding: ${clauses} ${verb} always true, whatever the row — with nothing else in the WHERE clause, the filter disappears entirely.`,
    plan: root,
    changed: new Set<Plan>([rewrittenFilter]),
  };
};

/**
 * Fold `Filter` into the scan beneath it.
 *
 * In a single-table query the filter already sits directly above the scan, so
 * there is nothing to push it *past*. The real move is pushing it *into* the
 * scan: the scan then discards non-matching rows as it reads them, instead of
 * materialising every row for a separate operator to throw away.
 */
const predicatePushdown: Rule = (input) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowSort } = unwrapSort(plan.child);
  const { aggregate, rest: belowProject } = unwrapAggregate(belowSort);
  if (belowProject.op !== 'Filter') return null;
  const scan = belowProject.child;
  if (scan.op !== 'SeqScan' || scan.filter) return null;

  const pushed: Plan = { op: 'SeqScan', table: scan.table, filter: belowProject.predicate };
  const root = rewrapLimit(
    limit,
    { op: 'Project', columns: plan.columns, child: rewrapSort(sort, rewrapAggregate(aggregate, pushed)) },
  );

  return {
    rule: 'predicate-pushdown',
    label:
      'Predicate pushdown: the filter moves into the scan, so rows are discarded as they are read rather than materialised and then thrown away.',
    plan: root,
    changed: new Set<Plan>([pushed]),
  };
};

/** Every table a qualified column reference inside `expr` names. Empty for a literal. */
function tablesReferencedBy(expr: Expr): Set<string> {
  switch (expr.kind) {
    case 'literal':
      return new Set();
    case 'column':
      return expr.table ? new Set([expr.table]) : new Set();
    case 'compare':
    case 'and':
      return new Set([...tablesReferencedBy(expr.left), ...tablesReferencedBy(expr.right)]);
  }
}

/**
 * Clears every column's table qualifier. A conjunct pushed into one side's own
 * `SeqScan` runs against that table's *raw* rows — `{ id: 1, name: 'ada' }`,
 * never `{ 'authors.id': 1, ... }` — qualification only exists to route a
 * `WHERE` clause to the right side before the rewrite, the same way it exists
 * in the SQL text only to route the reference to the right table at parse
 * time. Left qualified, `authors.name = 'ada'` would read `row['authors.name']`
 * off a row that has no such key and silently match nothing.
 */
function stripTableQualifiers(expr: Expr): Expr {
  switch (expr.kind) {
    case 'literal':
      return expr;
    case 'column': {
      if (!expr.table) return expr;
      const { table: _table, ...rest } = expr;
      return rest;
    }
    case 'compare':
      return { ...expr, left: stripTableQualifiers(expr.left), right: stripTableQualifiers(expr.right) };
    case 'and':
      return { ...expr, left: stripTableQualifiers(expr.left), right: stripTableQualifiers(expr.right) };
  }
}

/**
 * Pushes each `WHERE` conjunct that names only one side of a `JOIN` into that
 * side's own `SeqScan` — `predicatePushdown`'s counterpart for a `Join`'s two
 * children instead of a single scan. A conjunct naming both sides can only be
 * evaluated once a row from each side is already paired, so it stays behind
 * as a residual `Filter` above the `Join`; every reference is qualified once
 * a query has a `JOIN` at all (the parser guarantees it), so there is no
 * unqualified conjunct to worry about routing.
 *
 * Deliberately narrow: it does not also run `index-selection` on the side it
 * just filtered — that rule only ever looks at the very top of the tree
 * (`Project → … → SeqScan`), not inside a `Join`'s own children, so a pushed
 * conjunct that happens to match an index still runs as a full scan. Reaching
 * `index-selection` into a `Join`'s children is its own, larger step.
 */
const joinPredicatePushdown: Rule = (input) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowSort } = unwrapSort(plan.child);
  const { aggregate, rest: belowProject } = unwrapAggregate(belowSort);
  if (belowProject.op !== 'Filter') return null;
  const join = belowProject.child;
  if (
    join.op !== 'Join' ||
    join.left.op !== 'SeqScan' ||
    join.left.filter ||
    join.right.op !== 'SeqScan' ||
    join.right.filter
  ) {
    return null;
  }

  const parts = conjuncts(belowProject.predicate);
  const leftParts: Expr[] = [];
  const rightParts: Expr[] = [];
  const residualParts: Expr[] = [];
  for (const part of parts) {
    const tables = tablesReferencedBy(part);
    if (tables.size === 1 && tables.has(join.leftTable)) leftParts.push(part);
    else if (tables.size === 1 && tables.has(join.rightTable)) rightParts.push(part);
    else residualParts.push(part);
  }
  if (leftParts.length === 0 && rightParts.length === 0) return null;

  const newLeft: Plan =
    leftParts.length > 0
      ? { op: 'SeqScan', table: join.leftTable, filter: stripTableQualifiers(conjoin(leftParts)!) }
      : join.left;
  const newRight: Plan =
    rightParts.length > 0
      ? { op: 'SeqScan', table: join.rightTable, filter: stripTableQualifiers(conjoin(rightParts)!) }
      : join.right;
  const newJoin: Plan = { ...join, left: newLeft, right: newRight };
  const residual = conjoin(residualParts);
  const filtered: Plan = residual ? { op: 'Filter', predicate: residual, child: newJoin } : newJoin;

  const root = rewrapLimit(
    limit,
    { op: 'Project', columns: plan.columns, child: rewrapSort(sort, rewrapAggregate(aggregate, filtered)) },
  );

  const pushedSides = [
    leftParts.length > 0 ? join.leftTable : null,
    rightParts.length > 0 ? join.rightTable : null,
  ].filter((t): t is string => t !== null);
  const changed = new Set<Plan>([newJoin, ...(leftParts.length > 0 ? [newLeft] : []), ...(rightParts.length > 0 ? [newRight] : [])]);

  return {
    rule: 'join-predicate-pushdown',
    label: residual
      ? `Predicate pushdown: the part${pushedSides.length === 1 ? '' : 's'} of the WHERE clause naming only ${pushedSides.join(' or only ')} move${pushedSides.length === 1 ? 's' : ''} into that scan; the rest can only be checked once a row from each side is paired, so it stays a residual Filter above the Join.`
      : `Predicate pushdown: every part of the WHERE clause names only one side, so the whole thing moves into ${pushedSides.length === 1 ? 'that scan' : 'the two scans'} — nothing is left to recheck after the Join.`,
    plan: root,
    changed,
  };
};

/**
 * Swap a `SeqScan` for an `IndexScan` when a conjunct is an equality on an
 * indexed column. Conjuncts the index cannot answer stay behind as a
 * recheck — the index narrows the search, it does not verify the whole
 * predicate.
 *
 * A table can declare more than one index (plan.md §22.2's "second candidate
 * index"). When two or more each have a matching equality conjunct, this
 * picks the more selective one — higher `ndistinct`, so an equality on it
 * matches fewer rows on average — the same fact the cost model's own
 * equality-selectivity estimate already rests on, not a new page-cost
 * comparison inside the rule (§12's "plausible but false" line: a rule still
 * consults no cost estimate here, only the data itself). The conjunct that
 * lost stays in the recheck, exactly like every other conjunct the chosen
 * index can't answer — v0 has no way to intersect two index lookups.
 */
const indexSelection: Rule = (input, table) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowSort } = unwrapSort(plan.child);
  const { aggregate, rest: scan } = unwrapAggregate(belowSort);
  if (scan.op !== 'SeqScan' || !scan.filter) return null;

  const parts = conjuncts(scan.filter);
  const candidates = (table.indexedColumns ?? []).flatMap((column) => {
    const matchIndex = parts.findIndex((p) => equalityOn(p, column) !== undefined);
    if (matchIndex === -1) return [];
    return [{ column, matchIndex, key: equalityOn(parts[matchIndex]!, column)! }];
  });
  if (candidates.length === 0) return null;

  const chosen = candidates.reduce((best, c) =>
    ndistinct(table.rows, c.column) > ndistinct(table.rows, best.column) ? c : best,
  );
  const runnersUp = candidates.filter((c) => c !== chosen);

  const residual = conjoin(parts.filter((_, i) => i !== chosen.matchIndex));

  const indexScan: Plan = {
    op: 'IndexScan',
    table: scan.table,
    column: chosen.column,
    key: chosen.key,
    ...(residual ? { residual } : {}),
  };
  const root = rewrapLimit(
    limit,
    {
      op: 'Project',
      columns: plan.columns,
      child: rewrapSort(sort, rewrapAggregate(aggregate, indexScan)),
    },
  );

  const chosenDistinct = ndistinct(table.rows, chosen.column);
  const runnerUpNames = runnersUp.map((c) => `\`${c.column}\``).join(', ');
  const runnerUpDistinct = runnersUp.map((c) => ndistinct(table.rows, c.column));
  const choiceClause =
    runnersUp.length === 0
      ? ''
      : runnerUpDistinct.every((d) => d === chosenDistinct)
        ? ` (tied with ${runnerUpNames} at ${String(chosenDistinct)} distinct values each — \`${chosen.column}\` wins only because it was declared first, not because it narrows the search any further)`
        : ` (chosen over ${runnerUpNames} — ${String(chosenDistinct)} distinct values beats ${runnerUpDistinct.map(String).join('/')}, so it narrows the search more)`;

  return {
    rule: 'index-selection',
    label: residual
      ? `\`${chosen.column}\` is indexed${choiceClause}, so the equality becomes an index lookup. The rest of the predicate cannot be answered by the index and is rechecked on each row the index returns.`
      : `\`${chosen.column}\` is indexed${choiceClause} and the predicate is an equality on it, so the scan becomes a B+Tree lookup — a handful of pages instead of the whole table.`,
    plan: root,
    changed: new Set<Plan>([indexScan]),
    prompt: indexSelectionPrompt(chosen.column, chosen.key),
  };
};

/**
 * When an `IndexScan`'s equality lookup already answers the query outright —
 * every column the SELECT list needs is the indexed column itself, and
 * there is no leftover conjunct to recheck against the row — the leaf's key
 * *is* the answer. Runs after `index-selection`, since it rewrites the
 * `IndexScan` that rule just produced; deliberately narrow (no `Sort` or
 * aggregate node in between) rather than reaching through them the way the
 * earlier rules do, since an index-only result is always exactly one row and
 * there is nothing there yet worth the extra cases.
 */
const indexOnlyScan: Rule = (input) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project' || plan.columns.kind !== 'columns') return null;
  if (plan.child.op !== 'IndexScan' || plan.child.residual) return null;

  const scan = plan.child;
  const onlyIndexedColumn = plan.columns.names.every((name) => name === scan.column);
  if (!onlyIndexedColumn) return null;

  const indexOnly: Plan = { op: 'IndexOnlyScan', table: scan.table, column: scan.column, key: scan.key };
  const root = rewrapLimit(limit, { op: 'Project', columns: plan.columns, child: indexOnly });

  return {
    rule: 'index-only-scan',
    label: `Every column this query needs — \`${scan.column}\` — is already the index key, so the lookup answers it without ever fetching the heap page the pointer names.`,
    plan: root,
    changed: new Set<Plan>([indexOnly]),
  };
};

const RULES: { name: string; apply: Rule }[] = [
  { name: 'constant-folding', apply: constantFolding },
  { name: 'predicate-pushdown', apply: predicatePushdown },
  { name: 'join-predicate-pushdown', apply: joinPredicatePushdown },
  { name: 'index-selection', apply: indexSelection },
  { name: 'index-only-scan', apply: indexOnlyScan },
];

/** Every rewrite rule's name, in the order the optimizer runs them. */
export const OPTIMIZER_RULES: readonly string[] = RULES.map((r) => r.name);

/**
 * Applies every enabled rule that fires, in order. Returns each step for
 * animation.
 *
 * `enabled` defaults to all rules — the pipeline (`emit.ts`) never passes it.
 * `/tools/planner` (plan.md §22.3) passes a subset so a rule can be toggled
 * off and its effect on the plan watched.
 */
export function optimize(
  plan: Plan,
  table: Table,
  enabled: ReadonlySet<string> = new Set(OPTIMIZER_RULES),
): Rewrite[] {
  const steps: Rewrite[] = [];
  let current = plan;

  for (const { name, apply } of RULES) {
    if (!enabled.has(name)) continue;
    const rewrite = apply(current, table);
    if (!rewrite) continue;
    steps.push(rewrite);
    current = rewrite.plan;
  }

  return steps;
}

/** The predicate a scan will evaluate, whatever form it ended up in. */
export function scanPredicate(plan: Plan): Expr | undefined {
  if (plan.op === 'SeqScan') return plan.filter;
  if (plan.op === 'IndexScan') return plan.residual;
  return plan.op === 'Filter' ||
    plan.op === 'HashAggregate' ||
    plan.op === 'SortAggregate' ||
    plan.op === 'Sort' ||
    plan.op === 'Project' ||
    plan.op === 'Limit'
    ? scanPredicate(plan.child)
    : undefined;
}
