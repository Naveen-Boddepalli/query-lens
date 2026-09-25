import type { Heap } from '../storage/index.ts';
import type { IndexBuildOptions, IndexSpec, Row, SqlValue } from '../types.ts';
import { createTree, entryKey, insert } from './btree.ts';
import { bulkLoad, DEFAULT_FILL_FACTOR } from './bulk.ts';
import type { BulkEntry } from './bulk.ts';
import type { BPlusTree } from './btree.ts';
import { DEFAULT_MAX_KEYS } from './btree.ts';
import { indexNameOf } from './spec.ts';

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
  /** A column name (the plain, single-column index) or a full spec (a composite one). */
  index: string | IndexSpec,
  maxKeys = DEFAULT_MAX_KEYS,
  firstPageId = heap.pages.length,
  /** How to build it — one entry at a time (the default), or bulk-loaded and packed to a fill factor (plan.md §25.4 B3d). */
  build: IndexBuildOptions = { method: 'incremental' },
): BPlusTree {
  const columns = typeof index === 'string' ? [index] : index.columns;

  const entries: BulkEntry[] = [];
  heap.pages.forEach((page) => {
    page.rows.forEach((row, slot) => {
      const values = keyValuesOf(row, columns);
      // A NULL *leading* column is not indexed — an equality on it never matches, so a lookup has nothing to
      // find and NULL-keyed rows fall back to a scan. A NULL further along (`(1, NULL)`) is an ordinary entry:
      // the row must still be found by an equality on the columns before it.
      if (values[0] === null) return;
      const pointer = { pageId: page.pageId, slot };
      entries.push({ key: entryKey(values, pointer), pointer });
    });
  });

  // Entry keys (values + row address), so the key may repeat: two rows with the same values are two
  // distinct entries, adjacent in the leaves, and neither overwrites the other.
  let tree: BPlusTree;
  if (build.method === 'bulk') {
    tree = bulkLoad(entries, maxKeys, firstPageId, build.fillFactor ?? DEFAULT_FILL_FACTOR, true);
  } else {
    tree = createTree(maxKeys, firstPageId, true);
    for (const { key, pointer } of entries) insert(tree, key, pointer);
  }
  if (typeof index !== 'string' && index.unique) tree.unique = true;
  return tree;
}

/** The values of `columns` in `row`, in key order — what an index entry for that row holds. */
export function keyValuesOf(row: Row, columns: readonly string[]): SqlValue[] {
  return columns.map((column) => row[column] ?? null);
}

/**
 * One independent B+Tree per index — a plain single-column one for each bare name, or a composite one for a
 * spec — plan.md §22.2's "candidate indexes." Trees are keyed by the index's name (`indexNameOf`). Each is built in
 * turn, starting where the previous one's own page ids left off (`heap.pages.length` for the first), so however
 * many indexes a table declares, none of their page ids ever collide with the heap's or each other's.
 */
export function buildIndexes(
  heap: Heap,
  indexes: readonly (string | IndexSpec)[],
  maxKeys = DEFAULT_MAX_KEYS,
  /** Where the first tree's pages begin — the heap's end by default; a join's *inner* table starts past the outer's. */
  firstPageId = heap.pages.length,
  build?: IndexBuildOptions,
): Record<string, BPlusTree> {
  const trees: Record<string, BPlusTree> = {};
  for (const index of indexes) {
    const name = indexNameOf(typeof index === 'string' ? [index] : index.columns);
    const tree = buildIndex(heap, index, maxKeys, firstPageId, build);
    trees[name] = tree;
    firstPageId = tree.nextPageId;
  }
  return trees;
}

/** Total pages in the database: heap pages, then every index's own pages. */
export function pageCountFor(heap: Heap, trees: Record<string, BPlusTree>): number {
  const nextPageIds = Object.values(trees).map((t) => t.nextPageId);
  return nextPageIds.length > 0 ? Math.max(...nextPageIds) : heap.pages.length;
}
