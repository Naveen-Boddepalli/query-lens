import type { Heap } from '../storage/index.ts';
import type { SqlValue } from '../types.ts';
import { createTree, entryKey, insert } from './btree.ts';
import type { BPlusTree } from './btree.ts';
import { DEFAULT_MAX_KEYS } from './btree.ts';

/**
 * Builds one index over the heap. Index nodes are numbered starting at
 * `firstPageId` (the last heap page by default), so it competes for the same
 * buffer frames as the heap — which is the honest arrangement, and the
 * reason an index lookup shows up in the pool at all. `firstPageId` is a
 * parameter, not always `heap.pages.length`, so `buildIndexes` below can
 * chain several trees over the same heap without any two ever claiming the
 * same page id.
 *
 * Building is setup, not query execution, so it emits nothing: the trace
 * describes running your query, not preparing the database.
 */
export function buildIndex(
  heap: Heap,
  column: string,
  maxKeys = DEFAULT_MAX_KEYS,
  firstPageId = heap.pages.length,
): BPlusTree {
  // Entry keys (value + row address), so the column may repeat: two rows with the same value are two
  // distinct entries, adjacent in the leaves, and neither overwrites the other.
  const tree = createTree(maxKeys, firstPageId, true);

  heap.pages.forEach((page) => {
    page.rows.forEach((row, slot) => {
      const key: SqlValue = row[column] ?? null;
      // NULLs are not indexed — a lookup for one must fall back to a scan.
      if (key === null) return;
      const pointer = { pageId: page.pageId, slot };
      insert(tree, entryKey([key], pointer), pointer);
    });
  });

  return tree;
}

/**
 * One independent single-column B+Tree per column in `columns` — plan.md
 * §22.2's "two candidate indexes," not a composite (multi-column) index over
 * several columns at once, which is still open. Each tree is built in turn,
 * starting where the previous one's own page ids left off (`heap.pages.length`
 * for the first), so however many indexes a table declares, none of their
 * page ids ever collide with the heap's or each other's.
 */
export function buildIndexes(
  heap: Heap,
  columns: readonly string[],
  maxKeys = DEFAULT_MAX_KEYS,
  /** Where the first tree's pages begin — the heap's end by default; a join's *inner* table starts past the outer's. */
  firstPageId = heap.pages.length,
): Record<string, BPlusTree> {
  const trees: Record<string, BPlusTree> = {};
  for (const column of columns) {
    const tree = buildIndex(heap, column, maxKeys, firstPageId);
    trees[column] = tree;
    firstPageId = tree.nextPageId;
  }
  return trees;
}

/** Total pages in the database: heap pages, then every index's own pages. */
export function pageCountFor(heap: Heap, trees: Record<string, BPlusTree>): number {
  const nextPageIds = Object.values(trees).map((t) => t.nextPageId);
  return nextPageIds.length > 0 ? Math.max(...nextPageIds) : heap.pages.length;
}
