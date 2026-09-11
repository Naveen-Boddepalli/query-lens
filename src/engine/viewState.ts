/**
 * Events are deltas. The view state at step *n* is derived by folding them.
 *
 * We deliberately do NOT snapshot engine state per step: snapshots bloat
 * memory, make events non-diffable, and forfeit the ability to animate the
 * *transition* — an eviction must be a frame visibly leaving, not grid-N
 * swapped for grid-N+1. See plan.md §7.8.
 */

import type {
  ASTNode,
  EngineOptions,
  IndexNode,
  PlanNode,
  Row,
  Stage,
  StepEvent,
} from './types.ts';

export interface BufferFrame {
  frameId: number;
  pageId: number | null;
  /** Clock-sweep counter, capped at 5 (Postgres uses the same cap). */
  usageCount: number;
  /** Step id of the last access. Drives LRU ordering and recency shading. */
  lastTouchedAt: number;
}

export interface LockHeld {
  pageId: number;
  mode: 'shared' | 'exclusive';
}

export interface ViewState {
  /** Number of events applied. 0 = nothing has run yet. */
  step: number;
  stage: Stage | null;
  narration: string;
  /** The event that produced this state — the UI reads it to animate the change. */
  lastEvent: StepEvent | null;

  ast: ASTNode | null;
  plan: PlanNode | null;
  planBefore: PlanNode | null;
  appliedRules: string[];

  frames: BufferFrame[];
  clockHand: number;
  bufferStats: { hits: number; misses: number; evictions: number; writes: number };

  indexTree: IndexNode | null;
  indexPath: string[];
  indexOutcome: 'searching' | 'found' | 'not-found' | null;

  locks: LockHeld[];
  /** Total acquired so far — held locks alone cannot show the work done. */
  locksTaken: number;
  operators: { op: string; rowsProduced: number }[];
  rows: Row[];
}

export function initialViewState(options: EngineOptions): ViewState {
  return {
    step: 0,
    stage: null,
    narration: '',
    lastEvent: null,
    ast: null,
    plan: null,
    planBefore: null,
    appliedRules: [],
    frames: Array.from({ length: options.bufferFrames }, (_, frameId) => ({
      frameId,
      pageId: null,
      usageCount: 0,
      lastTouchedAt: -1,
    })),
    clockHand: 0,
    bufferStats: { hits: 0, misses: 0, evictions: 0, writes: 0 },
    indexTree: null,
    indexPath: [],
    indexOutcome: null,
    locks: [],
    locksTaken: 0,
    operators: [],
    rows: [],
  };
}

const USAGE_COUNT_CAP = 5;

function touchFrame(
  frames: BufferFrame[],
  frameId: number,
  patch: Partial<BufferFrame>,
): BufferFrame[] {
  return frames.map((f) => (f.frameId === frameId ? { ...f, ...patch } : f));
}

function frameById(frames: BufferFrame[], frameId: number): BufferFrame | undefined {
  return frames.find((f) => f.frameId === frameId);
}

