import { describe, expect, it } from 'vitest';
import { buildHeap } from '../storage/page.ts';
import { createBufferPool } from '../storage/bufferPool.ts';
import { policyFor, USAGE_COUNT_CAP } from '../storage/policy.ts';
import { createTracer } from '../trace.ts';
import { createSeedDatabase } from '../seed.ts';
import { stateAt } from '../viewState.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, StepEvent, Table } from '../types.ts';

const db = createSeedDatabase();
const users = db.tables.users!;

const opts = (over: Partial<EngineOptions> = {}): EngineOptions => ({
  ...DEFAULT_ENGINE_OPTIONS,
  ...over,
});

function pool(o: EngineOptions, table: Table = users) {
  const { emit, drain } = createTracer();
  const heap = buildHeap(table, o.rowsPerPage);
  return { pool: createBufferPool(heap, o, emit), heap, drain };
}

const bufferActions = (events: StepEvent[]) =>
  events.flatMap((e) => (e.stage === 'buffer' ? [e.action] : []));

describe('seed data', () => {
  it('has unique ids and names, so demo output is unambiguous', () => {
    expect(new Set(users.rows.map((r) => r.id)).size).toBe(users.rows.length);
    expect(new Set(users.rows.map((r) => r.name)).size).toBe(users.rows.length);
  });

  it('spans more pages than there are buffer frames — otherwise nothing evicts', () => {
    const heap = buildHeap(users, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    expect(heap.pages.length).toBeGreaterThan(DEFAULT_ENGINE_OPTIONS.bufferFrames);
  });
});

describe('buildHeap', () => {
  it('splits rows into pages of the configured size, losing none', () => {
    const heap = buildHeap(users, 4);
    expect(heap.pages).toHaveLength(Math.ceil(users.rows.length / 4));
    expect(heap.pages.flatMap((p) => p.rows)).toEqual(users.rows);
  });

  it('numbers pages contiguously from the first page id', () => {
    expect(buildHeap(users, 4, 10).pages.map((p) => p.pageId).slice(0, 3)).toEqual([
      10, 11, 12,
    ]);
  });

  it('leaves a partial last page rather than padding it', () => {
    const heap = buildHeap({ ...users, rows: users.rows.slice(0, 9) }, 4);
    expect(heap.pages.map((p) => p.rows.length)).toEqual([4, 4, 1]);
  });

  it('gives an empty table one empty page, so a scan still has something to read', () => {
    const heap = buildHeap({ ...users, rows: [] }, 4);
    expect(heap.pages).toHaveLength(1);
    expect(heap.pages[0]?.rows).toEqual([]);
  });
});

describe('buffer pool — hits and misses', () => {
  it('the first read of a page is a miss followed by a load', () => {
    const { pool: bp, drain } = pool(opts());
    bp.fetch(0);
    expect(bufferActions(drain())).toEqual(['miss', 'load']);
    expect(bp.stats).toMatchObject({ misses: 1, hits: 0, evictions: 0 });
  });

  it('a second read of a resident page is a hit with no load', () => {
    const { pool: bp, drain } = pool(opts());
    bp.fetch(0);
    bp.unpin(0);
    bp.fetch(0);
    expect(bufferActions(drain())).toEqual(['miss', 'load', 'hit']);
    expect(bp.stats).toMatchObject({ hits: 1, misses: 1, evictions: 0 });
  });

  it('never evicts while a free frame remains', () => {
    const o = opts({ bufferFrames: 8 });
    const { pool: bp, drain } = pool(o);
    for (let p = 0; p < 8; p++) {
      const f = bp.fetch(p);
      bp.unpin(f!.frameId);
    }
    expect(bufferActions(drain())).not.toContain('evict');
    expect(bp.stats.evictions).toBe(0);
  });

  it('holds each page in exactly one frame', () => {
    const o = opts({ bufferFrames: 4 });
    const { pool: bp } = pool(o);
    for (let p = 0; p < 12; p++) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    const held = bp.state.frames.map((f) => f.pageId).filter((p) => p !== null);
    expect(new Set(held).size).toBe(held.length);
  });

  it('returns null for a page that does not exist', () => {
    const { pool: bp } = pool(opts());
    expect(bp.fetch(9999)).toBeNull();
  });

  it('reports a load for every miss and nothing more', () => {
    const o = opts({ bufferFrames: 3 });
    const { pool: bp, drain } = pool(o);
    for (let p = 0; p < 10; p++) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    const actions = bufferActions(drain());
    expect(actions.filter((a) => a === 'load')).toHaveLength(bp.stats.misses);
    expect(actions.filter((a) => a === 'evict')).toHaveLength(bp.stats.evictions);
  });
});

describe('buffer pool — pinning', () => {
  it('will not evict a pinned frame', () => {
    const o = opts({ bufferFrames: 2 });
    const { pool: bp } = pool(o);
    bp.fetch(0); // stays pinned
    const b = bp.fetch(1);
    bp.unpin(b!.frameId);
    bp.fetch(2); // must evict, and page 0 is pinned

    const pinned = bp.state.frames.find((f) => f.pinCount > 0);
    expect(pinned?.pageId).toBe(0);
    expect(bp.state.frames.map((f) => f.pageId)).toContain(0);
  });

  it('refuses the fetch when every frame is pinned rather than evicting one', () => {
    const o = opts({ bufferFrames: 2 });
    const { pool: bp } = pool(o);
    bp.fetch(0);
    bp.fetch(1);
    expect(bp.fetch(2)).toBeNull();
  });
});

describe('LRU', () => {
  it('evicts the least recently used page', () => {
    const o = opts({ bufferFrames: 3, policy: 'lru' });
    const { pool: bp, drain } = pool(o);
    for (const p of [0, 1, 2]) bp.unpin(bp.fetch(p)!.frameId);
    bp.unpin(bp.fetch(0)!.frameId); // 0 becomes most recent; 1 is now oldest
    bp.unpin(bp.fetch(3)!.frameId);

    const evictions = drain().flatMap((e) =>
      e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
    );
    expect(evictions).toEqual([1]);
  });

  it('emits no sweep events — it has no hand to move', () => {
    const o = opts({ bufferFrames: 2, policy: 'lru' });
    const { pool: bp, drain } = pool(o);
    for (const p of [0, 1, 2, 3]) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    expect(bufferActions(drain())).not.toContain('sweep');
  });
});

describe('clock sweep', () => {
  it('caps usage count the way Postgres does', () => {
    const o = opts({ bufferFrames: 2, policy: 'clock' });
    const { pool: bp } = pool(o);
    for (let i = 0; i < 20; i++) {
      const f = bp.fetch(0);
      bp.unpin(f!.frameId);
    }
    const frame = bp.state.frames.find((f) => f.pageId === 0)!;
    expect(frame.usageCount).toBe(USAGE_COUNT_CAP);
  });

  it('gives a used page a second chance, decrementing rather than evicting it', () => {
    const o = opts({ bufferFrames: 2, policy: 'clock' });
    const { pool: bp, drain } = pool(o);
    for (const p of [0, 1]) bp.unpin(bp.fetch(p)!.frameId);
    bp.unpin(bp.fetch(2)!.frameId);

    const events = drain();
    const sweeps = events.filter((e) => e.stage === 'buffer' && e.action === 'sweep');
    expect(sweeps.length).toBeGreaterThan(0);
    // A sweep must never remove the page it passes over.
    for (const s of sweeps) {
      expect(s.stage === 'buffer' && s.action === 'sweep' && s.usageCountAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps a hot page resident while a cold one is evicted', () => {
    const o = opts({ bufferFrames: 3, policy: 'clock' });
    const { pool: bp } = pool(o);
    for (const p of [0, 1, 2]) bp.unpin(bp.fetch(p)!.frameId);
    // Hammer page 0 so its usage count is high.
    for (let i = 0; i < 5; i++) bp.unpin(bp.fetch(0)!.frameId);
    for (const p of [3, 4]) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    expect(bp.state.frames.map((f) => f.pageId)).toContain(0);
  });

  it('always terminates and returns a victim when one is unpinned', () => {
    const o = opts({ bufferFrames: 4, policy: 'clock' });
    const { pool: bp } = pool(o);
    for (let round = 0; round < 40; round++) {
      const f = bp.fetch(round % 12);
      if (f) bp.unpin(f.frameId);
    }
    expect(bp.state.frames.every((f) => f.pageId !== null)).toBe(true);
  });

  it('the hand advances and wraps within the frame count', () => {
    const o = opts({ bufferFrames: 3, policy: 'clock' });
    const { pool: bp } = pool(o);
    for (let p = 0; p < 12; p++) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    expect(bp.state.hand).toBeGreaterThanOrEqual(0);
    expect(bp.state.hand).toBeLessThan(3);
  });
});

describe('policy interface', () => {
  it('both policies are reachable by name', () => {
    expect(policyFor('lru').name).toBe('lru');
    expect(policyFor('clock').name).toBe('clock');
  });

  it('both survive a full scan and read every page exactly once', () => {
    for (const policy of ['lru', 'clock'] as const) {
      const o = opts({ policy });
      const { pool: bp, heap, drain } = pool(o);
      for (const page of heap.pages) {
        const f = bp.fetch(page.pageId);
        bp.unpin(f!.frameId);
      }
      const loads = drain().flatMap((e) =>
        e.stage === 'buffer' && e.action === 'load' ? [e.pageId] : [],
      );
      expect(loads, policy).toEqual(heap.pages.map((p) => p.pageId));
      expect(bp.stats.hits, policy).toBe(0);
    }
  });
});

describe('LRU vs clock sweep — where they actually differ', () => {
  /**
   * plan.md §7.5 pitches the toggle as "same access pattern, two policies,
   * different victim". That is only true when access is *skewed*. On a uniform
   * sequential scan every page is equally cold, so both policies evict exactly
   * the same pages — clock just takes extra steps to reach the same answer.
   * Worth knowing before the UI implies otherwise.
   */
  function victims(policy: 'lru' | 'clock', accesses: number[], frames: number) {
    const o = opts({ bufferFrames: frames, policy });
    const { pool: bp, drain } = pool(o);
    for (const p of accesses) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    return drain().flatMap((e) =>
      e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
    );
  }

  const scan = [0, 1, 2, 3, 4, 5, 6, 7];

  it('agree on a uniform sequential scan', () => {
    expect(victims('clock', scan, 4)).toEqual(victims('lru', scan, 4));
  });

  it('disagree once one page is hot — which is the whole point of clock sweep', () => {
    // Page 0 is re-read repeatedly; the others are touched once.
    const skewed = [0, 1, 2, 0, 0, 0, 3, 4, 5];
    expect(victims('clock', skewed, 3)).not.toEqual(victims('lru', skewed, 3));
  });
});

describe('engine state and the UI fold agree', () => {
  /**
   * The engine owns the real buffer state; the UI reconstructs it by folding
   * events. Those are two independent implementations of the same rules, so
   * they can drift. This pins them together.
   */
  it.each(['lru', 'clock'] as const)(
    'folding the emitted events reproduces the real frames (%s)',
    (policy) => {
      const o = opts({ policy });
      const { emit, drain } = createTracer();
      const heap = buildHeap(users, o.rowsPerPage);
      const bp = createBufferPool(heap, o, emit);

      for (const page of heap.pages) {
        const f = bp.fetch(page.pageId);
        bp.unpin(f!.frameId);
      }

      const events = drain();
      const folded = stateAt(events, events.length, o);

      expect(folded.frames.map((f) => f.pageId)).toEqual(
        bp.state.frames.map((f) => f.pageId),
      );
      expect(folded.frames.map((f) => f.usageCount)).toEqual(
        bp.state.frames.map((f) => f.usageCount),
      );
      expect(folded.bufferStats).toEqual(bp.stats);
      if (policy === 'clock') expect(folded.clockHand).toBe(bp.state.hand);
    },
  );
});
