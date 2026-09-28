import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { validate } from '../index/index.ts';
import type { BPlusTree } from '../index/index.ts';
import { buildHeap } from '../storage/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, Row, StepEvent, Table } from '../types.ts';

/**
 * Clustered (index-organized) tables (plan.md §25.4 B3e) — the last B3 slice. A table's own UNIQUE index doubles
 * as its physical layout: rows are stored in that key's order (`buildHeap` sorts them), so the clustering key's own
 * lookups need no separate structure to find a row by it, and a range on it reads pages in sequence rather than
 * wherever insertion happened to leave them. Every OTHER index then carries the clustering key instead of a
 * physical address — a clustered leaf can split and move rows between pages, the clustering key never does — so a
 * lookup through one costs a second, real descent, through the clustered index itself. That second hop is built
 * only for an equality lookup; a range scan or an index-nested-loop join never chooses a clustered table's
 * secondary index, and falls back to a plan that does not need one.
 */

function accounts(extra: Partial<Table> = {}): Database {
  // Inserted in an order that does not match `id` — the point of the fixture: an unclustered table would leave
  // these scattered across heap pages in this order; a clustered one puts them back in `id` order regardless.
  const rows: Row[] = [
    { id: 5, email: 'erin@x.org', team: 'b', score: 50 },
    { id: 2, email: 'bo@x.org', team: 'a', score: 20 },
    { id: 4, email: 'dee@x.org', team: 'b', score: 40 },
    { id: 1, email: 'ada@x.org', team: 'a', score: 10 },
    { id: 3, email: 'cy@x.org', team: 'a', score: 30 },
  ];
  return {
    tables: {
      accounts: {
        name: 'accounts',
        columns: ['id', 'email', 'team', 'score'],
        rows,
        indexes: [
          { columns: ['id'], unique: true },
          { columns: ['email'], unique: true },
          { columns: ['team'] },
          { columns: ['score'] },
        ],
        clusteredKey: ['id'],
        ...extra,
      },
    },
  };
}

const run = (sql: string, db: Database = accounts()) => runQuery(sql, db);
const text = (events: StepEvent[]) => events.map((e) => e.label).join('\n');
const opens = (events: StepEvent[]) => events.filter((e) => e.stage === 'index' && e.action === 'open').length;
const ids = (rows: Row[]) => rows.map((r) => r.id).sort((a, b) => (a as number) - (b as number));

describe('physical layout', () => {
  it('stores rows in clustering-key order, not insertion order', () => {
    const heap = buildHeap(accounts().tables.accounts!, 2);
    expect(heap.pages.flatMap((p) => p.rows.map((r) => r.id))).toEqual([1, 2, 3, 4, 5]);
  });

  it('an unclustered table keeps insertion order, unaffected', () => {
    const { clusteredKey: _clusteredKey, ...unclustered } = accounts().tables.accounts!;
    const heap = buildHeap(unclustered, 2);
    expect(heap.pages.flatMap((p) => p.rows.map((r) => r.id))).toEqual([5, 2, 4, 1, 3]);
  });
});

describe('a range on the clustering key reads fewer pages once it is clustered', () => {
  function scrambled(clustered: boolean): Database {
    // 3, 4, 5 and 6 each land in their own original heap page, paired with an unrelated id — a heap-organized
    // table's worst case for this range; a clustered one puts them on two adjacent pages instead.
    const order = [3, 1, 4, 2, 5, 7, 6, 8];
    return {
      tables: {
        t: {
          name: 't',
          columns: ['id'],
          rows: order.map((id) => ({ id })),
          indexes: [{ columns: ['id'], unique: true }],
          ...(clustered ? { clusteredKey: ['id'] } : {}),
        },
      },
    };
  }

  const missCount = (db: Database) => {
    const { events } = runQuery('SELECT * FROM t WHERE id > 2 AND id < 7', db, {
      ...DEFAULT_ENGINE_OPTIONS,
      rowsPerPage: 2,
      bufferFrames: 30,
    });
    return events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
  };

  it('measured: 6 disk reads clustered vs 8 for the same rows unclustered', () => {
    expect(missCount(scrambled(true))).toBe(6);
    expect(missCount(scrambled(false))).toBe(8);
  });
});

describe("the clustering key's own index", () => {
  it('an equality lookup behaves exactly like any other unique index — one descent, one heap fetch', () => {
    const { rows, events } = run('SELECT * FROM accounts WHERE id = 3');
    expect(rows).toEqual([{ id: 3, email: 'cy@x.org', team: 'a', score: 30 }]);
    expect(text(events)).not.toContain('clustered');
    expect(opens(events)).toBe(1);
  });

  it('a range on it still becomes an IndexRangeScan', () => {
    const { rows, events } = run('SELECT * FROM accounts WHERE id > 2');
    expect(ids(rows)).toEqual([3, 4, 5]);
    expect(events.some((e) => e.stage === 'optimize' && e.rule === 'range-index-selection')).toBe(true);
  });
});

