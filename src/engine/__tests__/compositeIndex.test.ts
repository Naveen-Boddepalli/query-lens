import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { columnsOfIndex, indexNameOf, indexSpecsOf, joinIndexFor, leafChain, node, validate, valuesOf } from '../index/index.ts';
import type { BPlusTree, LeafNode } from '../index/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, PlanNode, Row, StepEvent, Table } from '../types.ts';

/**
 * Composite indexes (plan.md §25.4 B3b): one B+Tree over several columns, entered through a *leftmost prefix* of
 * them, and covering any query that reads only the columns it holds.
 */

/**
 * 120 rows: `a` cycles 0..7, `b` cycles 0..4, `c` cycles three strings — coprime cycle lengths, so every (a, b)
 * combination occurs exactly 3 times. `a` alone is 8-valued rather than 4 (plan.md §25.4 C5): a leading-column
 * equality needs to be honestly selective enough for the B+Tree's own overhead to pay for itself against a scan,
 * which 1-in-4 on a fixture this small never was, once a rule actually compares the two costs instead of firing on
 * shape alone.
 */
function people(extra: Partial<Table> = {}): Database {
  const rows: Row[] = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, a: i % 8, b: i % 5, c: `v${String(i % 3)}` }));
  return { tables: { t: { name: 't', columns: ['id', 'a', 'b', 'c'], rows, indexes: [{ columns: ['a', 'b'] }], ...extra } } };
}

const run = (sql: string, db: Database = people()) => runQuery(sql, db);
const ops = (events: StepEvent[], op: string) => events.filter((e) => e.stage === 'execute' && e.op === op);

function finalPlan(events: StepEvent[]): PlanNode {
  const rewrites = events.filter((e): e is Extract<StepEvent, { stage: 'optimize' }> => e.stage === 'optimize');
  if (rewrites.length > 0) return rewrites[rewrites.length - 1]!.after;
  return events.filter((e): e is Extract<StepEvent, { stage: 'plan' }> => e.stage === 'plan').at(-1)!.planTree;
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.children ?? []).flatMap(flatten)];
const scanOf = (events: StepEvent[]) => flatten(finalPlan(events)).find((n) => n.op !== 'Project' && n.op !== 'Filter')!;
const all = (db: Database) => db.tables.t!.rows;
/** An index returns matching rows in key order and a scan in heap order; without ORDER BY neither is wrong. */
const byId = (rows: Row[]): Row[] => [...rows].sort((x, y) => (x.id as number) - (y.id as number));

describe('declaring indexes', () => {
  it('reads the one-column shorthand and the richer form as one list, named by their columns', () => {
    const table: Table = { name: 't', columns: ['a', 'b', 'c'], rows: [], indexedColumns: ['c'], indexes: [{ columns: ['a', 'b'] }] };
    expect(indexSpecsOf(table).map((s) => indexNameOf(s.columns))).toEqual(['c', 'a, b']);
    expect(columnsOfIndex('a, b')).toEqual(['a', 'b']);
  });

  it('a join can probe a composite index through its leading column, and prefers a plain one', () => {
    const table: Table = { name: 't', columns: ['a', 'b'], rows: [], indexes: [{ columns: ['a', 'b'] }] };
    expect(joinIndexFor(table, 'a')?.columns).toEqual(['a', 'b']);
    expect(joinIndexFor(table, 'b')).toBeUndefined();
    expect(joinIndexFor({ ...table, indexedColumns: ['a'] }, 'a')?.columns).toEqual(['a']);
  });
});

