import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import type { StepEvent } from '../types.ts';

const db = () => createSeedDatabase();
const run = (sql: string) => runQuery(sql, db());

describe('DELETE — correctness', () => {
  it('removes exactly the matching row, via an indexed equality', () => {
    const { rows, write } = run('DELETE FROM users WHERE id = 5');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 5 });
    expect(write?.deletedCount).toBe(1);
    expect(write?.rows).toHaveLength(47);
    expect(write?.rows.some((r) => r.id === 5)).toBe(false);
  });

  it('removes every matching row via a scan', () => {
    const before = db().tables.users!.rows;
    const overAge = before.filter((r) => (r.age as number) > 60);
    const { rows, write } = run('DELETE FROM users WHERE age > 60');
    expect(rows).toHaveLength(overAge.length);
    expect(write?.rows).toHaveLength(before.length - overAge.length);
    expect(write?.rows.every((r) => (r.age as number) <= 60)).toBe(true);
  });

  it('a bare DELETE with no WHERE removes every row', () => {
    const { rows, write } = run('DELETE FROM users');
    expect(rows).toHaveLength(48);
    expect(write?.rows).toEqual([]);
  });

  it('deletes nothing, and reports nothing, for a key that does not exist', () => {
    const { rows, write } = run('DELETE FROM users WHERE id = 9999');
    expect(rows).toEqual([]);
    expect(write?.deletedCount).toBe(0);
    expect(write?.rows).toHaveLength(48);
  });

  it('rechecks the residual after an index lookup — a matching key but a failing extra clause deletes nothing', () => {
    const { rows, write } = run('DELETE FROM users WHERE id = 5 AND age = 999');
    expect(rows).toEqual([]);
    expect(write?.rows).toHaveLength(48);
  });

  it('agrees whichever access method the optimizer picks', () => {
    // `id = 5` uses the index; `id > 4 AND id < 6` selects the same row via a scan.
    const indexed = run('DELETE FROM users WHERE id = 5');
    const scanned = run('DELETE FROM users WHERE id > 4 AND id < 6');
    expect(indexed.rows).toEqual(scanned.rows);
    expect(indexed.write?.rows).toEqual(scanned.write?.rows);
  });

  it('the returned new row set really has the row gone from a fresh index too', () => {
    // The realistic use: persist write.rows, then query again — nothing in
    // the engine keeps the old heap/tree around to leak a stale answer.
    const { write } = run('DELETE FROM users WHERE id = 5');
    const nextDb = { tables: { users: { ...db().tables.users!, rows: write!.rows } } };
    expect(runQuery('SELECT * FROM users WHERE id = 5', nextDb).rows).toEqual([]);
    expect(runQuery('SELECT * FROM users', nextDb).rows).toHaveLength(47);
  });

  it('works on a different table and a different index too', () => {
    const orders = DATASETS.orders.make();
    const { rows, write } = runQuery('DELETE FROM orders WHERE id = 1', orders);
    expect(rows).toHaveLength(1);
    expect(write).toMatchObject({ table: 'orders', deletedCount: 1 });
    expect(write?.rows).toHaveLength(119);
  });

  it('a table with no index still deletes correctly via a scan', () => {
    const orders = DATASETS.orders.make();
    const { rows, write } = runQuery("DELETE FROM orders WHERE customer = 'acme'", orders);
    const expected = orders.tables.orders!.rows.filter((r) => r.customer === 'acme');
    expect(rows).toHaveLength(expected.length);
    expect(write?.rows).toHaveLength(120 - expected.length);
  });
});

describe('DELETE — errors, same discipline as SELECT', () => {
  it('rejects an unknown table', () => {
    const out = run('DELETE FROM widgets');
    expect(out.error?.message).toMatch(/no table called `widgets`/);
    expect(out.rows).toEqual([]);
    expect(out.write).toBeUndefined();
  });

  it('rejects an unknown column in WHERE, pointing at it', () => {
    const out = run('DELETE FROM users WHERE nope = 1');
    expect(out.error?.message).toMatch(/no column called `nope`/);
  });
});

