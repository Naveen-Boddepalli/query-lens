import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import type { StepEvent } from '../types.ts';

const db = () => createSeedDatabase();
const run = (sql: string) => runQuery(sql, db());

/** Narrows `RunResult['write']` to the `update` branch, for `updatedCount`. */
function asUpdate(write: ReturnType<typeof run>['write']) {
  return write?.kind === 'update' ? write : undefined;
}

describe('UPDATE — correctness', () => {
  it('changes exactly the matching row, via an indexed equality', () => {
    const { rows, write } = run('UPDATE users SET age = 100 WHERE id = 5');
    expect(rows).toEqual([{ id: 5, name: 'carmack', email: 'carmack@example.com', age: 100 }]);
    expect(asUpdate(write)?.updatedCount).toBe(1);
    expect(write?.rows).toHaveLength(48); // UPDATE never changes the row count
    expect(write?.rows).toContainEqual({ id: 5, name: 'carmack', email: 'carmack@example.com', age: 100 });
  });

  it('changes every matching row via a scan', () => {
    const before = db().tables.users!.rows;
    const overAge = before.filter((r) => (r.age as number) > 60);
    const { rows, write } = run('UPDATE users SET age = 0 WHERE age > 60');
    expect(rows).toHaveLength(overAge.length);
    expect(rows.every((r) => r.age === 0)).toBe(true);
    expect(write?.rows.filter((r) => r.age === 0)).toHaveLength(overAge.length);
  });

  it('a bare UPDATE with no WHERE changes every row', () => {
    const { rows, write } = run('UPDATE users SET age = 1');
    expect(rows).toHaveLength(48);
    expect(write?.rows.every((r) => r.age === 1)).toBe(true);
  });

  it('applies multiple assignments at once', () => {
    const { rows } = run("UPDATE users SET name = 'renamed', age = 33 WHERE id = 5");
    expect(rows).toEqual([{ id: 5, name: 'renamed', email: 'carmack@example.com', age: 33 }]);
  });

  it('updates nothing, and reports nothing, for a key that does not exist', () => {
    const { rows, write } = run('UPDATE users SET age = 1 WHERE id = 9999');
    expect(rows).toEqual([]);
    expect(asUpdate(write)?.updatedCount).toBe(0);
    expect(write?.rows).toEqual(db().tables.users!.rows);
  });

  it('rechecks the residual after an index lookup — a matching key but a failing extra clause changes nothing', () => {
    const { rows } = run('UPDATE users SET age = 1 WHERE id = 5 AND age = 999');
    expect(rows).toEqual([]);
  });

  it('agrees whichever access method the optimizer picks', () => {
    const indexed = run('UPDATE users SET age = 1 WHERE id = 5');
    const scanned = run('UPDATE users SET age = 1 WHERE id > 4 AND id < 6');
    expect(indexed.rows).toEqual(scanned.rows);
  });

  it('a column left untouched by SET keeps its value', () => {
    const { rows } = run('UPDATE users SET age = 1 WHERE id = 5');
    expect(rows[0]).toMatchObject({ name: 'carmack', email: 'carmack@example.com' });
  });

  it('rekeying the indexed column really moves the row in a fresh index too', () => {
    const { write } = run('UPDATE users SET id = 9000 WHERE id = 5');
    const nextDb = { tables: { users: { ...db().tables.users!, rows: write!.rows } } };
    expect(runQuery('SELECT * FROM users WHERE id = 5', nextDb).rows).toEqual([]);
    expect(runQuery('SELECT * FROM users WHERE id = 9000', nextDb).rows).toEqual([
      { id: 9000, name: 'carmack', email: 'carmack@example.com', age: 48 },
    ]);
  });

  it('setting a column to the same value it already had does not touch the index', () => {
    const { events } = run('UPDATE users SET id = 5 WHERE id = 5');
    expect(events.some((e) => e.stage === 'execute' && e.op === 'Update' && /B\+Tree/.test(e.label))).toBe(
      false,
    );
  });

  it('works on a different table and a different index too', () => {
    const orders = DATASETS.orders.make();
    const { rows, write } = runQuery("UPDATE orders SET status = 'cancelled' WHERE id = 1", orders);
    expect(rows).toHaveLength(1);
    expect(write).toMatchObject({ table: 'orders', updatedCount: 1 });
    expect(rows[0]).toMatchObject({ status: 'cancelled' });
  });

  it('a table with no index at all still updates correctly', () => {
    const noIndexDb = {
      tables: {
        things: { name: 'things', columns: ['id', 'label'], rows: [{ id: 1, label: 'a' }] },
      },
    };
    const { rows } = runQuery("UPDATE things SET label = 'z' WHERE id = 1", noIndexDb);
    expect(rows).toEqual([{ id: 1, label: 'z' }]);
  });

  it('a table with two indexes only reindexes the one whose column actually changed', () => {
    const twoIndexDb = {
      tables: {
        things: {
          name: 'things',
          columns: ['id', 'category'],
          rows: [{ id: 1, category: 'a' }],
          indexedColumns: ['id', 'category'],
        },
      },
    };
    const r = runQuery("UPDATE things SET category = 'b' WHERE id = 1", twoIndexDb);
    expect(r.rows).toEqual([{ id: 1, category: 'b' }]);

    const labels = r.events.flatMap((e) => (e.stage === 'execute' && e.op === 'Update' ? [e.label] : []));
    expect(labels.some((l) => /Because `category` changed/.test(l))).toBe(true);
    expect(labels.some((l) => /Because `id` changed/.test(l))).toBe(false);

    // The category index moved; the id index still finds the same row by its unchanged id.
    const nextDb = { tables: { things: { ...twoIndexDb.tables.things, rows: r.write!.rows } } };
    expect(runQuery("SELECT * FROM things WHERE category = 'a'", nextDb).rows).toEqual([]);
    expect(runQuery("SELECT * FROM things WHERE category = 'b'", nextDb).rows).toEqual([
      { id: 1, category: 'b' },
    ]);
    expect(runQuery('SELECT * FROM things WHERE id = 1', nextDb).rows).toEqual([{ id: 1, category: 'b' }]);
  });
});

