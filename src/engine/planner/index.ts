export {
  buildAggregatePlan,
  buildDeletePlan,
  buildJoinPlan,
  buildPlan,
  buildUpdatePlan,
  isAggregateQuery,
} from './buildPlan.ts';
export {
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
export { optimize, OPTIMIZER_RULES, scanPredicate } from './optimize.ts';
export type { Rewrite } from './optimize.ts';
export {
  childOf,
  conjoin,
  conjuncts,
  equalityOn,
  exprToSql,
  findSort,
  findSortMergeJoin,
  needsSortSpill,
  toPlanDisplay,
} from './plan.ts';
export type { AggregateSpec, Plan, ProjectList } from './plan.ts';
