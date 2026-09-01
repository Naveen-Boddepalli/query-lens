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
  parse: { id: 'parse', title: 'Parser', blurb: 'SQL text → tokens → abstract syntax tree', tone: 'text-sky-300', milestone: 'M1' },
  plan: { id: 'plan', title: 'Planner', blurb: 'AST → logical plan tree', tone: 'text-violet-300', milestone: 'M2' },
  optimize: { id: 'optimize', title: 'Optimizer', blurb: 'Rule-based rewrites, e.g. predicate pushdown', tone: 'text-fuchsia-300', milestone: 'M2' },
  execute: { id: 'execute', title: 'Execution', blurb: 'Volcano-style operators pulling rows one at a time', tone: 'text-amber-300', milestone: 'M5' },
  buffer: { id: 'buffer', title: 'Buffer Pool', blurb: 'Fixed frames of pages; hits, misses, evictions', tone: 'text-emerald-300', milestone: 'M3' },
  index: { id: 'index', title: 'Index', blurb: 'B+Tree traversal from root to leaf', tone: 'text-pink-300', milestone: 'M4' },
  lock: { id: 'lock', title: 'Locks', blurb: 'Coarse page-level locks (visual only in v0)', tone: 'text-orange-300', milestone: 'M6' },
  result: { id: 'result', title: 'Result', blurb: 'The rows handed back to the client', tone: 'text-cyan-300', milestone: 'M5' },
};
