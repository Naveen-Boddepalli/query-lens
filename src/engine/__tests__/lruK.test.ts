import { describe, expect, it } from 'vitest';
import { runBufferTrace } from '../bufferTrace.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';

function missesFor(refs: readonly number[], policy: 'lru' | 'lru-k', frames: number): number {
  const result = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, policy, bufferFrames: frames });
  return result.events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
}

describe('LRU-2 (LRU-K, K = 2)', () => {
  it('evicts a page referenced once before a page referenced twice, even when the once-referenced one is more recent', () => {
    // Pages 1 and 2 fill two frames; page 1 has been touched twice, page 2 once. Loading page 3 must evict page 2,
    // so the final reference to page 1 is a hit. Plain LRU evicts page 1 (touched less recently), and misses it.
    const refs = [1, 1, 2, 3, 1];
    expect(missesFor(refs, 'lru-k', 2)).toBe(3);
    expect(missesFor(refs, 'lru', 2)).toBe(4);
  });

  it('a one-pass scan does not flush a hot page that has been referenced twice', () => {
    // Hot page 0 is referenced twice up front; then a long scan of pages touched once each. LRU-2 keeps page 0
    // resident throughout, so its final reference is a hit.
    const scan = Array.from({ length: 20 }, (_, i) => i + 10);
    const refs = [0, 0, ...scan, 0];
    const lruK = missesFor(refs, 'lru-k', 3);
    const lru = missesFor(refs, 'lru', 3);
    expect(lruK).toBeLessThan(lru);
  });

  it('with a cache big enough for everything, LRU-2 never misses a page twice', () => {
    const refs = [0, 1, 2, 0, 1, 2, 0, 1, 2];
    expect(missesFor(refs, 'lru-k', 8)).toBe(3); // one cold miss per distinct page, then all hits
  });

  it('is deterministic: the same reference string gives the same events', () => {
    const refs = [1, 2, 3, 1, 4, 2, 5, 1, 3];
    const a = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, policy: 'lru-k', bufferFrames: 3 });
    const b = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, policy: 'lru-k', bufferFrames: 3 });
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('leaves the default LRU policy exactly as it was', () => {
    const refs = [1, 2, 3, 1, 4, 2, 5, 1, 3];
    const explicit = missesFor(refs, 'lru', 3);
    const defaulted = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 3 })
      .events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
    expect(defaulted).toBe(explicit);
  });
});
