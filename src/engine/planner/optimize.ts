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
import { indexSelectionPrompt, leftmostPrefixPrompt } from '../predict.ts';
import { describeKeys as describeKeysText } from '../index/lookup.ts';
import { columnsOfIndex, indexNameOf, indexSpecsOf } from '../index/spec.ts';
import { mapChildren, walkExpr } from '../parser/index.ts';
import { arithmetic, negate } from '../value.ts';
import type { CompareOp, Expr } from '../parser/index.ts';
import { conjoin, conjuncts, equalityOn, exprToSql, formatRangeBounds, lookupText, rangeOn } from './plan.ts';
import type { Plan, RangeBound } from './plan.ts';
import { boundedRangeSelectivity, ndistinct } from './cost.ts';

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
type LimitSpec = { count: number; offset: number };
type DistinctNode = Extract<Plan, { op: 'HashDistinct' }> | Extract<Plan, { op: 'SortDistinct' }>;
/** Everything wrapped *around* the `Project`: an optional `Limit` above an optional `DISTINCT` (plan.md §25.4 B2). */
type TopSpec = { limit: LimitSpec | null; distinct: DistinctNode | null };
function unwrapLimit(plan: Plan): { limit: TopSpec | null; rest: Plan } {
  let rest = plan;
  let limit: LimitSpec | null = null;
  let distinct: DistinctNode | null = null;
  if (rest.op === 'Limit') {
    limit = { count: rest.count, offset: rest.offset ?? 0 };
    rest = rest.child;
  }
  if (rest.op === 'HashDistinct' || rest.op === 'SortDistinct') {
    distinct = rest;
    rest = rest.child;
  }
  return { limit: limit === null && distinct === null ? null : { limit, distinct }, rest };
}
function rewrapLimit(top: TopSpec | null, plan: Plan): Plan {
  if (top === null) return plan;
  let out = plan;
  if (top.distinct) {
    out = top.distinct.op === 'HashDistinct'
      ? { op: 'HashDistinct', child: out }
      : { op: 'SortDistinct', ...(top.distinct.sortKey ? { sortKey: top.distinct.sortKey } : {}), child: out };
  }
  if (top.limit) {
    out = { op: 'Limit', count: top.limit.count, ...(top.limit.offset > 0 ? { offset: top.limit.offset } : {}), child: out };
  }
  return out;
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
/**
 * The aggregate node together with the `Having` (plan.md §25.4 B2) that may sit
 * directly above it. The rules treat the pair as one unit, so a WHERE
 * predicate is still pushed *below* it and a HAVING is never touched.
 */
type AggregateChain = { node: AggregateNode; having: Extract<Plan, { op: 'Having' }> | null };
function unwrapAggregate(plan: Plan): { aggregate: AggregateChain | null; rest: Plan } {
  if (plan.op === 'Having' && (plan.child.op === 'HashAggregate' || plan.child.op === 'SortAggregate')) {
    return { aggregate: { node: plan.child, having: plan }, rest: plan.child.child };
  }
  return plan.op === 'HashAggregate' || plan.op === 'SortAggregate'
    ? { aggregate: { node: plan, having: null }, rest: plan.child }
    : { aggregate: null, rest: plan };
}
function rewrapAggregate(aggregate: AggregateChain | null, plan: Plan): Plan {
  if (aggregate === null) return plan;
  const { node, having } = aggregate;
  const rebuilt: Plan =
    node.op === 'HashAggregate'
      ? { op: 'HashAggregate', groupBy: node.groupBy, aggregates: node.aggregates, child: plan }
      : { op: 'SortAggregate', groupBy: node.groupBy, aggregates: node.aggregates, child: plan };
  return having ? { op: 'Having', predicate: having.predicate, child: rebuilt } : rebuilt;
}

/**
 * Statically compares two literals — the same three-valued logic
 * `exec/evaluate.ts`'s `compare` uses at runtime (kept as a small separate
 * copy rather than an import, since `planner/` never depends on `exec/`).
 * NULL on either side is UNKNOWN, not foldable.
 */
function foldLiteralCompare(op: CompareOp, left: SqlValue, right: SqlValue): boolean | null {
  if (left === null || right === null) return null;
  if (typeof left === 'number' && typeof right === 'number') return orderedCompare(op, left, right);
  const a = typeof left === 'boolean' ? String(Number(left)) : String(left);
  const b = typeof right === 'boolean' ? String(Number(right)) : String(right);
  return orderedCompare(op, a, b);
}

function orderedCompare<T extends number | string>(op: CompareOp, a: T, b: T): boolean {
  switch (op) {
    case '=':
      return a === b;
    case '<>':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
  }
}

/**
 * A comparison whose truth value does not depend on the row at all: two
 * literals (`5 > 3`). Anything else — a column against a literal, or two
 * columns — depends on the data and cannot be folded.
 *
 * That includes a column against *itself*. `age = age` looks like a
 * tautology, but under three-valued logic it is UNKNOWN, not TRUE, on a row
 * where `age` is NULL — and only TRUE passes a filter. Folding it away
 * returned (and, in a `DELETE`, destroyed) exactly the rows the predicate
 * excludes. The SQLite oracle found this (plan.md §25.4 A1). The correct
 * rewrite is `age IS NOT NULL`, which needs an `IS NULL` predicate the
 * engine did not have; until it does, the comparison is simply left alone.
 */
function foldComparison(expr: Extract<Expr, { kind: 'compare' }>): 'true' | 'false' | null {
  const { op, left, right } = expr;

  if (left.kind === 'literal' && right.kind === 'literal') {
    const result = foldLiteralCompare(op, left.value, right.value);
    return result === null ? null : result ? 'true' : 'false';
  }

  return null;
}

/** Arithmetic built only from literals — `2 + 3`, `-(4 * 5)` — which needs no row to evaluate. */
function isConstantArithmetic(expr: Expr): boolean {
  if (expr.kind === 'literal') return true;
  if (expr.kind === 'arith') return isConstantArithmetic(expr.left) && isConstantArithmetic(expr.right);
  if (expr.kind === 'neg') return isConstantArithmetic(expr.operand);
  return false;
}

function literalFor(value: SqlValue, span: Expr['span']): Expr {
  return { kind: 'literal', value, raw: value === null ? 'NULL' : String(value), span };
}

function evaluateConstant(expr: Expr): SqlValue {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'neg') return negate(evaluateConstant(expr.operand));
  if (expr.kind === 'arith') return arithmetic(expr.op, evaluateConstant(expr.left), evaluateConstant(expr.right));
  return null;
}

