import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LATCH_LIMITS, planLatchCrabbing } from '../latchCrabbing.ts';

const INITIAL = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);

describe('planLatchCrabbing — the two protocols, measured on one workload', () => {
  it('naive blocks far more than crabbing on contended inserts, and crabbing keeps each thread smaller', () => {
    const scripts = [[35, 36], [155, 156], [75, 76]];
    const naive = planLatchCrabbing(INITIAL, scripts, 4, 'naive');
    const crab = planLatchCrabbing(INITIAL, scripts, 4, 'crabbing');
    expect(naive.totalBlockedTicks).toBeGreaterThan(crab.totalBlockedTicks);
    expect(naive.threads.map((t) => t.peakLatches)).toEqual([3, 3, 3]);
    expect(crab.threads.map((t) => t.peakLatches)).toEqual([2, 2, 2]);
  });

  it('a single thread never blocks, under either protocol', () => {
    for (const protocol of ['naive', 'crabbing'] as const) {
      const plan = planLatchCrabbing(INITIAL, [[35, 36, 37]], 4, protocol);
      expect(plan.totalBlockedTicks).toBe(0);
    }
  });

  it('the final tree is valid and holds exactly the initial keys plus every scripted key', () => {
    const scripts = [[35, 36], [155, 156], [75, 76]];
    const plan = planLatchCrabbing(INITIAL, scripts, 4, 'crabbing');
    expect(plan.treeProblems).toEqual([]);
    expect(plan.finalKeyCount).toBe(INITIAL.length + 6);
  });

  it('is deterministic: the same inputs produce an identical plan', () => {
    const scripts = [[35, 36], [155, 156]];
    expect(JSON.stringify(planLatchCrabbing(INITIAL, scripts, 4, 'naive'))).toEqual(
      JSON.stringify(planLatchCrabbing(INITIAL, scripts, 4, 'naive')),
    );
  });

  it('every acquired latch is released, and a thread never releases one it does not hold', () => {
    const scripts = [[35, 36], [155, 156], [75, 76]];
    for (const protocol of ['naive', 'crabbing'] as const) {
      const plan = planLatchCrabbing(INITIAL, scripts, 4, protocol);
      const held = new Map<number, number>();
      for (const a of plan.timeline) {
        if (a.kind === 'acquire') held.set(a.thread, (held.get(a.thread) ?? 0) + 1);
        if (a.kind === 'release') {
          const n = (held.get(a.thread) ?? 0) - 1;
          expect(n).toBeGreaterThanOrEqual(0);
          held.set(a.thread, n);
        }
      }
      for (const n of held.values()) expect(n).toBe(0);
    }
  });

  it('clamps an out-of-range fanout rather than producing a broken tree', () => {
    const plan = planLatchCrabbing(INITIAL, [[35]], 999, 'crabbing');
    expect(plan.maxKeys).toBe(LATCH_LIMITS.maxFanout);
    expect(plan.treeProblems).toEqual([]);
  });
});

describe('planLatchCrabbing — invariants over any legal workload', () => {
  it('never deadlocks, never leaves a tree problem, and crabbing never holds more per thread than naive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: LATCH_LIMITS.minFanout, max: LATCH_LIMITS.maxFanout }),
        fc.integer({ min: LATCH_LIMITS.minThreads, max: LATCH_LIMITS.maxThreads }),
        fc.integer({ min: LATCH_LIMITS.minOpsPerThread, max: LATCH_LIMITS.maxOpsPerThread }),
        fc.integer({ min: 0, max: 9999 }),
        (fanout, threads, opsPerThread, seed) => {
          // Distinct keys drawn from a wide range, so inserts land in different parts of the tree.
          let s = seed + 1;
          const next = () => {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            return s;
          };
          const pool = new Set<number>();
          while (pool.size < threads * opsPerThread + INITIAL.length) pool.add(next() % 1000);
          const all = [...pool];
          const initial = all.slice(0, INITIAL.length);
          const scripts = Array.from({ length: threads }, (_, t) =>
            all.slice(INITIAL.length + t * opsPerThread, INITIAL.length + (t + 1) * opsPerThread),
          );

          const naive = planLatchCrabbing(initial, scripts, fanout, 'naive');
          const crab = planLatchCrabbing(initial, scripts, fanout, 'crabbing');
          expect(naive.ticks).toBeLessThan(100_000);
          expect(crab.ticks).toBeLessThan(100_000);
          expect(naive.treeProblems).toEqual([]);
          expect(crab.treeProblems).toEqual([]);
          for (let t = 0; t < threads; t++) {
            expect(crab.threads[t]!.peakLatches).toBeLessThanOrEqual(naive.threads[t]!.peakLatches);
          }
        },
      ),
    );
  });
});
