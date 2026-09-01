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

export interface PlanNode {
  /** Stable across a rewrite, so before/after trees can be compared. */
  id: string;
  op: string;
  label: string;
  detail?: string;
  /** Set on the nodes a rewrite rule produced. */
  highlight?: boolean;
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
  predictable?: PredictionPrompt;
}

export type StepEventBody =
  | { stage: 'parse'; ast: ASTNode; span?: Span }
  | { stage: 'plan'; planTree: PlanNode }
  | { stage: 'optimize'; rule: string; before: PlanNode; after: PlanNode }
  | { stage: 'execute'; op: string; rowsProduced: number }
  | { stage: 'buffer'; action: 'hit' | 'miss' | 'load'; pageId: number; frameId: number }
  | { stage: 'buffer'; action: 'evict'; frameId: number; victimPageId: number; pageId: number }
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
  | {
      stage: 'index';
      action: 'traverse' | 'found' | 'not-found';
      nodeId: string;
      key?: SqlValue;
    }
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

export type ReplacementPolicyName = 'lru' | 'clock';

export interface Database {
  tables: Record<string, Table>;
}

export interface EngineOptions {
  /** Buffer frames available. Small on purpose so eviction is visible. */
  bufferFrames: number;
  /** Rows stored per simulated page. Small on purpose. */
  rowsPerPage: number;
  policy: ReplacementPolicyName;
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
  rows: Row[];
  error?: QueryError;
}

/**
 * The stages this build of the engine actually executes. Everything else in
 * `STAGES` is scaffolding the UI must show as unbuilt — plan.md §2 makes
 * honesty about ground truth a top-line goal, and a pipeline that looks
 * complete when it is not breaks that. Grows one milestone at a time.
 */
export const IMPLEMENTED_STAGES: readonly Stage[] = ['parse', 'plan', 'optimize'] as const;
