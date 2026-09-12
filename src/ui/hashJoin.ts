/**
 * plan.md §22.3 `/tools/hash-join`: Grace hash join, with its own driver — the
 * engine's real `hashJoin` operator (`src/engine/exec/operators.ts`, §22.2) has
 * no partitioning, spill, or bucket-collision visualisation, the same reason
 * `/tools/sort` (`externalSort.ts`) doesn't just render the engine's `Sort`.
 * Pure and total — given a build-side key list, a probe-side key list, and a
 * memory budget, this lays out the whole plan up front: every partitioning
 * level, the bucket layout each leaf partition's build phase produces, and the
 * probe-phase result per key. The tool renders it; nothing here touches the DOM.
 *
 * The model (Ramakrishnan & Gehrke §14.4.3):
 *
 *   - `numPartitions = memPages - 1` (one page is the input buffer while every
 *     other page writes one partition's output).
 *   - Partitioning hashes each key with `h1` and buckets it by `key mod
 *     numPartitions`; each level of the tree uses a different multiplicative
 *     constant for `h1`, so a partition that still doesn't fit after one pass
 *     genuinely redistributes its keys on the next, not into the exact same
 *     split. Cost: read + write everything in a node once per partitioning
 *     level: `2 * (buildPages + probePages)`.
 *   - A partition is a leaf once its build side already fits in `memPages`
 *     pages, or three partitioning levels have already happened (`maxDepth`) —
 *     a hard stop so heavily-skewed keys (many equal values, which no amount
 *     of hashing on value alone will ever separate) still terminate.
 *   - A leaf's build phase hashes each build key again with a second function,
 *     `h2 = key mod numBuckets`, into an in-memory bucket array sized so two
 *     keys collide on average — the point being taught. The probe phase then
 *     hashes each probe key the same way and checks the bucket's build entries
 *     for an equal value: a genuine match, a bucket collision that still fails
 *     the equality check, or an empty bucket (no match at all).
 */

export interface HashJoinBucket {
  index: number;
  /** Build-side entries landing here, in insertion order. */
  entries: { value: number; row: number }[];
  /** True when 2+ *distinct* values share this bucket — a real hash collision. */
  hasCollision: boolean;
}

export interface HashJoinMatch {
  buildValue: number;
  probeValue: number;
  bucket: number;
}

/** A probe key that reached a bucket holding no equal value — a miss, real either way. */
export interface HashJoinMiss {
  probeValue: number;
  bucket: number;
  /** True when the bucket wasn't empty — the probe paid for a collision and still found nothing. */
  collided: boolean;
}

export interface HashJoinLeaf {
  numBuckets: number;
  buckets: HashJoinBucket[];
  matches: HashJoinMatch[];
  misses: HashJoinMiss[];
  /** True only when this leaf was forced by `maxDepth`, not because it actually fit. */
  overBudget: boolean;
}

export interface HashJoinPartition {
  id: number;
  /** 0 = the very first partitioning attempt, over the whole input. */
  level: number;
  /** This partition's index among its siblings (its parent's `h1` bucket). */
  slot: number;
  buildKeys: number[];
  probeKeys: number[];
  buildPages: number;
  probePages: number;
  /** Set once this partition's build side is handled in memory — the terminal case. */
  leaf?: HashJoinLeaf;
  /** Set only when this partition needed a further partitioning pass (spill). */
  children?: HashJoinPartition[];
}

export interface HashJoinPlan {
  buildKeys: number[];
  probeKeys: number[];
  pageSize: number;
  memPages: number;
  numPartitions: number;
  root: HashJoinPartition;
  /** Every leaf partition, in id order. */
  leaves: HashJoinPartition[];
  /** Every leaf's matches, combined. */
  matches: HashJoinMatch[];
  /** Read + write for every partitioning level that actually happened. */
  partitionIO: number;
  /** Read once for every leaf partition's own build + probe pages. */
  buildProbeIO: number;
  totalIO: number;
  /** Deepest partitioning level any leaf was found at. 0 means no partitioning ran at all. */
  maxDepth: number;
  /** True when the whole build side already fit in memory — no partitioning pass at all. */
  fitsInMemory: boolean;
}

export const HASH_JOIN_LIMITS = {
  minBuildKeys: 6,
  maxBuildKeys: 24,
  minProbeKeys: 6,
  maxProbeKeys: 32,
  minPageSize: 2,
  maxPageSize: 4,
  minMemPages: 3,
  maxMemPages: 6,
} as const;

/** Hard stop on partitioning recursion — see the module comment. */
const MAX_DEPTH = 2;

/**
 * A different multiplier per level, so re-partitioning a stuck node actually
 * redistributes it — each is odd and not a multiple of 2, 3, 4, or 5 (every
 * `numPartitions` this tool ever uses), which a naive choice can easily miss:
 * an earlier constant here (40503) was itself a multiple of 3, so at
 * `numPartitions = 3` every key landed in the same partition on that level,
 * collapsing the "split" into a no-op — caught by inspecting this tool in the
 * browser, not by a unit test (small `HASH_JOIN_LIMITS` ranges never happened
 * to need a real level-1 split in the suite's own cases).
 */
const LEVEL_MULTIPLIERS = [2654435761, 2246822519, 3266489917] as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

function pagesFor(count: number, pageSize: number): number {
  return Math.max(1, Math.ceil(count / pageSize));
}

/** `h1` at a given partitioning level: a Knuth multiplicative hash, folded into `numPartitions` slots. */
function h1(key: number, level: number, numPartitions: number): number {
  const m = LEVEL_MULTIPLIERS[level % LEVEL_MULTIPLIERS.length]!;
  return (Math.imul(key, m) >>> 0) % numPartitions;
}

