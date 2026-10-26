import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { demoWrites, LSM_LIMITS } from '../lsm.ts';
import type { LsmWrite } from '../lsm.ts';
import { planBTreeWrites } from '../btreeWriteCost.ts';

describe('planBTreeWrites', () => {
  it('a non-splitting insert touches exactly one node — the leaf it was added to', () => {
    const writes: LsmWrite[] = [{ key: 1, value: 1, seq: 0 }, { key: 2, value: 1, seq: 1 }];
    const plan = planBTreeWrites(writes, 4); // maxKeys 4, 2 keys — never overflows
    expect(plan.totalNodeWrites).toBe(2);
    expect(plan.writeAmplification).toBe(1);
    expect(plan.finalHeight).toBe(1);
  });

  it('a splitting insert touches exactly three nodes — the rewritten leaf, the new sibling, and the new root', () => {
    // maxKeys 2: a third key overflows the root leaf, which splits into two leaves under a brand-new root.
    const writes: LsmWrite[] = [1, 2, 3].map((key, seq) => ({ key, value: 1, seq }));
    const plan = planBTreeWrites(writes, 2);
    expect(plan.totalNodeWrites).toBe(1 + 1 + 3); // first two inserts (1 each) + the splitting third (3)
    expect(plan.finalHeight).toBe(2);
  });

  it('writing the same key again touches only the one leaf that already holds it — no restructuring', () => {
    const writes: LsmWrite[] = [{ key: 5, value: 1, seq: 0 }, { key: 5, value: 2, seq: 1 }];
    const plan = planBTreeWrites(writes, 4);
    expect(plan.totalNodeWrites).toBe(2); // 1 for the first insert, 1 for the update
    expect(plan.finalNodeCount).toBe(1); // still just the one leaf — no new node was ever needed
  });

  it("read cost is the tree's own height, the same number a real root-to-leaf descent always pays", () => {
    const writes = demoWrites(60, 1);
    const plan = planBTreeWrites(writes, 4);
    expect(plan.readCost).toBe(plan.finalHeight);
  });

  it('an empty write sequence costs nothing and touches nothing, but a tree always starts with one empty root leaf', () => {
    const plan = planBTreeWrites([], 4);
    expect(plan.writes).toBe(0);
    expect(plan.totalNodeWrites).toBe(0);
    expect(plan.writeAmplification).toBe(0);
    expect(plan.finalHeight).toBe(1);
    expect(plan.finalNodeCount).toBe(1);
  });

  it('never crashes, and write amplification never drops below 1 — unlike an LSM tree, there is no memtable stage to coalesce a repeat write into before anything is written', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: LSM_LIMITS.minWrites, max: LSM_LIMITS.maxWrites }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: 2, max: 8 }),
        (count, seed, maxKeys) => {
          const writes = demoWrites(count, seed);
          const plan = planBTreeWrites(writes, maxKeys);
          expect(plan.writeAmplification).toBeGreaterThanOrEqual(1);
          expect(Number.isFinite(plan.writeAmplification)).toBe(true);
          expect(plan.readCost).toBe(plan.finalHeight);
          expect(plan.finalHeight).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });
});
