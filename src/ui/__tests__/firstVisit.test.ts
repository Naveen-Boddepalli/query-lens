/**
 * The hand-off from the first-visit hint to the Playground's tour (`firstVisit.ts`). The page renders before it
 * listens, so a click can land in between; these hold the order that makes such a click still open the tour —
 * once, and never again on a later visit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasPendingTour, listenForTour, requestTour } from '../firstVisit.ts';

// Every listener is stopped after its test, even one that failed part-way, so none answers the next test's request.
const listening: (() => void)[] = [];
const listen = (open: () => void): (() => void) => {
  const stop = listenForTour(open);
  listening.push(stop);
  return stop;
};

afterEach(() => {
  for (const stop of listening.splice(0)) stop();
  sessionStorage.clear();
});

describe('a request to take the tour', () => {
  it('made after the page rendered but before it listened, is answered when it starts listening', () => {
    // The render looked and found nothing waiting…
    expect(hasPendingTour()).toBe(false);
    // …then the click: no one is listening yet, so only the flag is left behind.
    requestTour();
    const open = vi.fn();
    const stop = listen(open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(hasPendingTour()).toBe(false);
    stop();
  });

  it('made while listening, opens the tour once and leaves nothing waiting for a later visit', () => {
    const open = vi.fn();
    const stop = listen(open);
    expect(open).not.toHaveBeenCalled();
    requestTour();
    expect(open).toHaveBeenCalledTimes(1);
    stop();

    // The next visit to the Playground in this tab.
    expect(hasPendingTour()).toBe(false);
    const later = vi.fn();
    listen(later)();
    expect(later).not.toHaveBeenCalled();
  });

  it('is only looked at by hasPendingTour, never answered by it', () => {
    requestTour();
    expect(hasPendingTour()).toBe(true);
    expect(hasPendingTour()).toBe(true);
  });

  it('stops reaching a listener that has stopped', () => {
    const open = vi.fn();
    listen(open)();
    requestTour();
    expect(open).not.toHaveBeenCalled();
  });
});
