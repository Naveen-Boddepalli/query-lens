/**
 * The plan and optimize stages for a compound query (plan.md §27.5 S3): `SELECT … UNION [ALL] | INTERSECT | EXCEPT
 * SELECT …`. Each member is planned and optimized exactly as a SELECT on its own is — `emitPlanEvents`, unchanged —
 * and the set operation sits above them: no rewrite rule crosses it, the same way none crosses a join's two sides
 * yet. The trace reads in stage order: every member's plan steps, then the set operation built over them, then every
 * member's rewrites, then the whole plan that runs.
 */

import type { CompoundStatement, SelectStatement } from '../parser/index.ts';
import type { Emit, EmitOptions } from '../trace.ts';
import type { JoinAlgorithm, StepEventBody, Table } from '../types.ts';
import { buildPlan } from './buildPlan.ts';
import { estimatePlan } from './cost.ts';
import { emitPlanEvents } from './emit.ts';
import { toPlanDisplay } from './plan.ts';
import type { Plan } from './plan.ts';

/** One SELECT of a compound, as `runQuery.ts` resolved it: its own tables, and the columns it returns, in order. */
export interface CompoundMember {
  ast: SelectStatement;
  table: Table;
  joinTables: Record<string, Table>;
  writtenJoinOrder?: readonly string[];
  columns: string[];
}

export interface CompoundPlan {
  plan: Plan;
  /** Each member's own optimized plan, in order — the inputs the `SetOp`s read, each run in its member's context. */
  members: Plan[];
  /** Every `HashDistinct` / `SortDistinct` a plain `UNION` added, innermost first — a sort-based one needs its own block. */
  distincts: Plan[];
}

/** The words for one operator step: `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`. */
const opWords = (op: CompoundStatement['ops'][number]): string => `${op.op.toUpperCase()}${op.all ? ' ALL' : ''}`;

/**
 * The set operations over `inputs` (one plan per member), left to right, with the result's `ORDER BY` and `LIMIT` on
 * top. A plain `UNION` is a `UNION ALL` with a `DISTINCT` above it — hash or sort, as `aggregateStrategy` says, the seam
 * `SELECT DISTINCT` and `GROUP BY` share. `INTERSECT` and `EXCEPT` dedupe in their own hash set.
 */
export function combineMembers(
  ast: CompoundStatement,
  inputs: readonly Plan[],
  columns: readonly (readonly string[])[],
  aggregateStrategy: 'hash' | 'sort',
): { plan: Plan; distincts: Plan[] } {
  const distincts: Plan[] = [];
  let plan = inputs[0]!;
  ast.ops.forEach((step, i) => {
    plan = {
      op: 'SetOp',
      kind: step.op,
      all: step.op === 'union',
      left: plan,
      right: inputs[i + 1]!,
      columns: [...columns[0]!],
      rightColumns: [...columns[i + 1]!],
      position: i + 2,
    };
    if (step.op === 'union' && !step.all) {
      plan = aggregateStrategy === 'sort' ? { op: 'SortDistinct', child: plan } : { op: 'HashDistinct', child: plan };
      distincts.push(plan);
    }
  });
  if (ast.orderBy) plan = { op: 'Sort', column: ast.orderBy.column, direction: ast.orderBy.direction, child: plan };
  if (ast.limit) {
    plan = { op: 'Limit', count: ast.limit.value, ...(ast.limit.offset ? { offset: ast.limit.offset } : {}), child: plan };
  }
  return { plan, distincts };
}