/** A seeded PRNG (mulberry32), for a reproducible `?seed=` demo. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A demo key set with a realistic shape: `buildCount` distinct build keys
 * (`1..buildCount`, like a primary key), and `probeCount` probe keys drawn
 * from a slightly wider range — most land on a real build key (some more than
 * once, a normal fan-out), some land past it (a guaranteed miss, like a
 * dangling foreign key).
 */
export function demoKeys(
  buildCount: number,
  probeCount: number,
  seed: number,
): { buildKeys: number[]; probeKeys: number[] } {
  const buildKeys = Array.from({ length: buildCount }, (_, i) => i + 1);
  const missPool = Math.max(1, Math.ceil(buildCount / 3));
  const rnd = makeRng(seed);
  const probeKeys = Array.from(
    { length: probeCount },
    () => 1 + Math.floor(rnd() * (buildCount + missPool)),
  );
  return { buildKeys, probeKeys };
}

/** The in-memory build + probe phase for one leaf partition. */
function buildLeaf(buildKeys: readonly number[], probeKeys: readonly number[]): HashJoinLeaf {
  // Sized so two keys share a bucket on average — collisions are the point.
  const numBuckets = Math.max(1, Math.ceil(new Set(buildKeys).size / 2));
  const buckets: HashJoinBucket[] = Array.from({ length: numBuckets }, (_, index) => ({
    index,
    entries: [],
    hasCollision: false,
  }));

  buildKeys.forEach((value, row) => {
    buckets[value % numBuckets]!.entries.push({ value, row });
  });
  for (const bucket of buckets) {
    bucket.hasCollision = new Set(bucket.entries.map((e) => e.value)).size > 1;
  }

  const matches: HashJoinMatch[] = [];
  const misses: HashJoinMiss[] = [];
  for (const probeValue of probeKeys) {
    const bucketIndex = probeValue % numBuckets;
    const bucket = buckets[bucketIndex]!;
    const hits = bucket.entries.filter((e) => e.value === probeValue);
    if (hits.length > 0) {
      for (const hit of hits) matches.push({ buildValue: hit.value, probeValue, bucket: bucketIndex });
    } else {
      misses.push({ probeValue, bucket: bucketIndex, collided: bucket.entries.length > 0 });
    }
  }

  return { numBuckets, buckets, matches, misses, overBudget: false };
}

interface PartitionCost {
  partitionIO: number;
  buildProbeIO: number;
  maxDepthReached: number;
}

function partitionAt(
  buildKeys: number[],
  probeKeys: number[],
  level: number,
  slot: number,
  opts: { numPartitions: number; pageSize: number; memPages: number },
  nextId: { current: number },
  cost: PartitionCost,
): HashJoinPartition {
  const id = nextId.current++;
  const buildPages = pagesFor(buildKeys.length, opts.pageSize);
  const probePages = pagesFor(probeKeys.length, opts.pageSize);
  const partition: HashJoinPartition = { id, level, slot, buildKeys, probeKeys, buildPages, probePages };

  const fits = buildPages <= opts.memPages;
  if (fits || level >= MAX_DEPTH) {
    partition.leaf = buildLeaf(buildKeys, probeKeys);
    partition.leaf.overBudget = !fits;
    cost.buildProbeIO += buildPages + probePages;
    cost.maxDepthReached = Math.max(cost.maxDepthReached, level);
    return partition;
  }

  // Partitioning this node costs one read of everything in it, and one write
  // of everything into its children.
  cost.partitionIO += 2 * (buildPages + probePages);

  const children: HashJoinPartition[] = [];
  for (let p = 0; p < opts.numPartitions; p++) {
    const childBuild = buildKeys.filter((k) => h1(k, level + 1, opts.numPartitions) === p);
    const childProbe = probeKeys.filter((k) => h1(k, level + 1, opts.numPartitions) === p);
    children.push(partitionAt(childBuild, childProbe, level + 1, p, opts, nextId, cost));
  }
  partition.children = children;
  return partition;
}

function collectLeaves(partition: HashJoinPartition, out: HashJoinPartition[]): void {
  if (partition.leaf) {
    out.push(partition);
    return;
  }
  for (const child of partition.children ?? []) collectLeaves(child, out);
}

export function planHashJoin(
  buildKeys: readonly number[],
  probeKeys: readonly number[],
  opts: { pageSize: number; memPages: number },
): HashJoinPlan {
  const pageSize = clamp(opts.pageSize, HASH_JOIN_LIMITS.minPageSize, HASH_JOIN_LIMITS.maxPageSize);
  const memPages = clamp(opts.memPages, HASH_JOIN_LIMITS.minMemPages, HASH_JOIN_LIMITS.maxMemPages);
  const numPartitions = Math.max(2, memPages - 1);

  const nextId = { current: 0 };
  const cost: PartitionCost = { partitionIO: 0, buildProbeIO: 0, maxDepthReached: 0 };
  const root = partitionAt(
    [...buildKeys],
    [...probeKeys],
    0,
    0,
    { numPartitions, pageSize, memPages },
    nextId,
    cost,
  );

  const leaves: HashJoinPartition[] = [];
  collectLeaves(root, leaves);
  const matches = leaves.flatMap((leaf) => leaf.leaf!.matches);

  return {
    buildKeys: [...buildKeys],
    probeKeys: [...probeKeys],
    pageSize,
    memPages,
    numPartitions,
    root,
    leaves,
    matches,
    partitionIO: cost.partitionIO,
    buildProbeIO: cost.buildProbeIO,
    totalIO: cost.partitionIO + cost.buildProbeIO,
    maxDepth: cost.maxDepthReached,
    fitsInMemory: root.leaf !== undefined,
  };
}
