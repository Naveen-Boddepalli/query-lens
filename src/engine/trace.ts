/**
 * Trace buffer: an `emit` callback threaded down into every operator. The
 * query runs to completion and the array is returned. Simplest thing that
 * works, and it works because playback is pre-computed anyway (plan.md §7.8).
 *
 * It has a ceiling (plan.md §28.5 I1). A join of two big tables can take millions of steps — the parallel tool's
 * orders × payments recorded 13.5 million, about 2.6 GB, and took a CI worker down with it — and nobody steps
 * through more than a few thousand. Past `budget` events the run goes on to the end and its rows are exact, but a
 * step is counted rather than kept, except the result step, which is always kept and carries a `TraceCut`: how
 * many steps there were, and the totals the view state's counters and `EXPLAIN ANALYZE` would have summed from the
 * steps it no longer has.
 */

import type { PredictionPrompt, StepEvent, StepEventBody, TraceCut } from './types.ts';

/**
 * The most steps a trace keeps. Measured, not guessed: the largest trace any preset, lesson or challenge makes is
 * 9,749 steps (a full scan of the 3,000-row `transactions` table), so this is about twenty times that — some 40 MB
 * at the ~190 bytes a step costs — and still past anything anyone steps through by hand.
 */
export const TRACE_BUDGET = 200_000;

export interface EmitOptions {
  predictable?: PredictionPrompt;
  /** Playback pacing weight; see `StepEvent.dwell`. */
  dwell?: number;
}

export type Emit = (label: string, body: StepEventBody, options?: EmitOptions) => void;

export interface Tracer {
  emit: Emit;
  drain: () => StepEvent[];
}

export interface TracerOptions {
  /** The most events kept; see `TRACE_BUDGET`. */
  budget?: number;
  /** Sees every event's body as it is emitted, kept or not. */
  observe?: (body: StepEventBody) => void;
}

type BufferStats = TraceCut['bufferStats'];
type BufferBody = Extract<StepEventBody, { stage: 'buffer' }>;

/**
 * One buffer step's effect on the pool's running counts — the rule `applyEvent` folds by and `TraceCut` totals by,
 * so the two can never disagree. A dirty victim costs a write on the way out, as the pool's own `stats.writes`
 * counts it (bufferPool.ts).
 */
export function countBufferStep(stats: BufferStats, event: BufferBody): BufferStats {
  switch (event.action) {
    case 'hit':
      return { ...stats, hits: stats.hits + 1 };
    case 'miss':
      return { ...stats, misses: stats.misses + 1 };
    case 'prefetch':
      return { ...stats, prefetches: stats.prefetches + 1 };
    case 'write':
      return { ...stats, writes: stats.writes + 1 };
    case 'evict':
      return { ...stats, evictions: stats.evictions + 1, writes: stats.writes + (event.writtenBack ? 1 : 0) };
    case 'load':
    case 'sweep':
    case 'log':
    case 'flush':
    case 'undo':
      return stats;
  }
}

/** What a result step says when its trace was cut. */
export function cutNote(cut: TraceCut): string {
  const steps = (n: number) => n.toLocaleString('en');
  return `This run took ${steps(cut.total + 1)} steps; the trace keeps the first ${steps(cut.kept)} and this one, and the counts here are the whole run's.`;
}

/** The result step's cut, if the trace was cut. */
export function cutOf(events: readonly StepEvent[]): TraceCut | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.stage === 'result') return event.cut;
  }
  return undefined;
}

export function createTracer(tracerOptions: TracerOptions = {}): Tracer {
  const budget = tracerOptions.budget ?? TRACE_BUDGET;
  const observe = tracerOptions.observe;
  const events: StepEvent[] = [];

  // Running totals over every step, kept or not — only read once a step has been dropped.
  let total = 0;
  let bufferStats: BufferStats = { hits: 0, misses: 0, evictions: 0, writes: 0, prefetches: 0 };
  let locksTaken = 0;
  const lastRows = new Map<string, number>();
  const actualRows = new Map<string, { op: string; table?: string; rowsProduced: number }>();

  const tally = (body: StepEventBody) => {
    total += 1;
    if (body.stage === 'buffer') bufferStats = countBufferStep(bufferStats, body);
    else if (body.stage === 'lock' && body.action === 'acquire') locksTaken += 1;
    else if (body.stage === 'execute') {
      lastRows.set(body.op, body.rowsProduced);
      const key = body.table === undefined ? body.op : `${body.op}\u0000${body.table}`;
      const seen = actualRows.get(key);
      if (!seen || body.rowsProduced > seen.rowsProduced) {
        actualRows.set(key, {
          op: body.op,
          ...(body.table === undefined ? {} : { table: body.table }),
          rowsProduced: Math.max(seen?.rowsProduced ?? 0, body.rowsProduced),
        });
      }
    }
  };

  const emit: Emit = (label, body, options) => {
    tally(body);
    observe?.(body);
    const keep = events.length < budget || body.stage === 'result';
    if (!keep) return;
    const event = { ...body, id: events.length, label } as StepEvent;
    if (options?.predictable) event.predictable = options.predictable;
    if (options?.dwell !== undefined) event.dwell = options.dwell;
    // `total` already counts this step: the ones dropped are every step so far that is not in `events`, this one aside.
    const dropped = total - 1 - events.length;
    if (event.stage === 'result' && dropped > 0 && !event.cut) {
      event.cut = {
        kept: events.length,
        total: total - 1,
        bufferStats,
        locksTaken,
        operators: [...lastRows].map(([op, rowsProduced]) => ({ op, rowsProduced })),
        actualRows: [...actualRows.values()],
      };
      event.label = `${label} ${cutNote(event.cut)}`;
    }
    events.push(event);
  };

  return { emit, drain: () => events.slice() };
}
