/**
 * plan.md §25.4 F2 `/tools/hash-index`: extendible and linear hashing, with their own driver — the engine has
 * only ever built a B+Tree, so (the same situation `/tools/lsm`'s F1 was in) there is no existing structure to
 * reuse. Pure and total: given a write sequence and a chosen scheme, this lays out the whole resulting
 * structure — every bucket, every split, the final directory or bucket array — up front.
 *
 * **Why a hash index cannot range-scan**, the one fact both schemes share and the real reason this tool exists:
 * a hash scatters keys by their HASH VALUE, not their natural order, so two adjacent keys (`41`, `42`) almost
 * always land in unrelated buckets. There is no sorted leaf chain to walk the way a B+Tree's own `next` pointer
 * does (`engine/index/btree.ts`) — a range query has no choice but to hash every value in the range separately,
 * which only works at all for a short, enumerable range, and degrades to a full bucket scan for anything open-
 * ended (`WHERE id > 5`). `scatterOf` makes this concrete: it reports where N *consecutive* keys actually land.
 *
 * **Extendible hashing** (Fagin et al.): a directory of `2^globalDepth` slots, each pointing to a bucket. A
 * bucket's own `localDepth <= globalDepth` says how many of the directory's low bits actually distinguish it —
 * several directory slots can point at the same bucket when its `localDepth < globalDepth`. Inserting into a
 * full bucket SPLITS it: if `localDepth === globalDepth`, the whole directory DOUBLES first (every slot
 * duplicated, `globalDepth` incremented) so there is room for a new slot to point elsewhere; either way, the
 * bucket's own entries are rehashed one bit deeper to decide which of the two (old, new) buckets each belongs
 * to, and the directory slots that used to point at the old bucket are split between them. A single split can
 * still leave the target bucket full (every surviving entry shares the same low bits past the new depth) — the
 * insert retries, splitting again, as many times as it takes.
 *
 * **Linear hashing** (Litwin): no directory at all — just an array of primary buckets, plus whichever ones have
 * grown an overflow chain. A `level` (how many full doubling rounds have completed) and a `splitPointer` (which
 * primary bucket is next to split, this round) together decide a key's address: `hash(key) mod (N0 * 2^level)`,
 * EXCEPT a bucket at or past `splitPointer` has not been split yet this round and still uses that same formula,
 * while one before it already has and uses the next round's wider modulus instead. Splitting is **decoupled
 * from which bucket overflowed**: ANY overflow (even one bucket, hashing however unluckily) triggers the NEXT
 * bucket in round-robin order — `splitPointer`, not the overflowing bucket itself — to split, which is the
 * whole point of the scheme: growth stays controlled and predictable, never a cascade from one hot bucket.
 * Once `splitPointer` has swept every original-this-round bucket, the round closes (`level` increments,
 * `splitPointer` resets to 0) and the address space has doubled.
 *
 * **The hash function**: a full integer-mixing finalizer (xorshift + multiply, twice), not a bare single
 * multiply — `src/ui/lsm.ts`'s own Bloom filter caught, empirically, how a bare multiplicative hash can
 * correlate with structured key patterns badly enough to defeat a filter; extendible hashing is even more
 * exposed to the same risk, since it reads the hash's own LOW BITS directly as a directory index, so the same
 * finalizer is used here from the start rather than re-discovering the same bug a second time.
 */

export type HashStrategy = 'extendible' | 'linear';

export interface HashEntry {
  key: number;
  value: number;
}

export interface Bucket {
  id: number;
  entries: HashEntry[];
  /** Extendible only — how many of the directory's low bits this bucket's own entries all agree on. */
  localDepth: number;
  /** Linear only — the next bucket in this chain (an overflow page), or `null` at the chain's end. */
  next: number | null;
}

export interface HashEvent {
  id: number;
  kind: 'insert' | 'split' | 'directory-double' | 'overflow';
  bucketsCreated: number[];
  bucketsChanged: number[];
  detail: string;
}

export interface HashLimits {
  minWrites: number;
  maxWrites: number;
  minBucketCapacity: number;
  maxBucketCapacity: number;
  minInitialBuckets: number;
  maxInitialBuckets: number;
}

export const HASH_LIMITS: HashLimits = {
  minWrites: 10,
  maxWrites: 200,
  minBucketCapacity: 2,
  maxBucketCapacity: 8,
  minInitialBuckets: 1,
  maxInitialBuckets: 4,
};

export interface HashOptions {
  strategy: HashStrategy;
  bucketCapacity: number;
  /** Linear only — extendible always starts at a single bucket (globalDepth 0), the scheme's own fixed start. */
  initialBuckets: number;
}

