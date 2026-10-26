/**
 * A point lookup, narrated. Each node on the root-to-leaf path is fetched
 * through the buffer pool first — index pages are pages, so a traversal costs
 * real reads and shows up in the frame grid alongside the heap.
 *
 * On a table's index the key may repeat (plan.md §25.4 B3): the lookup descends
 * toward the *first* entry with that key, then reads along the leaf for as
 * long as the key holds, hopping to the next leaf only when the run reaches the
 * end of one *and* the leaf's high key says the key continues. A unique key is
 * the same walk that happens to stop after one entry.
 *
 * On a composite index the lookup key may be a *leftmost prefix* — one value of
 * an index over two, say. An entry matches when its first columns equal the
 * prefix, so the run it reads is every entry that starts that way.
 */

import type { Emit } from '../trace.ts';
import type { SqlValue } from '../types.ts';
import type { BufferPool } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import {
  childIndexFor,
  compareKeys,
  descend,
  entryWidth,
  height,
  highKey,
  lowerBound,
  node,
  probe,
  valuesOf,
} from './btree.ts';
import type { BPlusTree, EntryKey, IndexKey, LeafNode, RowPointer } from './btree.ts';
import { keyList, toIndexDisplay } from './display.ts';
import { traversalPrompt } from '../predict.ts';

export interface LookupOutcome {
  /** The first match — the one `touchHeap` fetched — or `null` when the key is not in the index. */
  pointer: RowPointer | null;
  /** Every match, in index order: one for a unique key, one per row for a repeated one. */
  pointers: RowPointer[];
  /** Each match's full key — every indexed column's value — parallel to `pointers`; what a covering scan answers from. */
  entries: SqlValue[][];
  /** Pages the traversal touched, root first. */
  pagesRead: number[];
  /**
   * Set only on a clustered table's secondary index (plan.md §25.4 B3e), parallel to `pointers`: each match's
   * CLUSTERING key, since `pointers` here are unused sentinels — finding the row needs a second descent, through
   * the clustered index itself (`resolveClustered`), which the caller must do.
   */
  clusterKeys?: (readonly SqlValue[])[];
}

function describe(key: SqlValue): string {
  return typeof key === 'string' ? `'${key}'` : String(key);
}

/** A lookup key as text: `3`, or `(3, 'ada')` for a composite one. */
export function describeKeys(keys: readonly SqlValue[]): string {
  return keys.length === 1 ? describe(keys[0]!) : `(${keys.map(describe).join(', ')})`;
}

/** Does `key`'s leading values equal `keys`? — an entry (or a separator) that starts with the lookup prefix. */
function startsWith(key: IndexKey, keys: readonly SqlValue[]): boolean {
  const values = valuesOf(key);
  return keys.every((k, i) => i < values.length && compareKeys(values[i]!, k) === 0);
}