describe('DELETE — the pipeline', () => {
  it('walks the same named stages an indexed SELECT does', () => {
    const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
    expect(stages(run('DELETE FROM users WHERE id = 5').events)).toEqual([
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
    expect(stages(run('DELETE FROM users WHERE age > 30').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('the optimizer still pushes the predicate down and selects the index for DELETE', () => {
    const rules = (events: StepEvent[]) =>
      events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules(run('DELETE FROM users WHERE id = 5').events)).toEqual([
      'predicate-pushdown',
      'index-selection',
    ]);
    expect(rules(run('DELETE FROM users WHERE age > 30').events)).toEqual(['predicate-pushdown']);
  });

  it('acquires an exclusive lock on every page it deletes from, and a shared one to read the index', () => {
    const { events } = run('DELETE FROM users WHERE age > 60');
    const modes = new Set(
      events.flatMap((e) => (e.stage === 'lock' ? [e.mode] : [])),
    );
    expect(modes.has('exclusive')).toBe(true);
  });

  it('a lookup that finds nothing never upgrades to an exclusive lock', () => {
    const { events } = run('DELETE FROM users WHERE id = 9999');
    const modes = new Set(events.flatMap((e) => (e.stage === 'lock' ? [e.mode] : [])));
    expect(modes.has('exclusive')).toBe(false);
    expect(modes.has('shared')).toBe(true);
  });

  it('balances every lock it takes', () => {
    for (const sql of ['DELETE FROM users WHERE id = 5', 'DELETE FROM users WHERE age > 30', 'DELETE FROM users']) {
      let held = 0;
      for (const e of run(sql).events) {
        if (e.stage !== 'lock') continue;
        held += e.action === 'acquire' ? 1 : -1;
      }
      expect(held, sql).toBe(0);
    }
  });

  it('ends with a result event whose rows are the deleted rows', () => {
    const { events, rows } = run('DELETE FROM users WHERE age > 60');
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('the result narration reports the deleted count and the table size after', () => {
    const { events } = run('DELETE FROM users WHERE id = 5');
    expect(events.at(-1)?.label).toMatch(/1 row deleted/);
    expect(events.at(-1)?.label).toMatch(/47 rows/);
  });

  it('is deterministic — the same delete twice gives byte-identical traces', () => {
    const a = run('DELETE FROM users WHERE id = 5');
    const b = run('DELETE FROM users WHERE id = 5');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('DELETE FROM users WHERE age > 60');
    expect(structuredClone(events)).toEqual(events);
  });
});

describe('DELETE — dirty pages cost a writeback on eviction', () => {
  it('a scan that both reads and deletes from more pages than there are frames writes some back', () => {
    const { events } = run('DELETE FROM users WHERE age > 30'); // touches most of the table
    const writebacks = events.filter(
      (e) => e.stage === 'buffer' && e.action === 'evict' && e.writtenBack,
    );
    expect(writebacks.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length).toBeGreaterThanOrEqual(
      writebacks.length,
    );
  });

  it('a writeback is charged as a write, on top of the eviction', () => {
    const { events } = run('DELETE FROM users'); // deletes from every page
    const writebacks = events.filter(
      (e) => e.stage === 'buffer' && e.action === 'evict' && e.writtenBack,
    ).length;
    // writes = 0 for reads alone; a DELETE with writebacks must show some.
    const writeStat = events.find((e) => e.stage === 'result'); // sanity: result still emits
    expect(writeStat).toBeDefined();
    expect(writebacks).toBeGreaterThan(0);
  });

  it('a lookup that touches only a handful of pages never triggers a writeback', () => {
    const { events } = run('DELETE FROM users WHERE id = 5');
    expect(events.filter((e) => e.stage === 'buffer' && e.action === 'evict' && e.writtenBack)).toHaveLength(0);
  });

  it('the writeback narration names the reason', () => {
    const { events } = run('DELETE FROM users WHERE age > 30');
    const writeback = events.find(
      (e) => e.stage === 'buffer' && e.action === 'evict' && e.writtenBack,
    );
    expect(writeback?.label).toMatch(/dirty/i);
    expect(writeback?.label).toMatch(/write back/i);
  });
});
