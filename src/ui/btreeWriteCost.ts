import { createTree, height, insert } from '../engine/index.ts';
import type { BPlusTree } from '../engine/index.ts';
import type { LsmWrite } from './lsm.ts';

/**
 * plan.md §25.4 F1's closing piece: `/compare`'s B+Tree-vs-LSM mode needs amplification numbers "from real
 * counters" on BOTH sides, the same honesty `src/ui/lsm.ts` already holds itself to. The LSM side already has
 * one (`planLsm`'s own `writeAmplification`); this gives the B+Tree side the equivalent, driving the REAL engine
 * B+Tree (`engine/index/btree.ts`'s `createTree`/`insert`/`height` — the one `/tools/*` sandbox precedent for
 * reusing real code, `/tools/btree`, extended here to a second use) with the exact same write sequence
 * `demoWrites()` already generates for the LSM side, so both structures answer for identical writes.
 *
 * **The B+Tree's own write cost, measured the same way LSM's is**: every `insert` touches at least the one
 * leaf it writes into — a plain update to an already-present key touches only that leaf, no restructuring — and
 * touches more only when a split cascades upward (a new leaf, a rewritten parent, sometimes further up still).
 * `writeAmplification` here is the average number of index PAGES touched per logical write — not, as `lsm.ts`'s
 * own counter is, the number of raw ENTRIES physically rewritten. That unit difference is not an inconsistency
 * to paper over: it is the actual, structural contrast between the two designs. A B+Tree updates in place, so
 * its cost is counted in whole pages touched; an LSM tree defers writes and rewrites raw entries wholesale
 * during compaction, so its cost is counted in entries. **Never a false equivalence**: comparing the two
 * numbers side by side shows *why* they're measured in different units, which is itself the lesson.
 *
 * Measured, not estimated, the same way: nodes are snapshotted (by id, serialized) immediately before each
 * `insert`, then diffed against the tree's own `nodes` map afterward — any id that is new, or whose serialized
 * content changed, was a real write for that one logical write. This needed no new B+Tree instrumentation; the
 * tree's own `nodes: Record<string, BTreeNode>` map is already the full, authoritative state.
 *
 * `readCost` is a point lookup's own worst case — `height(tree)`, the number of pages a root-to-leaf descent
 * always touches, exactly as real as `descend()`'s own path length anywhere else in this codebase.
 *
 * Because at least the leaf is always touched, `writeAmplification` can never measure below 1 here — the
 * direct, measured contrast with `lsm.ts`'s own genuinely-below-1 finding (in-memtable coalescing of a repeat
 * write before it is ever flushed). A B+Tree has no equivalent buffering stage to coalesce into.
 */

export interface BTreeWritePlan {
  writes: number;
  maxKeys: number;
  finalHeight: number;
  finalNodeCount: number;
  /** Every index page any insert actually rewrote, summed across the whole write sequence. */
  totalNodeWrites: number;
  /** `totalNodeWrites ÷ writes` — pages touched per logical write, on average. Never below 1 (see module doc). */
  writeAmplification: number;
  /** A point lookup's own worst case: `height(tree)`, the pages a root-to-leaf descent always touches. */
  readCost: number;
}

function snapshotNodeContents(tree: BPlusTree): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [id, node] of Object.entries(tree.nodes)) snapshot.set(id, JSON.stringify(node));
  return snapshot;
}

function countChangedNodes(before: ReadonlyMap<string, string>, tree: BPlusTree): number {
  let changed = 0;
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (before.get(id) !== JSON.stringify(node)) changed++;
  }
  return changed;
}

export function planBTreeWrites(writes: readonly LsmWrite[], maxKeys: number): BTreeWritePlan {
  const tree = createTree(maxKeys, 0);
  let totalNodeWrites = 0;

  for (const w of writes) {
    const before = snapshotNodeContents(tree);
    insert(tree, w.key, { pageId: w.seq, slot: 0 });
    totalNodeWrites += countChangedNodes(before, tree);
  }

  return {
    writes: writes.length,
    maxKeys,
    finalHeight: height(tree),
    finalNodeCount: Object.keys(tree.nodes).length,
    totalNodeWrites,
    writeAmplification: writes.length === 0 ? 0 : totalNodeWrites / writes.length,
    readCost: height(tree),
  };
}