describe('a secondary index', () => {
  it('an equality lookup finds the right row through a second, real descent', () => {
    const { rows, events } = run("SELECT * FROM accounts WHERE email = 'dee@x.org'");
    expect(rows).toEqual([{ id: 4, email: 'dee@x.org', team: 'b', score: 40 }]);
    expect(text(events)).toContain('This table is clustered on `id`, and `email` is a secondary index');
    expect(text(events)).toContain('finding the row costs a second descent, through the clustered index itself');
    expect(opens(events)).toBe(2); // the `email` tree, then the `id` tree
  });

  it('a non-unique secondary index resolves every match', () => {
    const { rows } = run("SELECT * FROM accounts WHERE team = 'a'");
    expect(ids(rows)).toEqual([1, 2, 3]);
  });

  it('a covering query needs no second descent — the entry alone answers it', () => {
    const { rows, events } = run("SELECT email FROM accounts WHERE email = 'dee@x.org'");
    expect(rows).toEqual([{ email: 'dee@x.org' }]);
    expect(opens(events)).toBe(1);
    expect(text(events)).not.toContain('second descent');
  });

  it('is never chosen for a range — the walk needs a row address the entries do not carry', () => {
    const { rows, events } = run('SELECT * FROM accounts WHERE score > 25');
    expect(ids(rows)).toEqual([3, 4, 5]);
    expect(events.some((e) => e.stage === 'optimize' && e.rule === 'range-index-selection')).toBe(false);
  });

  it('is never probed by an index-nested-loop join — it falls back to a plain nested-loop', () => {
    const db: Database = {
      tables: {
        ...accounts().tables,
        posts: { name: 'posts', columns: ['id', 'val'], rows: [{ id: 1, val: 20 }, { id: 2, val: 40 }] },
      },
    };
    const { rows, events } = runQuery('SELECT * FROM posts JOIN accounts ON posts.val = accounts.score', db, {
      ...DEFAULT_ENGINE_OPTIONS,
      joinStrategy: 'index-nested-loop',
    });
    expect(rows).toHaveLength(2);
    expect(text(events)).toContain('runs as an ordinary nested-loop');
  });

  it('the clustering key itself is still probed by an index-nested-loop join — no fallback needed', () => {
    const db: Database = {
      tables: {
        ...accounts().tables,
        posts: { name: 'posts', columns: ['id', 'authorId'], rows: [{ id: 1, authorId: 2 }, { id: 2, authorId: 4 }] },
      },
    };
    const { rows, events } = runQuery('SELECT * FROM posts JOIN accounts ON posts.authorId = accounts.id', db, {
      ...DEFAULT_ENGINE_OPTIONS,
      joinStrategy: 'index-nested-loop',
    });
    expect(rows).toHaveLength(2);
    expect(text(events)).toContain('index probe');
  });
});

describe('a UNIQUE secondary index still names the row that holds a taken key', () => {
  it("resolves the holder through the clustered index, even though the entry itself carries no address", () => {
    const { error } = run("INSERT INTO accounts (id, email, team, score) VALUES (9, 'dee@x.org', 'c', 90)");
    expect(error?.message).toContain("(email) = ('dee@x.org')");
    expect(error?.hint).toContain('"id":4');
  });
});

describe('writes keep every index sound', () => {
  it('INSERT adds an entry to the clustering index and every secondary index', () => {
    const captured: Record<string, BPlusTree> = {};
    const { write } = runQuery(
      "INSERT INTO accounts (id, email, team, score) VALUES (6, 'fi@x.org', 'c', 60)",
      accounts(),
      DEFAULT_ENGINE_OPTIONS,
      { afterWrite: (t) => Object.assign(captured, t) },
    );
    expect(write?.rows).toHaveLength(6);
    expect(Object.keys(captured)).toEqual(['id', 'email', 'team', 'score']);
    expect(captured.id!.clusteredVia).toBeUndefined();
    expect(captured.email!.clusteredVia).toBe('id');
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);
  });

  it('DELETE by SeqScan removes the row from every index, secondary ones included', () => {
    const captured: Record<string, BPlusTree> = {};
    const { write } = runQuery("DELETE FROM accounts WHERE team = 'b' AND id = 4", accounts(), DEFAULT_ENGINE_OPTIONS, {
      afterWrite: (t) => Object.assign(captured, t),
    });
    expect(ids(write!.rows)).toEqual([1, 2, 3, 5]);
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);
  });

  it('DELETE found through the secondary index itself removes the right row', () => {
    const { write, events } = run("DELETE FROM accounts WHERE email = 'dee@x.org'");
    expect(ids(write!.rows)).toEqual([1, 2, 3, 5]);
    expect(text(events)).toContain('IndexScan finds the one row DELETE will remove.');
  });

  it('UPDATE moving a secondary-indexed column drops the old entry and adds the new one', () => {
    const captured: Record<string, BPlusTree> = {};
    const { write } = runQuery("UPDATE accounts SET email = 'zz@x.org' WHERE id = 2", accounts(), DEFAULT_ENGINE_OPTIONS, {
      afterWrite: (t) => Object.assign(captured, t),
    });
    expect(write?.rows.find((r) => r.id === 2)?.email).toBe('zz@x.org');
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);

    const after: Database = { tables: { accounts: { ...accounts().tables.accounts!, rows: write!.rows } } };
    expect(run("SELECT * FROM accounts WHERE email = 'zz@x.org'", after).rows).toEqual([
      { id: 2, email: 'zz@x.org', team: 'a', score: 20 },
    ]);
    expect(run("SELECT * FROM accounts WHERE email = 'bo@x.org'", after).rows).toEqual([]);
  });

  it('UPDATE moving the clustering key itself still works, and every index stays sound', () => {
    const captured: Record<string, BPlusTree> = {};
    const { write } = runQuery('UPDATE accounts SET id = 9 WHERE id = 2', accounts(), DEFAULT_ENGINE_OPTIONS, {
      afterWrite: (t) => Object.assign(captured, t),
    });
    expect(ids(write!.rows)).toEqual([1, 3, 4, 5, 9]);
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);
  });
});
