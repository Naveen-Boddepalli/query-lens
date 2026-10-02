import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { demoWrites, HASH_LIMITS, lookupHashKey, planHashIndex } from '../hashIndex.ts';
import type { Bucket, HashEntry, HashPlan } from '../hashIndex.ts';

/** The newest value for every key, replaying the write sequence directly — the ground truth a correct hash index must match. */
function naiveLatest(writes: readonly HashEntry[]): Map<number, number> {
  const latest = new Map<number, number>();
  for (const w of writes) latest.set(w.key, w.value);
  return latest;
}

/** Every entry currently reachable, read straight out of the plan's own buckets — includes any orphaned,
 *  unreachable bucket left behind by a bug, which is exactly what this check is for. */
function onDiskEntries(plan: HashPlan): HashEntry[] {
  return Object.values(plan.buckets).flatMap((b) => b.entries);
}

const SHARED = { bucketCapacity: 4, initialBuckets: 2 } as const;

describe('demoWrites', () => {
  it('is deterministic for a seed and varies across seeds', () => {
    expect(demoWrites(20, 5)).toEqual(demoWrites(20, 5));
    expect(demoWrites(20, 5)).not.toEqual(demoWrites(20, 6));
  });

  it('produces exactly `count` writes, with real repeats', () => {
    const writes = demoWrites(30, 1);
    expect(writes).toHaveLength(30);
    const distinctKeys = new Set(writes.map((w) => w.key)).size;
    expect(distinctKeys).toBeLessThan(writes.length);
  });
});

describe('planHashIndex — correctness: the newest value for every key survives, for both strategies', () => {
  it.each(['extendible', 'linear'] as const)('%s matches a naive replay of the write sequence exactly', (strategy) => {
    const writes = demoWrites(100, 1);
    const plan = planHashIndex(writes, { strategy, ...SHARED });
    const onDisk = onDiskEntries(plan);
    expect(onDisk).toHaveLength(plan.distinctKeysWritten);
    const expected = naiveLatest(writes);
    for (const e of onDisk) expect(e.value).toBe(expected.get(e.key));
  });

  it.each(['extendible', 'linear'] as const)('%s never leaves a stale, unreachable duplicate of any key', (strategy) => {
    // The real regression this guards: a split that rebuilds a chain must remove whatever it replaces, or the
    // old entries linger in the plan's own bucket record even though nothing can reach them any more.
    const writes = demoWrites(150, 3);
    const plan = planHashIndex(writes, { strategy, ...SHARED });
    const keyCounts = new Map<number, number>();
    for (const e of onDiskEntries(plan)) keyCounts.set(e.key, (keyCounts.get(e.key) ?? 0) + 1);
    for (const [key, count] of keyCounts) expect(count, `key ${String(key)} appeared ${String(count)} times`).toBe(1);
  });

  it.each(['extendible', 'linear'] as const)('%s: writing the same key over and over keeps only its newest value, in exactly one bucket', (strategy) => {
    const writes: HashEntry[] = Array.from({ length: 50 }, (_, i) => ({ key: 7, value: i }));
    const plan = planHashIndex(writes, { strategy, ...SHARED });
    expect(plan.distinctKeysWritten).toBe(1);
    expect(plan.totalEntries).toBe(1);
    const result = lookupHashKey(plan, 7);
    expect(result.found).toBe(true);
    expect(result.value).toBe(49);
  });
});

describe('planHashIndex — extendible structural invariants', () => {
  it("the directory has exactly 2^globalDepth slots, and every bucket's local depth never exceeds it", () => {
    const writes = demoWrites(150, 2);
    const plan = planHashIndex(writes, { strategy: 'extendible', ...SHARED });
    expect(plan.directory).toHaveLength(2 ** plan.globalDepth);
    for (const bucket of Object.values(plan.buckets)) expect(bucket.localDepth).toBeLessThanOrEqual(plan.globalDepth);
  });

  it("every directory slot pointing at a bucket agrees with that bucket's own local-depth bits", () => {
    // THE core extendible-hashing invariant: a bucket's localDepth low bits are shared by every directory index
    // that names it — if this breaks, the directory and the buckets have silently gone out of sync.
    const writes = demoWrites(150, 2);
    const plan = planHashIndex(writes, { strategy: 'extendible', ...SHARED });
    for (let i = 0; i < plan.directory.length; i++) {
      const bucket = plan.buckets[plan.directory[i]!]!;
      const mask = (1 << bucket.localDepth) - 1;
      // Every OTHER slot pointing at the same bucket must share this slot's own low `localDepth` bits.
      for (let j = 0; j < plan.directory.length; j++) {
        if (plan.directory[j] === plan.directory[i] && (j & mask) !== (i & mask)) {
          throw new Error(`slots ${String(i)} and ${String(j)} point at the same bucket but disagree below local depth ${String(bucket.localDepth)}`);
        }
      }
    }
  });

  it('no bucket ever exceeds its own capacity', () => {
    const writes = demoWrites(150, 2);
    const plan = planHashIndex(writes, { strategy: 'extendible', ...SHARED });
    for (const bucket of Object.values(plan.buckets)) expect(bucket.entries.length).toBeLessThanOrEqual(SHARED.bucketCapacity);
  });
});