/**
 * Replaces every *maximal* constant-arithmetic subtree with its value
 * (plan.md §25.4 B1b), recording what it folded. `WHERE id = 2 + 3` becomes
 * `WHERE id = 5` — which is also what lets `index-selection` see an equality
 * on a literal at all. Outermost only: `2 + 3 * 4` is one fold to 14, not two.
 */
function foldArithmetic(expr: Expr, folds: { before: string; after: string }[]): Expr {
  if ((expr.kind === 'arith' || expr.kind === 'neg') && isConstantArithmetic(expr)) {
    const folded = literalFor(evaluateConstant(expr), expr.span);
    folds.push({ before: exprToSql(expr), after: folded.kind === 'literal' ? folded.raw : '' });
    return folded;
  }
  return mapChildren(expr, (child) => foldArithmetic(child, folds));
}

/**
 * Two simplifications, both about work that does not depend on the row:
 *
 *   - constant arithmetic (`2 + 3`) is worked out once, here, instead of for
 *     every row the scan reads (and so a literal can reach an index rule);
 *   - a conjunct that is always true (`5 > 3`) is dropped — `X AND true` is `X`.
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

  const folds: { before: string; after: string }[] = [];
  const parts = conjuncts(belowProject.predicate).map((part) => foldArithmetic(part, folds));
  const alwaysTrue = parts
    .map((p, i) => ({ i, expr: p }))
    .filter(({ expr }) => expr.kind === 'compare' && foldComparison(expr) === 'true');
  if (alwaysTrue.length === 0 && folds.length === 0) return null;

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

  const foldSentence =
    folds.length === 0
      ? ''
      : `${folds.map((f) => `\`${f.before}\` is just ${f.after}`).join(', ')} — worked out once here instead of for every row`;
  const clauses = alwaysTrue.map((f) => `\`${exprToSql(f.expr)}\``).join(', ');
  const verb = alwaysTrue.length === 1 ? 'is' : 'are';
  const dropSentence =
    alwaysTrue.length === 0
      ? ''
      : residual
        ? `${clauses} ${verb} always true, whatever the row — it drops out of the predicate, leaving only the part that actually depends on data`
        : `${clauses} ${verb} always true, whatever the row — with nothing else in the WHERE clause, the filter disappears entirely`;

  return {
    rule: 'constant-folding',
    label: `Constant folding: ${[foldSentence, dropSentence].filter(Boolean).join('; and ')}.`,
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
  const tables = new Set<string>();
  walkExpr(expr, (e) => {
    if (e.kind === 'column' && e.table) tables.add(e.table);
  });
  return tables;
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
  if (expr.kind === 'column') {
    if (!expr.table) return expr;
    const { table: _table, ...rest } = expr;
    return rest;
  }
  return mapChildren(expr, stripTableQualifiers);
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
  // The inner side is a bare `SeqScan` — or, for an index nested-loop join, an `IndexProbe`, which has no scan to
  // filter: a conjunct naming only the inner table then stays above the Join as a residual, never pushed.
  const probesInner = join.op === 'Join' && join.right.op === 'IndexProbe';
  if (
    join.op !== 'Join' ||
    join.left.op !== 'SeqScan' ||
    join.left.filter ||
    (join.right.op !== 'SeqScan' && join.right.op !== 'IndexProbe') ||
    (join.right.op === 'SeqScan' && join.right.filter)
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
    else if (tables.size === 1 && tables.has(join.rightTable) && !probesInner) rightParts.push(part);
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
 * One index the predicate can enter by equality, and how far: `matched` is the run of the index's *leading* columns
 * that each have an equality conjunct — the leftmost prefix — and `fraction` how much of the table that run selects.
 */