export interface ScatterEntry {
  key: number;
  bucketId: number;
}

export interface HashPlan {
  writes: HashEntry[];
  options: HashOptions;
  buckets: Record<number, Bucket>;
  /** Extendible only — `directory[i]` is the id of the bucket slot `i` points to. Empty for linear. */
  directory: number[];
  /** Extendible only — 0 for linear. */
  globalDepth: number;
  /** Linear only — ids of the primary buckets, in address order. Empty for extendible. */
  primaryBuckets: number[];
  /** Linear only — 0 for extendible. */
  splitPointer: number;
  /** Linear only — 0 for extendible. */
  level: number;
  events: HashEvent[];
  distinctKeysWritten: number;
  totalEntries: number;
  bucketCount: number;
  /** Linear only — the longest primary-plus-overflow chain. 1 for extendible (no chaining). */
  maxChainLength: number;
  /** Where N consecutive keys, starting just past the highest one written, would land — the range-scan demo. */
  scatter: ScatterEntry[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** A full integer-mixing finalizer (xorshift + multiply, twice) — see this module's own doc comment. */
function mixHash(x: number): number {
  let h = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A seeded PRNG (mulberry32), for a reproducible `?seed=` demo — the same generator `/tools/lsm` already uses. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A demo write sequence: `count` writes over a key space of `count` distinct keys, with real repeats. */
export function demoWrites(count: number, seed: number): HashEntry[] {
  const keySpace = Math.max(1, Math.ceil(count * 0.7));
  const rnd = makeRng(seed);
  return Array.from({ length: count }, () => ({
    key: 1 + Math.floor(rnd() * keySpace),
    value: Math.floor(rnd() * 1000),
  }));
}

function low(hash: number, bits: number): number {
  return bits === 0 ? 0 : hash & ((1 << bits) - 1);
}

export function planHashIndex(writes: readonly HashEntry[], rawOptions: HashOptions): HashPlan {
  const options: HashOptions = {
    strategy: rawOptions.strategy === 'linear' ? 'linear' : 'extendible',
    bucketCapacity: clamp(rawOptions.bucketCapacity, HASH_LIMITS.minBucketCapacity, HASH_LIMITS.maxBucketCapacity),
    initialBuckets: clamp(rawOptions.initialBuckets, HASH_LIMITS.minInitialBuckets, HASH_LIMITS.maxInitialBuckets),
  };

  let nextBucketId = 0;
  let nextEventId = 0;
  const buckets: Record<number, Bucket> = {};
  const events: HashEvent[] = [];

  const makeBucket = (localDepth: number): Bucket => {
    const bucket: Bucket = { id: nextBucketId++, entries: [], localDepth, next: null };
    buckets[bucket.id] = bucket;
    return bucket;
  };

  /* ---------------------------------------------------------------------- */
  /* Extendible hashing                                                      */
  /* ---------------------------------------------------------------------- */

  let globalDepth = 0;
  let directory: number[] = [];

  function initExtendible(): void {
    const root = makeBucket(0);
    directory = [root.id];
  }

  function insertExtendible(entry: HashEntry): void {
    for (;;) {
      const idx = low(mixHash(entry.key), globalDepth);
      const bucket = buckets[directory[idx]!]!;

      const existing = bucket.entries.findIndex((e) => e.key === entry.key);
      if (existing >= 0) {
        bucket.entries[existing] = entry;
        events.push({ id: nextEventId++, kind: 'insert', bucketsCreated: [], bucketsChanged: [bucket.id], detail: `updated key ${String(entry.key)} in bucket ${String(bucket.id)}` });
        return;
      }

      if (bucket.entries.length < options.bucketCapacity) {
        bucket.entries.push(entry);
        events.push({ id: nextEventId++, kind: 'insert', bucketsCreated: [], bucketsChanged: [bucket.id], detail: `inserted key ${String(entry.key)} into bucket ${String(bucket.id)}` });
        return;
      }

      // Overflow: split. Double the directory first if this bucket has no spare depth to split into.
      if (bucket.localDepth === globalDepth) {
        const oldDirectory = directory;
        globalDepth += 1;
        directory = [...oldDirectory, ...oldDirectory];
        events.push({ id: nextEventId++, kind: 'directory-double', bucketsCreated: [], bucketsChanged: [], detail: `directory doubled to ${String(directory.length)} slots (global depth ${String(globalDepth)})` });
      }

      const newLocalDepth = bucket.localDepth + 1;
      const sibling = makeBucket(newLocalDepth);
      bucket.localDepth = newLocalDepth;

      const [stay, move] = partitionByBit(bucket.entries, newLocalDepth - 1);
      bucket.entries = stay;
      sibling.entries = move;

      // Every directory slot that pointed at `bucket` and has a 1 at the new bit now points at `sibling`.
      for (let i = 0; i < directory.length; i++) {
        if (directory[i] === bucket.id && ((i >>> (newLocalDepth - 1)) & 1) === 1) directory[i] = sibling.id;
      }

      events.push({ id: nextEventId++, kind: 'split', bucketsCreated: [sibling.id], bucketsChanged: [bucket.id], detail: `bucket ${String(bucket.id)} split, creating bucket ${String(sibling.id)} (local depth ${String(newLocalDepth)})` });
      // Retry — the entry's own target bucket may be either of the two, and may still be full.
    }
  }

  /** Splits `entries` by the bit at `bitPosition` of each entry's own mixed hash: bit 0 stays, bit 1 moves. */
  function partitionByBit(entries: readonly HashEntry[], bitPosition: number): [HashEntry[], HashEntry[]] {
    const stay: HashEntry[] = [];
    const move: HashEntry[] = [];
    for (const e of entries) {
      const bit = (mixHash(e.key) >>> bitPosition) & 1;
      (bit === 0 ? stay : move).push(e);
    }
    return [stay, move];
  }

  /* ---------------------------------------------------------------------- */
  /* Linear hashing                                                          */
  /* ---------------------------------------------------------------------- */

  let primaryBuckets: number[] = [];
  let splitPointer = 0;
  let level = 0;

  function initLinear(): void {
    primaryBuckets = Array.from({ length: options.initialBuckets }, () => makeBucket(0).id);
  }

  /** The current address space size — `N0 * 2^level`. */
  const addressSpace = (): number => options.initialBuckets * 2 ** level;

  function addressFor(key: number): number {
    const mod = addressSpace();
    const addr = mixHash(key) % mod;
    return addr < splitPointer ? mixHash(key) % (mod * 2) : addr;
  }

  function chainOf(primaryId: number): number[] {
    const chain = [primaryId];
    let cur = buckets[primaryId]!;
    while (cur.next !== null) {
      chain.push(cur.next);
      cur = buckets[cur.next]!;
    }
    return chain;
  }

  function insertLinear(entry: HashEntry): void {
    const addr = addressFor(entry.key);
    const primaryId = primaryBuckets[addr]!;
    const chain = chainOf(primaryId);

    for (const id of chain) {
      const existing = buckets[id]!.entries.findIndex((e) => e.key === entry.key);
      if (existing >= 0) {
        buckets[id]!.entries[existing] = entry;
        events.push({ id: nextEventId++, kind: 'insert', bucketsCreated: [], bucketsChanged: [id], detail: `updated key ${String(entry.key)} in bucket ${String(id)}` });
        return;
      }
    }

    const last = buckets[chain[chain.length - 1]!]!;
    if (last.entries.length < options.bucketCapacity) {
      last.entries.push(entry);
      events.push({ id: nextEventId++, kind: 'insert', bucketsCreated: [], bucketsChanged: [last.id], detail: `inserted key ${String(entry.key)} into bucket ${String(last.id)}` });
      return;
    }

    // The chain's own last bucket is full: grow an overflow page onto it, then split the bucket this round's
    // own split pointer names — NOT necessarily the one that just overflowed, the scheme's own defining trait.
    const overflow = makeBucket(0);
    overflow.entries.push(entry);
    last.next = overflow.id;
    events.push({ id: nextEventId++, kind: 'overflow', bucketsCreated: [overflow.id], bucketsChanged: [last.id], detail: `bucket ${String(primaryId)}'s chain grew an overflow page (${String(overflow.id)}) for key ${String(entry.key)}` });

    splitPrimaryBucket();
  }

  function splitPrimaryBucket(): void {
    const splittingId = primaryBuckets[splitPointer]!;
    const allEntries = chainOf(splittingId).flatMap((id) => buckets[id]!.entries);
    const newAddr = splitPointer + addressSpace();

    const mod2 = addressSpace() * 2;
    const stay: HashEntry[] = [];
    const move: HashEntry[] = [];
    for (const e of allEntries) {
      const addr = mixHash(e.key) % mod2;
      (addr === splitPointer ? stay : move).push(e);
    }

    // The splitting primary bucket keeps its own id but loses its overflow chain — `stay`'s entries are re-laid
    // out across fresh pages up to `bucketCapacity`, same as any bucket's content ever is.
    const oldChainIds = chainOf(splittingId).slice(1); // overflow pages only; the primary id itself is kept
    const newBucket = makeBucket(0);
    primaryBuckets.push(newBucket.id);

    layOutChain(splittingId, stay);
    layOutChain(newBucket.id, move);
    // `layOutChain` rebuilt `splittingId`'s chain from fresh pages — its OLD overflow pages are no longer
    // reachable from anywhere and must be removed, not left behind as stale, still-counted garbage.
    for (const id of oldChainIds) delete buckets[id];

    events.push({
      id: nextEventId++,
      kind: 'split',
      bucketsCreated: [newBucket.id],
      bucketsChanged: [splittingId, ...oldChainIds],
      detail: `bucket ${String(splittingId)} (address ${String(splitPointer)}) split into address ${String(newAddr)} (bucket ${String(newBucket.id)})`,
    });

    splitPointer += 1;
    if (splitPointer >= addressSpace()) {
      // Every bucket that existed at this round's start has now split; the address space just doubled above.
      splitPointer = 0;
      level += 1;
    }
  }

  /** Rebuilds bucket `rootId`'s own chain from scratch to hold exactly `entries`, respecting `bucketCapacity` — used after a split redistributes a chain's worth of entries across two addresses. */
  function layOutChain(rootId: number, entries: readonly HashEntry[]): void {
    const root = buckets[rootId]!;
    root.entries = entries.slice(0, options.bucketCapacity);
    root.next = null;
    let cur = root;
    for (let i = options.bucketCapacity; i < entries.length; i += options.bucketCapacity) {
      const page = makeBucket(0);
      page.entries = entries.slice(i, i + options.bucketCapacity);
      cur.next = page.id;
      cur = page;
    }
  }

  /* ---------------------------------------------------------------------- */

  if (options.strategy === 'extendible') initExtendible();
  else initLinear();

  for (const w of writes) {
    if (options.strategy === 'extendible') insertExtendible(w);
    else insertLinear(w);
  }

  const distinctKeys = [...new Set(writes.map((w) => w.key))];
  const totalEntries = Object.values(buckets).reduce((n, b) => n + b.entries.length, 0);

  const bucketCount =
    options.strategy === 'extendible' ? new Set(directory).size : Object.keys(buckets).length;

  const maxChainLength =
    options.strategy === 'extendible'
      ? 1
      : Math.max(1, ...primaryBuckets.map((id) => chainOf(id).length));

  const maxWrittenKey = distinctKeys.length === 0 ? 0 : Math.max(...distinctKeys);
  const scatter: ScatterEntry[] = Array.from({ length: Math.min(10, Math.max(1, distinctKeys.length)) }, (_, i) => {
    const key = maxWrittenKey + i + 1;
    const bucketId =
      options.strategy === 'extendible'
        ? directory[low(mixHash(key), globalDepth)]!
        : primaryBuckets[addressFor(key)]!;
    return { key, bucketId };
  });

  return {
    writes: [...writes],
    options,
    buckets,
    directory: [...directory],
    globalDepth,
    primaryBuckets: [...primaryBuckets],
    splitPointer,
    level,
    events,
    distinctKeysWritten: distinctKeys.length,
    totalEntries,
    bucketCount,
    maxChainLength,
    scatter,
  };
}

/** A real point lookup, walking the structure the same way `insert` addresses it. */
export function lookupHashKey(plan: HashPlan, key: number): { found: boolean; value: number | null; bucketsChecked: number[] } {
  const bucketsChecked: number[] = [];

  if (plan.options.strategy === 'extendible') {
    const idx = low(mixHash(key), plan.globalDepth);
    const bucketId = plan.directory[idx];
    if (bucketId === undefined) return { found: false, value: null, bucketsChecked };
    bucketsChecked.push(bucketId);
    const hit = plan.buckets[bucketId]!.entries.find((e) => e.key === key);
    return hit ? { found: true, value: hit.value, bucketsChecked } : { found: false, value: null, bucketsChecked };
  }

  const mod = plan.options.initialBuckets * 2 ** plan.level;
  const addr0 = mixHash(key) % mod;
  const addr = addr0 < plan.splitPointer ? mixHash(key) % (mod * 2) : addr0;
  const primaryId = plan.primaryBuckets[addr];
  if (primaryId === undefined) return { found: false, value: null, bucketsChecked };

  let cur: number | null = primaryId;
  while (cur !== null) {
    bucketsChecked.push(cur);
    const bucket: Bucket = plan.buckets[cur]!;
    const hit = bucket.entries.find((e: HashEntry) => e.key === key);
    if (hit) return { found: true, value: hit.value, bucketsChecked };
    cur = bucket.next;
  }
  return { found: false, value: null, bucketsChecked };
}
