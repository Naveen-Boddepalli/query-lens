import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { buildHeap } from '../storage/index.ts';
import {
  buildIndex,
  compareKeys,
  createTree,
  deleteKey,
  entryKey,
  insert,
  leafChain,
  node,
  probe,
  search,
  validate,
} from '../index/index.ts';
import type { LeafNode, RowPointer } from '../index/index.ts';
import { isEntry } from '../index/btree.ts';
import type { Database, Row, StepEvent, Table } from '../types.ts';

/**
 * Non-unique indexes (plan.md §25.4 B3a). A table's index holds *entries* — the value plus the row's
 * own address — so a value that repeats is several entries, never one overwritten pointer.
 */

const GROUPS = 5;

function tableOf(rows: Row[], indexedColumns: string[] = ['id', 'grp']): Table {
  return { name: 'items', columns: ['id', 'grp', 'label'], rows, indexedColumns };
}

/** 40 rows, ids 1..40, `grp` cycling 0..4 — every group value repeats 8 times, spread across many pages. */
function cycling(): Database {
  const rows: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, grp: i % GROUPS, label: `r${String(i + 1)}` }));
  // Padding so the honest cost gate (plan.md §25.4 C5) still favors the index: with only 40 rows and 5 distinct
  // values, a B+Tree's own overhead (levels + one heap page per match) can honestly cost more than just scanning
  // 40 rows outright — too small a table for any index to pay for itself. Far-away filler (ids and `grp`s no other
  // test ever names) pushes `ndistinct(grp)` up enough that a uniform 1/ndistinct estimate reads any of the five
  // real groups as highly selective — the documented blind spot of an ndistinct-only estimator facing skewed
  // cardinality, not a number invented for this test alone.
  const filler: Row[] = Array.from({ length: 150 }, (_, i) => ({ id: 100000 + i, grp: 90000 + i, label: 'filler' }));
  return { tables: { items: tableOf([...rows, ...filler]) } };
}

const run = (sql: string, db: Database = cycling()) => runQuery(sql, db);
const ops = (events: StepEvent[], op: string) => events.filter((e) => e.stage === 'execute' && e.op === op);
const indexActions = (events: StepEvent[], action: string) => events.filter((e) => e.stage === 'index' && e.action === action);

describe('an index on a column that repeats', () => {
  it('returns every matching row, not the last one written', () => {
    for (let g = 0; g < GROUPS; g++) {
      const { rows } = run(`SELECT id FROM items WHERE grp = ${String(g)} ORDER BY id`);
      const expected = Array.from({ length: 8 }, (_, k) => ({ id: g + 1 + k * GROUPS }));
      expect(rows).toEqual(expected);
    }
  });

  it('is chosen by the planner, and reads through the index rather than scanning', () => {
    const { events } = run('SELECT * FROM items WHERE grp = 3');
    expect(ops(events, 'IndexScan').length).toBeGreaterThan(0);
    expect(ops(events, 'SeqScan')).toHaveLength(0);
  });

  it('a value that is not there finds nothing', () => {
    const { rows, events } = run('SELECT * FROM items WHERE grp = 99');
    expect(rows).toEqual([]);
    expect(indexActions(events, 'not-found')).toHaveLength(1);
  });

  it('applies the rest of the predicate to every entry, not just the first', () => {
    const { rows } = run('SELECT id FROM items WHERE grp = 2 AND id > 20 ORDER BY id');
    expect(rows).toEqual([{ id: 23 }, { id: 28 }, { id: 33 }, { id: 38 }]);
  });

  it('an index-only lookup returns one row per entry', () => {
    const { rows, events } = run('SELECT grp FROM items WHERE grp = 4');
    expect(rows).toEqual(Array.from({ length: 8 }, () => ({ grp: 4 })));
    expect(ops(events, 'IndexOnlyScan').length).toBeGreaterThan(0);
  });

  it('ranges over the column return every row in the range', () => {
    const inRange = cycling().tables.items!.rows.filter((r) => (r.grp as number) >= 3);
    const { rows } = run('SELECT id FROM items WHERE grp >= 3 ORDER BY id');
    expect(rows).toEqual(inRange.map((r) => ({ id: r.id })));
    const exclusive = run('SELECT id FROM items WHERE grp > 3 ORDER BY id').rows;
    expect(exclusive).toEqual(cycling().tables.items!.rows.filter((r) => (r.grp as number) > 3).map((r) => ({ id: r.id })));
    const below = run('SELECT id FROM items WHERE grp < 1 ORDER BY id').rows;
    expect(below).toEqual(cycling().tables.items!.rows.filter((r) => r.grp === 0).map((r) => ({ id: r.id })));
    const upTo = run('SELECT id FROM items WHERE grp <= 1 ORDER BY id').rows;
    expect(upTo).toHaveLength(16);
  });

  it('LIMIT stops the walk early — later matches never touch the heap', () => {
    const reads = (sql: string) =>
      run(sql).events.filter((e) => e.stage === 'buffer' && (e.action === 'hit' || e.action === 'load')).length;
    expect(reads('SELECT * FROM items WHERE grp = 1 LIMIT 1')).toBeLessThan(reads('SELECT * FROM items WHERE grp = 1'));
  });
});

