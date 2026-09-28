/**
 * Pages. Real engines use ~4–16 KB pages holding hundreds of rows; we hold a
 * handful, because a page you can see the contents of teaches more than a
 * realistic one you cannot. The disclaimer banner covers the difference.
 */

import type { Row, SqlValue, Table } from '../types.ts';

/** NULL-first, numeric-or-lexicographic compare — the same rule `index/btree.ts`'s `compareScalar` applies to a
 *  table's own entries, kept as its own tiny copy here so `storage/` need not depend on `index/`. */
function compareValue(a: SqlValue, b: SqlValue): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = typeof a === 'boolean' ? String(Number(a)) : String(a);
  const sb = typeof b === 'boolean' ? String(Number(b)) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareRows(a: Row, b: Row, columns: readonly string[]): number {
  for (const column of columns) {
    const cmp = compareValue(a[column] ?? null, b[column] ?? null);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export interface Page {
  pageId: number;
  table: string;
  rows: Row[];
}

export interface Heap {
  table: string;
  pages: Page[];
  /** Row index (into the table) of the first row on each page. */
  firstRowIndex: number[];
}

export function buildHeap(table: Table, rowsPerPage: number, firstPageId = 0): Heap {
  const pages: Page[] = [];
  const firstRowIndex: number[] = [];

  // A CLUSTERED (index-organized) table (plan.md §25.4 B3e) is stored in clustering-key order, not insertion order
  // — its whole reason to exist: rows near each other in key order sit near each other on disk, so a range on that
  // key reads pages in sequence instead of wherever insertion happened to leave them.
  const rows = table.clusteredKey ? [...table.rows].sort((a, b) => compareRows(a, b, table.clusteredKey!)) : table.rows;

  for (let i = 0; i < rows.length; i += rowsPerPage) {
    firstRowIndex.push(i);
    pages.push({
      pageId: firstPageId + pages.length,
      table: table.name,
      rows: rows.slice(i, i + rowsPerPage),
    });
  }

  // An empty table still has one (empty) page, so a scan has something to read.
  if (pages.length === 0) {
    firstRowIndex.push(0);
    pages.push({ pageId: firstPageId, table: table.name, rows: [] });
  }

  return { table: table.name, pages, firstRowIndex };
}

/** Which page holds the row at `rowIndex`. */
export function pageOfRow(heap: Heap, rowIndex: number, rowsPerPage: number): Page | undefined {
  return heap.pages[Math.floor(rowIndex / rowsPerPage)];
}

export function pageById(heap: Heap, pageId: number): Page | undefined {
  return heap.pages.find((p) => p.pageId === pageId);
}

export function rowsOnPage(page: Page): Row[] {
  return page.rows;
}