describe('the leftmost-prefix rule', () => {
  it('an equality on every column enters the index', () => {
    const { rows, events } = run('SELECT * FROM t WHERE a = 1 AND b = 2');
    expect(byId(rows)).toEqual(all(people()).filter((r) => r.a === 1 && r.b === 2));
    expect(ops(events, 'IndexScan').length).toBeGreaterThan(0);
    expect(ops(events, 'SeqScan')).toHaveLength(0);
    const scan = scanOf(events);
    expect(scan.label).toBe('IndexScan t.(a, b)');
    expect(scan.detail).toBe('key: a = 1 AND b = 2');
  });

  it('an equality on the first column alone enters it too, and returns every entry starting that way', () => {
    const { rows, events } = run('SELECT * FROM t WHERE a = 1');
    expect(byId(rows)).toEqual(all(people()).filter((r) => r.a === 1));
    expect(scanOf(events).label).toBe('IndexScan t.(a, b)');
    expect(scanOf(events).detail).toBe('key: a = 1');
  });

  it('an equality on the second column alone cannot: the index is left unused, and the plan says why', () => {
    const { rows, events } = run('SELECT * FROM t WHERE b = 2');
    expect(rows).toEqual(all(people()).filter((r) => r.b === 2));
    expect(ops(events, 'SeqScan').length).toBeGreaterThan(0);
    expect(ops(events, 'IndexScan')).toHaveLength(0);
    const text = events.filter((e) => e.stage === 'optimize').map((e) => e.label).join('\n');
    expect(text).toContain('The index on (a, b) cannot help');
    expect(text).toContain('leftmost column');
  });

  it('the order the conjuncts are written in does not matter', () => {
    const { rows, events } = run('SELECT * FROM t WHERE b = 2 AND a = 1');
    expect(byId(rows)).toEqual(all(people()).filter((r) => r.a === 1 && r.b === 2));
    expect(scanOf(events).detail).toBe('key: a = 1 AND b = 2');
  });

  it('what the prefix does not pin stays a recheck', () => {
    const { rows, events } = run("SELECT * FROM t WHERE a = 1 AND c = 'v1'");
    expect(byId(rows)).toEqual(all(people()).filter((r) => r.a === 1 && r.c === 'v1'));
    expect(scanOf(events).detail).toContain('recheck: c = \'v1\'');
  });

  it('a range on the leading column enters it as well', () => {
    const { rows, events } = run('SELECT * FROM t WHERE a >= 7');
    expect(byId(rows)).toEqual(all(people()).filter((r) => (r.a as number) >= 7));
    expect(ops(events, 'IndexRangeScan').length).toBeGreaterThan(0);
  });

  it('asks the leftmost-prefix question when only some of the columns are named', () => {
    const { events } = run('SELECT * FROM t WHERE a = 1');
    const step = events.find((e) => e.stage === 'optimize' && e.rule === 'index-selection');
    expect(step?.predictable?.question).toContain('(a, b)');
    expect(step?.predictable?.correctOptionId).toBe('yes');
  });

  it('a wider index is preferred to a narrower one it starts with, when both match', () => {
    const db = people({ indexedColumns: ['a'] });
    const { events } = run('SELECT * FROM t WHERE a = 1 AND b = 2', db);
    // Pinning two columns selects fewer rows than pinning one.
    expect(scanOf(events).label).toBe('IndexScan t.(a, b)');
  });
});

describe('covering', () => {
  it('a query over only the index columns is answered from the entries, without touching the heap', () => {
    const db = people();
    const { rows, events } = run('SELECT a, b FROM t WHERE a = 1', db);
    expect(rows.map((r) => [r.a, r.b])).toEqual(all(db).filter((r) => r.a === 1).map((r) => [r.a, r.b]).sort((x, y) => (x[1] as number) - (y[1] as number)));
    expect(ops(events, 'IndexOnlyScan').length).toBeGreaterThan(0);
    expect(scanOf(events).label).toBe('IndexOnlyScan t.(a, b)');
    // The heap has 30 pages (0–29); an index-only scan reads none of them.
    const fetched = events.flatMap((e) => (e.stage === 'buffer' && (e.action === 'hit' || e.action === 'load' || e.action === 'miss') ? [e.pageId] : []));
    expect(fetched.length).toBeGreaterThan(0);
    for (const page of fetched) expect(page).toBeGreaterThanOrEqual(30);
  });

  it('a query that reads a column the index does not hold is not covered', () => {
    const { events } = run('SELECT a, c FROM t WHERE a = 1');
    expect(ops(events, 'IndexOnlyScan')).toHaveLength(0);
    expect(ops(events, 'IndexScan').length).toBeGreaterThan(0);
  });

  it('a covered lookup narrates that the index covers it', () => {
    const text = run('SELECT a, b FROM t WHERE a = 1 AND b = 2').events.filter((e) => e.stage === 'optimize').map((e) => e.label).join('\n');
    expect(text).toContain('covers');
  });
});

