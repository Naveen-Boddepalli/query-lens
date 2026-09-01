/**
 * Pages. Real engines use ~4–16 KB pages holding hundreds of rows; we hold a
 * handful, because a page you can see the contents of teaches more than a
 * realistic one you cannot. The disclaimer banner covers the difference.
 */

import type { Row, Table } from '../types.ts';

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

  for (let i = 0; i < table.rows.length; i += rowsPerPage) {
    firstRowIndex.push(i);
    pages.push({
      pageId: firstPageId + pages.length,
      table: table.name,
      rows: table.rows.slice(i, i + rowsPerPage),
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
