import { describe, expect, it } from 'vitest';
import { buildHeap } from '../storage/index.ts';
import { buildIndex, buildIndexes, pageCountFor, search } from '../index/index.ts';
import type { Table } from '../types.ts';

const table: Table = {
  name: 'things',
  columns: ['id', 'category'],
  rows: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, category: i % 3 === 0 ? 'rare' : 'common' })),
};

describe('buildIndexes — multiple independent single-column trees (plan.md §22.2)', () => {
  it('one column behaves exactly like a single buildIndex call', () => {
    const heap = buildHeap(table, 4);
    const single = buildIndex(heap, 'id');
    const multi = buildIndexes(heap, ['id']);
    expect(multi.id).toEqual(single);
  });

  it('two trees never claim the same page id', () => {
    const heap = buildHeap(table, 4);
    const trees = buildIndexes(heap, ['id', 'category']);
    const idPages = new Set(Object.keys(trees.id!.nodes).map((k) => trees.id!.nodes[k]!.pageId));
    const categoryPages = new Set(Object.keys(trees.category!.nodes).map((k) => trees.category!.nodes[k]!.pageId));
    const heapPages = new Set(heap.pages.map((p) => p.pageId));

    for (const id of idPages) {
      expect(categoryPages.has(id)).toBe(false);
      expect(heapPages.has(id)).toBe(false);
    }
    // The second tree built (category) starts exactly where the first (id) left off.
    expect(Math.min(...categoryPages)).toBe(trees.id!.nextPageId);
  });

  it('order does not matter — building category first, then id, still never collides', () => {
    const heap = buildHeap(table, 4);
    const trees = buildIndexes(heap, ['category', 'id']);
    const categoryPages = new Set(Object.keys(trees.category!.nodes).map((k) => trees.category!.nodes[k]!.pageId));
    const idPages = new Set(Object.keys(trees.id!.nodes).map((k) => trees.id!.nodes[k]!.pageId));
    for (const p of idPages) expect(categoryPages.has(p)).toBe(false);
    expect(Math.min(...idPages)).toBe(trees.category!.nextPageId);
  });

  it('every row is still findable by either column — building two trees corrupts neither', () => {
    const heap = buildHeap(table, 4);
    const trees = buildIndexes(heap, ['id', 'category']);
    for (const row of table.rows) {
      expect(search(trees.id!, row.id ?? null).pointer).not.toBeNull();
    }
    expect(search(trees.category!, 'rare').pointer).not.toBeNull();
    expect(search(trees.category!, 'common').pointer).not.toBeNull();
    expect(search(trees.category!, 'bogus').pointer).toBeNull();
  });

  it('pageCountFor sums to the last tree\'s own nextPageId, not the heap alone', () => {
    const heap = buildHeap(table, 4);
    const trees = buildIndexes(heap, ['id', 'category']);
    const total = pageCountFor(heap, trees);
    expect(total).toBe(Math.max(trees.id!.nextPageId, trees.category!.nextPageId));
    expect(total).toBeGreaterThan(heap.pages.length);
  });

  it('pageCountFor falls back to the heap\'s own page count with no indexes at all', () => {
    const heap = buildHeap(table, 4);
    expect(pageCountFor(heap, {})).toBe(heap.pages.length);
    expect(pageCountFor(heap, buildIndexes(heap, []))).toBe(heap.pages.length);
  });
});