describe('a run of equal values that spans leaves', () => {
  /** Forty rows all holding the same value: the entries fill about ten 4-key leaves. */
  const same = (): Database => ({
    tables: {
      items: tableOf(
        [
          ...Array.from({ length: 40 }, (_, i) => ({ id: i + 1, grp: 7, label: 'x' })),
          // Padding for the same reason `cycling()`'s does (plan.md §25.4 C5) — see its own comment above.
          ...Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, grp: 9000 + i, label: 'filler' })),
        ],
        ['grp'],
      ),
    },
  });

  it('finds all of them, hopping leaf to leaf by the sibling chain', () => {
    const { rows, events } = run('SELECT id FROM items WHERE grp = 7', same());
    expect(rows).toHaveLength(40);
    expect(indexActions(events, 'chain-next').length).toBeGreaterThanOrEqual(8);
  });

  it('hops exactly as many times as the value spans leaves — no read past the end of the run', () => {
    const rows: Row[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: i + 1, grp: 1, label: 'a' })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: i + 9, grp: 2, label: 'b' })),
      // Padding for the same reason `cycling()`'s does (plan.md §25.4 C5) — see its own comment above.
      ...Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, grp: 9000 + i, label: 'filler' })),
    ];
    const table = tableOf(rows, ['grp']);
    const tree = buildIndex(buildHeap(table, 4), 'grp');
    const spanned = leafChain(tree).filter((id) =>
      (node(tree, id) as LeafNode).keys.some((k) => isEntry(k) && k.values[0] === 1),
    ).length;
    expect(spanned).toBeGreaterThan(1);
    const { events } = run('SELECT * FROM items WHERE grp = 1', { tables: { items: table } });
    expect(indexActions(events, 'chain-next')).toHaveLength(spanned - 1);
  });

  it('says so when a separator equals the value being sought', () => {
    const { events } = run('SELECT id FROM items WHERE grp = 7', same());
    const text = events.map((e) => e.label).join('\n');
    expect(text).toContain('straddle');
  });
});

describe('writes on an index with repeated values', () => {
  it('DELETE by a repeated value removes every such row and drops each one’s own entry', () => {
    const { rows, write, events } = run('DELETE FROM items WHERE grp = 2');
    expect(rows).toHaveLength(8);
    expect(write?.rows).toHaveLength(182);
    expect(write?.rows.some((r) => r.grp === 2)).toBe(false);
    // Each of the eight rows dropped an entry from *both* trees — the grp tree (8 entries for one value) and the id tree.
    const drops = events.filter((e) => e.label.startsWith('Delete removes'));
    expect(drops).toHaveLength(8);
    for (const d of drops) {
      expect(d.label).toContain('The `grp` B+Tree drops key 2');
      expect(d.label).toContain('The `id` B+Tree drops key');
    }
  });

  it('DELETE that names one row leaves its neighbours with the same value alone', () => {
    const { rows, write } = run('DELETE FROM items WHERE grp = 2 AND id = 13');
    expect(rows).toEqual([{ id: 13, grp: 2, label: 'r13' }]);
    expect(write?.rows.filter((r) => r.grp === 2)).toHaveLength(7);
  });

  it('UPDATE of an indexed column moves each row’s entry, and only its own', () => {
    const { rows, write, events } = run('UPDATE items SET grp = 9 WHERE grp = 1');
    expect(rows).toHaveLength(8);
    expect(write?.rows.filter((r) => r.grp === 9)).toHaveLength(8);
    expect(write?.rows.filter((r) => r.grp === 1)).toHaveLength(0);
    const updates = events.filter((e) => e.label.startsWith('Update changes'));
    expect(updates).toHaveLength(8);
    for (const u of updates) expect(u.label).toContain('Because `grp` changed, its B+Tree drops key 1');
  });

  it('INSERT of a value already present adds an entry beside the others', () => {
    const { events, write } = run("INSERT INTO items (id, grp, label) VALUES (41, 3, 'new')");
    expect(write?.rows).toHaveLength(191);
    const text = events.map((e) => e.label).join('\n');
    expect(text).toContain('The `grp` B+Tree gets key 3');
  });

  it('the table after a write reads back correctly through the index it now has', () => {
    const inserted = run("INSERT INTO items (id, grp, label) VALUES (41, 3, 'new')");
    const after: Database = { tables: { items: tableOf(inserted.write!.rows) } };
    const { rows } = run('SELECT id FROM items WHERE grp = 3 ORDER BY id', after);
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)).toEqual({ id: 41 });
  });
});