interface EqualityCandidate {
  name: string;
  columns: readonly string[];
  /** A `UNIQUE` index (plan.md §25.4 B3c): a lookup of its whole key returns at most one row. */
  unique: boolean;
  matched: { column: string; partIndex: number; key: SqlValue }[];
  /** Independent per-column selectivity, multiplied — the same assumption an `AND` in a `WHERE` already makes. */
  fraction: number;
  /** The range conjuncts on the column *after* the prefix (`a = 1 AND b > 5` on `(a, b)`): the index can narrow within the run. */
  next?: { column: string; low?: RangeBound; high?: RangeBound; consumed: number[] };
}

/** The lower and upper bound `parts` put on `column`, and which conjuncts they are — at most one of each direction. */
function rangeBoundsOn(parts: readonly Expr[], column: string, taken: ReadonlySet<number>) {
  const matches = parts
    .map((p, i) => ({ i, match: taken.has(i) ? undefined : rangeOn(p, column) }))
    .filter((m): m is { i: number; match: NonNullable<ReturnType<typeof rangeOn>> } => m.match !== undefined);
  const lower = matches.find((m) => m.match.op === '>' || m.match.op === '>=');
  const upper = matches.find((m) => m.match.op === '<' || m.match.op === '<=');
  if (!lower && !upper) return undefined;
  const low: RangeBound | undefined = lower ? { value: lower.match.value, inclusive: lower.match.op === '>=' } : undefined;
  const high: RangeBound | undefined = upper ? { value: upper.match.value, inclusive: upper.match.op === '<=' } : undefined;
  return { column, ...(low ? { low } : {}), ...(high ? { high } : {}), consumed: [lower?.i, upper?.i].filter((i): i is number => i !== undefined) };
}

