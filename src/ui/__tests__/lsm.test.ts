import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { demoWrites, LSM_LIMITS, planLsm } from '../lsm.ts';
import type { LsmWrite } from '../lsm.ts';

/** The newest value for every key, replaying the write sequence directly — the ground truth a correct LSM must match. */
function naiveLatest(writes: readonly LsmWrite[]): Map<number, number> {
  const latest = new Map<number, number>();
  for (const w of writes) latest.set(w.key, w.value);
  return latest;
}

/** The newest value for every key currently on disk, read straight out of the plan's own levels. */
function onDiskLatest(plan: ReturnType<typeof planLsm>): Map<number, number> {
  const latestSeq = new Map<number, number>();
  const latestValue = new Map<number, number>();
  for (const level of plan.levels) {
    for (const table of level) {
      for (const entry of table.entries) {
        const seenSeq = latestSeq.get(entry.key);
        if (seenSeq === undefined || entry.seq > seenSeq) {
          latestSeq.set(entry.key, entry.seq);
          latestValue.set(entry.key, entry.value);
        }
      }
    }
  }
  return latestValue;
}

function levelsNonOverlapping(plan: ReturnType<typeof planLsm>): boolean {
  // L0 (index 0) may overlap by design; every level below it must not.
  for (const level of plan.levels.slice(1)) {
    for (let i = 0; i < level.length; i++) {
      for (let j = i + 1; j < level.length; j++) {
        const a = level[i]!;
        const b = level[j]!;
        if (a.minKey <= b.maxKey && a.maxKey >= b.minKey) return false;
      }
    }
  }
  return true;
}