export function emitIndexLookup(
  emit: Emit,
  tree: BPlusTree,
  /** The key to find: one value for a plain index, or the leading values (a leftmost prefix) of a composite one. */
  keys: readonly SqlValue[],
  pool: BufferPool,
  /** The index's name — its column, or its columns joined — for the narration. */
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
  /** Replaces the "Found …" sentence when the lookup is not answering a query — a `UNIQUE` check's own words. */
  foundNote?: string,
): LookupOutcome {
  const label = describeKeys(keys);
  const wide = tree.tiebreak === true && entryWidth(tree) > 1;
  emit(
    `Open the B+Tree on \`${column}\`: ${height(tree)} levels, so any key is at most ${height(tree)} node reads away — however many rows the table holds.`,
    { stage: 'index', action: 'open', tree: toIndexDisplay(tree), nodeId: tree.rootId, height: height(tree) },
  );

  // A table's index orders entries by (values, row address); the lowest entry that could carry this key is what
  // the descent aims for. A sandbox tree just holds the value.
  const target: IndexKey = tree.tiebreak ? probe(keys, 'low') : keys[0]!;
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
      // Equal values can sit on both sides of a separator, so a separator that *starts with* this key sends the search left of it.
      const straddles = tree.tiebreak === true && childIndex < internal.keys.length && startsWith(internal.keys[childIndex]!, keys);
      // A plain index's separators are single values, which read as "below / between / at or above"; a composite
      // index's are tuples, and the sentence says where the search lands without pretending they are numbers.
      const where = wide
        ? `The first entry starting with ${label} can be no further left than child ${String(childIndex)}, so follow child ${String(childIndex)}.`
        : (() => {
            const separators = internal.keys.map((k) => valuesOf(k)[0]!);
            return `${label} ${
              childIndex === 0
                ? `is below ${describe(separators[0]!)}`
                : childIndex === separators.length
                  ? `is at or above ${describe(separators[separators.length - 1]!)}`
                  : `falls between ${describe(separators[childIndex - 1]!)} and ${describe(separators[childIndex]!)}`
            }, so follow child ${String(childIndex)}.`;
          })();
      emit(
        `Node ${nodeId} separates on ${keyList(internal.keys)}. ${
          straddles
            ? `${label} matches a separator, and a run of equal keys can straddle one — so go left of it, to child ${String(childIndex)}, to reach the first ${label} there is.`
            : where
        }`,
        { stage: 'index', action: 'traverse', nodeId, key: keys[0]!, childIndex },
        traversalAsked || straddles || wide
          ? undefined
          : (() => {
              traversalAsked = true;
              const prompt = traversalPrompt(nodeId, internal.keys.map((k) => valuesOf(k)[0]!), keys[0]!, childIndex);
              return prompt ? { predictable: prompt } : undefined;
            })(),
      );
    } else {
      emit(`Reach leaf ${nodeId}, which holds keys ${keyList(n.keys)}.`, {
        stage: 'index',
        action: 'traverse',
        nodeId,
        key: keys[0]!,
      });
    }
  }

  let leaf = node(tree, path[path.length - 1]!) as LeafNode;
  const pointers: RowPointer[] = [];
  const entries: SqlValue[][] = [];
  // Only a clustered table's secondary index ever fills this in (plan.md §25.4 B3e) — parallel to `pointers`.
  const clusterKeys: (readonly SqlValue[])[] = [];
  let foundLeaf = leaf.id;

  if (tree.tiebreak) {
    // Read along the leaves while the key holds. A hop is taken only when the run reached the end of a leaf and the
    // leaf's high key (its parent's separator) still starts with this key — otherwise the next leaf starts above it.
    let at = lowerBound(leaf.keys, target);
    // A UNIQUE index holds at most one entry per whole key, so the first match is the only one — no run to read, and
    // no reason to look at the next leaf even when the match is the last entry of this one.
    const single = tree.unique === true && keys.length >= entryWidth(tree);
    for (;;) {
      while (at < leaf.keys.length && startsWith(leaf.keys[at]!, keys) && !(single && pointers.length > 0)) {
        if (pointers.length === 0) foundLeaf = leaf.id;
        pointers.push(leaf.pointers[at]!);
        entries.push([...valuesOf(leaf.keys[at]!)]);
        if (tree.clusteredVia !== undefined) clusterKeys.push((leaf.keys[at] as EntryKey).clusterKey ?? []);
        at += 1;
      }
      if (single && pointers.length > 0) break;
      if (at < leaf.keys.length || leaf.next === null) break;
      const high = highKey(tree, leaf);
      if (high === null || !startsWith(high, keys)) break;

      const next = node(tree, leaf.next) as LeafNode;
      emit(
        `Leaf ${leaf.id} ends, and its high key starts with ${label} too — more entries for it continue in the next leaf. Follow the sibling pointer to leaf ${next.id}.`,
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
    const at = leaf.keys.findIndex((k) => compareKeys(k, keys[0]!) === 0);
    if (at !== -1) {
      pointers.push(leaf.pointers[at]!);
      entries.push([keys[0]!]);
    }
  }

  const clustered = tree.clusteredVia !== undefined;
  const pointer = pointers[0];
  if (pointer === undefined) {
    emit(`${label} is not in this leaf, so it is not in the table at all — the search stops here.`, {
      stage: 'index',
      action: 'not-found',
      nodeId: leaf.id,
      key: keys[0]!,
    });
    if (parentPage !== null) locks.release(parentPage, 'shared');
    return { pointer: null, pointers, entries, pagesRead, ...(clustered ? { clusterKeys } : {}) };
  }

  const also =
    pointers.length > 1
      ? ` ${String(pointers.length - 1)} more ${pointers.length === 2 ? 'entry' : 'entries'} for the same ${wide ? 'key prefix' : 'value'} follow it — a non-unique index keeps one entry per row, ordered by where the row lives, so a repeated ${wide ? 'key' : 'value'} is ${String(pointers.length)} pointers, not one.`
      : '';
  const partial = wide && keys.length < entryWidth(tree) ? ` (a leftmost prefix of the ${String(entryWidth(tree))}-column key)` : '';
  emit(
    foundNote ??
      (clustered && touchHeap
        ? `Found ${label}${partial}. This table is clustered on \`${tree.clusteredVia}\`, so the leaf holds that key, not the row's address — finding the row costs a second descent, through the clustered index itself.${also}`
        : touchHeap
          ? `Found ${label}${partial}. The leaf stores a pointer to the row, not the row itself: heap page ${pointer.pageId}, slot ${pointer.slot}.${also}`
          : `Found ${label}${partial}. This query only needs \`${column}\` itself, which the leaf already holds — the heap page the pointer names is never read.${also}`),
    { stage: 'index', action: 'found', nodeId: foundLeaf, key: keys[0]! },
  );

  // A clustered table's secondary entry has no address to fetch — `resolveClustered` does the real work, as a
  // second, honest descent, and only the caller knows which of `pointers` it still needs (a `LIMIT` may not need them all).
  if (touchHeap && !clustered) {
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

  return { pointer, pointers, entries, pagesRead, ...(clustered ? { clusterKeys } : {}) };
}

/**
 * The real row address for one of a clustered table's secondary-index matches (plan.md §25.4 B3e): a second, real
 * descent through the clustered index itself, narrated and costed exactly like any other lookup — because that is
 * exactly what it is. `null` only if the row genuinely is not there, which a correctly maintained index never shows.
 */
export function resolveClustered(
  emit: Emit,
  clusteredTree: BPlusTree,
  clusteringColumn: string,
  clusterKey: readonly SqlValue[],
  pool: BufferPool,
  locks: LockManager,
): RowPointer | null {
  return emitIndexLookup(emit, clusteredTree, clusterKey, pool, clusteringColumn, locks).pointer;
}
