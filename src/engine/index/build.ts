import type { Heap } from '../storage/index.ts';
import type { IndexBuildOptions, IndexSpec, Row, SqlValue } from '../types.ts';
import { createTree, entryKey, insert } from './btree.ts';
import { bulkLoad, DEFAULT_FILL_FACTOR } from './bulk.ts';
import type { BulkEntry } from './bulk.ts';
import type { BPlusTree, EntryKey, RowPointer } from './btree.ts';
import { DEFAULT_MAX_KEYS } from './btree.ts';
import { indexNameOf, isClusteringIndex } from './spec.ts';

/** A sentinel — never dereferenced — for a clustered table's secondary entries (plan.md §25.4 B3e): they carry a
 *  `clusterKey` instead of an address, so `page`/`slot` are meaningless and must never be fetched as a heap page. */
const NO_ADDRESS: RowPointer = { pageId: -1, slot: -1 };

/**
 * The entry `columns`'s index holds for `row`, and the pointer to store alongside it. Ordinarily that pointer *is*
 * the row's real heap address — `pointer`, unchanged. On a CLUSTERED table (plan.md §25.4 B3e), the clustering key's
 * own index still gets that real address (its whole point: no second structure is needed to find a row by it), but
 * every OTHER index gets the row's clustering key instead, behind the sentinel `NO_ADDRESS` — a clustered leaf can
 * split and move rows between pages, and the clustering key never goes stale the way a physical pointer would.
 */
export function entryFor(
  columns: readonly string[],
  row: Row,
  pointer: RowPointer,
  clusteredKey: readonly string[] | undefined,
): { key: EntryKey; pointer: RowPointer } {
  if (!clusteredKey || isClusteringIndex(clusteredKey, columns)) {
    return { key: entryKey(keyValuesOf(row, columns), pointer), pointer };
  }
  const clusterKey = keyValuesOf(row, clusteredKey);
  return { key: entryKey(keyValuesOf(row, columns), NO_ADDRESS, clusterKey), pointer: NO_ADDRESS };
}

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
  /** The table's clustering key (plan.md §25.4 B3e), if it has one. */
  clusteredKey?: readonly string[],
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
      entries.push(entryFor(columns, row, { pageId: page.pageId, slot }, clusteredKey));
    });
  });

  // Entry keys (values + row address, or a clustered secondary's clustering key), so the key may repeat: two rows
  // with the same values are two distinct entries, adjacent in the leaves, and neither overwrites the other.
  let tree: BPlusTree;
  if (build.method === 'bulk') {
    tree = bulkLoad(entries, maxKeys, firstPageId, build.fillFactor ?? DEFAULT_FILL_FACTOR, true);
  } else {
    tree = createTree(maxKeys, firstPageId, true);
    for (const { key, pointer } of entries) insert(tree, key, pointer);
  }
  if (typeof index !== 'string' && index.unique) tree.unique = true;
  if (clusteredKey && !isClusteringIndex(clusteredKey, columns)) tree.clusteredVia = indexNameOf(clusteredKey);
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
  /** The table's clustering key (plan.md §25.4 B3e), if it has one. */
  clusteredKey?: readonly string[],
): Record<string, BPlusTree> {
  const trees: Record<string, BPlusTree> = {};
  for (const index of indexes) {
    const name = indexNameOf(typeof index === 'string' ? [index] : index.columns);
    const tree = buildIndex(heap, index, maxKeys, firstPageId, build, clusteredKey);
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
