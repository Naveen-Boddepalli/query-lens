export { runQuery } from './runQuery.ts';
export { resolveExists } from './exists.ts';
export { resolveStatementSubqueries } from './subquery.ts';
export {
  MAX_REFERENCES,
  parseReferenceScans,
  parseReferenceString,
  randomReferenceString,
  runBufferTrace,
} from './bufferTrace.ts';
export type { BufferTraceResult, ScanSpan } from './bufferTrace.ts';
export {
  createAccountsDatabase,
  createJoinCompareDatabase,
  createJoinDemoDatabase,
  createJoinOrderDemoDatabase,
  createSeedDatabase,
} from './seed.ts';
export {
  DATASETS,
  DATASET_IDS,
  DEFAULT_DATASET,
  isDatasetId,
} from './datasets.ts';
export type { DatasetId, DatasetSpec } from './datasets.ts';
export { createTracer } from './trace.ts';
export { compoundDisplayTree, parse, parseQueryStatement, toDisplayTree, columnsIn, tokenize } from './parser/index.ts';
export type { Token, TokenType } from './parser/index.ts';
export {
  buildPlan,
  estimatePlan,
  exprToSql,
  optimize,
  OPTIMIZER_RULES,
  rootEstimate,
  selectivityOf,
  toPlanDisplay,
} from './planner/index.ts';
export type { CostEstimate, PlanCost } from './planner/index.ts';
export {
  costOfOrder,
  isReorderableChain,
  joinGraphFromAst,
  rebuildJoinsForOrder,
  reorderJoinsIfCheaper,
  runJoinOrderDP,
  writtenOrderFromAst,
} from './planner/joinOrder.ts';
export type { JoinOrderCandidate, JoinOrderEdge, JoinOrderNode, JoinOrderResult, SubsetPlan } from './planner/joinOrder.ts';
export {
  buildHeap,
  createBufferPool,
  policyFor,
  REPLACEMENT_POLICY_LABELS,
  REPLACEMENT_POLICY_NAMES,
  USAGE_COUNT_CAP,
} from './storage/index.ts';
export { isReplacementPolicyName } from './types.ts';
export type { BufferPool, Frame as BufferPoolFrame, Heap, Page } from './storage/index.ts';
export {
  allKeys,
  buildIndex,
  createTree,
  DEFAULT_MAX_KEYS,
  deleteKey,
  descend,
  height,
  columnsOfIndex,
  indexNameOf,
  indexSpecsOf,
  insert,
  keyList,
  search,
  toIndexDisplay,
  uniqueViolation,
  validate,
} from './index/index.ts';
export type {
  BPlusTree,
  BTreeNode,
  DeleteResult,
  DeleteStep,
  RowPointer,
} from './index/index.ts';
export { evaluatePredicate, externalMergeSort, passes, sortPassCount, sortTempPageCount } from './exec/index.ts';
export type { SortIO } from './exec/index.ts';
export { createLockManager } from './locks/index.ts';
export type { HeldLock, LockManager, LockMode } from './locks/index.ts';
export type { Plan } from './planner/index.ts';
export type { Expr, SelectStatement } from './parser/index.ts';
export {
  applyEvent,
  createTraceProjector,
  initialViewState,
  stateAt,
} from './viewState.ts';
export type { BufferFrame, LockHeld, TraceProjector, ViewState } from './viewState.ts';
export { DEFAULT_ENGINE_OPTIONS, IMPLEMENTED_STAGES, STAGES } from './types.ts';
export { analyzeTable, statsToRows } from './stats.ts';
export { finalPlan, nodeKey } from './explain.ts';
export type {
  ASTNode,
  ColumnStats,
  CostAlternative,
  Database,
  EngineOptions,
  EventOf,
  IndexBuildOptions,
  IndexNode,
  IndexSpec,
  JoinAlgorithm,
  PlanNode,
  PredictionOption,
  PredictionPrompt,
  QueryError,
  RaInfo,
  ReplacementPolicyName,
  Row,
  RunResult,
  TableStats,
  Span,
  SqlValue,
  Stage,
  StepEvent,
  StepEventBody,
  Table,
  WhyNot,
} from './types.ts';
