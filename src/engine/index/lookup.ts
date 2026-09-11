/**
 * A point lookup, narrated. Each node on the root-to-leaf path is fetched
 * through the buffer pool first — index pages are pages, so a traversal costs
 * real reads and shows up in the frame grid alongside the heap.
 */

import type { Emit } from '../trace.ts';
import type { SqlValue } from '../types.ts';
import type { BufferPool } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import { childIndexFor, compareKeys, descend, height, node } from './btree.ts';
import type { BPlusTree, LeafNode, RowPointer } from './btree.ts';
import { keyList, toIndexDisplay } from './display.ts';
import { traversalPrompt } from '../predict.ts';

export interface LookupOutcome {
  pointer: RowPointer | null;
  /** Pages the traversal touched, root first. */
  pagesRead: number[];
}

function describe(key: SqlValue): string {
  return typeof key === 'string' ? `'${key}'` : String(key);
}

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
   */
  touchHeap = true,
): LookupOutcome {
  emit(
    `Open the B+Tree on \`${column}\`: ${height(tree)} levels, so any key is at most ${height(tree)} node reads away — however many rows the table holds.`,
    { stage: 'index', action: 'open', tree: toIndexDisplay(tree), nodeId: tree.rootId, height: height(tree) },
  );

  const path = descend(tree, key);
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
      const childIndex = childIndexFor(internal, key);
      emit(
        `Node ${nodeId} separates on ${keyList(internal.keys)}. ${describe(key)} ${
          childIndex === 0
            ? `is below ${describe(internal.keys[0]!)}`
            : childIndex === internal.keys.length
              ? `is at or above ${describe(internal.keys[internal.keys.length - 1]!)}`
              : `falls between ${describe(internal.keys[childIndex - 1]!)} and ${describe(internal.keys[childIndex]!)}`
        }, so follow child ${childIndex}.`,
        { stage: 'index', action: 'traverse', nodeId, key, childIndex },
        traversalAsked
          ? undefined
          : (() => {
              traversalAsked = true;
              const prompt = traversalPrompt(nodeId, internal.keys, key, childIndex);
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

  const leaf = node(tree, path[path.length - 1]!) as LeafNode;
  const at = leaf.keys.findIndex((k) => compareKeys(k, key) === 0);

  if (at === -1) {
    emit(`${describe(key)} is not in this leaf, so it is not in the table at all — the search stops here.`, {
      stage: 'index',
      action: 'not-found',
      nodeId: leaf.id,
      key,
    });
    if (parentPage !== null) locks.release(parentPage, 'shared');
    return { pointer: null, pagesRead };
  }

  const pointer = leaf.pointers[at]!;
  emit(
    touchHeap
      ? `Found ${describe(key)}. The leaf stores a pointer to the row, not the row itself: heap page ${pointer.pageId}, slot ${pointer.slot}.`
      : `Found ${describe(key)}. This query only needs \`${column}\` itself, which the leaf already holds — the heap page the pointer names is never read.`,
    { stage: 'index', action: 'found', nodeId: leaf.id, key },
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

  return { pointer, pagesRead };
}
