export {
  buildAggregatePlan,
  buildDeletePlan,
  buildJoinPlan,
  distinctNodeFor,
  effectiveJoinAlgorithm,
  buildPlan,
  buildUpdatePlan,
  isAggregateQuery,
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
export { emitDeletePlanEvents } from './emitDelete.ts';
export { emitUpdatePlanEvents } from './emitUpdate.ts';
export { optimize, OPTIMIZER_RULES, scanPredicate, WRITE_PATH_RULES } from './optimize.ts';
export type { Rewrite } from './optimize.ts';
export {
  childOf,
  conjoin,
  conjuncts,
  equalityOn,
  exprToSql,
  findIndexNestedLoopJoin,
  findSort,
  findSortDistinct,
  findSortMergeJoin,
  formatRangeBounds,
  needsSortSpill,
  rangeOn,
  toPlanDisplay,
} from './plan.ts';
export type { AggregateSpec, Plan, ProjectList, RangeBound } from './plan.ts';
