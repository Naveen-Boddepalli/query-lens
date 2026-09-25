/**
 * A range scan, narrated. `emitRangeStart` descends the B+Tree once, the same
 * crabbing-locks pattern `lookup.ts`'s point lookup uses, to find the leaf a
 * range's lower bound would start at (or the leftmost leaf, with no lower
 * bound) — the vertical half of plan.md §23.1's leaf-chaining range scan.
 * `nextInRange` is the horizontal half: it walks forward from a position
 * inside that leaf, across `next` sibling pointers as leaves run out, one
 * matching key at a time — so the executor can pull rows through the buffer
 * pool exactly as lazily as every other operator does, rather than
 * materialising the whole range up front.
 */

import type { Emit } from '../trace.ts';
import type { SqlValue } from '../types.ts';
import type { BufferPool } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import {
  childIndexFor,
  compareKeys,
  descend,
  height,
  isEntry,
  leftmostPath,
  lowerBound,
  node,
  probe,
} from './btree.ts';
import type { BPlusTree, IndexKey, LeafNode, RowPointer } from './btree.ts';
import { keyList, toIndexDisplay } from './display.ts';

export interface RangeBoundValue {
  value: SqlValue;
  inclusive: boolean;
}

export interface RangeStart {
  /** The leaf to start reading from — the tree always has at least a root leaf, even when empty. */
  leafId: string;
  /** Index of the first key in that leaf the range actually includes. */
  startIndex: number;
}

export interface RangeMatch {
  key: IndexKey;
  pointer: RowPointer;
  /** Cursor position for the *next* call: the leaf the match came from, and the index right after it. */
  leafId: string;
  nextIndex: number;
}

function describe(key: SqlValue): string {
  return typeof key === 'string' ? `'${key}'` : String(key);
}

function withinHigh(key: IndexKey, high: RangeBoundValue | undefined): boolean {
  if (!high) return true;
  // An entry carries its row address as well as its value, so it is never *equal* to a bare bound. Instead the bound
  // becomes a probe: just after every entry with this value (an inclusive `<=`) or just before them all (`<`).
  if (isEntry(key)) return compareKeys(key, probe([high.value], high.inclusive ? 'high' : 'low')) < 0;
  const c = compareKeys(key, high.value);
  return high.inclusive ? c <= 0 : c < 0;
}

/**
 * Descends to the range's starting leaf and narrates it. Unlike a point
 * lookup there is no found/not-found here — the boundary itself is the
 * answer, not a specific key, so `startIndex` may land one past the leaf's
 * last key (an empty range) without that being an error.
 */
