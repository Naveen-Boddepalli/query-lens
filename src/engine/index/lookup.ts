/**
 * A point lookup, narrated. Each node on the root-to-leaf path is fetched
 * through the buffer pool first — index pages are pages, so a traversal costs
 * real reads and shows up in the frame grid alongside the heap.
 *
 * On a table's index the value may repeat (plan.md §25.4 B3): the lookup
 * descends toward the *first* entry with that value, then reads along the leaf
 * for as long as the value holds, hopping to the next leaf only when the run
 * reaches the end of one *and* the leaf's high key says the value continues.
 * A unique value is the same walk that happens to stop after one entry.
 */

import type { Emit } from '../trace.ts';
import type { SqlValue } from '../types.ts';
import type { BufferPool } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import { childIndexFor, compareKeys, descend, height, highKey, lowerBound, node, probe, valuesOf } from './btree.ts';
import type { BPlusTree, IndexKey, LeafNode, RowPointer } from './btree.ts';
import { keyList, toIndexDisplay } from './display.ts';
import { traversalPrompt } from '../predict.ts';

export interface LookupOutcome {
  /** The first match — the one `touchHeap` fetched — or `null` when the value is not in the index. */
  pointer: RowPointer | null;
  /** Every match, in index order: one for a unique value, one per row for a repeated one. */
  pointers: RowPointer[];
  /** Pages the traversal touched, root first. */
  pagesRead: number[];
}

function describe(key: SqlValue): string {
  return typeof key === 'string' ? `'${key}'` : String(key);
}

/** The first indexed value of an entry — a separator or a leaf key, as a plain value. */
const leadingValue = (key: IndexKey): SqlValue => valuesOf(key)[0]!;

