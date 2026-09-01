/**
 * Trace buffer: an `emit` callback threaded down into every operator. The
 * query runs to completion and the array is returned. Simplest thing that
 * works, and it works because playback is pre-computed anyway (plan.md §7.8).
 */

import type { PredictionPrompt, StepEvent, StepEventBody } from './types.ts';

export interface EmitOptions {
  predictable?: PredictionPrompt;
}

export type Emit = (label: string, body: StepEventBody, options?: EmitOptions) => void;

export interface Tracer {
  emit: Emit;
  drain: () => StepEvent[];
}

export function createTracer(): Tracer {
  const events: StepEvent[] = [];

  const emit: Emit = (label, body, options) => {
    const base = { ...body, id: events.length, label } as StepEvent;
    events.push(
      options?.predictable ? { ...base, predictable: options.predictable } : base,
    );
  };

  return { emit, drain: () => events.slice() };
}
