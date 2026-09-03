import { describe, expect, it } from 'vitest';
import { createSeedDatabase } from '../seed.ts';
import { runQuery } from '../runQuery.ts';
import { createTraceProjector } from '../viewState.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';

/**
 * plan.md §14.2: measure step latency, do not guess at it.
 *
 * INP is the most-failed Core Web Vital, and stepping the trace is *literally*
 * an INP measurement — one keypress re-folds events and re-lays-out a graph.
 * The half that can be pinned down here is the algorithmic half: the fold is
 * the only part of a step whose cost can grow with trace length, and the only
 * part that could quietly become quadratic. React's render and React Flow's
 * layout are the other half, and jsdom timings for those would be fiction —
 * those need field data from real hardware, which §14.2 says to collect before
 * optimising rather than after.
 *
 * So this is a tripwire, not a benchmark. It fails if `at()` stops memoising or
 * starts re-folding from zero, which are the two ways stepping gets slow.
 */

// The sequential scan, not the point lookup: 139 events against 33, and the
// longest trace the v0 subset can produce on the seed data.
const LONG_SCAN = 'SELECT * FROM users WHERE age > 30;';

function longTrace() {
  const result = runQuery(LONG_SCAN, createSeedDatabase(), DEFAULT_ENGINE_OPTIONS);
  expect(result.events.length).toBeGreaterThan(100);
  return result.events;
}

describe('step latency', () => {
  it('folds each event exactly once, however often a step is revisited', () => {
    const projector = createTraceProjector(longTrace(), DEFAULT_ENGINE_OPTIONS);

    // Reference equality is the memoisation contract: a re-fold would produce
    // an equal-but-distinct object, and this would fail without timing anything.
    const first = projector.at(40);
    expect(projector.at(40)).toBe(first);

    projector.at(120);
    expect(projector.at(40)).toBe(first);
  });

  it('is free to walk backwards after walking forwards', () => {
    // Step-back is the interaction a learner uses most — "wait, what just
    // happened?" — and it must not re-run the fold.
    const events = longTrace();
    const projector = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);

    const forward = Array.from({ length: events.length + 1 }, (_, i) => projector.at(i));
    for (let i = events.length; i >= 0; i--) {
      expect(projector.at(i)).toBe(forward[i]);
    }
  });

  it('costs the same per step whether stepped or jumped to', () => {
    // A projector that re-folded from zero on every call would make the
    // sequential walk quadratic; folding once makes the two paths identical.
    const events = longTrace();

    const stepped = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);
    for (let i = 0; i <= events.length; i++) stepped.at(i);

    const jumped = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);
    jumped.at(events.length);

    expect(jumped.at(events.length)).toEqual(stepped.at(events.length));
  });

  it('keeps a whole trace walk well inside one interaction budget', () => {
    // Deliberately loose: CI runners are shared and this is a tripwire for an
    // order-of-magnitude regression, not a performance gate. Folding *every*
    // step of the longest trace should still cost less than the 200 ms INP
    // budget for a single one.
    const events = longTrace();
    const projector = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);

    const start = performance.now();
    for (let i = 0; i <= events.length; i++) projector.at(i);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
  });
});
