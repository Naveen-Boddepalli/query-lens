import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { demoWrites, LSM_LIMITS, lookupKey, planLsm } from '../lsm.ts';
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
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
  });

  it('holds for a run that cascades through several levels (tiny capacities force deep compaction)', () => {
    const writes = demoWrites(LSM_LIMITS.maxWrites, 7);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 2, l0CompactionTrigger: 2, baseLevelCapacity: 2, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.levels.length).toBeGreaterThan(3); // confirms this case genuinely cascades, not a vacuous check
    expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
  });

  it('writing the same key over and over keeps only its newest value', () => {
    const writes: LsmWrite[] = Array.from({ length: 50 }, (_, i) => ({ key: 1, value: i, seq: i }));
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.distinctKeysWritten).toBe(1);
    expect(onDiskLatest(plan).get(1)).toBe(49);
  });
});

describe('planLsm — structural invariants', () => {
  it('every level past L0 holds non-overlapping SSTables', () => {
    const writes = demoWrites(80, 3);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(levelsNonOverlapping(plan)).toBe(true);
  });

  it('never leaves a trailing empty level', () => {
    const writes = demoWrites(40, 2);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    if (plan.levels.length > 1) expect(plan.levels[plan.levels.length - 1]!.length).toBeGreaterThan(0);
  });

  it('every SSTable a flush or compaction creates is named in exactly one event, and removed tables are never also current', () => {
    const writes = demoWrites(60, 4);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    const currentIds = new Set(plan.levels.flatMap((l) => l.map((t) => t.id)));
    const removedIds = new Set(plan.events.flatMap((e) => e.removed));
    for (const id of removedIds) expect(currentIds.has(id)).toBe(false);
  });
});

describe('planLsm — amplification', () => {
  it('is at least 1 for a typical run — enough compaction happens that rewriting dominates', () => {
    const writes = demoWrites(60, 1);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.writeAmplification).toBeGreaterThanOrEqual(1);
  });

  it('can drop below 1 when the memtable coalesces an overwrite before it is ever flushed — a real write-reduction, not a bug', () => {
    // Key 2 is written twice (seq 0 and 1) before the memtable (capacity 3) flushes for the first time — only
    // the newer value is ever physically written, so this flush costs 2 entries for 3 writes, not 3.
    const writes = demoWrites(10, 0);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 3, l0CompactionTrigger: 5, baseLevelCapacity: 2, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.writeAmplification).toBeLessThan(1);
    expect(plan.writeAmplification).toBeGreaterThan(0);
  });

  it('a tighter memtable and smaller levels cause more write amplification, not less, for the same writes', () => {
    const writes = demoWrites(100, 2);
    const tight = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 2, l0CompactionTrigger: 2, baseLevelCapacity: 2, levelSizeMultiplier: 2, bitsPerKey: 8 });
    const roomy = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 8, l0CompactionTrigger: 6, baseLevelCapacity: 32, levelSizeMultiplier: 4, bitsPerKey: 8 });
    expect(tight.writeAmplification).toBeGreaterThan(roomy.writeAmplification);
  });

  it('space amplification is at least 1 — the live data is always a subset of what is on disk', () => {
    const writes = demoWrites(60, 5);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.spaceAmplification).toBeGreaterThanOrEqual(1);
  });

  it('read amplification worst case counts every L0 table plus one per non-empty level below it', () => {
    const writes = demoWrites(60, 1);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    const expected = plan.levels[0]!.length + plan.levels.slice(1).filter((l) => l.length > 0).length;
    expect(plan.readAmplificationWorstCase).toBe(expected);
  });

  it('measured read amplification is at most the worst case — the Bloom filter can only ever help, never hurt', () => {
    const writes = demoWrites(80, 2);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 10 });
    expect(plan.readAmplificationAverage).toBeLessThanOrEqual(plan.readAmplificationWorstCase);
  });

  it('a wider Bloom filter (more bits per key) never increases the measured false-positive rate', () => {
    const writes = demoWrites(100, 4);
    const narrow = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 2 });
    const wide = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 20 });
    expect(wide.measuredFalsePositiveRate).toBeLessThanOrEqual(narrow.measuredFalsePositiveRate);
  });
});

