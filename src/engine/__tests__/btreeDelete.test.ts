import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allKeys,
  createTree,
  DEFAULT_MAX_KEYS,
  deleteKey,
  height,
  insert,
  node,
  search,
} from '../index/btree.ts';
import type { BPlusTree } from '../index/btree.ts';
import { validate } from '../index/validate.ts';

/**
 * plan.md §7.6: the delete rules — borrow, merge, root-collapse, and the
 * separator rewrite that keeps every internal key a real leaf key — get a
 * plausible-looking tree wrong in ways only an invariant check catches. So
 * `validate` is asserted clean after *every* delete, not just at the end, and
 * a `Set` oracle rides alongside every property test.
 */

const ptr = (i: number) => ({ pageId: Math.floor(i / 4), slot: i % 4 });

function treeOf(keys: number[], maxKeys = DEFAULT_MAX_KEYS): BPlusTree {
  const tree = createTree(maxKeys, 0);
  keys.forEach((k, i) => { insert(tree, k, ptr(i)); });
  return tree;
}

const nodeCount = (tree: BPlusTree) => Object.keys(tree.nodes).length;

describe('deleteKey — the shapes, by hand (maxKeys 4)', () => {
  it('takes a key out of a leaf that stays at least half full, and does nothing else', () => {
    const tree = treeOf([1, 2, 3, 4, 5]); // leaves [1 2 3] | [4 5], separator 4
    const before = nodeCount(tree);
    const res = deleteKey(tree, 3); // left leaf -> [1 2], still at the floor of 2

    expect(res.found).toBe(true);
    expect(res.steps.map((s) => s.kind)).toEqual(['remove']);
    expect(nodeCount(tree)).toBe(before);
    expect(allKeys(tree)).toEqual([1, 2, 4, 5]);
    expect(validate(tree)).toEqual([]);
  });

  it('borrows from the left sibling when it has a key to spare', () => {
    const tree = treeOf([1, 2, 3, 4, 5]); // [1 2 3] | [4 5]
    const res = deleteKey(tree, 4); // right leaf underflows; left has three
    expect(res.steps.some((s) => s.kind === 'borrow-left')).toBe(true);
    expect(allKeys(tree)).toEqual([1, 2, 3, 5]);
    expect(nodeCount(tree)).toBe(3); // no node removed
    expect(validate(tree)).toEqual([]);
  });

  it('borrows from the right sibling when the left cannot spare one', () => {
    const tree = treeOf([1, 2, 3, 4, 5, 6]); // [1 2 3] | [4 5 6]
    deleteKey(tree, 3); // left -> [1 2]
    const res = deleteKey(tree, 1); // left underflows; no left sibling; right has three
    expect(res.steps.some((s) => s.kind === 'borrow-right')).toBe(true);
    expect(allKeys(tree)).toEqual([2, 4, 5, 6]);
    expect(nodeCount(tree)).toBe(3);
    expect(validate(tree)).toEqual([]);
  });

  it('merges two leaves and collapses the root when both siblings are at the floor', () => {
    const tree = treeOf([1, 2, 3, 4, 5]);
    deleteKey(tree, 3); // leaves [1 2] | [4 5], both at the minimum
    const res = deleteKey(tree, 4); // right underflows; left cannot lend -> merge -> root drops

    expect(res.steps.map((s) => s.kind)).toContain('merge');
    expect(res.steps.map((s) => s.kind)).toContain('root-collapse');
    expect(node(tree, tree.rootId).kind).toBe('leaf');
    expect(height(tree)).toBe(1);
    expect(allKeys(tree)).toEqual([1, 2, 5]);
    expect(validate(tree)).toEqual([]);
  });

  it('rewrites an ancestor separator when the deleted key was one', () => {
    const tree = treeOf([1, 2, 3, 4, 5]);
    const root = node(tree, tree.rootId);
    expect(root.kind).toBe('internal');
    if (root.kind !== 'internal') return;
    expect(root.keys).toContain(4); // 4 was copied up as the separator

    deleteKey(tree, 4);
    expect(node(tree, tree.rootId).keys).not.toContain(4);
    expect(search(tree, 4).pointer).toBeNull();
    for (const k of [1, 2, 3, 5]) expect(search(tree, k).pointer, `key ${k}`).not.toBeNull();
    expect(validate(tree)).toEqual([]);
  });

  it('returns found:false and changes nothing for a key that is not there', () => {
    const tree = treeOf([1, 2, 3, 4, 5]);
    const before = JSON.stringify(tree);
    const res = deleteKey(tree, 99);
    expect(res).toEqual({ found: false, steps: [] });
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('lets the root leaf empty out completely', () => {
    const tree = treeOf([7, 3, 9]);
    for (const k of [7, 3, 9]) expect(deleteKey(tree, k).found).toBe(true);
    expect(allKeys(tree)).toEqual([]);
    expect(node(tree, tree.rootId).kind).toBe('leaf');
    expect(validate(tree)).toEqual([]);
  });

  it('loses height under heavy deletion, staying sound throughout', () => {
    const tree = treeOf(Array.from({ length: 40 }, (_, i) => i + 1));
    const tall = height(tree);
    expect(tall).toBeGreaterThanOrEqual(3);
    for (let k = 1; k <= 35; k++) {
      deleteKey(tree, k);
      expect(validate(tree), `after deleting ${k}`).toEqual([]);
    }
    expect(height(tree)).toBeLessThan(tall);
    expect(allKeys(tree)).toEqual([36, 37, 38, 39, 40]);
  });
});

describe('property: delete keeps the tree sound and in sync with a Set oracle', () => {
  it('interleaved inserts and deletes, every maxKeys, validate clean after each op', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.constantFrom<'ins' | 'del'>('ins', 'ins', 'del'),
            key: fc.integer({ min: 0, max: 40 }),
          }),
          { minLength: 1, maxLength: 300 },
        ),
        fc.integer({ min: 3, max: 6 }),
        (ops, maxKeys) => {
          const tree = createTree(maxKeys, 0);
          const oracle = new Map<number, { pageId: number; slot: number }>();
          let seq = 0;

          for (const { op, key } of ops) {
            if (op === 'ins') {
              const p = ptr(seq++);
              insert(tree, key, p);
              oracle.set(key, p);
            } else {
              const had = oracle.has(key);
              const res = deleteKey(tree, key);
              expect(res.found).toBe(had);
              oracle.delete(key);
            }
            expect(validate(tree)).toEqual([]);
            expect(allKeys(tree)).toEqual([...oracle.keys()].sort((a, b) => a - b));
          }

          for (const [k, p] of oracle) expect(search(tree, k).pointer).toEqual(p);
          const absent = 999;
          if (!oracle.has(absent)) expect(search(tree, absent).pointer).toBeNull();
        },
      ),
      { numRuns: 250 },
    );
  });

  it('insert a whole set, then delete it in random order, ending at an empty leaf', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: -300, max: 300 }), { minLength: 1, maxLength: 120 }),
        fc.integer({ min: 3, max: 6 }),
        (keys, maxKeys) => {
          const tree = createTree(maxKeys, 0);
          keys.forEach((k, i) => { insert(tree, k, ptr(i)); });

          const order = [...keys].sort(() => Math.random() - 0.5);
          const remaining = new Set(keys);
          for (const k of order) {
            expect(deleteKey(tree, k).found).toBe(true);
            remaining.delete(k);
            expect(validate(tree)).toEqual([]);
            expect(allKeys(tree)).toEqual([...remaining].sort((a, b) => a - b));
          }
          expect(node(tree, tree.rootId).kind).toBe('leaf');
          expect(height(tree)).toBe(1);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('height never rises across a delete', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 2, maxLength: 80 }),
        (keys) => {
          const tree = createTree(DEFAULT_MAX_KEYS, 0);
          keys.forEach((k, i) => { insert(tree, k, ptr(i)); });
          for (const k of keys) {
            const before = height(tree);
            deleteKey(tree, k);
            expect(height(tree)).toBeLessThanOrEqual(before);
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe('property: string keys delete cleanly too', () => {
  it('stays sound and sorted', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 50 }),
        (keys) => {
          const tree = createTree(DEFAULT_MAX_KEYS, 0);
          keys.forEach((k, i) => { insert(tree, k, ptr(i)); });
          const remaining = new Set(keys);
          for (const k of keys.filter((_, i) => i % 2 === 0)) {
            deleteKey(tree, k);
            remaining.delete(k);
            expect(validate(tree)).toEqual([]);
          }
          expect(allKeys(tree)).toEqual([...remaining].sort());
        },
      ),
      { numRuns: 120 },
    );
  });
});
