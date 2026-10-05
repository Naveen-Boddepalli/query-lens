import { describe, expect, it } from 'vitest';
import { runBufferTrace } from '../bufferTrace.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { StepEvent } from '../types.ts';

const pages = 10;
const scan = Array.from({ length: pages }, (_, i) => i);

function bufferEvents(refs: readonly number[], readAhead: number | undefined): StepEvent[] {
  const options = {
    ...DEFAULT_ENGINE_OPTIONS,
    policy: 'lru' as const,
    bufferFrames: 8,
    ...(readAhead === undefined ? {} : { readAhead }),
  };
  return runBufferTrace(refs, options).events.filter((e) => e.stage === 'buffer');
}

const count = (events: StepEvent[], action: string) =>
  events.filter((e) => e.stage === 'buffer' && e.action === action).length;

describe('sequential read-ahead (plan.md §25.4 F7, decided 2026-10-05)', () => {
  it('reads each page from disk exactly once, and every request after the first two is a hit', () => {
    const events = bufferEvents(scan, 2);
    // Pages 0 and 1 are demanded cold; from page 1 onward the scan is sequential, so pages 2..9 are read early.
    expect(count(events, 'miss')).toBe(2);
    expect(count(events, 'prefetch')).toBe(8);
    expect(count(events, 'load')).toBe(2);
    expect(count(events, 'hit')).toBe(8);
    expect(count(events, 'load') + count(events, 'prefetch')).toBe(pages);
  });

  it('a prefetched page is a prefetch first, and a hit when the scan asks for it', () => {
    const events = bufferEvents(scan, 2);
    for (let p = 2; p < pages; p++) {
      const prefetchAt = events.findIndex((e) => e.stage === 'buffer' && e.action === 'prefetch' && e.pageId === p);
      const hitAt = events.findIndex((e) => e.stage === 'buffer' && e.action === 'hit' && e.pageId === p);
      expect(prefetchAt).toBeGreaterThanOrEqual(0);
      expect(hitAt).toBeGreaterThan(prefetchAt);
    }
  });

  it('without read-ahead, a scan misses every page, as before', () => {
    const events = bufferEvents(scan, undefined);
    expect(count(events, 'prefetch')).toBe(0);
    expect(count(events, 'miss')).toBe(pages);
    expect(count(events, 'hit')).toBe(0);
  });

  it('a non-sequential access pattern prefetches nothing', () => {
    const events = bufferEvents([5, 1, 7, 3, 9, 0, 4], 2);
    expect(count(events, 'prefetch')).toBe(0);
  });

  it('never reads past the last page', () => {
    const events = bufferEvents(scan, 4);
    const prefetched = events.flatMap((e) => (e.stage === 'buffer' && e.action === 'prefetch' ? [e.pageId] : []));
    expect(Math.max(...prefetched)).toBe(pages - 1);
    expect(new Set(prefetched).size).toBe(prefetched.length);
  });
});
