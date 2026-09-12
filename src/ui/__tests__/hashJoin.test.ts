import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { demoKeys, HASH_JOIN_LIMITS, planHashJoin } from '../hashJoin.ts';
import type { HashJoinPartition } from '../hashJoin.ts';

function allLeaves(partition: HashJoinPartition): HashJoinPartition[] {
  if (partition.leaf) return [partition];
  return (partition.children ?? []).flatMap(allLeaves);
}

describe('demoKeys', () => {
  it('build keys are 1..n, distinct', () => {
    const { buildKeys } = demoKeys(10, 20, 1);
    expect(buildKeys).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect(demoKeys(10, 20, 5)).toEqual(demoKeys(10, 20, 5));
    expect(demoKeys(10, 20, 5).probeKeys).not.toEqual(demoKeys(10, 20, 6).probeKeys);
  });

  it('produces exactly probeCount probe keys, some beyond buildCount (guaranteed misses)', () => {
    const { probeKeys } = demoKeys(6, 30, 3);
    expect(probeKeys).toHaveLength(30);
    expect(probeKeys.some((k) => k > 6)).toBe(true);
  });
});

describe('planHashJoin — partitioning covers every key exactly once', () => {
  it('every leaf\'s build + probe keys, combined, reproduce the original multisets', () => {
    const { buildKeys, probeKeys } = demoKeys(20, 40, 9);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 3 });
    const leafBuild = plan.leaves.flatMap((l) => l.buildKeys).sort((a, b) => a - b);
    const leafProbe = plan.leaves.flatMap((l) => l.probeKeys).sort((a, b) => a - b);
    expect(leafBuild).toEqual([...buildKeys].sort((a, b) => a - b));
    expect(leafProbe).toEqual([...probeKeys].sort((a, b) => a - b));
  });

  it('collectLeaves (via plan.leaves) agrees with walking the tree directly', () => {
    const { buildKeys, probeKeys } = demoKeys(20, 40, 9);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 3 });
    expect(plan.leaves.map((l) => l.id).sort((a, b) => a - b)).toEqual(
      allLeaves(plan.root).map((l) => l.id).sort((a, b) => a - b),
    );
  });

  it('a small build side that already fits needs no partitioning at all', () => {
    const { buildKeys, probeKeys } = demoKeys(6, 10, 1);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 4, memPages: 6 });
    expect(plan.fitsInMemory).toBe(true);
    expect(plan.leaves).toHaveLength(1);
    expect(plan.root.level).toBe(0);
    expect(plan.root.leaf).toBeDefined();
    expect(plan.totalIO).toBe(plan.buildProbeIO);
    expect(plan.partitionIO).toBe(0);
  });

  it('a split never just recreates the parent in one child (regression: a bad level-1 multiplier once collapsed every key into a single partition at numPartitions=3)', () => {
    const { buildKeys, probeKeys } = demoKeys(12, 20, 1);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 4 });
    const check = (node: HashJoinPartition) => {
      for (const child of node.children ?? []) {
        if (node.buildKeys.length > 0) expect(child.buildKeys.length).toBeLessThan(node.buildKeys.length);
        check(child);
      }
    };
    check(plan.root);
    expect(plan.maxDepth).toBe(1);
  });

  it('a build side too big for memory forces at least one partitioning level', () => {
    const { buildKeys, probeKeys } = demoKeys(24, 40, 2);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 3 });
    expect(plan.fitsInMemory).toBe(false);
    expect(plan.leaves.length).toBeGreaterThan(1);
    expect(plan.partitionIO).toBeGreaterThan(0);
  });

  it('never partitions deeper than the hard cap, even for a skewed build side', () => {
    // Every build key the same value: no hash function on the value alone can
    // ever split it further, so this must terminate via the depth cap, not loop.
    const skewed = Array.from({ length: 24 }, () => 7);
    const plan = planHashJoin(skewed, [7, 7, 3], { pageSize: 2, memPages: 3 });
    expect(plan.maxDepth).toBeLessThanOrEqual(2);
    expect(plan.leaves.some((l) => l.leaf!.overBudget)).toBe(true);
  });

  it('more buffer pages never increases total I/O', () => {
    const { buildKeys, probeKeys } = demoKeys(24, 40, 4);
    const tight = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 3 });
    const roomy = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 6 });
    expect(roomy.totalIO).toBeLessThanOrEqual(tight.totalIO);
  });
});