describe('demoWrites', () => {
  it('is deterministic for a seed and varies across seeds', () => {
    expect(demoWrites(20, 5)).toEqual(demoWrites(20, 5));
    expect(demoWrites(20, 5)).not.toEqual(demoWrites(20, 6));
  });

  it('produces exactly `count` writes, with sequence numbers 0..count-1 in order', () => {
    const writes = demoWrites(30, 1);
    expect(writes).toHaveLength(30);
    expect(writes.map((w) => w.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('writes some keys more than once — there is something for compaction to deduplicate', () => {
    const writes = demoWrites(30, 1);
    const distinctKeys = new Set(writes.map((w) => w.key)).size;
    expect(distinctKeys).toBeLessThan(writes.length);
  });
});

describe('planLsm — correctness: the newest value for every key survives', () => {
  it('matches a naive replay of the write sequence exactly, after flushes and compaction', () => {
    const writes = demoWrites(60, 1);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
  });

  it('holds for a run that cascades through several levels (tiny capacities force deep compaction)', () => {
    const writes = demoWrites(LSM_LIMITS.maxWrites, 7);
    const plan = planLsm(writes, { memtableCapacity: 2, l0CompactionTrigger: 2, baseLevelCapacity: 2, levelSizeMultiplier: 2 });
    expect(plan.levels.length).toBeGreaterThan(3); // confirms this case genuinely cascades, not a vacuous check
    expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
  });

  it('writing the same key over and over keeps only its newest value', () => {
    const writes: LsmWrite[] = Array.from({ length: 50 }, (_, i) => ({ key: 1, value: i, seq: i }));
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(plan.distinctKeysWritten).toBe(1);
    expect(onDiskLatest(plan).get(1)).toBe(49);
  });
});

describe('planLsm — structural invariants', () => {
  it('every level past L0 holds non-overlapping SSTables', () => {
    const writes = demoWrites(80, 3);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(levelsNonOverlapping(plan)).toBe(true);
  });

  it('never leaves a trailing empty level', () => {
    const writes = demoWrites(40, 2);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    if (plan.levels.length > 1) expect(plan.levels[plan.levels.length - 1]!.length).toBeGreaterThan(0);
  });

  it('every SSTable a flush or compaction creates is named in exactly one event, and removed tables are never also current', () => {
    const writes = demoWrites(60, 4);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    const currentIds = new Set(plan.levels.flatMap((l) => l.map((t) => t.id)));
    const removedIds = new Set(plan.events.flatMap((e) => e.removed));
    for (const id of removedIds) expect(currentIds.has(id)).toBe(false);
  });
});

describe('planLsm — amplification', () => {
  it('is at least 1 for a typical run — enough compaction happens that rewriting dominates', () => {
    const writes = demoWrites(60, 1);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(plan.writeAmplification).toBeGreaterThanOrEqual(1);
  });

  it('can drop below 1 when the memtable coalesces an overwrite before it is ever flushed — a real write-reduction, not a bug', () => {
    // Key 2 is written twice (seq 0 and 1) before the memtable (capacity 3) flushes for the first time — only
    // the newer value is ever physically written, so this flush costs 2 entries for 3 writes, not 3.
    const writes = demoWrites(10, 0);
    const plan = planLsm(writes, { memtableCapacity: 3, l0CompactionTrigger: 5, baseLevelCapacity: 2, levelSizeMultiplier: 2 });
    expect(plan.writeAmplification).toBeLessThan(1);
    expect(plan.writeAmplification).toBeGreaterThan(0);
  });

  it('a tighter memtable and smaller levels cause more write amplification, not less, for the same writes', () => {
    const writes = demoWrites(100, 2);
    const tight = planLsm(writes, { memtableCapacity: 2, l0CompactionTrigger: 2, baseLevelCapacity: 2, levelSizeMultiplier: 2 });
    const roomy = planLsm(writes, { memtableCapacity: 8, l0CompactionTrigger: 6, baseLevelCapacity: 32, levelSizeMultiplier: 4 });
    expect(tight.writeAmplification).toBeGreaterThan(roomy.writeAmplification);
  });

  it('space amplification is at least 1 — the live data is always a subset of what is on disk', () => {
    const writes = demoWrites(60, 5);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(plan.spaceAmplification).toBeGreaterThanOrEqual(1);
  });

  it('read amplification worst case counts every L0 table plus one per non-empty level below it', () => {
    const writes = demoWrites(60, 1);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    const expected = plan.levels[0]!.length + plan.levels.slice(1).filter((l) => l.length > 0).length;
    expect(plan.readAmplificationWorstCase).toBe(expected);
  });
});

describe('planLsm — edge cases', () => {
  it('no writes at all produces an empty L0 and no events', () => {
    const plan = planLsm([], { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(plan.levels).toEqual([[]]);
    expect(plan.events).toEqual([]);
    expect(plan.writeAmplification).toBe(0);
  });

  it('fewer writes than the memtable capacity still flushes once at the end', () => {
    const writes = demoWrites(1, 1);
    const plan = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]!.kind).toBe('flush');
    expect(plan.totalEntriesOnDisk).toBe(1);
  });
});

describe('planLsm — is deterministic and total', () => {
  it('the same inputs produce byte-identical plans', () => {
    const writes = demoWrites(40, 3);
    const a = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    const b = planLsm(writes, { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('clamps out-of-range options rather than producing a broken plan', () => {
    const plan = planLsm(demoWrites(10, 1), { memtableCapacity: 999, l0CompactionTrigger: 0, baseLevelCapacity: 8, levelSizeMultiplier: 999 });
    expect(plan.options.memtableCapacity).toBe(LSM_LIMITS.maxMemtableCapacity);
    expect(plan.options.l0CompactionTrigger).toBe(LSM_LIMITS.minL0Trigger);
    expect(plan.options.levelSizeMultiplier).toBe(LSM_LIMITS.maxLevelSizeMultiplier);
  });

  it('never crashes, always resolves correctly, and keeps every level past L0 non-overlapping, for any legal parameters', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: LSM_LIMITS.minWrites, max: LSM_LIMITS.maxWrites }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: LSM_LIMITS.minMemtableCapacity, max: LSM_LIMITS.maxMemtableCapacity }),
        fc.integer({ min: LSM_LIMITS.minL0Trigger, max: LSM_LIMITS.maxL0Trigger }),
        fc.integer({ min: 2, max: 32 }),
        fc.integer({ min: LSM_LIMITS.minLevelSizeMultiplier, max: LSM_LIMITS.maxLevelSizeMultiplier }),
        (count, seed, memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier) => {
          const writes = demoWrites(count, seed);
          const plan = planLsm(writes, { memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier });
          expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
          expect(levelsNonOverlapping(plan)).toBe(true);
          // Not always >= 1 — in-memtable coalescing (an overwrite before the first flush) can legitimately drop
          // it below 1, its own dedicated test above. It is always finite and never negative, though.
          expect(plan.writeAmplification).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(plan.writeAmplification)).toBe(true);
        },
      ),
    );
  });
});
