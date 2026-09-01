/**
 * Trace buffer: an `emit` callback threaded down into every operator. The
 * query runs to completion and the array is returned. Simplest thing that
 * works, and it works because playback is pre-computed anyway (plan.md §7.8).
 */

import type { PredictionPrompt, StepEvent, StepEventBody } from './types.ts';

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

export function createTracer(): Tracer {
  const events: StepEvent[] = [];

  const emit: Emit = (label, body, options) => {
    const event = { ...body, id: events.length, label } as StepEvent;
    if (options?.predictable) event.predictable = options.predictable;
    if (options?.dwell !== undefined) event.dwell = options.dwell;
    events.push(event);
  };

  return { emit, drain: () => events.slice() };
}