describe('planHashJoin — matches and misses', () => {
  it('matches exactly the probe keys that are also build keys, and nothing else', () => {
    const buildKeys = [1, 2, 3, 4, 5];
    const probeKeys = [2, 4, 4, 6, 9, 1];
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 4, memPages: 6 });
    const matchedProbeValues = plan.matches.map((m) => m.probeValue).sort((a, b) => a - b);
    const expected = probeKeys.filter((p) => buildKeys.includes(p)).sort((a, b) => a - b);
    expect(matchedProbeValues).toEqual(expected);
    for (const m of plan.matches) expect(m.buildValue).toBe(m.probeValue);
  });

  it('a probe key with no equal build key is a miss, never a match', () => {
    const buildKeys = [1, 2, 3];
    const probeKeys = [10, 11];
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 4, memPages: 6 });
    expect(plan.matches).toEqual([]);
    expect(plan.leaves[0]!.leaf!.misses).toHaveLength(2);
  });

  it('an empty build side matches nothing — every probe key is a miss', () => {
    const plan = planHashJoin([], [1, 2, 3], { pageSize: 4, memPages: 6 });
    expect(plan.matches).toEqual([]);
    expect(plan.leaves[0]!.leaf!.misses).toHaveLength(3);
  });

  it('an empty probe side produces no matches and no misses', () => {
    const plan = planHashJoin([1, 2, 3], [], { pageSize: 4, memPages: 6 });
    expect(plan.matches).toEqual([]);
    expect(plan.leaves[0]!.leaf!.misses).toEqual([]);
  });
});

describe('planHashJoin — bucket collisions', () => {
  it('flags a bucket only when it holds 2+ distinct values', () => {
    const { buildKeys, probeKeys } = demoKeys(12, 20, 6);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 4, memPages: 6 });
    for (const leaf of plan.leaves) {
      for (const bucket of leaf.leaf!.buckets) {
        const distinct = new Set(bucket.entries.map((e) => e.value)).size;
        expect(bucket.hasCollision).toBe(distinct > 1);
      }
    }
  });

  it('sizing buckets at ~half the distinct build-key count reliably produces a collision', () => {
    const { buildKeys, probeKeys } = demoKeys(12, 20, 6);
    const plan = planHashJoin(buildKeys, probeKeys, { pageSize: 4, memPages: 6 });
    expect(plan.leaves.some((l) => l.leaf!.buckets.some((b) => b.hasCollision))).toBe(true);
  });

  it('a miss through a colliding bucket is flagged distinctly from an empty-bucket miss', () => {
    // Bucket count = ceil(3/2) = 2 for build keys [1,2,3]: 1 and 3 both land
    // in bucket 1 (a collision); probing with 5 (also bucket 1) checks both
    // and finds neither — a collided miss, not a clean empty-bucket one.
    const plan = planHashJoin([1, 2, 3], [5], { pageSize: 4, memPages: 6 });
    const miss = plan.leaves[0]!.leaf!.misses[0]!;
    expect(miss.collided).toBe(true);
  });
});

describe('planHashJoin — is deterministic and total', () => {
  it('the same inputs produce byte-identical plans', () => {
    const { buildKeys, probeKeys } = demoKeys(16, 24, 3);
    const a = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 4 });
    const b = planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: 4 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('clamps out-of-range pageSize/memPages rather than producing a broken plan', () => {
    const plan = planHashJoin([1, 2, 3], [1, 2], { pageSize: 999, memPages: 0 });
    expect(plan.pageSize).toBe(HASH_JOIN_LIMITS.maxPageSize);
    expect(plan.memPages).toBe(HASH_JOIN_LIMITS.minMemPages);
  });

  it('never crashes and always fully partitions, for any legal parameters', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: HASH_JOIN_LIMITS.minBuildKeys, max: HASH_JOIN_LIMITS.maxBuildKeys }),
        fc.integer({ min: HASH_JOIN_LIMITS.minProbeKeys, max: HASH_JOIN_LIMITS.maxProbeKeys }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: HASH_JOIN_LIMITS.minPageSize, max: HASH_JOIN_LIMITS.maxPageSize }),
        fc.integer({ min: HASH_JOIN_LIMITS.minMemPages, max: HASH_JOIN_LIMITS.maxMemPages }),
        (buildCount, probeCount, seed, pageSize, memPages) => {
          const { buildKeys, probeKeys } = demoKeys(buildCount, probeCount, seed);
          const plan = planHashJoin(buildKeys, probeKeys, { pageSize, memPages });
          expect(plan.leaves.flatMap((l) => l.buildKeys)).toHaveLength(buildKeys.length);
          expect(plan.leaves.flatMap((l) => l.probeKeys)).toHaveLength(probeKeys.length);
          expect(plan.maxDepth).toBeLessThanOrEqual(2);
          expect(plan.totalIO).toBe(plan.partitionIO + plan.buildProbeIO);
        },
      ),
    );
  });
});
