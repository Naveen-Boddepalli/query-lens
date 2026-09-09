import type { Stage } from '../engine/index.ts';

export interface StageMeta {
  id: Stage;
  title: string;
  blurb: string;
  /**
   * Two sentences of "what am I looking at" — the payload behind the `?` on the
   * Playground panel (plan.md §19.2) and the teaser on the `/stages` index.
   */
  help: string;
  /** Where the panel's "read more" link goes: an in-app concept page. */
  doc: string;
  /** Tailwind text colour for the stage accent. */
  tone: string;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  parse: {
    id: 'parse',
    title: 'Parser',
    blurb: 'SQL text → tokens → abstract syntax tree',
    help: 'The parser turns your SQL text into an abstract syntax tree — the keyword, column and condition nodes shown here. Every later stage reads this tree, never the original string.',
    doc: '/stages/parse',
    tone: 'text-stage-parse',
  },
  plan: {
    id: 'plan',
    title: 'Planner',
    blurb: 'AST → logical plan tree',
    help: 'The planner walks the syntax tree and picks the relational operators needed to answer the query — scan, filter, project. The result is a logical plan: what to compute, not yet how fast.',
    doc: '/stages/plan',
    tone: 'text-stage-plan',
  },
  optimize: {
    id: 'optimize',
    title: 'Optimizer',
    blurb: 'Rule-based rewrites, e.g. predicate pushdown',
    help: 'The optimizer rewrites the logical plan with rules like predicate pushdown, which moves a filter down to where the rows are read. The before and after trees are shown side by side with the rule that fired.',
    doc: '/stages/optimize',
    tone: 'text-stage-optimize',
  },
  execute: {
    id: 'execute',
    title: 'Execution',
    blurb: 'Volcano-style operators pulling rows one at a time',
    help: 'Execution pulls one row at a time: each operator asks the one below it for a row, from the scan up to the result. Nothing materialises the whole table — a row reaches the top before the next is fetched.',
    doc: '/stages/execute',
    tone: 'text-stage-execute',
  },
  buffer: {
    id: 'buffer',
    title: 'Buffer Pool',
    blurb: 'Fixed frames of pages; hits, misses, evictions',
    help: 'The buffer pool is a fixed set of memory frames holding disk pages. A hit means the page was already there; a miss reads it from disk and, when every frame is full, evicts one by the current policy.',
    doc: '/docs/concepts/buffer-pool',
    tone: 'text-stage-buffer',
  },
  index: {
    id: 'index',
    title: 'Index',
    blurb: 'B+Tree traversal from root to leaf',
    help: 'The B+Tree index maps a key to a row’s location without scanning the table. A lookup starts at the root and follows one child pointer per level, comparing keys, until it reaches the leaf that holds the row pointer.',
    doc: '/docs/concepts/btree',
    tone: 'text-stage-index',
  },
  lock: {
    id: 'lock',
    title: 'Locks',
    blurb: 'Coarse page-level locks (visual only in v0)',
    help: 'Before touching a page the engine takes a lock on it — shared to read, exclusive to write. This model locks whole pages; real engines usually lock individual rows and detect deadlocks.',
    doc: '/stages/lock',
    tone: 'text-stage-lock',
  },
  result: {
    id: 'result',
    title: 'Result',
    blurb: 'The rows handed back to the client',
    help: 'The result stage collects the rows the execution tree produced and hands them back. In a real client this is also where formatting, pagination and protocol encoding happen.',
    doc: '/stages/result',
    tone: 'text-stage-result',
  },
};
