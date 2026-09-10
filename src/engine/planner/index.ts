export { buildPlan } from './buildPlan.ts';
export { emitPlanEvents } from './emit.ts';
export { optimize, OPTIMIZER_RULES, scanPredicate } from './optimize.ts';
export type { Rewrite } from './optimize.ts';
export {
  conjoin,
  conjuncts,
  equalityOn,
  exprToSql,
  toPlanDisplay,
} from './plan.ts';
export type { Plan, ProjectList } from './plan.ts';