describe('planHashIndex — linear structural invariants', () => {
  it('the split pointer always stays inside the current round — never equal to or past the address space it is sweeping', () => {
    const writes = demoWrites(150, 4);
    const plan = planHashIndex(writes, { strategy: 'linear', ...SHARED });
    const addressSpace = SHARED.initialBuckets * 2 ** plan.level;
    expect(plan.splitPointer).toBeGreaterThanOrEqual(0);
    expect(plan.splitPointer).toBeLessThan(addressSpace);
  });

  it('the primary bucket count always equals the current address space plus how far the split pointer has swept it', () => {
    const writes = demoWrites(150, 4);
    const plan = planHashIndex(writes, { strategy: 'linear', ...SHARED });
    const addressSpace = SHARED.initialBuckets * 2 ** plan.level;
    expect(plan.primaryBuckets).toHaveLength(addressSpace + plan.splitPointer);
  });

  it('a primary bucket chain never exceeds its own capacity except in its very last page', () => {
    const writes = demoWrites(150, 4);
    const plan = planHashIndex(writes, { strategy: 'linear', ...SHARED });
    for (const primaryId of plan.primaryBuckets) {
      let cur: number | null = primaryId;
      while (cur !== null) {
        const bucket: Bucket = plan.buckets[cur]!;
        expect(bucket.entries.length).toBeLessThanOrEqual(SHARED.bucketCapacity);
        cur = bucket.next;
      }
    }
  });
});

describe('lookupHashKey', () => {
  it.each(['extendible', 'linear'] as const)('%s finds every distinct written key, with its newest value', (strategy) => {
    const writes = demoWrites(100, 5);
    const plan = planHashIndex(writes, { strategy, ...SHARED });
    const expected = naiveLatest(writes);
    for (const [key, value] of expected) {
      const result = lookupHashKey(plan, key);
      expect(result.found).toBe(true);
      expect(result.value).toBe(value);
      expect(result.bucketsChecked.length).toBeGreaterThan(0);
    }
  });

  it.each(['extendible', 'linear'] as const)('%s: a key that was never written is a genuine miss', (strategy) => {
    const writes = demoWrites(40, 6);
    const plan = planHashIndex(writes, { strategy, ...SHARED });
    const maxKey = Math.max(...writes.map((w) => w.key));
    const result = lookupHashKey(plan, maxKey + 1000);
    expect(result.found).toBe(false);
    expect(result.value).toBeNull();
  });

  it('an empty structure finds nothing, for either strategy', () => {
    for (const strategy of ['extendible', 'linear'] as const) {
      const plan = planHashIndex([], { strategy, ...SHARED });
      expect(lookupHashKey(plan, 1).found).toBe(false);
    }
  });
});

describe('scatter — why a hash index cannot range-scan', () => {
  it.each(['extendible', 'linear'] as const)('%s: consecutive keys land across several different buckets, not adjacent ones', (strategy) => {
    const writes = demoWrites(60, 1);
    const plan = planHashIndex(writes, { strategy, ...SHARED });
    expect(plan.scatter.length).toBeGreaterThan(1);
    const distinctBuckets = new Set(plan.scatter.map((s) => s.bucketId)).size;
    // A sorted structure would put every one of these in the same handful of adjacent leaves; a hash index
    // scatters them — the whole reason this demo exists.
    expect(distinctBuckets).toBeGreaterThan(1);
  });
});

describe('planHashIndex — edge cases', () => {
  it.each(['extendible', 'linear'] as const)('%s: no writes at all produces no events and an empty structure', (strategy) => {
    const plan = planHashIndex([], { strategy, ...SHARED });
    expect(plan.events).toEqual([]);
    expect(plan.totalEntries).toBe(0);
  });
});

describe('planHashIndex — is deterministic and total', () => {
  it.each(['extendible', 'linear'] as const)('%s: the same inputs produce byte-identical plans', (strategy) => {
    const writes = demoWrites(40, 3);
    const a = planHashIndex(writes, { strategy, ...SHARED });
    const b = planHashIndex(writes, { strategy, ...SHARED });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('clamps out-of-range options rather than producing a broken plan', () => {
    const plan = planHashIndex(demoWrites(10, 1), { strategy: 'linear', bucketCapacity: 999, initialBuckets: 999 });
    expect(plan.options.bucketCapacity).toBe(HASH_LIMITS.maxBucketCapacity);
    expect(plan.options.initialBuckets).toBe(HASH_LIMITS.maxInitialBuckets);
  });

  it('never crashes and always resolves correctly, for any legal parameters — extendible', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: HASH_LIMITS.minWrites, max: HASH_LIMITS.maxWrites }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: HASH_LIMITS.minBucketCapacity, max: HASH_LIMITS.maxBucketCapacity }),
        (count, seed, bucketCapacity) => {
          const writes = demoWrites(count, seed);
          const plan = planHashIndex(writes, { strategy: 'extendible', bucketCapacity, initialBuckets: 1 });
          expect(onDiskEntries(plan)).toHaveLength(plan.distinctKeysWritten);
          for (const key of new Set(writes.map((w) => w.key))) expect(lookupHashKey(plan, key).found).toBe(true);
        },
      ),
    );
  });

  it('never crashes and always resolves correctly, for any legal parameters — linear', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: HASH_LIMITS.minWrites, max: HASH_LIMITS.maxWrites }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: HASH_LIMITS.minBucketCapacity, max: HASH_LIMITS.maxBucketCapacity }),
        fc.integer({ min: HASH_LIMITS.minInitialBuckets, max: HASH_LIMITS.maxInitialBuckets }),
        (count, seed, bucketCapacity, initialBuckets) => {
          const writes = demoWrites(count, seed);
          const plan = planHashIndex(writes, { strategy: 'linear', bucketCapacity, initialBuckets });
          expect(onDiskEntries(plan)).toHaveLength(plan.distinctKeysWritten);
          for (const key of new Set(writes.map((w) => w.key))) expect(lookupHashKey(plan, key).found).toBe(true);
        },
      ),
    );
  });
});
