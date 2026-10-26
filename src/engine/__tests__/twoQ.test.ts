import { describe, expect, it } from 'vitest';
import { runBufferTrace } from '../bufferTrace.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';

function missEvents(refs: readonly number[], policy: 'lru' | 'two-q', frames: number): number {
  const result = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, policy, bufferFrames: frames });
  return result.events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
}

/** Misses incurred by the last reference alone: the trace with and without it. */
function missesOnLast(refs: readonly number[], policy: 'lru' | 'two-q', frames: number): number {
  return missEvents(refs, policy, frames) - missEvents(refs.slice(0, -1), policy, frames);
}

describe('2Q (Johnson and Shasha, 1994)', () => {
  it('a page read again after it left the FIFO is promoted, and survives a later one-pass scan', () => {
    // Page 0 is read once, then pushed out of the FIFO by a burst and read again: the ghost list remembers it, so the
    // second read promotes it to the hot queue. A long scan then evicts only the FIFO, and the final read of 0 hits.
    const refs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, ...Array.from({ length: 30 }, (_, i) => 200 + i), 0];
    expect(missesOnLast(refs, 'two-q', 8)).toBe(0);
    expect(missesOnLast(refs, 'lru', 8)).toBe(1);
  });

  it('a page read twice in a burst, while still in the FIFO, is not promoted: the correlated-reference rule', () => {
    const refs = [0, 0, ...Array.from({ length: 30 }, (_, i) => 100 + i), 0];
    expect(missesOnLast(refs, 'two-q', 8)).toBe(1);
  });

  it('a hot set read only in a burst gets no protection from a scan (the essay trace)', () => {
    // Recorded so the limit stays visible: LRU-2 keeps this set and 2Q, like LRU, does not.
    const hot = [0, 1, 2, 3];
    const scan = Array.from({ length: 40 }, (_, i) => 100 + i);
    const refs = [...hot, ...hot, ...scan, ...hot];
    expect(missEvents(refs, 'two-q', 8)).toBe(missEvents(refs, 'lru', 8));
    expect(missEvents(refs, 'two-q', 8) - missEvents(refs.slice(0, -4), 'two-q', 8)).toBe(4);
  });

  it('a working set that fits in the pool misses each page exactly once', () => {
    const pages = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(missEvents([...pages, ...pages, ...pages], 'two-q', 8)).toBe(8);
  });

  it('is deterministic: the same reference string gives the same events', () => {
    const refs = [1, 2, 3, 1, 4, 2, 5, 1, 3, 6, 7, 1];
    const a = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, policy: 'two-q', bufferFrames: 3 });
    const b = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, policy: 'two-q', bufferFrames: 3 });
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });
});