export function emitRangeStart(
  emit: Emit,
  tree: BPlusTree,
  column: string,
  low: RangeBoundValue | undefined,
  pool: BufferPool,
  locks: LockManager,
): RangeStart {
  const h = height(tree);
  emit(
    `Open the B+Tree on \`${column}\`: ${String(h)} level${h === 1 ? '' : 's'}. ${
      low
        ? `Descend once toward ${describe(low.value)} — not to find that exact key, but to find where the range begins.`
        : "This range has no lower bound, so descend to the tree's leftmost leaf instead."
    }`,
    { stage: 'index', action: 'open', tree: toIndexDisplay(tree), nodeId: tree.rootId, height: h },
  );

  // On a table's index an inclusive `>= v` starts at the first entry *for* v; an exclusive `> v` starts just past the last.
  const target: IndexKey | undefined = low
    ? tree.tiebreak
      ? probe([low.value], low.inclusive ? 'low' : 'high')
      : low.value
    : undefined;
  const path = target !== undefined ? descend(tree, target) : leftmostPath(tree);
  let parentPage: number | null = null;

  for (const nodeId of path) {
    const n = node(tree, nodeId);

    locks.acquire(
      n.pageId,
      'shared',
      parentPage === null
        ? `Lock the root page ${String(n.pageId)} before reading it.`
        : `Lock child page ${String(n.pageId)} before letting go of page ${String(parentPage)} — "crabbing" down the tree, so the branch cannot move while we are following it.`,
    );

    const fetched = pool.fetch(n.pageId);
    if (fetched) pool.unpin(fetched.frameId);

    if (parentPage !== null) {
      locks.release(
        parentPage,
        'shared',
        `Now that page ${String(n.pageId)} is locked, page ${String(parentPage)} can be released.`,
      );
    }
    parentPage = n.pageId;

    if (n.kind === 'internal') {
      const childIndex = target !== undefined ? childIndexFor(n, target) : 0;
      emit(
        `Node ${nodeId} separates on ${keyList(n.keys)}. ${
          low
            ? `${describe(low.value)} routes to child ${String(childIndex)}.`
            : 'With no lower bound, follow the leftmost child.'
        }`,
        { stage: 'index', action: 'traverse', nodeId, ...(low ? { key: low.value } : {}), childIndex },
      );
    } else {
      emit(`Reach leaf ${nodeId}, which holds keys ${keyList(n.keys)} — the scan starts here.`, {
        stage: 'index',
        action: 'traverse',
        nodeId,
        ...(low ? { key: low.value } : {}),
      });
    }
  }

  if (parentPage !== null) locks.release(parentPage, 'shared');

  const leafId = path[path.length - 1]!;
  const leaf = node(tree, leafId) as LeafNode;
  const at = target !== undefined ? lowerBound(leaf.keys, target) : 0;
  // `lowerBound` finds the first key >= the target — exactly right for an
  // inclusive `>=` bound. In a sandbox tree an exclusive `>` on a key that
  // happens to be present has to skip one further, past the exact match; a
  // table's index already aimed at a probe just past the whole run.
  const startIndex =
    low && !low.inclusive && !tree.tiebreak && at < leaf.keys.length && compareKeys(leaf.keys[at]!, low.value) === 0
      ? at + 1
      : at;

  return { leafId, startIndex };
}

/** What a leaf hop reads through: the buffer pool and lock manager. Omitted only by tests that walk a bare tree. */
export interface ChainIO {
  pool: BufferPool;
  locks: LockManager;
}

/**
 * The next matching key from `(leafId, index)` onward, following sibling
 * pointers as leaves run out and narrating each hop. Returns `null` once the
 * chain ends or a key exceeds `high` — a sorted leaf chain means every key
 * past that point is out of range too, so the walk can stop rather than
 * checking the rest.
 *
 * Each hop *reads the sibling leaf through the buffer pool* (`io`): a leaf is a
 * page, and a range that spans ten of them costs ten reads — the same figure
 * the cost model prices (`extraLeaves`), so an `EXPLAIN ANALYZE` estimate and
 * its actual agree on how many leaves the walk touched.
 */
export function nextInRange(
  emit: Emit,
  tree: BPlusTree,
  leafId: string,
  index: number,
  high: RangeBoundValue | undefined,
  io?: ChainIO,
): RangeMatch | null {
  let currentLeafId: string | null = leafId;
  let currentIndex = index;

  for (;;) {
    if (currentLeafId === null) return null;
    const leaf = node(tree, currentLeafId) as LeafNode;

    if (currentIndex >= leaf.keys.length) {
      if (!leaf.next) return null;
      emit(`Leaf ${currentLeafId} is exhausted; follow its sibling pointer to leaf ${leaf.next}.`, {
        stage: 'index',
        action: 'chain-next',
        fromNodeId: currentLeafId,
        toNodeId: leaf.next,
      });
      if (io) {
        const sibling = node(tree, leaf.next);
        io.locks.acquire(sibling.pageId, 'shared', `Lock the sibling leaf, page ${String(sibling.pageId)}, to read it.`);
        const fetched = io.pool.fetch(sibling.pageId);
        if (fetched) io.pool.unpin(fetched.frameId);
        io.locks.release(sibling.pageId, 'shared');
      }
      currentLeafId = leaf.next;
      currentIndex = 0;
      continue;
    }

    const key = leaf.keys[currentIndex]!;
    if (!withinHigh(key, high)) return null;

    return {
      key,
      pointer: leaf.pointers[currentIndex]!,
      leafId: currentLeafId,
      nextIndex: currentIndex + 1,
    };
  }
}
