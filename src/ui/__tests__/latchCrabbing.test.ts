import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEMO_INITIAL_KEYS, demoScripts, LATCH_LIMITS, planLatchCrabbing } from '../latchCrabbing.ts';

const INITIAL = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);

describe('planLatchCrabbing — naive and crabbing, measured on one workload', () => {
  it('naive blocks far more than crabbing on contended inserts, and crabbing keeps each thread smaller', () => {
    const scripts = [[35, 36], [155, 156], [75, 76]];
    const naive = planLatchCrabbing(INITIAL, scripts, 4, 'naive');
    const crab = planLatchCrabbing(INITIAL, scripts, 4, 'crabbing');
    expect(naive.totalBlockedTicks).toBeGreaterThan(crab.totalBlockedTicks);
    expect(naive.threads.map((t) => t.peakLatches)).toEqual([3, 3, 3]);
    expect(crab.threads.map((t) => t.peakLatches)).toEqual([2, 2, 2]);
  });

  it('a single thread never blocks and never restarts, under any protocol', () => {
    for (const protocol of ['naive', 'crabbing', 'optimistic'] as const) {
      const plan = planLatchCrabbing(INITIAL, [[35, 36, 37]], 4, protocol);
      expect(plan.totalBlockedTicks).toBe(0);
      expect(plan.totalRestarts).toBe(0);
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
    for (const protocol of ['naive', 'crabbing', 'optimistic'] as const) {
      const plan = planLatchCrabbing(INITIAL, scripts, 4, protocol);
      // A restart gives back whatever the insert held without a release of its own, so it empties the set.
      const held = new Map<number, Set<string | undefined>>();
      for (const a of plan.timeline) {
        const mine = held.get(a.thread) ?? new Set<string | undefined>();
        held.set(a.thread, mine);
        if (a.kind === 'acquire') {
          expect(mine.has(a.nodeId), `${protocol}: T${String(a.thread)} latched ${String(a.nodeId)} twice`).toBe(false);
          mine.add(a.nodeId);
        }
        if (a.kind === 'release') {
          expect(mine.delete(a.nodeId), `${protocol}: released a latch it did not hold`).toBe(true);
        }
        if (a.kind === 'restart') mine.clear();
      }
      for (const mine of held.values()) expect(mine.size).toBe(0);
    }
  });

  it('clamps an out-of-range fanout rather than producing a broken tree', () => {
    const plan = planLatchCrabbing(INITIAL, [[35]], 999, 'crabbing');
    expect(plan.maxKeys).toBe(LATCH_LIMITS.maxFanout);
    expect(plan.treeProblems).toEqual([]);
  });
});

describe('planLatchCrabbing — optimistic lock coupling', () => {
  // Twenty keys at fan-out 6 fill the tree's leaves unevenly; 205 and 206 are both past the last key, so they land
  // in the same rightmost leaf, and 15 and 105 land in two different ones with room.
  const same = [[205], [206]];
  const apart = [[15], [105]];

  it('latches nothing on the way down: its only latches are the pages it changes, and only one of them for an insert with room', () => {
    const plan = planLatchCrabbing(INITIAL, apart, 6, 'optimistic');
    const reads = plan.timeline.filter((a) => a.kind === 'read');
    const acquires = plan.timeline.filter((a) => a.kind === 'acquire');
    // The tree is two levels deep at this fan-out: each thread reads the root and a leaf, and latches the leaf alone.
    expect(reads.length).toBe(2 * 2);
    expect(acquires.length).toBe(2);
    expect(plan.threads.map((t) => t.peakLatches)).toEqual([1, 1]);
    expect(plan.maxConcurrentLatches).toBe(2);
  });

  it('inserts into different leaves, with room, neither wait nor restart', () => {
    const plan = planLatchCrabbing(INITIAL, apart, 6, 'optimistic');
    expect(plan.totalBlockedTicks).toBe(0);
    expect(plan.totalRestarts).toBe(0);
    expect(plan.treeProblems).toEqual([]);
    expect(plan.finalKeyCount).toBe(INITIAL.length + 2);
  });

  it('two inserts into one leaf: the second finds the page it read has changed and restarts, once', () => {
    const plan = planLatchCrabbing(INITIAL, same, 6, 'optimistic');
    expect(plan.threads.map((t) => t.restarts)).toEqual([0, 1]);
    expect(plan.totalRestarts).toBe(1);
    const restart = plan.timeline.find((a) => a.kind === 'restart')!;
    expect(restart.thread).toBe(1);
    // It had read the leaf before the first insert's write, and latching it would have been to overwrite that.
    const write = plan.timeline.find((a) => a.kind === 'write' && a.thread === 0)!;
    expect(restart.tick).toBeLessThanOrEqual(write.tick + 1);
    // Both keys are there in the end.
    expect(plan.finalKeyCount).toBe(INITIAL.length + 2);
    expect(plan.treeProblems).toEqual([]);
  });

  it('a restart begins again at the root, and what it reads then is the page the first insert left', () => {
    const plan = planLatchCrabbing(INITIAL, same, 6, 'optimistic');
    const t2 = plan.timeline.filter((a) => a.thread === 1);
    const at = t2.findIndex((a) => a.kind === 'restart');
    const before = t2.slice(0, at).filter((a) => a.kind === 'read').map((a) => a.nodeId);
    const after = t2.slice(at + 1).filter((a) => a.kind === 'read').map((a) => a.nodeId);
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });

  it('a page another thread has latched is not waited for at the latch: the insert restarts, and its read waits', () => {
    const plan = planLatchCrabbing(INITIAL, same, 6, 'optimistic');
    expect(plan.timeline.some((a) => a.kind === 'restart')).toBe(true);
    // Whatever the second thread waited for, it waited at a read, never at an acquire.
    const t2 = plan.timeline.filter((a) => a.thread === 1);
    for (let i = 0; i < t2.length - 1; i++) {
      if (t2[i]!.kind === 'blocked') expect(['read', 'blocked']).toContain(t2[i + 1]!.kind);
    }
  });

  it('says why each restart happened: a held page, a page changed since it was read, a parent that moved under the descent', () => {
    const reasons = (threads: number, ops: number, seed: number, fanout: number) => {
      const plan = planLatchCrabbing(DEMO_INITIAL_KEYS, demoScripts(threads, ops, seed), fanout, 'optimistic');
      const count: Record<string, number> = {};
      for (const a of plan.timeline) if (a.kind === 'restart') count[a.reason!] = (count[a.reason!] ?? 0) + 1;
      expect(Object.values(count).reduce((a, b) => a + b, 0)).toBe(plan.totalRestarts);
      return count;
    };
    // Most restarts find the page held. A page that changed in the gap between the read and the latch is rarer, and
    // a parent that changed while its child was waited for is rarer still: seed 7 is one that has it.
    expect(reasons(4, 6, 1, 4)).toEqual({ 'page-held': 7, 'page-changed': 1 });
    expect(reasons(3, 4, 7, 4)).toEqual({ 'page-held': 3, 'parent-changed': 1 });
    for (const a of planLatchCrabbing(DEMO_INITIAL_KEYS, demoScripts(3, 4, 7), 4, 'optimistic').timeline) {
      expect(a.reason !== undefined).toBe(a.kind === 'restart');
    }
  });

  it('naive and crabbing never restart, and never read', () => {
    for (const protocol of ['naive', 'crabbing'] as const) {
      const plan = planLatchCrabbing(INITIAL, [[205], [206], [207], [208]], 4, protocol);
      expect(plan.totalRestarts).toBe(0);
      expect(plan.timeline.some((a) => a.kind === 'read' || a.kind === 'restart')).toBe(false);
    }
  });

  it('on a crowded workload it spends far fewer ticks blocked than crabbing, and pays in restarts', () => {
    // Four threads, six inserts each, fan-out 4, seed 1 — the workload the lesson uses.
    const scripts = demoScripts(4, 6, 1);
    const crab = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, 4, 'crabbing');
    const opt = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, 4, 'optimistic');
    expect([crab.ticks, crab.totalBlockedTicks, crab.totalRestarts]).toEqual([82, 148, 0]);
    expect([opt.ticks, opt.totalBlockedTicks, opt.totalRestarts]).toEqual([78, 18, 8]);
  });

  it('and with two threads on wide pages it loses to crabbing, because a restart costs a whole descent', () => {
    const scripts = demoScripts(2, 2, 1);
    const crab = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, 5, 'crabbing');
    const opt = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, 5, 'optimistic');
    expect([crab.ticks, opt.ticks]).toEqual([15, 19]);
    expect(opt.totalRestarts).toBe(1);
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
          const opt = planLatchCrabbing(initial, scripts, fanout, 'optimistic');
          for (const plan of [naive, crab, opt]) {
            expect(plan.ticks).toBeLessThan(100_000);
            expect(plan.treeProblems).toEqual([]);
            expect(plan.finalKeyCount).toBe(initial.length + threads * opsPerThread);
          }
          for (let t = 0; t < threads; t++) {
            expect(crab.threads[t]!.peakLatches).toBeLessThanOrEqual(naive.threads[t]!.peakLatches);
            // What an optimistic insert latches is what crabbing is left holding, so never more.
            expect(opt.threads[t]!.peakLatches).toBeLessThanOrEqual(crab.threads[t]!.peakLatches);
          }
          expect(naive.totalRestarts + crab.totalRestarts).toBe(0);
        },
      ),
    );
  });
});
