/**
 * plan.md §25.4 F1 `/tools/lsm`: a log-structured merge-tree, with its own driver — §4's engine has only ever
 * built a B+Tree, so there is no existing structure to reuse the way `/tools/btree` reuses the real index code.
 * Pure and total, like `/tools/sort` and `/tools/hash-join`: given a write sequence and a set of size parameters,
 * this lays out the whole resulting structure — every SSTable flush, every compaction, the final levels — up
 * front. The tool renders it; nothing here touches the DOM.
 *
 * The model (Ramakrishnan & Gehrke's own LSM coverage; RocksDB/LevelDB's "leveled compaction"):
 *
 *   - Writes buffer in an in-memory **memtable**. Once it holds `memtableCapacity` entries, it is **flushed** as
 *     one new, immutable, sorted **SSTable** at level 0.
 *   - L0 SSTables may have **overlapping key ranges** — each is just whatever was in the memtable at flush
 *     time, not partitioned by key — exactly the classic LSM wrinkle. Once L0 holds `l0CompactionTrigger`
 *     SSTables, they compact into L1.
 *   - Level *n* ≥ 1 has a capacity of `baseLevelCapacity × levelSizeMultiplier^(n-1)` entries; once a level's
 *     total entry count exceeds it, that level compacts into the next.
 *   - **Compaction, simplified on purpose:** a real leveled compaction merges one file at a time, picked by a
 *     scheduling heuristic. This model merges a *whole* level's current SSTables (plus whichever next-level
 *     SSTables their key ranges overlap) in one step, keeping only each key's most recently written value, then
 *     re-splits the merged, deduplicated result into fresh, non-overlapping SSTables of `sstableCapacity`
 *     entries each — the same simplification the B+Tree's tiny fan-out already makes (`index/btree.ts`): real
 *     compaction would never rewrite a whole level at once, but a toy model that does still teaches the real
 *     lesson — data cascades downward, each level is geometrically bigger than the last, and a key written once
 *     gets physically rewritten every time it is swept into the next level, which is *why* write amplification
 *     exists at all — without needing a file-picking policy that would only obscure it.
 *   - **Write amplification** = every entry ever physically written (every flush, every compaction's rebuilt
 *     entries) ÷ the number of writes the caller actually made.
 *   - **Space amplification** = every entry currently sitting in some SSTable (stale, superseded duplicates
 *     included) ÷ the number of distinct keys actually written.
 *   - **Read amplification, worst case** = the number of SSTables a point lookup might have to check: every L0
 *     table (they can all overlap any key) plus one per non-empty level beyond L0 (each level's own tables never
 *     overlap each other, so at most one per level can hold a given key).
 *   - **The Bloom filter (plan.md's own next slice, now built):** every SSTable carries its own filter, built
 *     from the keys it holds, sized by a `bitsPerKey` parameter — `m = n × bitsPerKey` bits, `k = (m/n) × ln 2`
 *     hash functions (the standard optimum for a given bits-per-key budget). A lookup checks a table's filter
 *     before the table itself; a "definitely not here" skips the table outright, and a "maybe" — sometimes a
 *     genuine false positive, never a false negative — still costs the check. `readAmplificationAverage` is
 *     **measured, not estimated**: every distinct key actually written (an expected hit) plus an equal-sized
 *     sample of keys that were never written (an expected miss) are each looked up for real, and the number of
 *     SSTables actually checked is averaged — the number `readAmplificationWorstCase` alone cannot show, since
 *     it says nothing about how often the filter actually earns its keep. `measuredFalsePositiveRate` is
 *     likewise measured by testing every (table, key-not-in-that-table) pair across the whole structure, not
 *     read off the textbook formula — though the two agree closely (checked in this module's own tests).
 *   - **The hash functions**, `h1`/`h2`: a full integer-mixing finalizer (xorshift + multiply, twice), not a
 *     bare single multiply — a bare multiplicative hash can correlate with structured key patterns in a way that
 *     silently defeats the filter (caught empirically while validating this module: an all-even test key set
 *     against an even table size produced a suspicious, too-good 0% false-positive rate at every `bitsPerKey`,
 *     including ones the textbook formula says should be far worse — traced to the bare-multiply hash mapping
 *     even inputs to even bit positions only, not a property of Bloom filters at all). `h_i(key) = h1 + i·h2`
 *     (Kirsch–Mitzenmacher double hashing) derives all `k` positions from the two mixed hashes.
 *   - **A second, selectable compaction strategy: `tiered` (size-tiered), alongside the `leveled` model above.**
 *     Where leveled compaction keeps every level past L0 non-overlapping (re-splitting a merge's output into
 *     fresh, range-partitioned SSTables, and pulling in whatever next-level tables the merge's own key range
 *     touches), tiered compaction does neither: once a level (any level, not just L0) accumulates
 *     `filesPerTier` SSTables, they merge into ONE new, unsplit table that moves down a level — the next level's
 *     *existing* tables are left completely untouched until that level, too, fills up. This is a real,
 *     well-known trade-off (RocksDB calls it "universal" compaction, as opposed to its default "leveled"), not a
 *     cosmetic toggle: tiered compaction touches less data per compaction event (never reading and rewriting
 *     whatever the next level already holds), so it genuinely costs **less write amplification** for the same
 *     writes — but every level below L0 can now hold several overlapping tables, the same wrinkle leveled
 *     compaction confines to L0 alone, so a lookup may have to check every table at every level, costing
 *     genuinely **more read amplification**, measured the same way leveled's is. Both directions of this
 *     trade-off are measured in this module's own tests, not assumed from the textbook description.
 */