/** The composite indexes `parts` cannot enter: it constrains one of their columns, but not their leftmost one. */
function unusableComposites(table: Table, parts: readonly Expr[]): { name: string; columns: readonly string[]; named: string[] }[] {
  return indexSpecsOf(table).flatMap((spec) => {
    if (spec.columns.length < 2) return [];
    const constrains = (column: string) => parts.some((p) => equalityOn(p, column) !== undefined || rangeOn(p, column) !== undefined);
    if (constrains(spec.columns[0]!)) return [];
    const named = spec.columns.slice(1).filter(constrains);
    return named.length > 0 ? [{ name: indexNameOf(spec.columns), columns: spec.columns, named }] : [];
  });
}

/**
 * The leftmost-prefix rule, said aloud for whoever is looking at a plan that did *not* use an index it might have
 * (plan.md §25.4 B3): a composite index on `(a, b)` is ordered by `a` first, so an equality on `b` alone matches entries
 * scattered across the whole index — there is no run to read, and the index cannot be entered. `null` when there is
 * nothing to say.
 */
export function leftmostPrefixNote(table: Table, where: Expr | undefined): string | null {
  if (!where) return null;
  const skipped = unusableComposites(table, conjuncts(where));
  if (skipped.length === 0) return null;
  return skipped
    .map(
      (c) =>
        `The index on (${c.columns.join(', ')}) cannot help: the predicate constrains ${c.named.map((n) => `\`${n}\``).join(' and ')} but not \`${c.columns[0]}\`, and an index can only be entered through its leftmost column — its entries are ordered by \`${c.columns[0]}\` first, so ${c.named.length === 1 ? 'that value is' : 'those values are'} scattered across the whole index.`,
    )
    .join(' ');
}

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
 *
 * A **composite** index (plan.md §25.4 B3) is entered through a *leftmost
 * prefix*: the run of its leading columns that each have an equality. An
 * equality on `a` enters an index on `(a, b)`; one on `b` alone cannot, and the
 * rule leaves that index unused — and says why. The more columns a candidate's
 * prefix pins, the fewer rows it selects, so that is what the choice compares.
 */
