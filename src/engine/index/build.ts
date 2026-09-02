import type { Heap } from '../storage/index.ts';
import type { SqlValue } from '../types.ts';
import { createTree, insert } from './btree.ts';
import type { BPlusTree } from './btree.ts';
import { DEFAULT_MAX_KEYS } from './btree.ts';

/**
 * Builds the index over the heap. Index nodes are numbered starting after the
 * last heap page, so both compete for the same buffer frames — which is the
 * honest arrangement, and the reason an index lookup shows up in the pool at
 * all.
 *
 * Building is setup, not query execution, so it emits nothing: the trace
 * describes running your query, not preparing the database.
 */
export function buildIndex(
  heap: Heap,
  column: string,
  maxKeys = DEFAULT_MAX_KEYS,
): BPlusTree {
  const tree = createTree(maxKeys, heap.pages.length);

  heap.pages.forEach((page) => {
    page.rows.forEach((row, slot) => {
      const key: SqlValue = row[column] ?? null;
      // NULLs are not indexed — a lookup for one must fall back to a scan.
      if (key === null) return;
      insert(tree, key, { pageId: page.pageId, slot });
    });
  });

  return tree;
}

/** Total pages in the database: heap pages, then index pages. */
export function pageCountFor(heap: Heap, tree: BPlusTree | null): number {
  return tree ? tree.nextPageId : heap.pages.length;
}