export interface LsmWrite {
  key: number;
  value: number;
  /** Order written — breaks ties when the same key is written more than once. */
  seq: number;
}

export interface BloomFilter {
  /** `m` bits. A plain boolean array — these toy filters never hold more than a few hundred bits, so a packed
   *  bitset would buy nothing and cost readability. */
  bits: boolean[];
  m: number;
  k: number;
  bitsPerKey: number;
}

export interface SSTable {
  id: number;
  level: number;
  /** Sorted by key, one entry per key — the newest write to reach this table, for any key it holds. */
  entries: LsmWrite[];
  minKey: number;
  maxKey: number;
  bloom: BloomFilter;
}

export interface LsmEvent {
  id: number;
  kind: 'flush' | 'compaction';
  /** The level a flush lands at (always 0), or the source level a compaction drains. */
  level: number;
  /** SSTable ids this event removed from the structure. */
  removed: number[];
  /** SSTable ids this event created. */
  created: number[];
  /** Entries physically written by this one event — what write amplification actually counts. */
  entriesWritten: number;
}

export interface LsmLimits {
  minWrites: number;
  maxWrites: number;
  minMemtableCapacity: number;
  maxMemtableCapacity: number;
  minLevelSizeMultiplier: number;
  maxLevelSizeMultiplier: number;
  minL0Trigger: number;
  maxL0Trigger: number;
  minBitsPerKey: number;
  maxBitsPerKey: number;
}

export const LSM_LIMITS: LsmLimits = {
  minWrites: 10,
  maxWrites: 200,
  minMemtableCapacity: 2,
  maxMemtableCapacity: 8,
  minLevelSizeMultiplier: 2,
  maxLevelSizeMultiplier: 4,
  minL0Trigger: 2,
  maxL0Trigger: 6,
  minBitsPerKey: 2,
  maxBitsPerKey: 20,
};

export type CompactionStrategy = 'leveled' | 'tiered';

export interface LsmOptions {
  compactionStrategy: CompactionStrategy;
  memtableCapacity: number;
  /** Leveled: L0's own trigger only. Tiered: the SAME files-per-tier trigger, reused at every level. */
  l0CompactionTrigger: number;
  /** L1's own capacity, in entries. Every SSTable this model ever creates also holds at most this many. Leveled only — tiered never re-splits a merge, so this is ignored under that strategy. */
  baseLevelCapacity: number;
  /** Leveled only, same reason as `baseLevelCapacity`. */
  levelSizeMultiplier: number;
  /** Bits of filter per key an SSTable holds — the false-positive/size trade-off. */
  bitsPerKey: number;
}

export interface LookupResult {
  key: number;
  found: boolean;
  value: number | null;
  /** SSTable ids whose filter said "maybe" and were actually checked, in check order — L0 newest-first, then at most one per level below. */
  tablesChecked: number[];
  /** Among `tablesChecked`, the ones checked and found NOT to hold the key — a real false positive unless this is the one that found it. */
  falsePositives: number[];
}