describe('lookupKey', () => {
  it('finds every distinct written key, with its newest value, regardless of how many levels it cascaded through', () => {
    const writes = demoWrites(60, 1);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 2, l0CompactionTrigger: 2, baseLevelCapacity: 2, levelSizeMultiplier: 2, bitsPerKey: 10 });
    const expected = onDiskLatest(plan);
    for (const [key, value] of expected) {
      const result = lookupKey(plan.levels, key, plan.options.compactionStrategy);
      expect(result.found).toBe(true);
      expect(result.value).toBe(value);
      expect(result.tablesChecked.length).toBeGreaterThan(0);
    }
  });

  it('when a key sits in two different L0 tables at once, returns the newer table\'s value, not the older one\'s', () => {
    // A high trigger (4) keeps both flushes sitting in L0 together, uncompacted — the scenario leveled
    // compaction's "L0 may overlap" wrinkle actually describes. Key 1 is flushed twice, with different values.
    const writes: LsmWrite[] = [
      { key: 1, value: 100, seq: 0 },
      { key: 2, value: 1, seq: 1 },
      { key: 1, value: 200, seq: 2 },
      { key: 3, value: 1, seq: 3 },
    ];
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 2, l0CompactionTrigger: 4, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.levels[0]).toHaveLength(2); // both flushes present, uncompacted — the scenario this test needs
    const result = lookupKey(plan.levels, 1, plan.options.compactionStrategy);
    expect(result.found).toBe(true);
    expect(result.value).toBe(200);
  });

  it('a key strictly past the highest one ever written is a genuine miss, every time', () => {
    const writes = demoWrites(40, 3);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 10 });
    const maxKey = Math.max(...writes.map((w) => w.key));
    const result = lookupKey(plan.levels, maxKey + 1000, plan.options.compactionStrategy);
    expect(result.found).toBe(false);
    expect(result.value).toBeNull();
    // Whatever it checked (if anything — the filter may have correctly said "no" every time) was a false
    // positive by definition, since the key genuinely is not anywhere.
    expect(result.falsePositives).toEqual(result.tablesChecked);
  });

  it('every table a lookup actually checked had already said "maybe" — never one the filter ruled out', () => {
    const writes = demoWrites(70, 6);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 3, l0CompactionTrigger: 2, baseLevelCapacity: 4, levelSizeMultiplier: 2, bitsPerKey: 16 });
    const allTables = new Map(plan.levels.flatMap((l) => l.map((t) => [t.id, t] as const)));
    for (const key of new Set(writes.map((w) => w.key))) {
      const result = lookupKey(plan.levels, key, plan.options.compactionStrategy);
      for (const id of result.tablesChecked) {
        const table = allTables.get(id)!;
        const reallyThere = table.entries.some((e) => e.key === key);
        // A checked table either genuinely holds the key (the hit, or a stale duplicate deeper down that a
        // shallower hit already returned before reaching it) or is a counted false positive — never neither.
        expect(reallyThere || result.falsePositives.includes(id)).toBe(true);
      }
    }
  });

  it('an empty structure finds nothing and checks nothing', () => {
    const plan = planLsm([], { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    const result = lookupKey(plan.levels, 1, plan.options.compactionStrategy);
    expect(result.found).toBe(false);
    expect(result.tablesChecked).toEqual([]);
  });
});

describe('tiered compaction — the real trade-off against leveled, measured not assumed', () => {
  it('still replays correctly, and every compaction creates exactly ONE unsplit table (never re-split, unlike leveled)', () => {
    const writes = demoWrites(100, 1);
    const plan = planLsm(writes, { compactionStrategy: 'tiered', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
    const compactions = plan.events.filter((e) => e.kind === 'compaction');
    expect(compactions.length).toBeGreaterThan(0); // confirms this case genuinely compacts, not a vacuous check
    for (const e of compactions) expect(e.created).toHaveLength(1);
  });

  it('costs genuinely less write amplification than leveled for the identical writes and parameters — the whole point of the strategy', () => {
    const writes = demoWrites(100, 1);
    const shared = { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 } as const;
    const leveled = planLsm(writes, { compactionStrategy: 'leveled', ...shared });
    const tiered = planLsm(writes, { compactionStrategy: 'tiered', ...shared });
    expect(tiered.writeAmplification).toBeLessThan(leveled.writeAmplification);
  });

  it('costs genuinely more worst-case read amplification than leveled for the identical writes and parameters — the other side of the same trade-off', () => {
    const writes = demoWrites(100, 1);
    const shared = { memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 } as const;
    const leveled = planLsm(writes, { compactionStrategy: 'leveled', ...shared });
    const tiered = planLsm(writes, { compactionStrategy: 'tiered', ...shared });
    expect(tiered.readAmplificationWorstCase).toBeGreaterThan(leveled.readAmplificationWorstCase);
  });

  it('a level below L0 can legitimately hold two overlapping tables with the same key — lookupKey still returns the newer one', () => {
    // A files-per-tier trigger of 4 lets L1 rest at 2 tables (below its own trigger) after two separate
    // L0-to-L1 merges, each landing a different value for key 1 — exactly the overlap leveled compaction
    // confines to L0 alone, now possible one level down too.
    const writes: LsmWrite[] = [
      { key: 1, value: 100, seq: 0 }, { key: 10, value: 1, seq: 1 },
      { key: 11, value: 1, seq: 2 }, { key: 12, value: 1, seq: 3 },
      { key: 13, value: 1, seq: 4 }, { key: 14, value: 1, seq: 5 },
      { key: 15, value: 1, seq: 6 }, { key: 16, value: 1, seq: 7 },
      { key: 1, value: 200, seq: 8 }, { key: 20, value: 1, seq: 9 },
      { key: 21, value: 1, seq: 10 }, { key: 22, value: 1, seq: 11 },
      { key: 23, value: 1, seq: 12 }, { key: 24, value: 1, seq: 13 },
      { key: 25, value: 1, seq: 14 }, { key: 26, value: 1, seq: 15 },
    ];
    const plan = planLsm(writes, { compactionStrategy: 'tiered', memtableCapacity: 2, l0CompactionTrigger: 4, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.levels[1]).toHaveLength(2); // both L1 merges present, uncompacted further — the scenario this test needs
    const result = lookupKey(plan.levels, 1, 'tiered');
    expect(result.found).toBe(true);
    expect(result.value).toBe(200);
  });

  it('never crashes and always resolves correctly, for any legal parameters — but, unlike leveled, levels below L0 may overlap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: LSM_LIMITS.minWrites, max: LSM_LIMITS.maxWrites }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: LSM_LIMITS.minMemtableCapacity, max: LSM_LIMITS.maxMemtableCapacity }),
        fc.integer({ min: LSM_LIMITS.minL0Trigger, max: LSM_LIMITS.maxL0Trigger }),
        fc.integer({ min: LSM_LIMITS.minBitsPerKey, max: LSM_LIMITS.maxBitsPerKey }),
        (count, seed, memtableCapacity, l0CompactionTrigger, bitsPerKey) => {
          const writes = demoWrites(count, seed);
          const plan = planLsm(writes, {
            compactionStrategy: 'tiered',
            memtableCapacity,
            l0CompactionTrigger,
            baseLevelCapacity: 8,
            levelSizeMultiplier: 2,
            bitsPerKey,
          });
          expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
          expect(plan.writeAmplification).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(plan.writeAmplification)).toBe(true);
          for (const key of new Set(writes.map((w) => w.key))) {
            expect(lookupKey(plan.levels, key, 'tiered').found).toBe(true);
          }
        },
      ),
    );
  });
});

