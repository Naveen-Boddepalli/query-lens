import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allKeys,
  compareKeys,
  createTree,
  DEFAULT_MAX_KEYS,
  descend,
  height,
  insert,
  leafChain,
  leftmostPath,
  lowerBound,
  node,
  search,
} from '../index/btree.ts';
import type { BPlusTree, LeafNode } from '../index/btree.ts';
import { validate } from '../index/validate.ts';

function treeOf(keys: number[], maxKeys = DEFAULT_MAX_KEYS): BPlusTree {
  const tree = createTree(maxKeys, 0);
  keys.forEach((k, i) => { insert(tree, k, { pageId: Math.floor(i / 4), slot: i % 4 }); });
  return tree;
}

describe('compareKeys', () => {
  it('orders numbers numerically, not lexicographically', () => {
    expect(compareKeys(9, 10)).toBeLessThan(0);
    expect(compareKeys(100, 20)).toBeGreaterThan(0);
  });

  it('orders strings lexicographically', () => {
    expect(compareKeys('ada', 'brendan')).toBeLessThan(0);
    expect(compareKeys('ada', 'ada')).toBe(0);
  });
});

describe('B+Tree basics', () => {
  it('starts as a single empty leaf that is also the root', () => {
    const tree = createTree();
    expect(node(tree, tree.rootId).kind).toBe('leaf');
    expect(allKeys(tree)).toEqual([]);
    expect(height(tree)).toBe(1);
  });

  it('does not split before the node is over capacity', () => {
    const tree = treeOf([1, 2, 3, 4]);
    expect(node(tree, tree.rootId).kind).toBe('leaf');
    expect(height(tree)).toBe(1);
  });

  it('splits on the key that overflows the root leaf', () => {
    const tree = treeOf([1, 2, 3, 4, 5]);
    expect(node(tree, tree.rootId).kind).toBe('internal');
    expect(height(tree)).toBe(2);
  });

  it('grows taller as keys accumulate', () => {
    expect(height(treeOf(Array.from({ length: 60 }, (_, i) => i + 1)))).toBeGreaterThan(2);
  });

  it('overwrites the pointer for a duplicate key rather than storing it twice', () => {
    const tree = createTree();
    insert(tree, 7, { pageId: 1, slot: 1 });
    insert(tree, 7, { pageId: 9, slot: 3 });
    expect(allKeys(tree)).toEqual([7]);
    expect(search(tree, 7).pointer).toEqual({ pageId: 9, slot: 3 });
  });

  it('assigns every node its own page', () => {
    const tree = treeOf(Array.from({ length: 40 }, (_, i) => i + 1));
    const pages = Object.values(tree.nodes).map((n) => n.pageId);
    expect(new Set(pages).size).toBe(pages.length);
  });
});

describe('lowerBound (plan.md §23.1 — a range scan\'s own starting position)', () => {
  it('finds the first index at or after the key', () => {
    expect(lowerBound([10, 20, 30, 40], 25)).toBe(2);
    expect(lowerBound([10, 20, 30, 40], 20)).toBe(1);
    expect(lowerBound([10, 20, 30, 40], 5)).toBe(0);
    expect(lowerBound([10, 20, 30, 40], 41)).toBe(4);
  });

  it('is the length of an empty array', () => {
    expect(lowerBound([], 5)).toBe(0);
  });
});

