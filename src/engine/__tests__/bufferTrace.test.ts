import { describe, expect, it } from 'vitest';
import {
  MAX_REFERENCES,
  parseReferenceString,
  randomReferenceString,
  runBufferTrace,
} from '../bufferTrace.ts';
import { createTraceProjector } from '../viewState.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, StepEvent } from '../types.ts';

const opts = (over: Partial<EngineOptions> = {}): EngineOptions => ({
  ...DEFAULT_ENGINE_OPTIONS,
  ...over,
});

const actions = (events: StepEvent[]) =>
  events.flatMap((e) => (e.stage === 'buffer' ? [e.action] : []));

describe('runBufferTrace', () => {
  it('emits only buffer events, in the order the reference string implies', () => {
    const { events } = runBufferTrace([0, 1, 0], opts({ bufferFrames: 4 }));
    expect(events.every((e) => e.stage === 'buffer')).toBe(true);
    // 0 miss+load, 1 miss+load, 0 hit.
    expect(actions(events)).toEqual(['miss', 'load', 'miss', 'load', 'hit']);
  });

  it('evicts once the distinct pages outrun the frames', () => {
    const { events } = runBufferTrace([0, 1, 2, 3, 4], opts({ bufferFrames: 3, policy: 'lru' }));
    expect(actions(events)).toContain('evict');
  });

  it('LRU and clock sweep pick the same victim on a uniform scan, as the docs claim', () => {
    // A pure sweep with no revisits gives every frame the same recency and the
    // same usage count, so both policies are forced to the same first victim —
    // the fact the buffer-pool docs page states (plan.md §17.1's status note).
    const refs = [0, 1, 2, 3, 4, 5];
    const lru = runBufferTrace(refs, opts({ bufferFrames: 4, policy: 'lru' }));
    const clock = runBufferTrace(refs, opts({ bufferFrames: 4, policy: 'clock' }));
    const victim = (events: StepEvent[]) =>
      events.find((e) => e.stage === 'buffer' && e.action === 'evict');
    expect(victim(lru.events)).toMatchObject({ victimPageId: 0 });
    expect(victim(clock.events)).toMatchObject({ victimPageId: 0 });
  });

  it('LRU and clock sweep diverge once some pages are hotter than others', () => {
    // The companion to the uniform-scan test above, and the default reference
    // string ComparePage.tsx ships: pages 0-2 touched twice each, page 3 once,
    // then page 4 forces an eviction. Clock's usage count protects the hot
    // pages and takes the cold one; LRU only sees recency and takes whichever
    // of the hot three happened to be touched least recently.
    const refs = [0, 1, 2, 0, 1, 2, 3, 4];
    const lru = runBufferTrace(refs, opts({ bufferFrames: 4, policy: 'lru' }));
    const clock = runBufferTrace(refs, opts({ bufferFrames: 4, policy: 'clock' }));
    const victim = (events: StepEvent[]) =>
      events.find((e) => e.stage === 'buffer' && e.action === 'evict');
    expect(victim(lru.events)).toMatchObject({ victimPageId: 0 });
    expect(victim(clock.events)).toMatchObject({ victimPageId: 3 });
  });

  it('the optimal policy uses the reference string to beat LRU on the same input', () => {
    // [0 1 2 3 1 0], 3 frames. LRU evicts page 0 at access 3 (oldest), then has
    // to re-read it at access 5 — 5 misses. The optimal policy sees that page 2
    // is the one never touched again and evicts *that*, keeping 0 and 1
    // resident for their later hits — 4 misses.
    const refs = [0, 1, 2, 3, 1, 0];
    const misses = (events: StepEvent[]) => actions(events).filter((a) => a === 'miss').length;
    const firstVictim = (events: StepEvent[]) =>
      events.find((e) => e.stage === 'buffer' && e.action === 'evict');

    const lru = runBufferTrace(refs, opts({ bufferFrames: 3, policy: 'lru' }));
    const optimal = runBufferTrace(refs, opts({ bufferFrames: 3, policy: 'optimal' }));

    expect(firstVictim(optimal.events)).toMatchObject({ victimPageId: 2 });
    expect(firstVictim(lru.events)).toMatchObject({ victimPageId: 0 });
    expect(misses(optimal.events)).toBeLessThan(misses(lru.events));
  });

  it('no policy ever reads a page that is not referenced by the string', () => {
    for (const policy of ['fifo', 'second-chance', 'optimal', 'midpoint'] as const) {
      const refs = [0, 1, 2, 3, 4, 2, 1, 5, 0];
      const { events } = runBufferTrace(refs, opts({ bufferFrames: 3, policy }));
      const loaded = events.flatMap((e) =>
        e.stage === 'buffer' && e.action === 'load' ? [e.pageId] : [],
      );
      expect(new Set(loaded).size, policy).toBeLessThanOrEqual(new Set(refs).size);
      expect(loaded.every((p) => refs.includes(p)), policy).toBe(true);
    }
  });

  it('caps the reference string rather than hanging on a hostile input', () => {
    const huge = Array.from({ length: MAX_REFERENCES + 200 }, (_, i) => i % 10);
    const { accessBoundaries } = runBufferTrace(huge, opts());
    expect(accessBoundaries.length).toBe(MAX_REFERENCES);
  });

  it('accessBoundaries lines up an access with the event count at that point', () => {
    const { events, accessBoundaries } = runBufferTrace([0, 1, 0], opts({ bufferFrames: 4 }));
    accessBoundaries.forEach((boundary, i) => {
      expect(boundary).toBeLessThanOrEqual(events.length);
      expect(boundary).toBeGreaterThan(i === 0 ? -1 : accessBoundaries[i - 1]! - 1);
    });
    expect(accessBoundaries.at(-1)).toBe(events.length);
  });

  it('folds through the same projector the SQL path uses, with no non-buffer state touched', () => {
    const { events } = runBufferTrace([0, 1, 2, 0], opts({ bufferFrames: 2 }));
    const projector = createTraceProjector(events, opts({ bufferFrames: 2 }));
    const end = projector.at(events.length);
    expect(end.ast).toBeNull();
    expect(end.plan).toBeNull();
    expect(end.frames).toHaveLength(2);
    expect(end.bufferStats.misses + end.bufferStats.hits).toBe(4);
  });
});

describe('parseReferenceString', () => {
  it('accepts commas, whitespace, and mixtures of both', () => {
    expect(parseReferenceString('1 2, 3,4   5')).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops anything that is not a non-negative integer rather than throwing', () => {
    expect(parseReferenceString('1, -2, 3.5, abc, 4')).toEqual([1, 4]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseReferenceString('   ')).toEqual([]);
  });
});

describe('randomReferenceString', () => {
  it('produces the requested length, all within range', () => {
    const refs = randomReferenceString(40, 6);
    expect(refs).toHaveLength(40);
    expect(refs.every((p) => p >= 0 && p < 6)).toBe(true);
  });

  it('is not uniform noise — it revisits pages, so hits actually happen', () => {
    const { events } = runBufferTrace(randomReferenceString(60, 8), opts({ bufferFrames: 6 }));
    expect(actions(events)).toContain('hit');
  });
});
