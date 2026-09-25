import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import {
  bulkLoad,
  compareKeys,
  createTree,
  deleteKey,
  entryKey,
  height,
  insert,
  leafChain,
  node,
  search,
  validate,
} from '../index/index.ts';
import type { BPlusTree, BulkEntry, LeafNode } from '../index/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, Row } from '../types.ts';

/**
 * Bulk loading (plan.md §25.4 B3d): the same tree, packed differently. The packing is what decides the height and
 * the pages a lookup reads — never the answer.
 */

const entriesFor = (values: readonly number[]): BulkEntry[] =>
  values.map((v, i) => {
    const pointer = { pageId: Math.floor(i / 4), slot: i % 4 };
    return { key: entryKey([v], pointer), pointer };
  });

const incremental = (entries: readonly BulkEntry[], maxKeys: number): BPlusTree => {
  const tree = createTree(maxKeys, 0, true);
  for (const e of entries) insert(tree, e.key, e.pointer);
  return tree;
};

const leaves = (tree: BPlusTree): LeafNode[] => leafChain(tree).map((id) => node(tree, id) as LeafNode);
const keysOf = (tree: BPlusTree) => leaves(tree).flatMap((l) => l.keys);
const nodeCount = (tree: BPlusTree): number => Object.keys(tree.nodes).length;

describe('a bulk-loaded tree is a sound B+Tree', () => {
  const values = fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 0, maxLength: 150 });

  it('holds every entry in order, satisfies every invariant, at any fan-out and fill factor', () => {
    fc.assert(
      fc.property(values, fc.integer({ min: 3, max: 6 }), fc.double({ min: 0.5, max: 1, noNaN: true }), (vals, maxKeys, fill) => {
        const entries = entriesFor(vals);
        const tree = bulkLoad(entries, maxKeys, 0, fill);
        expect(validate(tree)).toEqual([]);
        const held = keysOf(tree);
        expect(held).toHaveLength(entries.length);
        expect(held.every((k, i) => i === 0 || compareKeys(held[i - 1]!, k) < 0)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('is found by search exactly where it should be', () => {
    fc.assert(
      fc.property(values, fc.integer({ min: 3, max: 5 }), fc.double({ min: 0.5, max: 1, noNaN: true }), (vals, maxKeys, fill) => {
        const tree = bulkLoad(entriesFor(vals), maxKeys, 0, fill);
        for (let v = 0; v <= 41; v++) expect(search(tree, v).pointer !== null).toBe(vals.includes(v));
      }),
      { numRuns: 150 },
    );
  });

  it('takes inserts and deletes afterwards like any other tree', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 60 }),
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 100, max: 140 })), { maxLength: 60 }),
        fc.double({ min: 0.5, max: 1, noNaN: true }),
        (initial, actions, fill) => {
          const tree = bulkLoad(entriesFor(initial), 4, 0, fill);
          for (const [add, value, slot] of actions) {
            const pointer = { pageId: 90, slot };
            if (add) insert(tree, entryKey([value], pointer), pointer);
            else deleteKey(tree, entryKey([value], pointer));
            expect(validate(tree)).toEqual([]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('numbers its pages from the page it was given, one per node, with no gaps', () => {
    const tree = bulkLoad(entriesFor(Array.from({ length: 50 }, (_, i) => i)), 4, 17, 1);
    const pages = Object.values(tree.nodes).map((n) => n.pageId).sort((a, b) => a - b);
    expect(pages).toEqual(Array.from({ length: pages.length }, (_, i) => 17 + i));
    expect(tree.nextPageId).toBe(17 + pages.length);
  });
});

describe('packing', () => {
  const sorted = Array.from({ length: 120 }, (_, i) => i);

  it('keys inserted in order leave every left leaf three-quarters full (at fan-out 4); a bulk load packs them', () => {
    const entries = entriesFor(sorted);
    const one = incremental(entries, 4);
    const full = bulkLoad(entries, 4, 0, 1);
    expect(leaves(one).slice(0, -1).every((l) => l.keys.length === 3)).toBe(true);
    expect(leaves(full).slice(0, -1).every((l) => l.keys.length === 4)).toBe(true);
    expect(leaves(full).length).toBeLessThan(leaves(one).length);
    expect(nodeCount(full)).toBeLessThan(nodeCount(one));
    expect(height(full)).toBeLessThanOrEqual(height(one));
  });

  it('a lower fill factor leaves room: more leaves than a full pack, fewer than half-full ones', () => {
    const entries = entriesFor(sorted);
    const full = leaves(bulkLoad(entries, 4, 0, 1)).length;
    const seventy = leaves(bulkLoad(entries, 4, 0, 0.75)).length;
    const half = leaves(bulkLoad(entries, 4, 0, 0.5)).length;
    expect(full).toBeLessThan(seventy);
    expect(seventy).toBeLessThan(half);
  });

  it('a fill factor below one half is raised to it — a node may never be under-full', () => {
    const entries = entriesFor(sorted);
    expect(leaves(bulkLoad(entries, 4, 0, 0.1)).length).toBe(leaves(bulkLoad(entries, 4, 0, 0.5)).length);
    expect(validate(bulkLoad(entries, 4, 0, 0.1))).toEqual([]);
  });

  it('a small load is just a root leaf', () => {
    const tree = bulkLoad(entriesFor([3, 1, 2]), 4, 0, 1);
    expect(height(tree)).toBe(1);
    expect(keysOf(tree)).toHaveLength(3);
  });
});

describe('as an index build option', () => {
  const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, grp: i % 7 }));
  const db = (): Database => ({ tables: { t: { name: 't', columns: ['id', 'grp'], rows, indexedColumns: ['id', 'grp'] } } });
  const run = (sql: string, indexBuild?: NonNullable<typeof DEFAULT_ENGINE_OPTIONS.indexBuild>) =>
    runQuery(sql, db(), { ...DEFAULT_ENGINE_OPTIONS, ...(indexBuild ? { indexBuild } : {}) });

  it('never changes an answer', () => {
    for (const sql of ['SELECT * FROM t WHERE id = 77', 'SELECT id FROM t WHERE id > 280', 'SELECT * FROM t WHERE grp = 3', 'SELECT grp FROM t WHERE grp >= 5']) {
      const plain = run(sql).rows.map((r) => JSON.stringify(r)).sort();
      expect(run(sql, { method: 'bulk' }).rows.map((r) => JSON.stringify(r)).sort(), sql).toEqual(plain);
      expect(run(sql, { method: 'bulk', fillFactor: 0.7 }).rows.map((r) => JSON.stringify(r)).sort(), sql).toEqual(plain);
    }
  });

  it('a packed index is shallower, so a lookup reads fewer pages', () => {
    const levels = (indexBuild?: NonNullable<typeof DEFAULT_ENGINE_OPTIONS.indexBuild>): number => {
      const open = run('SELECT * FROM t WHERE id = 77', indexBuild).events.find((e) => e.stage === 'index' && e.action === 'open');
      return open?.stage === 'index' && open.action === 'open' ? open.height : -1;
    };
    expect(levels({ method: 'bulk' })).toBeLessThan(levels());
  });

  it('every insert into a bulk-loaded index still splits and keeps it sound', () => {
    const captured: Record<string, BPlusTree> = {};
    runQuery("INSERT INTO t (id, grp) VALUES (500, 3)", db(), { ...DEFAULT_ENGINE_OPTIONS, indexBuild: { method: 'bulk' } }, { afterWrite: (t) => Object.assign(captured, t) });
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);
  });
});