describe('a range on the column after an equality prefix', () => {
  it('narrows within the prefix: one descent to where the range begins, then along the run', () => {
    const db = people();
    const { rows, events } = run('SELECT * FROM t WHERE a = 1 AND b > 2', db);
    expect(byId(rows)).toEqual(all(db).filter((r) => r.a === 1 && (r.b as number) > 2));
    expect(ops(events, 'IndexRangeScan').length).toBeGreaterThan(0);
    expect(ops(events, 'IndexScan')).toHaveLength(0);
    const scan = scanOf(events);
    expect(scan.label).toBe('IndexRangeScan t.(a, b)');
    expect(scan.detail).toBe('range: a = 1, `b` > 2');
    const text = events.filter((e) => e.stage === 'optimize').map((e) => e.label).join('\n');
    expect(text).toContain('narrows it within that run');
  });

  it('honours both bounds, inclusive and exclusive, and never leaves the prefix', () => {
    const db = people();
    for (const [sql, keep] of [
      ['SELECT * FROM t WHERE a = 2 AND b >= 1 AND b <= 3', (r: Row) => r.a === 2 && (r.b as number) >= 1 && (r.b as number) <= 3],
      ['SELECT * FROM t WHERE a = 2 AND b > 1 AND b < 3', (r: Row) => r.a === 2 && (r.b as number) > 1 && (r.b as number) < 3],
      ['SELECT * FROM t WHERE a = 3 AND b < 2', (r: Row) => r.a === 3 && (r.b as number) < 2],
      ['SELECT * FROM t WHERE a = 0 AND b BETWEEN 1 AND 2', (r: Row) => r.a === 0 && (r.b as number) >= 1 && (r.b as number) <= 2],
      ['SELECT * FROM t WHERE a = 1 AND b > 99', () => false],
    ] as const) {
      const { rows, events } = run(sql, db);
      expect(byId(rows), sql).toEqual(all(db).filter(keep));
      expect(scanOf(events).op, sql).toBe('IndexRangeScan'); // by the plan: an empty result emits no execute event
    }
  });

  it('never returns a NULL in the range column, though NULLs sit among the entries', () => {
    const db: Database = {
      tables: {
        t: {
          name: 't',
          columns: ['id', 'a', 'b'],
          rows: [
            { id: 1, a: 1, b: null },
            { id: 2, a: 1, b: 1 },
            { id: 3, a: 1, b: 7 },
            { id: 4, a: 2, b: null },
            { id: 5, a: 1, b: null },
          ],
          indexes: [{ columns: ['a', 'b'] }],
        },
      },
    };
    expect(run('SELECT id FROM t WHERE a = 1 AND b < 5', db).rows.map((r) => r.id)).toEqual([2]);
    expect(run('SELECT id FROM t WHERE a = 1 AND b > 0', db).rows.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it('prefers the index that can narrow further when two match the equality equally', () => {
    const db = people({ indexedColumns: ['a'] });
    expect(scanOf(run('SELECT * FROM t WHERE a = 1 AND b > 2', db).events).label).toBe('IndexRangeScan t.(a, b)');
  });

  it('prices it inside the prefix — fewer rows than the prefix alone', () => {
    const range = flatten(finalPlan(run('SELECT * FROM t WHERE a = 1 AND b > 2').events)).find((n) => n.op === 'IndexRangeScan')!;
    const prefix = flatten(finalPlan(run('SELECT * FROM t WHERE a = 1').events)).find((n) => n.op === 'IndexScan')!;
    expect(range.estRows!).toBeLessThan(prefix.estRows!);
    expect(range.estBasis).toContain('1/8 on a');
  });
});

describe('writes that find their rows by a range', () => {
  const written = (sql: string, db: Database = people()) => {
    const captured: Record<string, BPlusTree> = {};
    const result = runQuery(sql, db, DEFAULT_ENGINE_OPTIONS, { afterWrite: (t) => Object.assign(captured, t) });
    return { ...result, captured };
  };

  it('DELETE with a range on an indexed column walks the leaf chain, and leaves every tree sound', () => {
    const db: Database = { tables: { t: { ...people().tables.t!, indexedColumns: ['id'] } } };
    const { write, events, captured } = written('DELETE FROM t WHERE id > 110', db);
    expect(write?.rows).toHaveLength(110);
    expect(ops(events, 'IndexRangeScan').length).toBeGreaterThan(0);
    expect(ops(events, 'SeqScan')).toHaveLength(0);
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);
    const ids = leafChain(captured['id']!).flatMap((id) => (node(captured['id']!, id) as LeafNode).keys.map((k) => valuesOf(k)[0]));
    expect(ids.sort((x, y) => (x as number) - (y as number))).toEqual(Array.from({ length: 110 }, (_, i) => i + 1));
  });

  it('UPDATE that moves the very column it scans still touches each row once', () => {
    // Setting `id` beyond the scanned range: an update that found its own output again would loop or double-apply.
    const db: Database = { tables: { t: { ...people().tables.t!, indexedColumns: ['id'] } } };
    const { rows, write } = written('UPDATE t SET id = id + 100 WHERE id > 115', db);
    expect(rows).toHaveLength(5);
    expect(write?.rows.filter((r) => (r.id as number) > 200).map((r) => r.id).sort()).toEqual([216, 217, 218, 219, 220]);
  });

  it('DELETE by an equality prefix and a range keeps the composite index sound', () => {
    const { write, captured, events } = written('DELETE FROM t WHERE a = 1 AND b > 2');
    expect(ops(events, 'IndexRangeScan').length).toBeGreaterThan(0);
    expect(write?.rows.some((r) => r.a === 1 && (r.b as number) > 2)).toBe(false);
    expect(validate(captured['a, b']!)).toEqual([]);
    const held = leafChain(captured['a, b']!).flatMap((id) => (node(captured['a, b']!, id) as LeafNode).keys.map((k) => JSON.stringify(valuesOf(k)))).sort();
    expect(held).toEqual(write!.rows.map((r) => JSON.stringify([r.a, r.b])).sort());
  });
});

describe('NULLs in a composite index', () => {
  const db = (): Database => ({
    tables: {
      t: {
        name: 't',
        columns: ['id', 'a', 'b'],
        rows: [
          { id: 1, a: 1, b: null },
          { id: 2, a: 1, b: '' },
          { id: 3, a: 1, b: 'x' },
          { id: 4, a: null, b: 'x' },
          { id: 5, a: 2, b: null },
        ],
        indexes: [{ columns: ['a', 'b'] }],
      },
    },
  });

  it('a NULL after the leading column is an ordinary entry: the row is found by the columns before it', () => {
    expect(run('SELECT id FROM t WHERE a = 1', db()).rows.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(run('SELECT id FROM t WHERE a = 2', db()).rows.map((r) => r.id)).toEqual([5]);
  });

  it('but NULL is not the empty string — (1, NULL) is not (1, \'\')', () => {
    expect(run("SELECT id FROM t WHERE a = 1 AND b = ''", db()).rows.map((r) => r.id)).toEqual([2]);
    expect(run("SELECT id FROM t WHERE a = 1 AND b = 'x'", db()).rows.map((r) => r.id)).toEqual([3]);
  });

  it('a NULL leading column is never indexed, and never matched', () => {
    expect(run("SELECT id FROM t WHERE b = 'x'", db()).rows.map((r) => r.id).sort()).toEqual([3, 4]);
  });
});

describe('writes through a composite index', () => {
  const trees: BPlusTree[] = [];
  const run2 = (sql: string) => {
    const captured: Record<string, BPlusTree> = {};
    const result = runQuery(sql, people(), DEFAULT_ENGINE_OPTIONS, { afterWrite: (t) => Object.assign(captured, t) });
    trees.push(...Object.values(captured));
    return { ...result, captured };
  };

  /** The whole keys a tree holds, sorted — one per row, valued by every column. */
  const held = (tree: BPlusTree): string[] =>
    leafChain(tree).flatMap((id) => (node(tree, id) as LeafNode).keys.map((k) => JSON.stringify(valuesOf(k)))).sort();
  const want = (rows: Row[]): string[] => rows.map((r) => JSON.stringify([r.a, r.b])).sort();

  it('INSERT adds an entry valued by both columns', () => {
    const { write, events, captured } = run2("INSERT INTO t (id, a, b, c) VALUES (121, 9, 9, 'z')");
    expect(events.map((e) => e.label).join('\n')).toContain('The `a, b` B+Tree gets key (9, 9)');
    expect(validate(captured['a, b']!)).toEqual([]);
    expect(held(captured['a, b']!)).toEqual(want(write!.rows));
  });

  it('DELETE drops exactly the entries of the rows it removes', () => {
    const { write, events, captured } = run2('DELETE FROM t WHERE a = 2 AND b = 3');
    expect(write?.rows).toHaveLength(117);
    expect(events.filter((e) => e.label.startsWith('Delete removes')).every((e) => e.label.includes('The `a, b` B+Tree drops key (2, 3)'))).toBe(true);
    expect(validate(captured['a, b']!)).toEqual([]);
    expect(held(captured['a, b']!)).toEqual(want(write!.rows));
  });

  it('UPDATE of one indexed column moves the entry, and of an unrelated one leaves the index alone', () => {
    const moved = run2('UPDATE t SET b = 9 WHERE a = 1');
    expect(moved.events.some((e) => e.label.includes('Because `a, b` changed, its B+Tree drops key (1,'))).toBe(true);
    expect(held(moved.captured['a, b']!)).toEqual(want(moved.write!.rows));

    const untouched = run2("UPDATE t SET c = 'q' WHERE a = 1");
    expect(untouched.events.some((e) => e.label.includes('Because `a, b` changed'))).toBe(false);
    expect(held(untouched.captured['a, b']!)).toEqual(want(untouched.write!.rows));
  });

  it('every tree left behind is a sound B+Tree', () => {
    for (const tree of trees) expect(validate(tree)).toEqual([]);
  });
});

describe('what it costs', () => {
  it('prices a prefix by the columns it pins, multiplied — the same independence an AND assumes', () => {
    const one = flatten(finalPlan(run('SELECT * FROM t WHERE a = 1').events)).find((n) => n.op === 'IndexScan')!;
    const two = flatten(finalPlan(run('SELECT * FROM t WHERE a = 1 AND b = 2').events)).find((n) => n.op === 'IndexScan')!;
    expect(one.estBasis).toContain('1/8 on a');
    expect(two.estBasis).toContain('1/8 × 1/5 on a, b');
    // 120 rows / (8 × 5) = 3 — and the data has exactly 3 rows per (a, b).
    expect(two.estRows).toBe(3);
    expect(one.estRows).toBe(15);
  });

  it('says so when the index it is choosing costs more than the scan it replaces', () => {
    const text = run('SELECT * FROM t WHERE a = 1').events.filter((e) => e.stage === 'optimize').map((e) => e.label).join('\n');
    expect(text).toMatch(/Estimated cost (agrees|disagrees)/);
  });
});

describe('an index join through a composite index', () => {
  const db = (): Database => ({
    tables: {
      parents: { name: 'parents', columns: ['id', 'k'], rows: [{ id: 1, k: 1 }, { id: 2, k: 2 }, { id: 3, k: 7 }] },
      kids: {
        name: 'kids',
        columns: ['id', 'k', 'x'],
        rows: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, k: (i % 3) + 1, x: i })),
        indexes: [{ columns: ['k', 'x'] }],
      },
    },
  });
  const sql = 'SELECT parents.id, kids.x FROM parents JOIN kids ON parents.k = kids.k';

  it('probes it by its leading column, and returns what a nested-loop returns', () => {
    const indexed = runQuery(sql, db(), { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'index-nested-loop' });
    const plain = runQuery(sql, db(), { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'nested-loop' });
    const bag = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(bag(indexed.rows)).toEqual(bag(plain.rows));
    expect(indexed.rows.length).toBeGreaterThan(0);
    expect(flatten(finalPlan(indexed.events)).find((n) => n.op === 'IndexProbe')?.label).toBe('IndexProbe kids.(k, x)');
  });
});