/** Pure reducer. `state` is never mutated. */
export function applyEvent(state: ViewState, event: StepEvent): ViewState {
  const next: ViewState = {
    ...state,
    step: state.step + 1,
    stage: event.stage,
    narration: event.label,
    lastEvent: event,
  };

  switch (event.stage) {
    case 'parse':
      next.ast = event.ast;
      return next;

    case 'plan':
      next.plan = event.planTree;
      return next;

    case 'optimize':
      next.planBefore = event.before;
      next.plan = event.after;
      next.appliedRules = [...state.appliedRules, event.rule];
      return next;

    case 'execute': {
      const existing = state.operators.findIndex((o) => o.op === event.op);
      next.operators =
        existing === -1
          ? [...state.operators, { op: event.op, rowsProduced: event.rowsProduced }]
          : state.operators.map((o, i) =>
              i === existing ? { ...o, rowsProduced: event.rowsProduced } : o,
            );
      return next;
    }

    case 'buffer': {
      switch (event.action) {
        case 'hit': {
          const frame = frameById(state.frames, event.frameId);
          next.frames = touchFrame(state.frames, event.frameId, {
            usageCount: Math.min((frame?.usageCount ?? 0) + 1, USAGE_COUNT_CAP),
            lastTouchedAt: event.id,
          });
          next.bufferStats = { ...state.bufferStats, hits: state.bufferStats.hits + 1 };
          return next;
        }
        case 'miss':
          next.bufferStats = {
            ...state.bufferStats,
            misses: state.bufferStats.misses + 1,
          };
          return next;
        case 'load':
          next.frames = touchFrame(state.frames, event.frameId, {
            pageId: event.pageId,
            usageCount: 1,
            lastTouchedAt: event.id,
          });
          return next;
        case 'write':
          next.frames = touchFrame(state.frames, event.frameId, {
            pageId: event.pageId,
            usageCount: 1,
            lastTouchedAt: event.id,
          });
          next.bufferStats = { ...state.bufferStats, writes: state.bufferStats.writes + 1 };
          return next;
        case 'evict':
          next.frames = touchFrame(state.frames, event.frameId, {
            pageId: null,
            usageCount: 0,
            lastTouchedAt: event.id,
          });
          next.bufferStats = {
            ...state.bufferStats,
            evictions: state.bufferStats.evictions + 1,
            // A dirty victim costs a write on the way out — the pool's own
            // `stats.writes` counts it too (bufferPool.ts), so the fold must
            // match or the panel and the engine would silently disagree.
            writes: state.bufferStats.writes + (event.writtenBack ? 1 : 0),
          };
          if (event.clockHand !== undefined) next.clockHand = event.clockHand;
          return next;
        case 'sweep':
          next.frames = touchFrame(state.frames, event.frameId, {
            usageCount: event.usageCountAfter,
          });
          next.clockHand = event.clockHand;
          return next;
      }
      return next;
    }

    case 'index':
      switch (event.action) {
        case 'open':
          next.indexTree = event.tree;
          next.indexPath = [];
          next.indexOutcome = null;
          return next;
        case 'traverse':
          next.indexPath = [...state.indexPath, event.nodeId];
          next.indexOutcome = 'searching';
          return next;
        case 'found':
          next.indexOutcome = 'found';
          return next;
        case 'not-found':
          next.indexOutcome = 'not-found';
          return next;
      }
      return next;

    case 'lock':
      next.locks =
        event.action === 'acquire'
          ? [...state.locks, { pageId: event.pageId, mode: event.mode }]
          : state.locks.filter(
              (l) => !(l.pageId === event.pageId && l.mode === event.mode),
            );
      next.locksTaken = state.locksTaken + (event.action === 'acquire' ? 1 : 0);
      return next;

    case 'result':
      next.rows = event.rows;
      return next;
  }
}

/**
 * Incremental projector over a fixed trace. `at(n)` is O(1) amortised going
 * forward and free going backward, which is what makes step-back cheap.
 */
export interface TraceProjector {
  at(step: number): ViewState;
  readonly length: number;
}

export function createTraceProjector(
  events: StepEvent[],
  options: EngineOptions,
): TraceProjector {
  const cache: ViewState[] = [initialViewState(options)];

  return {
    length: events.length,
    at(step: number): ViewState {
      const target = Math.max(0, Math.min(step, events.length));
      while (cache.length <= target) {
        const prev = cache[cache.length - 1]!;
        const event = events[cache.length - 1]!;
        cache.push(applyEvent(prev, event));
      }
      return cache[target]!;
    },
  };
}

/** Convenience for tests and one-off reads. */
export function stateAt(
  events: StepEvent[],
  step: number,
  options: EngineOptions,
): ViewState {
  return createTraceProjector(events, options).at(step);
}
