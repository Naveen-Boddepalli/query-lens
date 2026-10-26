/**
 * Bulk-loading a B+Tree (plan.md §25.4 B3d) — the other way to build an index.
 *
 * `insert` builds one entry at a time, splitting a node whenever it overflows. Fed keys in ascending order that
 * leaves every left leaf a fixed fraction full — three keys of four at the default fan-out: a full leaf splits, and
 * nothing is ever inserted into its left half again.
 * A **bulk load** knows all the entries up front. It sorts them, packs them into leaves left to right up to a
 * **fill factor** — 100% leaves no room to grow, 70% leaves 30% free so the next inserts do not split at once — and
 * builds each level above from the one below, bottom-up, with no splits at all. It is how a database builds an index
 * over data that already exists (`CREATE INDEX`), and why that is much faster and yields a smaller, shallower tree
 * than inserting the rows one by one.
 *
 * The result is an ordinary tree — the same node shapes, the same invariants (`validate`), the same `insert` and
 * `deleteKey` afterwards. Only its *packing* differs, and packing is what decides the height and how many pages a
 * lookup reads.
 */

import { compareKeys, createTree, DEFAULT_MAX_KEYS } from './btree.ts';
import type { BPlusTree, IndexKey, InternalNode, LeafNode, RowPointer } from './btree.ts';

export interface BulkEntry {
  key: IndexKey;
  pointer: RowPointer;
}

/** How full each node is packed: a fraction of its capacity. Below one half a node would break the tree's minimum occupancy. */
export const MIN_FILL_FACTOR = 0.5;
export const DEFAULT_FILL_FACTOR = 1;

/** Splits `count` items into groups of about `size`, each at least `min` and at most `max` — the last group is the only one that can fall short, and is topped up from (or merged into) the one before. */
function groupSizes(count: number, size: number, min: number, max: number): number[] {
  const sizes: number[] = [];
  let left = count;
  while (left > 0) {
    const take = Math.min(size, left);
    sizes.push(take);
    left -= take;
  }
  const last = sizes.length - 1;
  if (last > 0 && sizes[last]! < min) {
    const together = sizes[last - 1]! + sizes[last]!;
    if (together <= max) {
      sizes.splice(last - 1, 2, together);
    } else {
      // Too many for one node, so share them: each gets at least `min` because together > max ≥ 2·min − 1.
      sizes[last - 1] = Math.ceil(together / 2);
      sizes[last] = together - sizes[last - 1]!;
    }
  }
  return sizes;
}

/**
 * Builds a tree over `entries` — sorted here, so callers need not — packing every node to `fillFactor`.
 * `tiebreak` says the keys are entry keys (a table's index) rather than plain values.
 */
export function bulkLoad(
  entries: readonly BulkEntry[],
  maxKeys = DEFAULT_MAX_KEYS,
  firstPageId = 0,
  fillFactor = DEFAULT_FILL_FACTOR,
  tiebreak = true,
): BPlusTree {
  const tree = createTree(maxKeys, firstPageId, tiebreak);
  const sorted = [...entries].sort((a, b) => compareKeys(a.key, b.key));
  const fill = Math.min(1, Math.max(MIN_FILL_FACTOR, fillFactor));

  // Everything fits in one leaf: the root, as `createTree` already made it.
  if (sorted.length <= maxKeys) {
    const root = tree.nodes[tree.rootId] as LeafNode;
    root.keys = sorted.map((e) => e.key);
    root.pointers = sorted.map((e) => e.pointer);
    return tree;
  }

  const nodes: Record<string, LeafNode | InternalNode> = {};
  let nextId = 0;
  let nextPage = firstPageId;
  const idFor = (): { id: string; pageId: number } => ({ id: `n${String(nextId++)}`, pageId: nextPage++ });

  // Leaves: as full as the fill factor allows, but never below the half-full floor.
  const minLeaf = Math.ceil(maxKeys / 2);
  const leafSize = Math.max(minLeaf, Math.floor(maxKeys * fill));
  let level: { id: string; min: IndexKey }[] = [];
  let cursor = 0;
  let previous: LeafNode | null = null;
  for (const size of groupSizes(sorted.length, leafSize, minLeaf, maxKeys)) {
    const chunk = sorted.slice(cursor, cursor + size);
    cursor += size;
    const leaf: LeafNode = {
      kind: 'leaf',
      ...idFor(),
      keys: chunk.map((e) => e.key),
      pointers: chunk.map((e) => e.pointer),
      next: null,
    };
    if (previous) previous.next = leaf.id;
    previous = leaf;
    nodes[leaf.id] = leaf;
    level.push({ id: leaf.id, min: leaf.keys[0]! });
  }

  // Each level above groups the one below into nodes of up to `maxKeys + 1` children, packed to the same fill factor.
  const minChildren = Math.ceil((maxKeys + 1) / 2);
  const childSize = Math.max(minChildren, Math.floor((maxKeys + 1) * fill));
  while (level.length > 1) {
    const above: { id: string; min: IndexKey }[] = [];
    let at = 0;
    for (const size of groupSizes(level.length, childSize, minChildren, maxKeys + 1)) {
      const group = level.slice(at, at + size);
      at += size;
      const internal: InternalNode = {
        kind: 'internal',
        ...idFor(),
        // A separator is the lowest key of the subtree to its right.
        keys: group.slice(1).map((child) => child.min),
        children: group.map((child) => child.id),
      };
      nodes[internal.id] = internal;
      above.push({ id: internal.id, min: group[0]!.min });
    }
    level = above;
  }

  return { ...tree, rootId: level[0]!.id, nodes, nextNodeId: nextId, nextPageId: nextPage };
}