export function emitIndexLookup(
  emit: Emit,
  tree: BPlusTree,
  key: SqlValue,
  pool: BufferPool,
  column: string,
  locks: LockManager,
  /**
   * Every existing caller wants the row, so this defaults to `true`. An
   * index-only scan (plan.md §22.2) passes `false`: the leaf already holds
   * everything the query needs, so fetching and locking the heap page the
   * pointer names would be pure theatre — real disk I/O the query never
   * actually required, which is exactly the discount §12 rules out claiming.
   *
   * With `true`, only the *first* match's heap page is fetched here; the caller
   * fetches each later one as it pulls that row, so a `LIMIT` that stops early
   * never pays for the rest.
   */
  touchHeap = true,
): LookupOutcome {
  emit(
    `Open the B+Tree on \`${column}\`: ${height(tree)} levels, so any key is at most ${height(tree)} node reads away — however many rows the table holds.`,
    { stage: 'index', action: 'open', tree: toIndexDisplay(tree), nodeId: tree.rootId, height: height(tree) },
  );

  // A table's index orders entries by (value, row address); the lowest entry that could carry this value is what
  // the descent aims for. A sandbox tree just holds the value.
  const target: IndexKey = tree.tiebreak ? probe([key], 'low') : key;
  const path = descend(tree, target);
  const pagesRead: number[] = [];
  let parentPage: number | null = null;
  // Ask once, at the first branch. Asking at every level is repetition, not
  // practice — the rule is the same each time.
  let traversalAsked = false;

  for (const nodeId of path) {
    const n = node(tree, nodeId);

    /**
     * Latch crabbing: take the child's lock *before* releasing the parent's,
     * so the subtree cannot be restructured out from under the descent. For a
     * moment two locks are held at once — that overlap is the whole technique.
     */
    locks.acquire(
      n.pageId,
      'shared',
      parentPage === null
        ? `Lock the root page ${String(n.pageId)} before reading it.`
        : `Lock child page ${String(n.pageId)} before letting go of page ${String(parentPage)} — "crabbing" down the tree, so the branch cannot move while we are following it.`,
    );

    const fetched = pool.fetch(n.pageId);
    if (fetched) {
      pagesRead.push(n.pageId);
      pool.unpin(fetched.frameId);
    }

    if (parentPage !== null) {
      locks.release(
        parentPage,
        'shared',
        `Now that page ${String(n.pageId)} is locked, page ${String(parentPage)} can be released. The descent never holds the whole path at once.`,
      );
    }
    parentPage = n.pageId;

    if (n.kind === 'internal') {
      const internal = n;
      const childIndex = childIndexFor(internal, target);
      const separators = internal.keys.map(leadingValue);
      // Equal values can sit on both sides of a separator, so a separator that *is* this value sends the search left of it.
      const straddles = tree.tiebreak === true && childIndex < separators.length && compareKeys(separators[childIndex]!, key) === 0;
      emit(
        `Node ${nodeId} separates on ${keyList(internal.keys)}. ${
          straddles
            ? `${describe(key)} equals a separator, and a run of equal values can straddle one — so go left of it, to child ${childIndex}, to reach the first ${describe(key)} there is.`
            : `${describe(key)} ${
                childIndex === 0
                  ? `is below ${describe(separators[0]!)}`
                  : childIndex === separators.length
                    ? `is at or above ${describe(separators[separators.length - 1]!)}`
                    : `falls between ${describe(separators[childIndex - 1]!)} and ${describe(separators[childIndex]!)}`
              }, so follow child ${childIndex}.`
        }`,
        { stage: 'index', action: 'traverse', nodeId, key, childIndex },
        traversalAsked || straddles
          ? undefined
          : (() => {
              traversalAsked = true;
              const prompt = traversalPrompt(nodeId, separators, key, childIndex);
              return prompt ? { predictable: prompt } : undefined;
            })(),
      );
    } else {
      emit(`Reach leaf ${nodeId}, which holds keys ${keyList(n.keys)}.`, {
        stage: 'index',
        action: 'traverse',
        nodeId,
        key,
      });
    }
  }

  let leaf = node(tree, path[path.length - 1]!) as LeafNode;
  const pointers: RowPointer[] = [];
  let foundLeaf = leaf.id;

  if (tree.tiebreak) {
    // Read along the leaves while the value holds. A hop is taken only when the run reached the end of a leaf and the
    // leaf's high key (its parent's separator) is this value too — otherwise the next leaf starts above it.
    let at = lowerBound(leaf.keys, target);
    for (;;) {
      while (at < leaf.keys.length && compareKeys(leadingValue(leaf.keys[at]!), key) === 0) {
        if (pointers.length === 0) foundLeaf = leaf.id;
        pointers.push(leaf.pointers[at]!);
        at += 1;
      }
      if (at < leaf.keys.length || leaf.next === null) break;
      const high = highKey(tree, leaf);
      if (high === null || compareKeys(leadingValue(high), key) !== 0) break;

      const next = node(tree, leaf.next) as LeafNode;
      emit(
        `Leaf ${leaf.id} ends, and its high key is ${describe(key)} too — more entries for it continue in the next leaf. Follow the sibling pointer to leaf ${next.id}.`,
        { stage: 'index', action: 'chain-next', fromNodeId: leaf.id, toNodeId: next.id },
      );
      locks.acquire(
        next.pageId,
        'shared',
        `Lock the sibling leaf, page ${String(next.pageId)}, before letting go of page ${String(leaf.pageId)}.`,
      );
      const hopped = pool.fetch(next.pageId);
      if (hopped) {
        pagesRead.push(next.pageId);
        pool.unpin(hopped.frameId);
      }
      locks.release(leaf.pageId, 'shared');
      parentPage = next.pageId;
      leaf = next;
      at = 0;
    }
  } else {
    const at = leaf.keys.findIndex((k) => compareKeys(k, key) === 0);
    if (at !== -1) pointers.push(leaf.pointers[at]!);
  }

  const pointer = pointers[0];
  if (pointer === undefined) {
    emit(`${describe(key)} is not in this leaf, so it is not in the table at all — the search stops here.`, {
      stage: 'index',
      action: 'not-found',
      nodeId: leaf.id,
      key,
    });
    if (parentPage !== null) locks.release(parentPage, 'shared');
    return { pointer: null, pointers, pagesRead };
  }

  const also =
    pointers.length > 1
      ? ` ${String(pointers.length - 1)} more ${pointers.length === 2 ? 'entry' : 'entries'} for the same value follow it — a non-unique index keeps one entry per row, ordered by where the row lives, so a repeated value is ${String(pointers.length)} pointers, not one.`
      : '';
  emit(
    touchHeap
      ? `Found ${describe(key)}. The leaf stores a pointer to the row, not the row itself: heap page ${pointer.pageId}, slot ${pointer.slot}.${also}`
      : `Found ${describe(key)}. This query only needs \`${column}\` itself, which the leaf already holds — the heap page the pointer names is never read.${also}`,
    { stage: 'index', action: 'found', nodeId: foundLeaf, key },
  );

  if (touchHeap) {
    locks.acquire(
      pointer.pageId,
      'shared',
      `Lock heap page ${String(pointer.pageId)}, where the row itself lives.`,
    );

    const heapFetch = pool.fetch(pointer.pageId);
    if (heapFetch) {
      pagesRead.push(pointer.pageId);
      pool.unpin(heapFetch.frameId);
    }

    locks.release(pointer.pageId, 'shared');
  }

  if (parentPage !== null) locks.release(parentPage, 'shared');

  return { pointer, pointers, pagesRead };
}