const indexSelection: Rule = (input, table) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowSort } = unwrapSort(plan.child);
  const { aggregate, rest: scan } = unwrapAggregate(belowSort);
  if (scan.op !== 'SeqScan' || !scan.filter) return null;

  const parts = conjuncts(scan.filter);
  const candidates: EqualityCandidate[] = indexSpecsOf(table).flatMap((spec) => {
    const matched: EqualityCandidate['matched'] = [];
    const used = new Set<number>();
    for (const column of spec.columns) {
      // The run of matched columns stops at the first one with no equality — that is the leftmost-prefix rule.
      const partIndex = parts.findIndex((p, i) => !used.has(i) && equalityOn(p, column) !== undefined);
      if (partIndex === -1) break;
      used.add(partIndex);
      matched.push({ column, partIndex, key: equalityOn(parts[partIndex]!, column)! });
    }
    if (matched.length === 0) return [];
    const nextColumn = spec.columns[matched.length];
    const next = nextColumn === undefined ? undefined : rangeBoundsOn(parts, nextColumn, used);
    return [
      {
        name: indexNameOf(spec.columns),
        columns: spec.columns,
        unique: spec.unique === true,
        matched,
        fraction: matched.reduce((product, m) => product / ndistinct(table.rows, m.column), 1),
        ...(next ? { next } : {}),
      },
    ];
  });
  if (candidates.length === 0) return null;

  const distinctOf = (c: EqualityCandidate): number => Math.round(1 / c.fraction);
  // Narrower wins: a smaller fraction, then more columns pinned, then a range on the next column to narrow the run further.
  const better = (c: EqualityCandidate, best: EqualityCandidate): boolean =>
    c.fraction !== best.fraction
      ? c.fraction < best.fraction
      : c.matched.length !== best.matched.length
        ? c.matched.length > best.matched.length
        : c.next !== undefined && best.next === undefined;
  const chosen = candidates.reduce((best, c) => (better(c, best) ? c : best));
  const runnersUp = candidates.filter((c) => c !== chosen);

  const consumed = new Set([...chosen.matched.map((m) => m.partIndex), ...(chosen.next?.consumed ?? [])]);
  const residual = conjoin(parts.filter((_, i) => !consumed.has(i)));
  const keys = chosen.matched.map((m) => m.key);
  const composite = chosen.columns.length > 1;

  // An equality prefix with a range on the next column becomes a range scan *within* the prefix's run; otherwise a lookup.
  const indexScan: Plan = chosen.next
    ? {
        op: 'IndexRangeScan',
        table: scan.table,
        column: chosen.name,
        prefix: keys,
        ...(chosen.next.low ? { low: chosen.next.low } : {}),
        ...(chosen.next.high ? { high: chosen.next.high } : {}),
        ...(residual ? { residual } : {}),
      }
    : {
        op: 'IndexScan',
        table: scan.table,
        column: chosen.name,
        key: keys[0]!,
        ...(composite ? { keys } : {}),
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

  const chosenDistinct = distinctOf(chosen);
  const nameOf = (c: EqualityCandidate) => (c.columns.length > 1 ? `(${c.columns.join(', ')})` : `\`${c.name}\``);
  const runnerUpNames = runnersUp.map(nameOf).join(', ');
  const runnerUpDistinct = runnersUp.map(distinctOf);
  const choiceClause =
    runnersUp.length === 0
      ? ''
      : runnerUpDistinct.every((d) => d === chosenDistinct)
        ? ` (tied with ${runnerUpNames} at ${String(chosenDistinct)} distinct values each — ${nameOf(chosen)} wins only because it was declared first, not because it narrows the search any further)`
        : ` (chosen over ${runnerUpNames} — ${String(chosenDistinct)} distinct values beats ${runnerUpDistinct.map(String).join('/')}, so it narrows the search more)`;

  const named = chosen.matched.map((m) => m.column);
  const prefixClause = composite
    ? named.length === chosen.columns.length
      ? `The predicate has an equality on every column of the composite index (${chosen.columns.join(', ')})`
      : `The predicate has an equality on ${named.map((c) => `\`${c}\``).join(' and ')} — ${named.length === 1 ? 'the leftmost column' : 'the leftmost columns'} of the composite index (${chosen.columns.join(', ')}), which is all an index needs to be entered: \`${chosen.columns[named.length]}\` only orders the entries inside each run`
    : '';
  const unusable = leftmostPrefixNote(table, scan.filter);
  const uniqueClause =
    chosen.unique && named.length === chosen.columns.length && !chosen.next
      ? ' The index is UNIQUE, so the lookup returns at most one row and stops at the first entry it finds.'
      : '';
  const rangeClause = chosen.next
    ? ` The next column, \`${chosen.next.column}\`, has a range (${formatRangeBounds(chosen.next.column, chosen.next.low, chosen.next.high)}), so the index narrows it within that run: one descent to where the range begins inside ${describeKeysText(keys)}, then along the leaf chain until the run ends.`
    : '';

  return {
    rule: 'index-selection',
    label: `${
      composite
        ? `${prefixClause}${choiceClause}, so the ${named.length > 1 ? 'equalities become' : 'equality becomes'} an index lookup.${residual ? ' The rest of the predicate cannot be answered by the index and is rechecked on each row the index returns.' : ''}`
        : residual
          ? `\`${chosen.name}\` is indexed${choiceClause}, so the equality becomes an index lookup. The rest of the predicate cannot be answered by the index and is rechecked on each row the index returns.`
          : `\`${chosen.name}\` is indexed${choiceClause} and the predicate is an equality on it, so the scan becomes a B+Tree lookup — a handful of pages instead of the whole table.`
    }${uniqueClause}${rangeClause}${unusable ? ` ${unusable}` : ''}`,
    plan: root,
    changed: new Set<Plan>([indexScan]),
    prompt:
      composite && named.length < chosen.columns.length
        ? leftmostPrefixPrompt(chosen.name, chosen.columns, named)
        : composite
          ? indexSelectionPrompt(`(${chosen.columns.join(', ')})`, keys[0]!, lookupText(chosen.name, keys))
          : indexSelectionPrompt(chosen.name, chosen.matched[0]!.key),
  };
};

/**
 * Swap a `SeqScan` for an `IndexRangeScan` when a range comparison (`<`,
 * `>`, `<=`, `>=` — including a `BETWEEN`, already desugared to both a lower
 * and an upper bound by the parser) sits on an indexed column. Descends the
 * B+Tree once to the leaf the lower bound would start at (the leftmost leaf,
 * with none), then the executor walks the leaf sibling chain horizontally
 * rather than rescanning the table (plan.md §23.1).
 *
 * Deliberately narrower than `index-selection`: it only ever sees a plan
 * `index-selection` left untouched as a `SeqScan` — i.e. no equality conjunct
 * matched any indexed column at all — because an equality is always at least
 * as selective a starting point as a range, and choosing between an
 * equality's `1/ndistinct` and a range's interval fraction by comparing the
 * two numbers would be exactly the kind of cost-model call inside a rule
 * §12 rules out. At most one lower bound and one upper bound per column are
 * consumed; a second bound in the same direction (`age > 10 AND age > 20`)
 * is left as a residual recheck rather than merged — correctness never
 * depends on catching it, only how tightly the index narrows the search
 * does.
 */
const rangeIndexSelection: Rule = (input, table) => {
  const { limit, rest: plan } = unwrapLimit(input);
  if (plan.op !== 'Project') return null;
  const { sort, rest: belowSort } = unwrapSort(plan.child);
  const { aggregate, rest: scan } = unwrapAggregate(belowSort);
  if (scan.op !== 'SeqScan' || !scan.filter) return null;

  const parts = conjuncts(scan.filter);
  // A range enters an index through its *leading* column, plain or composite — the entries are ordered by it first.
  const candidates = indexSpecsOf(table).flatMap((spec) => {
    const column = spec.columns[0]!;
    const name = indexNameOf(spec.columns);
    const matches = parts
      .map((p, i) => ({ i, match: rangeOn(p, column) }))
      .filter((m): m is { i: number; match: NonNullable<ReturnType<typeof rangeOn>> } => m.match !== undefined);
    if (matches.length === 0) return [];

    const lower = matches.find((m) => m.match.op === '>' || m.match.op === '>=');
    const upper = matches.find((m) => m.match.op === '<' || m.match.op === '<=');
    const consumed = new Set([lower?.i, upper?.i].filter((i): i is number => i !== undefined));
    const low: RangeBound | undefined = lower
      ? { value: lower.match.value, inclusive: lower.match.op === '>=' }
      : undefined;
    const high: RangeBound | undefined = upper
      ? { value: upper.match.value, inclusive: upper.match.op === '<=' }
      : undefined;
    const numericLow = low && typeof low.value === 'number' ? low.value : null;
    const numericHigh = high && typeof high.value === 'number' ? high.value : null;
    const selectivity = boundedRangeSelectivity(column, numericLow, numericHigh, table);
    return [{ column, name, consumed, low, high, selectivity }];
  });
  if (candidates.length === 0) return null;

  const chosen = candidates.reduce((best, c) =>
    c.selectivity.fraction < best.selectivity.fraction ? c : best,
  );
  const runnersUp = candidates.filter((c) => c !== chosen);

  const residual = conjoin(parts.filter((_, i) => !chosen.consumed.has(i)));

  const rangeScan: Plan = {
    op: 'IndexRangeScan',
    table: scan.table,
    column: chosen.name,
    ...(chosen.low ? { low: chosen.low } : {}),
    ...(chosen.high ? { high: chosen.high } : {}),
    ...(residual ? { residual } : {}),
  };
  const root = rewrapLimit(
    limit,
    { op: 'Project', columns: plan.columns, child: rewrapSort(sort, rewrapAggregate(aggregate, rangeScan)) },
  );

  const runnerUpNames = runnersUp.map((c) => `\`${c.column}\``).join(', ');
  const choiceClause =
    runnersUp.length === 0
      ? ''
      : runnersUp.every((c) => c.selectivity.fraction === chosen.selectivity.fraction)
        ? ` (tied with ${runnerUpNames} — \`${chosen.column}\` wins only because it was declared first, not because it narrows the search any further)`
        : ` (chosen over ${runnerUpNames} — a narrower estimated range)`;
  const boundsText = formatRangeBounds(chosen.column, chosen.low, chosen.high);
  const indexedText =
    chosen.name === chosen.column
      ? `\`${chosen.column}\` is indexed`
      : `the composite index (${chosen.name}) is ordered by \`${chosen.column}\` first, so it can be entered there`;

  return {
    rule: 'range-index-selection',
    label: residual
      ? `${indexedText} and ${boundsText}${choiceClause}, so the scan becomes a single descent to the first matching leaf, then a walk along the leaf chain — no full table scan. The rest of the predicate is rechecked on each row the index returns.`
      : `${indexedText} and the whole predicate is ${boundsText}${choiceClause}, so the scan becomes a single descent to the first matching leaf, then a walk along the leaf chain — no full table scan.`,
    plan: root,
    changed: new Set<Plan>([rangeScan]),
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
  // An index holds the values of every column it is on — one for a plain index, several for a composite one, which
  // therefore *covers* any query that reads only those columns (plan.md §25.4 B3).
  const covered = columnsOfIndex(scan.column);
  const onlyIndexedColumns = plan.columns.names.every((name) => covered.includes(name));
  if (!onlyIndexedColumns) return null;

  const indexOnly: Plan = {
    op: 'IndexOnlyScan',
    table: scan.table,
    column: scan.column,
    key: scan.key,
    ...(scan.keys ? { keys: scan.keys } : {}),
  };
  const root = rewrapLimit(limit, { op: 'Project', columns: plan.columns, child: indexOnly });
  const needs = plan.columns.names.map((n) => `\`${n}\``).join(', ');

  return {
    rule: 'index-only-scan',
    label:
      covered.length > 1
        ? `Every column this query needs — ${needs} — is one the composite index (${scan.column}) holds, so the index covers the query: the entries answer it without ever fetching the heap page the pointers name.`
        : `Every column this query needs — \`${scan.column}\` — is already the index key, so the lookup answers it without ever fetching the heap page the pointer names.`,
    plan: root,
    changed: new Set<Plan>([indexOnly]),
  };
};

