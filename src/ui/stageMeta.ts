import type { Stage } from '../engine/index.ts';

export interface StageMeta {
  id: Stage;
  title: string;
  blurb: string;
  /** Tailwind text colour for the stage accent. */
  tone: string;
  /** The milestone that builds this stage for real. */
  milestone: string;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  parse: { id: 'parse', title: 'Parser', blurb: 'SQL text → tokens → abstract syntax tree', tone: 'text-stage-parse', milestone: 'M1' },
  plan: { id: 'plan', title: 'Planner', blurb: 'AST → logical plan tree', tone: 'text-stage-plan', milestone: 'M2' },
  optimize: { id: 'optimize', title: 'Optimizer', blurb: 'Rule-based rewrites, e.g. predicate pushdown', tone: 'text-stage-optimize', milestone: 'M2' },
  execute: { id: 'execute', title: 'Execution', blurb: 'Volcano-style operators pulling rows one at a time', tone: 'text-stage-execute', milestone: 'M5' },
  buffer: { id: 'buffer', title: 'Buffer Pool', blurb: 'Fixed frames of pages; hits, misses, evictions', tone: 'text-stage-buffer', milestone: 'M3' },
  index: { id: 'index', title: 'Index', blurb: 'B+Tree traversal from root to leaf', tone: 'text-stage-index', milestone: 'M4' },
  lock: { id: 'lock', title: 'Locks', blurb: 'Coarse page-level locks (visual only in v0)', tone: 'text-stage-lock', milestone: 'M6' },
  result: { id: 'result', title: 'Result', blurb: 'The rows handed back to the client', tone: 'text-stage-result', milestone: 'M5' },
};