describe('leftmostPath (plan.md §23.1 — a range scan with no lower bound)', () => {
  it('is just the root for a single-leaf tree', () => {
    const tree = treeOf([1, 2, 3]);
    expect(leftmostPath(tree)).toEqual([tree.rootId]);
  });

  it('always takes child 0 at every internal node — the same leaf descend(minKey) would reach', () => {
    // Built from keys 1..40, so 1 is the minimum key by construction.
    const tree = treeOf(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(leftmostPath(tree)).toEqual(descend(tree, 1));
  });

  it('ends at the same leaf leafChain() starts its walk from', () => {
    const tree = treeOf(Array.from({ length: 40 }, (_, i) => i + 1));
    const path = leftmostPath(tree);
    expect(path[path.length - 1]).toBe(leafChain(tree)[0]);
  });
});

describe('the split rules', () => {
  it('LEAF SPLIT COPIES UP — the separator stays in the leaf', () => {
    const tree = treeOf([1, 2, 3, 4, 5]);
    const root = node(tree, tree.rootId);
    expect(root.kind).toBe('internal');
    const separator = root.keys[0]!;

    // The separator must still be findable as a data entry.
    expect(allKeys(tree)).toContain(separator);
    expect(search(tree, separator).pointer).not.toBeNull();
  });

  it('INTERNAL SPLIT PUSHES UP — the middle key leaves the node', () => {
    // Enough keys to split an internal node at least once.
    const tree = treeOf(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(height(tree)).toBeGreaterThanOrEqual(3);

    const root = node(tree, tree.rootId);
    expect(root.kind).toBe('internal');
    if (root.kind !== 'internal') return;

    // A pushed-up key must appear exactly once among the internal nodes below
    // it — it moved, it was not copied.
    for (const pushed of root.keys) {
      const occurrences = Object.values(tree.nodes).filter(
        (n) => n.kind === 'internal' && n.id !== root.id && n.keys.some((k) => compareKeys(k, pushed) === 0),
      );
      expect(occurrences, `separator ${String(pushed)}`).toHaveLength(0);
    }
  });

  it('every internal separator still exists as a leaf key', () => {
    const tree = treeOf(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(validate(tree)).toEqual([]);
  });
});

describe('property: any insertion order produces a sound tree', () => {
  const keySet = fc
    .uniqueArray(fc.integer({ min: -500, max: 500 }), { minLength: 1, maxLength: 120 })
    .chain((keys) => fc.constant(keys));

  it('satisfies every structural invariant', () => {
    fc.assert(
      fc.property(keySet, fc.integer({ min: 3, max: 6 }), (keys, maxKeys) => {
        const tree = treeOf(keys, maxKeys);
        expect(validate(tree)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('(a) every inserted key is findable', () => {
    fc.assert(
      fc.property(keySet, (keys) => {
        const tree = treeOf(keys);
        for (const key of keys) {
          const hit = search(tree, key);
          expect(hit.pointer, `key ${key}`).not.toBeNull();
          expect(hit.slotInLeaf).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('(b) the leaf chain holds every key in ascending order', () => {
    fc.assert(
      fc.property(keySet, (keys) => {
        const tree = treeOf(keys);
        expect(allKeys(tree)).toEqual([...keys].sort((a, b) => a - b));
      }),
      { numRuns: 200 },
    );
  });

  it('(c) every leaf sits at the same depth', () => {
    fc.assert(
      fc.property(keySet, (keys) => {
        const tree = treeOf(keys);
        const depthOf = (id: string): number => {
          let depth = 0;
          let current = node(tree, tree.rootId);
          const target = node(tree, id) as LeafNode;
          const first = target.keys[0];
          while (current.kind === 'internal') {
            const idx =
              first === undefined
                ? 0
                : current.keys.filter((k) => compareKeys(first, k) >= 0).length;
            current = node(tree, current.children[idx]!);
            depth += 1;
          }
          return depth;
        };
        const depths = leafChain(tree).map(depthOf);
        expect(new Set(depths).size).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it('reports a miss for keys that were never inserted', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 60 }),
        (keys) => {
          const tree = treeOf(keys);
          const absent = 1000; // outside the generated range
          const miss = search(tree, absent);
          expect(miss.pointer).toBeNull();
          expect(miss.slotInLeaf).toBe(-1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the pointer found is the one that was stored', () => {
    fc.assert(
      fc.property(keySet, (keys) => {
        const tree = createTree();
        const expected = new Map<number, { pageId: number; slot: number }>();
        keys.forEach((k, i) => {
          const ptr = { pageId: i, slot: i % 4 };
          expected.set(k, ptr);
          insert(tree, k, ptr);
        });
        for (const [key, ptr] of expected) {
          expect(search(tree, key).pointer).toEqual(ptr);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('property: string keys work too', () => {
  it('stays sound and sorted', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 60 }),
        (keys) => {
          const tree = createTree();
          keys.forEach((k, i) => { insert(tree, k, { pageId: i, slot: 0 }); });
          expect(validate(tree)).toEqual([]);
          expect(allKeys(tree)).toEqual([...keys].sort());
          for (const k of keys) expect(search(tree, k).pointer).not.toBeNull();
        },
      ),
      { numRuns: 150 },
    );
  });
});