export function emitCompoundPlanEvents(
  emit: Emit,
  ast: CompoundStatement,
  members: readonly CompoundMember[],
  rowsPerPage: number,
  aggregateStrategy: 'hash' | 'sort' = 'hash',
  joinStrategy?: JoinAlgorithm,
): CompoundPlan {
  const first = members[0]!;
  const allTables: Record<string, Table> = {};
  for (const m of members) Object.assign(allTables, m.joinTables, { [m.table.name]: m.table });
  const display = (plan: Plan, changed?: ReadonlySet<Plan>) =>
    toPlanDisplay(plan, changed, estimatePlan(plan, first.table, rowsPerPage, allTables));

  // Each member exactly as a SELECT of its own — its steps held back, to be told in stage order below.
  const runs = members.map((m) => {
    const held: [string, StepEventBody, EmitOptions | undefined][] = [];
    const plan = emitPlanEvents(
      (label, body, options) => { held.push([label, body, options]); },
      m.ast,
      m.table,
      rowsPerPage,
      aggregateStrategy,
      m.joinTables,
      joinStrategy,
      m.writtenJoinOrder,
    );
    return { plan, held };
  });
  const n = members.length;
  const replay = (stage: 'plan' | 'optimize') => {
    runs.forEach((run, i) => {
      for (const [label, body, options] of run.held) {
        if (body.stage === stage) emit(`SELECT ${String(i + 1)} of ${String(n)}. ${label}`, body, options);
      }
    });
  };

  replay('plan');

  // The set operations over the members' canonical plans — the plan as written, before any rewrite.
  const canonicalInputs = members.map((m) => buildPlan(m.ast, aggregateStrategy, joinStrategy ?? 'nested-loop', m.joinTables));
  const columns = members.map((m) => m.columns);
  let shown: Plan = canonicalInputs[0]!;
  ast.ops.forEach((step, i) => {
    const partial: CompoundStatement = { ...ast, members: ast.members.slice(0, i + 2), ops: ast.ops.slice(0, i + 1) };
    const { orderBy: _o, limit: _l, ...bare } = partial;
    shown = combineMembers(bare, canonicalInputs.slice(0, i + 2), columns, aggregateStrategy).plan;
    const renamed = members[i + 1]!.columns.some((c, j) => c !== first.columns[j]);
    const how =
      step.op === 'union'
        ? step.all
          ? `${opWords(step)} becomes a Union all node: every row of the plan so far, then every row of SELECT ${String(i + 2)} — repeats kept.`
          : `${opWords(step)} becomes a Union all node with a ${aggregateStrategy === 'sort' ? 'SortDistinct' : 'HashDistinct'} above it: every row of both, then each repeat dropped${aggregateStrategy === 'sort' ? ' by sorting so equal rows sit together' : ' by a hash set of the rows already passed'} — the same node SELECT DISTINCT uses. A NULL counts as equal to a NULL here, though no comparison says so.`
        : `${opWords(step)} becomes ${step.op === 'intersect' ? 'an Intersect' : 'an Except'} node: it reads every row of SELECT ${String(i + 2)} into a hash set, then keeps each row of the plan so far that is ${step.op === 'intersect' ? 'in' : 'not in'} it — each once, NULLs counting as equal.`;
    emit(
      `${how}${renamed ? ` SELECT ${String(i + 2)}'s columns (${members[i + 1]!.columns.join(', ')}) are matched to the first SELECT's (${first.columns.join(', ')}) by position, and take its names.` : ''}`,
      { stage: 'plan', planTree: display(shown) },
    );
  });
  if (ast.orderBy) {
    shown = { op: 'Sort', column: ast.orderBy.column, direction: ast.orderBy.direction, child: shown };
    emit(
      `ORDER BY becomes one Sort above everything: the combined rows, ordered by \`${ast.orderBy.column}\` ${ast.orderBy.direction === 'asc' ? 'ascending' : 'descending'}. No single SELECT is sorted — only the result is.`,
      { stage: 'plan', planTree: display(shown) },
    );
  }
  if (ast.limit) {
    shown = { op: 'Limit', count: ast.limit.value, ...(ast.limit.offset ? { offset: ast.limit.offset } : {}), child: shown };
    emit(`LIMIT becomes a Limit on top of the whole result, not of any one SELECT.`, { stage: 'plan', planTree: display(shown) });
  }

  replay('optimize');

  const optimized = runs.map((r) => r.plan);
  const { plan, distincts } = combineMembers(ast, optimized, columns, aggregateStrategy);
  emit(
    `Each SELECT was optimized on its own; no rewrite rule reaches across the ${[...new Set(ast.ops.map((o) => o.op.toUpperCase()))].join(' and ')} above them. This is the plan that runs.`,
    { stage: 'optimize', rule: 'none', before: display(shown), after: display(plan) },
  );

  return { plan, members: optimized, distincts };
}
