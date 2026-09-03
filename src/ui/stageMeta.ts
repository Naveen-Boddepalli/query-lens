import type { Stage } from '../engine/index.ts';

export interface StageMeta {
  id: Stage;
  title: string;
  blurb: string;
  /** Tailwind text colour for the stage accent. */
  tone: string;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  parse: { id: 'parse', title: 'Parser', blurb: 'SQL text → tokens → abstract syntax tree', tone: 'text-stage-parse' },
  plan: { id: 'plan', title: 'Planner', blurb: 'AST → logical plan tree', tone: 'text-stage-plan' },
  optimize: { id: 'optimize', title: 'Optimizer', blurb: 'Rule-based rewrites, e.g. predicate pushdown', tone: 'text-stage-optimize' },
  execute: { id: 'execute', title: 'Execution', blurb: 'Volcano-style operators pulling rows one at a time', tone: 'text-stage-execute' },
  buffer: { id: 'buffer', title: 'Buffer Pool', blurb: 'Fixed frames of pages; hits, misses, evictions', tone: 'text-stage-buffer' },
  index: { id: 'index', title: 'Index', blurb: 'B+Tree traversal from root to leaf', tone: 'text-stage-index' },
  lock: { id: 'lock', title: 'Locks', blurb: 'Coarse page-level locks (visual only in v0)', tone: 'text-stage-lock' },
  result: { id: 'result', title: 'Result', blurb: 'The rows handed back to the client', tone: 'text-stage-result' },
};