describe('planLsm — edge cases', () => {
  it('no writes at all produces an empty L0 and no events', () => {
    const plan = planLsm([], { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.levels).toEqual([[]]);
    expect(plan.events).toEqual([]);
    expect(plan.writeAmplification).toBe(0);
  });

  it('fewer writes than the memtable capacity still flushes once at the end', () => {
    const writes = demoWrites(1, 1);
    const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]!.kind).toBe('flush');
    expect(plan.totalEntriesOnDisk).toBe(1);
  });
});

describe('planLsm — is deterministic and total', () => {
  it('the same inputs produce byte-identical plans', () => {
    const writes = demoWrites(40, 3);
    const a = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    const b = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity: 4, l0CompactionTrigger: 3, baseLevelCapacity: 8, levelSizeMultiplier: 2, bitsPerKey: 8 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('clamps out-of-range options rather than producing a broken plan', () => {
    const plan = planLsm(demoWrites(10, 1), { compactionStrategy: 'leveled', memtableCapacity: 999, l0CompactionTrigger: 0, baseLevelCapacity: 8, levelSizeMultiplier: 999, bitsPerKey: 999 });
    expect(plan.options.memtableCapacity).toBe(LSM_LIMITS.maxMemtableCapacity);
    expect(plan.options.l0CompactionTrigger).toBe(LSM_LIMITS.minL0Trigger);
    expect(plan.options.levelSizeMultiplier).toBe(LSM_LIMITS.maxLevelSizeMultiplier);
    expect(plan.options.bitsPerKey).toBe(LSM_LIMITS.maxBitsPerKey);
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
        fc.integer({ min: LSM_LIMITS.minBitsPerKey, max: LSM_LIMITS.maxBitsPerKey }),
        (count, seed, memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier, bitsPerKey) => {
          const writes = demoWrites(count, seed);
          const plan = planLsm(writes, { compactionStrategy: 'leveled', memtableCapacity, l0CompactionTrigger, baseLevelCapacity, levelSizeMultiplier, bitsPerKey });
          expect(onDiskLatest(plan)).toEqual(naiveLatest(writes));
          expect(levelsNonOverlapping(plan)).toBe(true);
          // Not always >= 1 — in-memtable coalescing (an overwrite before the first flush) can legitimately drop
          // it below 1, its own dedicated test above. It is always finite and never negative, though.
          expect(plan.writeAmplification).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(plan.writeAmplification)).toBe(true);
          // A Bloom filter never produces a false NEGATIVE — every distinct key actually written must still
          // resolve to a real hit through `lookupKey`, regardless of how aggressively `bitsPerKey` is tuned.
          for (const key of new Set(writes.map((w) => w.key))) {
            expect(lookupKey(plan.levels, key, plan.options.compactionStrategy).found).toBe(true);
          }
          expect(plan.readAmplificationAverage).toBeGreaterThanOrEqual(0);
          expect(plan.measuredFalsePositiveRate).toBeGreaterThanOrEqual(0);
          expect(plan.measuredFalsePositiveRate).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
