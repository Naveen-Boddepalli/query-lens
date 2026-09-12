/**
 * The single contract between the engine and the UI.
 *
 * Rules for everything in `src/engine`:
 *   - pure and synchronous (no DOM, no React, no async, no I/O)
 *   - every value here must be structurally cloneable, so the engine stays
 *     worker-ready even though v0 runs it on the main thread
 */

export type SqlValue = string | number | boolean | null;
export type Row = Record<string, SqlValue>;

export type Stage =
  | 'parse'
  | 'plan'
  | 'optimize'
  | 'execute'
  | 'buffer'
  | 'index'
  | 'lock'
  | 'result';

export const STAGES: readonly Stage[] = [
  'parse',
  'plan',
  'optimize',
  'execute',
  'buffer',
  'index',
  'lock',
  'result',
] as const;

/** Character range in the original SQL text. */
export interface Span {
  from: number;
  to: number;
}

/** Display shape for the AST tree. Produced from the typed AST by `toDisplayTree`. */
export interface ASTNode {
  /** Stable across steps, so a progressive reveal animates rather than remounts. */
  id: string;
  kind: string;
  label: string;
  detail?: string;
  /** The source text this node came from, for highlighting in the editor. */
  span?: Span;
  children?: ASTNode[];
}

/** Display shape for the B+Tree. */
export interface IndexNode {
  id: string;
  kind: 'internal' | 'leaf';
  /** The keys held in this node, formatted. */
  label: string;
  pageId: number;
  /** Right sibling id — the chain that makes range scans possible. */
  next?: string;
  children?: IndexNode[];
}

export interface PlanNode {
  /** Stable across a rewrite, so before/after trees can be compared. */
  id: string;
  op: string;
  label: string;
  detail?: string;
  /** Set on the nodes a rewrite rule produced. */
  highlight?: boolean;
  /** Cost model's estimated output rows for this node (plan.md §22.2). */
  estRows?: number;
  /** The heuristic behind `estRows`, in a few words. */
  estBasis?: string;
  children?: PlanNode[];
}

/* -------------------------------------------------------------------------- */
/* Predict-then-reveal                                                         */
/* -------------------------------------------------------------------------- */

export interface PredictionOption {
  id: string;
  label: string;
}

/**
 * Attached to a step the learner should commit to an answer on *before* it
 * runs. This is the engagement hook the research says drives the learning —
 * see RESEARCH.md §1.
 */
export interface PredictionPrompt {
  question: string;
  options: PredictionOption[];
  correctOptionId: string;
  /** Shown after the reveal, whether they were right or wrong. */
  explanation: string;
}

/* -------------------------------------------------------------------------- */
/* Step events — deltas, not snapshots                                         */
/* -------------------------------------------------------------------------- */

interface StepEventBase {
  /** Position in the trace. Assigned by the trace builder; equals array index. */
  id: number;
  /** Human-readable narration. This is what turns an animation into a lesson. */
  label: string;
  /**
   * Playback pacing weight, default 1. A disk read should *feel* slower than a
   * buffer hit. This is a presentation hint, not a latency claim — the engine
   * makes no measurement it could honestly report.
   */
  dwell?: number;
  predictable?: PredictionPrompt;
}

export type StepEventBody =
  | { stage: 'parse'; ast: ASTNode; span?: Span }
  | { stage: 'plan'; planTree: PlanNode }
  | { stage: 'optimize'; rule: string; before: PlanNode; after: PlanNode }
  | { stage: 'execute'; op: string; rowsProduced: number }
  | { stage: 'buffer'; action: 'hit' | 'load'; pageId: number; frameId: number }
  /** A miss names no frame: nothing has been chosen to hold the page yet. */
  | { stage: 'buffer'; action: 'miss'; pageId: number }
  /** A page a `Sort` produced (a run, or a merge-pass output) rather than read off disk. */
  | { stage: 'buffer'; action: 'write'; pageId: number; frameId: number }
  | {
      stage: 'buffer';
      action: 'evict';
      frameId: number;
      victimPageId: number;
      pageId: number;
      /** Where the clock hand ended up. Absent under LRU, which has no hand. */
      clockHand?: number;
      /** The victim was dirty, so eviction cost a writeback, not just a discard. */
      writtenBack?: boolean;
    }
  /**
   * One tick of the clock-sweep hand. Emitted only by the `clock` policy, so
   * the decrement walk is visible rather than hidden inside the eviction.
   */
  | {
      stage: 'buffer';
      action: 'sweep';
      frameId: number;
      usageCountAfter: number;
      clockHand: number;
    }
  /** Emitted once, before a traversal, so the UI has a tree to draw. */
  | { stage: 'index'; action: 'open'; tree: IndexNode; nodeId: string; height: number }
  | {
      stage: 'index';
      action: 'traverse';
      nodeId: string;
      key?: SqlValue;
      /** Which child pointer the comparison chose. Absent on a leaf. */
      childIndex?: number;
    }
  | { stage: 'index'; action: 'found' | 'not-found'; nodeId: string; key?: SqlValue }
  | {
      stage: 'lock';
      action: 'acquire' | 'release';
      pageId: number;
      mode: 'shared' | 'exclusive';
    }
  | { stage: 'result'; rows: Row[] };