/* -------------------------------------------------------------------------- */
/* The tree itself, against a model                                            */
/* -------------------------------------------------------------------------- */

describe('entry keys order by value, then by row address', () => {
  it('is a total order in which a probe sits before or after every entry sharing its value', () => {
    const a = entryKey([5], { pageId: 1, slot: 0 });
    const b = entryKey([5], { pageId: 1, slot: 3 });
    const c = entryKey([5], { pageId: 2, slot: 0 });
    const d = entryKey([6], { pageId: 0, slot: 0 });
    expect([a, b, c, d].every((k, i, all) => i === 0 || compareKeys(all[i - 1]!, k) < 0)).toBe(true);
    for (const e of [a, b, c]) {
      expect(compareKeys(probe([5], 'low'), e)).toBeLessThan(0);
      expect(compareKeys(probe([5], 'high'), e)).toBeGreaterThan(0);
      expect(compareKeys(e, probe([5], 'low'))).toBeGreaterThan(0);
      expect(compareKeys(e, probe([5], 'high'))).toBeLessThan(0);
    }
    expect(compareKeys(probe([5], 'high'), d)).toBeLessThan(0);
    expect(compareKeys(probe([6], 'low'), d)).toBeLessThan(0);
  });

  it('leaves the plain-value order untouched, so the sandbox trees are unaffected', () => {
    expect(compareKeys(2, 10)).toBeLessThan(0);
    expect(compareKeys('b', 'a')).toBeGreaterThan(0);
    expect(compareKeys(3, 3)).toBe(0);
  });
});

describe('a table index is a sound B+Tree however the values repeat', () => {
  const values = fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 0, maxLength: 80 });

  it('holds every row as its own entry, in order, at any fan-out', () => {
    fc.assert(
      fc.property(values, fc.integer({ min: 3, max: 6 }), (vals, maxKeys) => {
        const rows: Row[] = vals.map((grp, i) => ({ id: i, grp }));
        const heap = buildHeap(tableOf(rows), 4);
        const tree = buildIndex(heap, 'grp', maxKeys);
        expect(validate(tree)).toEqual([]);
        for (let g = 0; g <= 6; g++) {
          const want = vals.filter((v) => v === g).length;
          expect(search(tree, g).pointer !== null).toBe(want > 0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('survives any interleaving of inserts and deletes of individual entries', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 30 })), { maxLength: 120 }),
        fc.integer({ min: 3, max: 5 }),
        (actions, maxKeys) => {
          const tree = createTree(maxKeys, 0, true);
          const model = new Map<string, RowPointer>();
          for (const [add, value, slot] of actions) {
            const pointer = { pageId: 0, slot };
            const key = `${String(value)}@${String(slot)}`;
            if (add) {
              insert(tree, entryKey([value], pointer), pointer);
              model.set(key, pointer);
            } else {
              const removed = deleteKey(tree, entryKey([value], pointer));
              expect(removed.found).toBe(model.delete(key));
            }
            expect(validate(tree)).toEqual([]);
          }
          for (let v = 0; v <= 4; v++) {
            const held = [...model.keys()].some((k) => k.startsWith(`${String(v)}@`));
            expect(search(tree, v).pointer !== null).toBe(held);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