describe('UPDATE — errors, same discipline as SELECT, DELETE and INSERT', () => {
  it('rejects an unknown table', () => {
    const out = run('UPDATE widgets SET x = 1');
    expect(out.error?.message).toMatch(/no table called `widgets`/);
    expect(out.rows).toEqual([]);
    expect(out.write).toBeUndefined();
  });

  it('rejects an unknown column in SET, pointing at it', () => {
    const out = run('UPDATE users SET bogus = 1 WHERE id = 5');
    expect(out.error?.message).toMatch(/no column called `bogus`/);
  });

  it('rejects an unknown column in WHERE, pointing at it', () => {
    const out = run('UPDATE users SET age = 1 WHERE bogus = 5');
    expect(out.error?.message).toMatch(/no column called `bogus`/);
  });
});

describe('UPDATE — the pipeline', () => {
  it('walks the same named stages an indexed SELECT does', () => {
    const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
    expect(stages(run('UPDATE users SET age = 1 WHERE id = 5').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'index',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('walks the scan stages when the predicate cannot use the index', () => {
    const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
    expect(stages(run('UPDATE users SET age = 1 WHERE age > 30').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('the optimizer still pushes the predicate down and selects the index for UPDATE', () => {
    const rules = (events: StepEvent[]) =>
      events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules(run('UPDATE users SET age = 1 WHERE id = 5').events)).toEqual([
      'predicate-pushdown',
      'index-selection',
    ]);
  });

  it('acquires an exclusive lock on every page it modifies', () => {
    const { events } = run('UPDATE users SET age = 1 WHERE age > 60');
    const modes = new Set(events.flatMap((e) => (e.stage === 'lock' ? [e.mode] : [])));
    expect(modes.has('exclusive')).toBe(true);
  });

  it('balances every lock it takes', () => {
    for (const sql of [
      'UPDATE users SET age = 1 WHERE id = 5',
      'UPDATE users SET age = 1 WHERE age > 30',
      'UPDATE users SET age = 1',
    ]) {
      let held = 0;
      for (const e of run(sql).events) {
        if (e.stage !== 'lock') continue;
        held += e.action === 'acquire' ? 1 : -1;
      }
      expect(held, sql).toBe(0);
    }
  });

  it('ends with a result event whose rows are the updated rows', () => {
    const { events, rows } = run('UPDATE users SET age = 1 WHERE age > 60');
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('the result narration reports the updated count', () => {
    const { events } = run('UPDATE users SET age = 1 WHERE id = 5');
    expect(events.at(-1)?.label).toMatch(/1 row updated/);
  });

  it('is deterministic — the same update twice gives byte-identical traces', () => {
    const a = run('UPDATE users SET age = 1 WHERE id = 5');
    const b = run('UPDATE users SET age = 1 WHERE id = 5');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('UPDATE users SET age = 1 WHERE age > 60');
    expect(structuredClone(events)).toEqual(events);
  });
});
