/**
 * Partitioning a table over nodes (plan.md §27.5 X1): which node each row lives on under **hash**, **range** and
 * **consistent hashing** — and what adding a node or taking one away costs, counted in rows that have to move.
 *
 * - **Hash**: a row goes to node `hash(key) mod n` of the `n` nodes in the cluster. Even, and stateless — and change `n`
 *   and nearly every row's remainder changes with it.
 * - **Range**: the key space cut into one contiguous range per node, equal in rows when the table was split. A node
 *   that joins takes the upper half of the fullest range; one that leaves hands its range to a neighbour — so only
 *   those rows move. But the newest keys all fall in the last range: inserts in key order pile onto one node.
 * - **Consistent hashing**: every node is hashed onto a ring at `v` points (its virtual nodes), and a row goes to the
 *   first point clockwise from its key's hash. A node that joins takes only the arcs before its points; one that leaves
 *   gives its arcs to the next points round. More virtual nodes, a more even share.
 *
 * Pure and deterministic: the hash is FNV-1a over the key's text, the same everywhere, so a placement is a function of
 * its inputs. Nothing here is a network; a node is a number.
 */

import type { Row, SqlValue } from './types.ts';
import { compareValues } from './value.ts';

export type PartitionScheme = 'hash' | 'range' | 'consistent';
export const PARTITION_SCHEMES: readonly PartitionScheme[] = ['hash', 'range', 'consistent'];
export const PARTITION_LIMITS = { minNodes: 2, maxNodes: 10, minVirtual: 1, maxVirtual: 64 } as const;

export type ClusterChange = { kind: 'none' } | { kind: 'add' } | { kind: 'remove'; node: number };

export interface PartitionOptions {
  scheme: PartitionScheme;
  nodes: number;
  /** Points on the ring per node, for consistent hashing. */
  virtualNodes: number;
  change: ClusterChange;
}

/** Where the rows are, on a cluster of named nodes. */
export interface Placement {
  /** The nodes, by name (1, 2, …), in the order the scheme lists them. */
  nodes: number[];
  /** The node each row is on, in table order. */
  rowNode: number[];
  /** Rows per node, in `nodes`' order. */
  counts: number[];
  /** The fullest node's rows over the average: 1 is perfectly even. */
  skew: number;
  /** For range partitioning: each node's range of keys, `[low, high)`, `null` meaning open. */
  ranges?: { node: number; low: SqlValue; high: SqlValue }[];
  /** For consistent hashing: every point on the ring, in ring order, as a fraction of the way round. */
  ring?: { node: number; at: number }[];
}

export interface PartitionResult {
  before: Placement;
  after: Placement | null;
  /** Rows on a different node after the change. */
  moved: number;
  /**
   * What a change has to move at the least: when a node leaves, every row it held; when one joins, its fair share,
   * a table's rows over the new number of nodes — move fewer, and the newcomer is left under-loaded.
   */
  minimum: number;
  /** Where the next `inserts` rows, keys after the last, would land — before the change. */
  inserts: { rows: number; counts: number[] };
}

/**
 * FNV-1a over a value's text, then MurmurHash3's finalizer: a 32-bit unsigned hash. FNV-1a alone leaves short, alike
 * strings — `node-1#0`, `node-1#1`, `acct-01` — close together on the ring; the finalizer spreads every bit of the
 * input over every bit of the output, which is what a ring of points needs.
 */
export function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const keyText = (v: SqlValue): string => (typeof v === 'string' ? v : JSON.stringify(v));
const TWO32 = 2 ** 32;

function summarize(nodes: number[], rowNode: number[], extra: Partial<Placement> = {}): Placement {
  const counts = nodes.map((n) => rowNode.filter((x) => x === n).length);
  const mean = rowNode.length / Math.max(1, nodes.length);
  return { nodes, rowNode, counts, skew: mean === 0 ? 1 : Math.max(...counts) / mean, ...extra };
}

function hashPlace(keys: readonly SqlValue[], nodes: number[]): Placement {
  return summarize(nodes, keys.map((k) => nodes[fnv(keyText(k)) % nodes.length]!));
}

function ringOf(nodes: number[], virtualNodes: number): { node: number; h: number }[] {
  const points: { node: number; h: number }[] = [];
  for (const node of nodes) for (let v = 0; v < virtualNodes; v++) points.push({ node, h: fnv(`node-${String(node)}#${String(v)}`) });
  return points.sort((a, b) => a.h - b.h || a.node - b.node);
}

function consistentPlace(keys: readonly SqlValue[], nodes: number[], virtualNodes: number): Placement {
  const ring = ringOf(nodes, virtualNodes);
  const owner = (h: number): number => {
    // The first point at or after h, wrapping round.
    let lo = 0;
    let hi = ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ring[mid]!.h < h) lo = mid + 1;
      else hi = mid;
    }
    return ring[lo % ring.length]!.node;
  };
  return summarize(nodes, keys.map((k) => owner(fnv(keyText(k)))), { ring: ring.map((p) => ({ node: p.node, at: p.h / TWO32 })) });
}

type Range = { node: number; low: SqlValue; high: SqlValue };

/** Equal-depth ranges: one per node, each the same number of rows when cut, by key order. */
function initialRanges(keys: readonly SqlValue[], nodes: number[]): Range[] {
  const sorted = [...keys].sort(compareValues);
  return nodes.map((node, i) => ({
    node,
    low: i === 0 ? null : sorted[Math.floor((i * sorted.length) / nodes.length)] ?? null,
    high: i === nodes.length - 1 ? null : sorted[Math.floor(((i + 1) * sorted.length) / nodes.length)] ?? null,
  }));
}

