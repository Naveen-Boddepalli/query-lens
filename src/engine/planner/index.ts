export {
  buildAggregatePlan,
  buildDeletePlan,
  buildJoinPlan,
  buildSemiJoin,
  distinctNodeFor,
  effectiveJoinAlgorithm,
  buildPlan,
  buildUpdatePlan,
  isAggregateQuery,
  projectListFor,
  withSemiJoins,
} from './buildPlan.ts';
export {
  boundedRangeSelectivity,
  estimateIndexLevels,
  estimatePlan,
  ndistinct,
  NO_STATS_EQ_SELECTIVITY,
  OPEN_RANGE_SELECTIVITY,
  rootEstimate,
  selectivityOf,
} from './cost.ts';
export type { CostEstimate, PlanCost } from './cost.ts';
export { emitPlanEvents } from './emit.ts';
export { combineMembers, emitCompoundPlanEvents } from './compound.ts';
export type { CompoundMember, CompoundPlan } from './compound.ts';
export { emitDeletePlanEvents } from './emitDelete.ts';
export { emitUpdatePlanEvents } from './emitUpdate.ts';
export {
  costOfOrder,
  isReorderableChain,
  joinGraphFromAst,
  rebuildJoinsForOrder,
  reorderJoinsIfCheaper,
  runJoinOrderDP,
  writtenOrderFromAst,
} from './joinOrder.ts';
export type { JoinOrderCandidate, JoinOrderEdge, JoinOrderNode, JoinOrderResult, SubsetPlan } from './joinOrder.ts';
export { optimize, OPTIMIZER_RULES, scanPredicate, WRITE_PATH_RULES } from './optimize.ts';
export type { Rewrite } from './optimize.ts';
export {
  childOf,
  conjoin,
  conjuncts,
  distinctSortColumn,
  equalityOn,
  exprToSql,
  findIndexNestedLoopJoins,
  findSort,
  findSortAggregate,
  findSortDistinct,
  findSortMergeJoins,
  formatRangeBounds,
  indexLabel,
  joinsIn,
  lookupKeysOf,
  lookupText,
  rangeOn,
  renamesOf,
  toPlanDisplay,
} from './plan.ts';
export type { AggregateSpec, Plan, ProjectList, RangeBound } from './plan.ts';