export type StepEvent = StepEventBase & StepEventBody;

/** Narrow a StepEvent to one stage: `Extract<StepEvent, { stage: 'buffer' }>`. */
export type EventOf<S extends Stage> = Extract<StepEvent, { stage: S }>;

/* -------------------------------------------------------------------------- */
/* Engine input / output                                                       */
/* -------------------------------------------------------------------------- */

export interface Table {
  name: string;
  columns: string[];
  rows: Row[];
  /** Column the B+Tree index is built on, if any. */
  indexedColumn?: string;
}

/**
 * `lru` and `clock` are the pipeline's contrast (plan.md §9) and the only two
 * the Playground and shareable links offer. `fifo`, `second-chance` and
 * `optimal` are the standalone buffer-pool tool's extra study material
 * (plan.md §20.4) — reachable through `runBufferTrace`, not the SQL path.
 * `optimal` needs the future reference string and falls back to FIFO order
 * when it does not have one (i.e. anywhere but the tool).
 */
export type ReplacementPolicyName =
  | 'lru'
  | 'clock'
  | 'fifo'
  | 'second-chance'
  | 'optimal'
  | 'midpoint';

export interface Database {
  tables: Record<string, Table>;
}

export interface EngineOptions {
  /** Buffer frames available. Small on purpose so eviction is visible. */
  bufferFrames: number;
  /** Rows stored per simulated page. Small on purpose. */
  rowsPerPage: number;
  policy: ReplacementPolicyName;
  /**
   * Which physical strategy a `GROUP BY` / aggregate query uses — `hash`
   * (the default, when absent) builds an in-memory hash table; `sort` sorts
   * by the `GROUP BY` columns first (spilling through the real buffer pool
   * exactly as `ORDER BY`'s `Sort` does) and then collapses runs of equal
   * keys. Nothing in the pipeline chooses between them on its own — this is
   * how `/compare`'s third mode forces each side explicitly (plan.md §22.2).
   */
  aggregateStrategy?: 'hash' | 'sort';
  /**
   * Which algorithm a `JOIN` runs — `nested-loop` (the default, when absent)
   * rescans the right table whole per left row; `hash` builds an in-memory
   * hash table over the right table once, then probes it with the left
   * table streamed a row at a time. Same rows out either way; nothing in the
   * pipeline picks between them on its own — this is how `/compare`'s fourth
   * mode forces each side explicitly, the same way `aggregateStrategy` above
   * does for `GROUP BY` (plan.md §22.2).
   */
  joinStrategy?: 'nested-loop' | 'hash';
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  bufferFrames: 8,
  rowsPerPage: 4,
  policy: 'lru',
};

export interface QueryError {
  message: string;
  /** What to do about it — the error messages are half the teaching value. */
  hint?: string;
  /** Character offsets into the SQL text, for the CodeMirror squiggle. */
  from?: number;
  to?: number;
}

export interface RunResult {
  events: StepEvent[];
  /**
   * `SELECT`'s result rows; the rows a `DELETE` removed, an `INSERT` added,
   * or an `UPDATE` changed (after values), for `write`.
   */
  rows: Row[];
  error?: QueryError;
  /**
   * Present only for a successful write (`DELETE`/`INSERT`/`UPDATE` —
   * plan.md §22.2). The caller persists `rows` as the table's new contents;
   * nothing in the engine holds state between calls, so this is the only way
   * a write has any effect beyond its own trace.
   */
  write?: WriteOutcome;
}

export type WriteOutcome =
  | { kind: 'delete'; table: string; deletedCount: number; rows: Row[] }
  | { kind: 'insert'; table: string; insertedCount: number; rows: Row[] }
  | { kind: 'update'; table: string; updatedCount: number; rows: Row[] };

/**
 * The stages this build of the engine actually executes. Everything else in
 * `STAGES` is scaffolding the UI must show as unbuilt — plan.md §2 makes
 * honesty about ground truth a top-line goal, and a pipeline that looks
 * complete when it is not breaks that. Grows one milestone at a time.
 */
export const IMPLEMENTED_STAGES: readonly Stage[] = [
  'parse',
  'plan',
  'optimize',
  'buffer',
  'index',
  'execute',
  'lock',
  'result',
] as const;