const inRange = (k: SqlValue, r: Range) => (r.low === null || compareValues(k, r.low) >= 0) && (r.high === null || compareValues(k, r.high) < 0);

function rangePlace(keys: readonly SqlValue[], ranges: Range[]): Placement {
  const rowNode = keys.map((k) => (ranges.find((r) => inRange(k, r)) ?? ranges.at(-1)!).node);
  return summarize(ranges.map((r) => r.node), rowNode, { ranges: ranges.map((r) => ({ ...r })) });
}

/** A new node takes the upper half of the fullest range, cut at its median key. */
function splitFullest(keys: readonly SqlValue[], ranges: Range[], newNode: number): Range[] {
  const sizes = ranges.map((r) => keys.filter((k) => inRange(k, r)).length);
  const at = sizes.indexOf(Math.max(...sizes));
  const r = ranges[at]!;
  const inside = keys.filter((k) => inRange(k, r)).sort(compareValues);
  const cut = inside[Math.floor(inside.length / 2)] ?? r.low;
  // A range of one key cannot be split: the new node gets an empty range above it.
  const lower: Range = { node: r.node, low: r.low, high: cut };
  const upper: Range = { node: newNode, low: cut, high: r.high };
  return [...ranges.slice(0, at), lower, upper, ...ranges.slice(at + 1)];
}

/** A leaving node's range goes to its neighbour — the one after it, or before it when it was last. */
function mergeAway(ranges: Range[], node: number): Range[] {
  const at = ranges.findIndex((r) => r.node === node);
  if (at < 0 || ranges.length < 2) return ranges;
  const gone = ranges[at]!;
  if (at < ranges.length - 1) {
    const next = ranges[at + 1]!;
    return [...ranges.slice(0, at), { node: next.node, low: gone.low, high: next.high }, ...ranges.slice(at + 2)];
  }
  const prev = ranges[at - 1]!;
  return [...ranges.slice(0, at - 1), { node: prev.node, low: prev.low, high: gone.high }];
}

/**
 * Places `rows` by their `key` under `options`, applies the change if there is one, and counts what moved. The keys
 * that follow the last — for `inserts` — are the next `id`s (or, for any other key, the existing keys again, in order).
 */
export function partition(rows: readonly Row[], key: string, options: PartitionOptions, inserts = 300): PartitionResult {
  const n = Math.max(PARTITION_LIMITS.minNodes, Math.min(PARTITION_LIMITS.maxNodes, Math.floor(options.nodes)));
  const v = Math.max(PARTITION_LIMITS.minVirtual, Math.min(PARTITION_LIMITS.maxVirtual, Math.floor(options.virtualNodes)));
  const keys = rows.map((r) => r[key] ?? null);
  const nodes = Array.from({ length: n }, (_, i) => i + 1);

  const place = (live: number[], ranges?: Range[]): Placement =>
    options.scheme === 'hash' ? hashPlace(keys, live) : options.scheme === 'consistent' ? consistentPlace(keys, live, v) : rangePlace(keys, ranges!);
  const startRanges = options.scheme === 'range' ? initialRanges(keys, nodes) : undefined;
  const before = place(nodes, startRanges);

  // The next keys after the last: for a numeric key, counting on from the largest.
  const numeric = keys.every((k) => typeof k === 'number');
  const top = numeric ? Math.max(...(keys)) : 0;
  const nextKeys: SqlValue[] = Array.from({ length: inserts }, (_, i) => (numeric ? top + i + 1 : keys[i % Math.max(1, keys.length)] ?? null));
  const insertNode =
    options.scheme === 'hash'
      ? nextKeys.map((k) => nodes[fnv(keyText(k)) % nodes.length]!)
      : options.scheme === 'consistent'
        ? consistentPlaceKeys(nextKeys, nodes, v)
        : nextKeys.map((k) => (startRanges!.find((r) => inRange(k, r)) ?? startRanges!.at(-1)!).node);
  const insertCounts = nodes.map((node) => insertNode.filter((x) => x === node).length);

  if (options.change.kind === 'none') {
    return { before, after: null, moved: 0, minimum: 0, inserts: { rows: inserts, counts: insertCounts } };
  }
  let live: number[];
  let ranges: Range[] | undefined;
  let minimum: number;
  if (options.change.kind === 'add') {
    const joining = n + 1;
    live = [...nodes, joining];
    ranges = startRanges ? splitFullest(keys, startRanges, joining) : undefined;
    minimum = Math.round(rows.length / live.length);
  } else {
    const leaving = Math.max(1, Math.min(n, Math.floor(options.change.node)));
    live = nodes.filter((x) => x !== leaving);
    ranges = startRanges ? mergeAway(startRanges, leaving) : undefined;
    minimum = before.counts[nodes.indexOf(leaving)] ?? 0;
  }
  const after = place(live, ranges);
  const moved = before.rowNode.filter((node, i) => after.rowNode[i] !== node).length;
  return { before, after, moved, minimum, inserts: { rows: inserts, counts: insertCounts } };
}

function consistentPlaceKeys(keys: readonly SqlValue[], nodes: number[], v: number): number[] {
  return consistentPlace(keys, nodes, v).rowNode;
}
