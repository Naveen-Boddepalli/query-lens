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
 *   - **Read amplification** (worst case, no Bloom filter yet — plan.md's own next slice) = the number of
 *     SSTables a point lookup might have to check: every L0 table (they can all overlap any key) plus one per
 *     non-empty level beyond L0 (each level's own tables never overlap each other, so at most one per level can
 *     hold a given key).
 */

export interface LsmWrite {
  key: number;
  value: number;
  /** Order written — breaks ties when the same key is written more than once. */
  seq: number;
}

export interface SSTable {
  id: number;
  level: number;
  /** Sorted by key, one entry per key — the newest write to reach this table, for any key it holds. */
  entries: LsmWrite[];
  minKey: number;
  maxKey: number;
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
};

export interface LsmOptions {
  memtableCapacity: number;
  l0CompactionTrigger: number;
  /** L1's own capacity, in entries. Every SSTable this model ever creates also holds at most this many. */
  baseLevelCapacity: number;
  levelSizeMultiplier: number;
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
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

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
    memtableCapacity: clamp(rawOptions.memtableCapacity, LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity),
    l0CompactionTrigger: clamp(rawOptions.l0CompactionTrigger, LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger),
    baseLevelCapacity: Math.max(1, Math.round(rawOptions.baseLevelCapacity)),
    levelSizeMultiplier: clamp(rawOptions.levelSizeMultiplier, LSM_LIMITS.minLevelSizeMultiplier, LSM_LIMITS.maxLevelSizeMultiplier),
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

  /** Merges every SSTable currently in `level` (plus whatever it overlaps in `level + 1`) down one level. */
  function compact(level: number): void {
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
      compact(level + 1);
    }
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

  const distinctKeysWritten = new Set(writes.map((w) => w.key)).size;
  const totalEntriesOnDisk = levels.reduce((n, lvl) => n + lvl.reduce((m, t) => m + t.entries.length, 0), 0);
  const nonEmptyLevelsBeyondL0 = levels.slice(1).filter((lvl) => lvl.length > 0).length;

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
    readAmplificationWorstCase: levels[0]!.length + nonEmptyLevelsBeyondL0,
  };
}