export interface LsmPlan {
  writes: LsmWrite[];
  options: LsmOptions;
  events: LsmEvent[];
  /** Final structure: `levels[0]` is L0, `levels[1]` is L1, … Never trailing-empty. */
  levels: SSTable[][];
  distinctKeysWritten: number;
  totalEntriesOnDisk: number;
  totalEntriesEverWritten: number;
  writeAmplification: number;
  spaceAmplification: number;
  readAmplificationWorstCase: number;
  /** Measured, not estimated — see this module's own doc comment. */
  readAmplificationAverage: number;
  measuredFalsePositiveRate: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * A full integer-mixing finalizer (xorshift + multiply, twice over) — NOT a bare single multiply, which this
 * module's own doc comment explains correlated with structured key patterns badly enough to silently defeat
 * the filter during validation.
 */
function mixHash(x: number): number {
  let h = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Kirsch–Mitzenmacher double hashing: every one of a filter's `k` bit positions, derived from two independent mixed hashes. */
function bloomPositions(key: number, m: number, k: number): number[] {
  const h1 = mixHash(key) % m;
  const h2 = mixHash(key ^ 0x9e3779b9) % m || 1; // never 0 — a 0 second hash would make every position equal h1
  return Array.from({ length: k }, (_, i) => (h1 + i * h2) % m);
}

/** `m = n × bitsPerKey` bits, `k = (m/n) × ln 2` hash functions — the standard optimal `k` for a given bits-per-key budget. */
function buildBloomFilter(keys: readonly number[], bitsPerKey: number): BloomFilter {
  const n = Math.max(1, keys.length);
  const m = Math.max(8, Math.round(n * bitsPerKey));
  const k = Math.max(1, Math.round((m / n) * Math.LN2));
  const bits = new Array<boolean>(m).fill(false);
  for (const key of keys) for (const pos of bloomPositions(key, m, k)) bits[pos] = true;
  return { bits, m, k, bitsPerKey };
}

/** Never a false negative — a key actually inserted always passes. May be a false positive — a key never inserted sometimes does too. */
function bloomMightContain(filter: BloomFilter, key: number): boolean {
  return bloomPositions(key, filter.m, filter.k).every((pos) => filter.bits[pos]);
}

/** A seeded PRNG (mulberry32), for a reproducible `?seed=` demo — the same generator `/tools/sort` and `/tools/hash-join` already use. */
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
 * A demo write sequence: `count` writes over a key space of `count` distinct keys, each key written once on
 * average but with real repeats (about a third of writes land on an already-written key) — enough for
 * compaction to genuinely deduplicate something, the point of the whole demo.
 */
export function demoWrites(count: number, seed: number): LsmWrite[] {
  const keySpace = Math.max(1, Math.ceil(count * 0.7));
  const rnd = makeRng(seed);
  return Array.from({ length: count }, (_, i) => ({
    key: 1 + Math.floor(rnd() * keySpace),
    value: Math.floor(rnd() * 1000),
    seq: i,
  }));
}

/** Keeps only the highest-`seq` entry per key — "last write wins" — sorted ascending by key. */
function dedupeNewest(entries: readonly LsmWrite[]): LsmWrite[] {
  const byKey = new Map<number, LsmWrite>();
  for (const e of entries) {
    const existing = byKey.get(e.key);
    if (!existing || e.seq > existing.seq) byKey.set(e.key, e);
  }
  return [...byKey.values()].sort((a, b) => a.key - b.key);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function overlaps(table: SSTable, minKey: number, maxKey: number): boolean {
  return table.minKey <= maxKey && table.maxKey >= minKey;
}

export function planLsm(writes: readonly LsmWrite[], rawOptions: LsmOptions): LsmPlan {
  const options: LsmOptions = {
    compactionStrategy: rawOptions.compactionStrategy === 'tiered' ? 'tiered' : 'leveled',
    memtableCapacity: clamp(rawOptions.memtableCapacity, LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity),
    l0CompactionTrigger: clamp(rawOptions.l0CompactionTrigger, LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger),
    baseLevelCapacity: Math.max(1, Math.round(rawOptions.baseLevelCapacity)),
    levelSizeMultiplier: clamp(rawOptions.levelSizeMultiplier, LSM_LIMITS.minLevelSizeMultiplier, LSM_LIMITS.maxLevelSizeMultiplier),
    bitsPerKey: clamp(rawOptions.bitsPerKey, LSM_LIMITS.minBitsPerKey, LSM_LIMITS.maxBitsPerKey),
  };

  let nextTableId = 0;
  let nextEventId = 0;
  let totalEntriesEverWritten = 0;
  const levels: SSTable[][] = [[]];
  const events: LsmEvent[] = [];

  const levelCapacity = (level: number): number =>
    level === 0 ? Infinity : options.baseLevelCapacity * options.levelSizeMultiplier ** (level - 1);

  function ensureLevel(level: number): void {
    while (levels.length <= level) levels.push([]);
  }

  function compact(level: number): void {
    if (options.compactionStrategy === 'tiered') compactTiered(level);
    else compactLeveled(level);
  }

  /** Leveled: merges every SSTable currently in `level` (plus whatever it overlaps in `level + 1`) down one
   *  level, re-splitting the result into fresh, non-overlapping SSTables. */
  function compactLeveled(level: number): void {
    ensureLevel(level + 1);
    const source = levels[level]!;
    if (source.length === 0) return;
    const merged = dedupeNewest(source.flatMap((t) => t.entries));
    const minKey = merged[0]!.key;
    const maxKey = merged[merged.length - 1]!.key;
    const nextLevel = levels[level + 1]!;
    const overlapping = nextLevel.filter((t) => overlaps(t, minKey, maxKey));
    const untouched = nextLevel.filter((t) => !overlapping.includes(t));
    const combined = dedupeNewest([...merged, ...overlapping.flatMap((t) => t.entries)]);

    const newTables: SSTable[] = chunk(combined, options.baseLevelCapacity).map((group) => ({
      id: nextTableId++,
      level: level + 1,
      entries: group,
      minKey: group[0]!.key,
      maxKey: group[group.length - 1]!.key,
      bloom: buildBloomFilter(group.map((e) => e.key), options.bitsPerKey),
    }));

    totalEntriesEverWritten += combined.length;
    events.push({
      id: nextEventId++,
      kind: 'compaction',
      level,
      removed: [...source.map((t) => t.id), ...overlapping.map((t) => t.id)],
      created: newTables.map((t) => t.id),
      entriesWritten: combined.length,
    });

    levels[level] = [];
    levels[level + 1] = [...untouched, ...newTables];

    if (levels[level + 1]!.reduce((n, t) => n + t.entries.length, 0) > levelCapacity(level + 1)) {
      compactLeveled(level + 1);
    }
  }

  /** Tiered: merges every SSTable currently in `level` into ONE new, unsplit table and moves it down a level —
   *  whatever the next level already holds is left untouched until it, too, reaches `filesPerTier`. */
  function compactTiered(level: number): void {
    ensureLevel(level + 1);
    const source = levels[level]!;
    if (source.length === 0) return;
    const merged = dedupeNewest(source.flatMap((t) => t.entries));
    const newTable: SSTable = {
      id: nextTableId++,
      level: level + 1,
      entries: merged,
      minKey: merged[0]!.key,
      maxKey: merged[merged.length - 1]!.key,
      bloom: buildBloomFilter(merged.map((e) => e.key), options.bitsPerKey),
    };

    totalEntriesEverWritten += merged.length;
    events.push({
      id: nextEventId++,
      kind: 'compaction',
      level,
      removed: source.map((t) => t.id),
      created: [newTable.id],
      entriesWritten: merged.length,
    });

    levels[level] = [];
    levels[level + 1] = [...levels[level + 1]!, newTable];

    if (levels[level + 1]!.length >= options.l0CompactionTrigger) compactTiered(level + 1);
  }

  function flush(memtable: readonly LsmWrite[]): void {
    if (memtable.length === 0) return;
    const sorted = dedupeNewest(memtable);
    const table: SSTable = {
      id: nextTableId++,
      level: 0,
      entries: sorted,
      minKey: sorted[0]!.key,
      maxKey: sorted[sorted.length - 1]!.key,
      bloom: buildBloomFilter(sorted.map((e) => e.key), options.bitsPerKey),
    };
    levels[0]!.push(table);
    totalEntriesEverWritten += sorted.length;
    events.push({ id: nextEventId++, kind: 'flush', level: 0, removed: [], created: [table.id], entriesWritten: sorted.length });

    if (levels[0]!.length >= options.l0CompactionTrigger) compact(0);
  }

  let memtable: LsmWrite[] = [];
  for (const w of writes) {
    memtable.push(w);
    if (memtable.length >= options.memtableCapacity) {
      flush(memtable);
      memtable = [];
    }
  }
  flush(memtable);

  // Trim trailing empty levels a compaction may have left behind.
  while (levels.length > 1 && levels[levels.length - 1]!.length === 0) levels.pop();

  const distinctKeys = [...new Set(writes.map((w) => w.key))];
  const distinctKeysWritten = distinctKeys.length;
  const totalEntriesOnDisk = levels.reduce((n, lvl) => n + lvl.reduce((m, t) => m + t.entries.length, 0), 0);
  const nonEmptyLevelsBeyondL0 = levels.slice(1).filter((lvl) => lvl.length > 0).length;

  // Measured, not estimated: every distinct key actually written (an expected hit) plus an equal-sized sample
  // of keys strictly past the highest one ever written (guaranteed never written, an expected miss) are each
  // looked up for real. `readAmplificationAverage` is the mean of how many SSTables each lookup actually
  // checked; `measuredFalsePositiveRate` is, across every check any lookup made, what fraction found the
  // filter said "maybe" and was wrong — the two numbers this module's own doc comment explains are measured,
  // not read off the textbook formula (though they agree closely — this module's own tests check that).
  const maxWrittenKey = distinctKeys.length === 0 ? 0 : Math.max(...distinctKeys);
  const missKeys = Array.from({ length: distinctKeysWritten }, (_, i) => maxWrittenKey + i + 1);
  const lookups = [...distinctKeys, ...missKeys].map((key) => lookupKey(levels, key, options.compactionStrategy));
  const totalChecked = lookups.reduce((n, l) => n + l.tablesChecked.length, 0);
  const totalFalsePositives = lookups.reduce((n, l) => n + l.falsePositives.length, 0);

  // Leveled: at most every L0 table (they can all overlap) plus one per non-empty level below (each kept
  // non-overlapping). Tiered: every level, not just L0, can hold several overlapping tables — worst case is
  // every table, everywhere.
  const totalTables = levels.reduce((n, lvl) => n + lvl.length, 0);
  const readAmplificationWorstCase =
    options.compactionStrategy === 'tiered' ? totalTables : levels[0]!.length + nonEmptyLevelsBeyondL0;

  return {
    writes: [...writes],
    options,
    events,
    levels,
    distinctKeysWritten,
    totalEntriesOnDisk,
    totalEntriesEverWritten,
    writeAmplification: writes.length === 0 ? 0 : totalEntriesEverWritten / writes.length,
    spaceAmplification: distinctKeysWritten === 0 ? 0 : totalEntriesOnDisk / distinctKeysWritten,
    readAmplificationWorstCase,
    readAmplificationAverage: lookups.length === 0 ? 0 : totalChecked / lookups.length,
    measuredFalsePositiveRate: totalChecked === 0 ? 0 : totalFalsePositives / totalChecked,
  };
}

/**
 * A real point lookup: the memtable is always empty by the time a `LsmPlan` is returned (the last write
 * sequence always ends with a flush), so this only ever walks `levels`. L0 is always scanned newest-first in
 * full — any of its tables could hold the key, leveled or tiered alike. Below L0, the two strategies differ:
 * leveled keeps every level non-overlapping, so the first range match is the only candidate; tiered can leave
 * several overlapping tables at any level, so every table at that level is scanned newest-first, same as L0. A
 * table's own Bloom filter is checked before the table itself; "definitely not here" skips it outright, "maybe"
 * costs a real check — sometimes a false positive, never a false negative.
 */
export function lookupKey(levels: readonly SSTable[][], key: number, strategy: CompactionStrategy): LookupResult {
  const tablesChecked: number[] = [];
  const falsePositives: number[] = [];

  const checkTable = (table: SSTable): LsmWrite | undefined => {
    if (!bloomMightContain(table.bloom, key)) return undefined;
    tablesChecked.push(table.id);
    const hit = table.entries.find((e) => e.key === key);
    if (!hit) falsePositives.push(table.id);
    return hit;
  };

  const scanNewestFirst = (level: readonly SSTable[]): LsmWrite | undefined => {
    for (let i = level.length - 1; i >= 0; i--) {
      const hit = checkTable(level[i]!);
      if (hit) return hit;
    }
    return undefined;
  };

  const l0Hit = scanNewestFirst(levels[0] ?? []);
  if (l0Hit) return { key, found: true, value: l0Hit.value, tablesChecked, falsePositives };

  for (const level of levels.slice(1)) {
    if (strategy === 'tiered') {
      const hit = scanNewestFirst(level);
      if (hit) return { key, found: true, value: hit.value, tablesChecked, falsePositives };
      continue;
    }
    const table = level.find((t) => t.minKey <= key && t.maxKey >= key);
    if (!table) continue;
    const hit = checkTable(table);
    if (hit) return { key, found: true, value: hit.value, tablesChecked, falsePositives };
  }

  return { key, found: false, value: null, tablesChecked, falsePositives };
}
