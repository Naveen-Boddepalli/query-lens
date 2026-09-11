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
  return { pool: createBufferPool(heap.pages.length, o, emit), heap, drain };
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
    expect(bp.fetch(-1)).toBeNull();
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

describe('buffer pool — write (Sort spill, plan.md §22.2)', () => {
  it('occupies a free frame and counts as a write, not a hit or a miss', () => {
    const { emit, drain } = createTracer();
    const bp = createBufferPool(10, opts(), emit);
    const result = bp.write(5);
    expect(result).toEqual({ frameId: 0, hit: false });
    expect(bufferActions(drain())).toEqual(['write']);
    expect(bp.stats).toMatchObject({ writes: 1, hits: 0, misses: 0, evictions: 0 });
  });

  it('evicts under the same policy a read would, once every frame is full', () => {
    const o = opts({ bufferFrames: 2 });
    const { emit, drain } = createTracer();
    const bp = createBufferPool(10, o, emit);
    bp.write(0);
    bp.unpin(0);
    bp.write(1);
    bp.unpin(1);
    bp.write(2); // both frames full — this must evict
    expect(bufferActions(drain())).toEqual(['write', 'write', 'evict', 'write']);
    expect(bp.stats).toMatchObject({ writes: 3, evictions: 1 });
  });

  it('a write and a read compete for the same frames', () => {
    const o = opts({ bufferFrames: 1 });
    const { emit } = createTracer();
    const bp = createBufferPool(10, o, emit);
    const written = bp.write(0);
    bp.unpin(written!.frameId);
    // The pool has one frame, already holding the written page — a fetch of
    // a different page must evict it.
    bp.fetch(1);
    expect(bp.stats.evictions).toBe(1);
    expect(bp.state.frames[0]?.pageId).toBe(1);
  });

  it('rejects a page id outside the pool, exactly like fetch', () => {
    const { emit } = createTracer();
    const bp = createBufferPool(4, opts(), emit);
    expect(bp.write(4)).toBeNull();
    expect(bp.write(-1)).toBeNull();
  });

  it('returns null rather than evict when every frame is pinned', () => {
    const o = opts({ bufferFrames: 1 });
    const { emit } = createTracer();
    const bp = createBufferPool(10, o, emit);
    bp.write(0); // stays pinned — never unpinned
    expect(bp.write(1)).toBeNull();
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
  const ALL = ['lru', 'clock', 'fifo', 'second-chance', 'optimal', 'midpoint'] as const;

  it('every policy is reachable by name', () => {
    for (const name of ALL) expect(policyFor(name).name).toBe(name);
  });

  it('every policy survives a full scan and reads each page exactly once', () => {
    for (const policy of ALL) {
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

describe('FIFO', () => {
  const victims = (accesses: number[], frames: number) => {
    const o = opts({ bufferFrames: frames, policy: 'fifo' });
    const { pool: bp, drain } = pool(o);
    for (const p of accesses) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    return drain().flatMap((e) =>
      e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
    );
  };

  it('evicts in load order, however hot the page has since become', () => {
    // Page 0 is hammered after loading; FIFO evicts it anyway — first in,
    // first out. This is precisely the failure clock sweep was designed around.
    expect(victims([0, 1, 2, 0, 0, 0, 3], 3)).toEqual([0]);
  });

  it('emits no sweep events — it has no second-chance pass', () => {
    const o = opts({ bufferFrames: 2, policy: 'fifo' });
    const { pool: bp, drain } = pool(o);
    for (const p of [0, 1, 2, 3]) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    expect(bufferActions(drain())).not.toContain('sweep');
  });
});

describe('second-chance', () => {
  function evictRun(accesses: number[], frames: number) {
    const o = opts({ bufferFrames: frames, policy: 'second-chance' });
    const { pool: bp, drain } = pool(o);
    for (const p of accesses) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    const events = drain();
    return {
      victims: events.flatMap((e) =>
        e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
      ),
      sweeps: events.filter((e) => e.stage === 'buffer' && e.action === 'sweep').length,
    };
  }

  it('forgives a page referenced since it loaded, and says so with a sweep', () => {
    // [0 1 2] fill; 3 forces a pass that clears every bit and evicts 0; then 1
    // is re-touched (bit set again) so the next eviction passes over it and
    // takes 2 instead. FIFO would have taken 1.
    const { victims, sweeps } = evictRun([0, 1, 2, 3, 1, 4], 3);
    expect(victims).toEqual([0, 2]);
    expect(sweeps).toBeGreaterThan(0);

    const fifoVictims = (() => {
      const o = opts({ bufferFrames: 3, policy: 'fifo' });
      const { pool: bp, drain } = pool(o);
      for (const p of [0, 1, 2, 3, 1, 4]) {
        const f = bp.fetch(p);
        if (f) bp.unpin(f.frameId);
      }
      return drain().flatMap((e) =>
        e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
      );
    })();
    expect(fifoVictims).toEqual([0, 1]);
  });

  it('terminates and returns a victim once every bit in the pool is set', () => {
    const o = opts({ bufferFrames: 4, policy: 'second-chance' });
    const { pool: bp } = pool(o);
    for (let round = 0; round < 40; round++) {
      const f = bp.fetch(round % 12);
      if (f) bp.unpin(f.frameId);
    }
    expect(bp.state.frames.every((f) => f.pageId !== null)).toBe(true);
  });
});

describe('midpoint LRU (InnoDB)', () => {
  const bufferActionsOf = (accesses: number[], frames: number, policy: 'lru' | 'midpoint') => {
    const o = opts({ bufferFrames: frames, policy });
    const { pool: bp, drain } = pool(o);
    for (const p of accesses) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    const events = drain();
    return {
      victims: events.flatMap((e) =>
        e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
      ),
      hits: bp.stats.hits,
      resident: bp.state.frames.map((f) => f.pageId).filter((p) => p !== null),
    };
  };

  // Pages 0 and 1 are read, then re-read (so they reach the young sublist),
  // then a run of fresh pages arrives and page 0 is asked for once more. Plain
  // LRU evicts the hot pages first (0, then 1) and the closing read of 0 misses.
  // Midpoint evicts only the scan's own pages and keeps 0 and 1 resident.
  const HOT_THEN_SCAN = [0, 1, 0, 1, 2, 3, 4, 5, 0];

  it('protects the young sublist from a one-pass scan', () => {
    const mid = bufferActionsOf(HOT_THEN_SCAN, 4, 'midpoint');
    const lru = bufferActionsOf(HOT_THEN_SCAN, 4, 'lru');

    expect(mid.victims).toEqual([2, 3]);
    expect(lru.victims).toEqual([0, 1, 2]);
    expect(mid.resident).toContain(0);
    expect(mid.resident).toContain(1);
    expect(mid.hits).toBeGreaterThan(lru.hits);
  });

  it('behaves like LRU when every page is re-used (all young)', () => {
    // Nothing stays in the old sublist, so the fallback — overall LRU — runs.
    const refs = [0, 1, 2, 0, 1, 2, 3];
    expect(bufferActionsOf(refs, 3, 'midpoint').victims).toEqual(
      bufferActionsOf(refs, 3, 'lru').victims,
    );
  });
});

describe('optimal (Bélády)', () => {
  it('falls back to FIFO order when it has no lookahead', () => {
    // `createBufferPool` with no reference string — the SQL path. The farthest
    // next use is unknowable, so every resident page ties and the oldest goes.
    const o = opts({ bufferFrames: 3, policy: 'optimal' });
    const { emit, drain } = createTracer();
    const heap = buildHeap(users, o.rowsPerPage);
    const bp = createBufferPool(heap.pages.length, o, emit); // no 4th arg
    for (const p of [0, 1, 2, 3]) {
      const f = bp.fetch(p);
      if (f) bp.unpin(f.frameId);
    }
    const victims = drain().flatMap((e) =>
      e.stage === 'buffer' && e.action === 'evict' ? [e.victimPageId] : [],
    );
    expect(victims).toEqual([0]);
  });
});

describe('engine state and the UI fold agree — extra policies', () => {
  // The clock-only `usageCount` the fold reconstructs is meaningless for these
  // policies (the panel never renders it for them), so this pins the frame
  // *contents* and the stats rather than every field.
  it.each(['fifo', 'second-chance', 'optimal', 'midpoint'] as const)(
    'folding the emitted events reproduces the resident pages (%s)',
    (policy) => {
      const o = opts({ policy });
      const { emit, drain } = createTracer();
      const heap = buildHeap(users, o.rowsPerPage);
      const bp = createBufferPool(heap.pages.length, o, emit);
      for (const page of heap.pages) {
        const f = bp.fetch(page.pageId);
        bp.unpin(f!.frameId);
      }
      const events = drain();
      const folded = stateAt(events, events.length, o);
      expect(folded.frames.map((f) => f.pageId)).toEqual(bp.state.frames.map((f) => f.pageId));
      expect(folded.bufferStats).toEqual(bp.stats);
    },
  );
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
      const bp = createBufferPool(heap.pages.length, o, emit);

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
