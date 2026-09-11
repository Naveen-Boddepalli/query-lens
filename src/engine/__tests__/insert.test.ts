import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import type { StepEvent } from '../types.ts';

const db = () => createSeedDatabase();
const run = (sql: string) => runQuery(sql, db());

/** Narrows `RunResult['write']` to the `insert` branch, for `insertedCount`. */
function asInsert(write: ReturnType<typeof run>['write']) {
  return write?.kind === 'insert' ? write : undefined;
}

describe('INSERT — correctness', () => {
  it('adds the row with an explicit column list', () => {
    const { rows, write } = run("INSERT INTO users (id, name, email, age) VALUES (999, 'zeta', 'zeta@example.com', 50)");
    expect(rows).toEqual([{ id: 999, name: 'zeta', email: 'zeta@example.com', age: 50 }]);
    expect(asInsert(write)?.insertedCount).toBe(1);
    expect(write?.rows).toHaveLength(49);
    expect(write?.rows).toContainEqual({ id: 999, name: 'zeta', email: 'zeta@example.com', age: 50 });
  });

  it('omitting the column list means every column, in table order', () => {
    const { rows } = run("INSERT INTO users VALUES (999, 'zeta', 'zeta@example.com', 50)");
    expect(rows).toEqual([{ id: 999, name: 'zeta', email: 'zeta@example.com', age: 50 }]);
  });

  it('a column left out of an explicit list defaults to NULL', () => {
    const { rows } = run("INSERT INTO users (id, name) VALUES (999, 'zeta')");
    expect(rows).toEqual([{ id: 999, name: 'zeta', email: null, age: null }]);
  });

  it('the returned new row set really has the row there on a fresh query too', () => {
    const { write } = run("INSERT INTO users (id, name, email, age) VALUES (999, 'zeta', 'zeta@example.com', 50)");
    const nextDb = { tables: { users: { ...db().tables.users!, rows: write!.rows } } };
    expect(runQuery('SELECT * FROM users WHERE id = 999', nextDb).rows).toEqual([
      { id: 999, name: 'zeta', email: 'zeta@example.com', age: 50 },
    ]);
    expect(runQuery('SELECT * FROM users', nextDb).rows).toHaveLength(49);
  });

  it('works on a different table and a different index too', () => {
    const orders = DATASETS.orders.make();
    const before = orders.tables.orders!.rows.length;
    const { rows, write } = runQuery(
      "INSERT INTO orders (id, customer, total, status) VALUES (9999, 'acme', 42, 'shipped')",
      orders,
    );
    expect(rows).toHaveLength(1);
    expect(write).toMatchObject({ table: 'orders', insertedCount: 1 });
    expect(write?.rows).toHaveLength(before + 1);
  });

  it('a table with no index at all still inserts correctly', () => {
    const noIndexDb = {
      tables: {
        things: { name: 'things', columns: ['id', 'label'], rows: [{ id: 1, label: 'a' }] },
      },
    };
    const { rows, write } = runQuery("INSERT INTO things (id, label) VALUES (2, 'b')", noIndexDb);
    expect(rows).toEqual([{ id: 2, label: 'b' }]);
    expect(write?.rows).toHaveLength(2);
  });

  it('lands on the last page when it has room, and on a fresh page when it is full', () => {
    // The seed table is exactly full (48 rows, 4 per page) — the very next
    // insert must land on a fresh page.
    const full = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    expect(full.events.some((e) => e.stage === 'buffer' && e.action === 'write')).toBe(true);
    expect(full.events.some((e) => e.stage === 'buffer' && e.action === 'load')).toBe(false);

    const deleted = runQuery('DELETE FROM users WHERE id = 1', db());
    const roomyDb = { tables: { users: { ...db().tables.users!, rows: deleted.write!.rows } } };
    const roomy = runQuery("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)", roomyDb);
    expect(roomy.events.some((e) => e.stage === 'buffer' && e.action === 'load')).toBe(true);
    expect(roomy.events.some((e) => e.stage === 'buffer' && e.action === 'write')).toBe(false);
  });

  it('a leaf that overflows really splits, through the real B+Tree algorithm', () => {
    let current = db();
    let sawSplit = false;
    for (let i = 1; i <= 10; i++) {
      const r = runQuery(
        `INSERT INTO users (id, name, email, age) VALUES (${6000 + i}, 'x', 'x@example.com', 1)`,
        current,
      );
      expect(r.error).toBeUndefined();
      current = { tables: { users: { ...current.tables.users!, rows: r.write!.rows } } };
      if (r.events.some((e) => e.stage === 'execute' && e.op === 'Insert' && /split added/.test(e.label))) {
        sawSplit = true;
        break;
      }
    }
    expect(sawSplit).toBe(true);
  });
});

describe('INSERT — errors, same discipline as SELECT and DELETE', () => {
  it('rejects an unknown table', () => {
    const out = run("INSERT INTO widgets VALUES (1)");
    expect(out.error?.message).toMatch(/no table called `widgets`/);
    expect(out.rows).toEqual([]);
    expect(out.write).toBeUndefined();
  });

  it('rejects an unknown column in an explicit column list, pointing at it', () => {
    const out = run("INSERT INTO users (id, bogus) VALUES (1, 2)");
    expect(out.error?.message).toMatch(/no column called `bogus`/);
  });

  it('rejects a value count that does not match the table, when no column list is given', () => {
    const out = run("INSERT INTO users VALUES (1, 'a')");
    expect(out.error?.message).toMatch(/4 columns, but this INSERT gives 2 values/);
  });

  it('rejects a value count that does not match an explicit column list, at parse time', () => {
    const out = run("INSERT INTO users (id) VALUES (1, 2)");
    expect(out.error?.message).toMatch(/1 column but 2 values/);
  });

  it('rejects a column name inside VALUES, explaining where column names belong', () => {
    const out = run('INSERT INTO users (id) VALUES (age)');
    expect(out.error?.message).toMatch(/Expected a value/);
    expect(out.error?.hint).toMatch(/before VALUES/);
  });
});

describe('INSERT — the pipeline', () => {
  it('has nothing to plan or optimize — INSERT with literal values goes straight from parse to execute', () => {
    const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
    expect(stages(run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)").events)).toEqual([
      'parse',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('acquires an exclusive lock on the page it writes to', () => {
    const { events } = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    const modes = new Set(events.flatMap((e) => (e.stage === 'lock' ? [e.mode] : [])));
    expect(modes.has('exclusive')).toBe(true);
  });

  it('balances every lock it takes', () => {
    let held = 0;
    for (const e of run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)").events) {
      if (e.stage !== 'lock') continue;
      held += e.action === 'acquire' ? 1 : -1;
    }
    expect(held).toBe(0);
  });

  it('ends with a result event whose rows are the inserted row', () => {
    const { events, rows } = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('the result narration reports the inserted row and the table size after', () => {
    const { events } = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    expect(events.at(-1)?.label).toMatch(/1 row inserted/);
    expect(events.at(-1)?.label).toMatch(/49 rows/);
  });

  it('is deterministic — the same insert twice gives byte-identical traces', () => {
    const a = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    const b = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run("INSERT INTO users VALUES (999, 'a', 'a@example.com', 1)");
    expect(structuredClone(events)).toEqual(events);
  });
});