const RULES: { name: string; apply: Rule }[] = [
  { name: 'constant-folding', apply: constantFolding },
  { name: 'predicate-pushdown', apply: predicatePushdown },
  { name: 'join-predicate-pushdown', apply: joinPredicatePushdown },
  { name: 'index-selection', apply: indexSelection },
  { name: 'range-index-selection', apply: rangeIndexSelection },
  { name: 'index-only-scan', apply: indexOnlyScan },
];

/** Every rewrite rule's name, in the order the optimizer runs them. */
export const OPTIMIZER_RULES: readonly string[] = RULES.map((r) => r.name);

/**
 * `DELETE`/`UPDATE` reuse this same optimizer (`emitDeletePlanEvents`, `emitUpdatePlanEvents`) to find the rows to touch,
 * wrapped in a throwaway `Project *`. Until §25.4 B3b their executors could only run a `SeqScan` or an `IndexScan`,
 * so `range-index-selection` was left out and a write could never use a range index; `exec/writeScan.ts` now runs an
 * `IndexRangeScan` too, so every rule applies. (`index-only-scan` never fires on a write — the `Project *` wants every
 * column — which is the point: a write reads the rows it changes.) Kept as its own export so the write path's rule set
 * stays a named decision, not an accident of reusing `OPTIMIZER_RULES`.
 */
export const WRITE_PATH_RULES: ReadonlySet<string> = new Set(OPTIMIZER_RULES);

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
  if (plan.op === 'IndexScan' || plan.op === 'IndexRangeScan') return plan.residual;
  return plan.op === 'Filter' ||
    plan.op === 'Having' ||
    plan.op === 'HashDistinct' ||
    plan.op === 'SortDistinct' ||
    plan.op === 'HashAggregate' ||
    plan.op === 'SortAggregate' ||
    plan.op === 'Sort' ||
    plan.op === 'Project' ||
    plan.op === 'Limit'
    ? scanPredicate(plan.child)
    : undefined;
}
