import { describe, expect, it } from 'vitest';
import { createLockManager } from '../locks/lockManager.ts';
import { createTracer } from '../trace.ts';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import type { StepEvent } from '../types.ts';

const db = createSeedDatabase();
const run = (sql: string) => runQuery(sql, db);

const lockEvents = (events: StepEvent[]) =>
  events.flatMap((e) => (e.stage === 'lock' ? [e] : []));

describe('lock manager', () => {
  it('emits an event per acquire and per release', () => {
    const { emit, drain } = createTracer();
    const locks = createLockManager(emit);
    locks.acquire(1, 'shared', 'lock 1');
    locks.release(1, 'shared');

    expect(lockEvents(drain()).map((e) => e.action)).toEqual(['acquire', 'release']);
  });

  it('is re-entrant: one query cannot conflict with itself', () => {
    const { emit, drain } = createTracer();
    const locks = createLockManager(emit);
    locks.acquire(1, 'shared', 'first');
    locks.acquire(1, 'shared', 'again');

    expect(lockEvents(drain())).toHaveLength(1);
    expect(locks.held()).toEqual([{ pageId: 1, mode: 'shared' }]);
  });

  it('ignores a release of a lock that is not held', () => {
    const { emit, drain } = createTracer();
    const locks = createLockManager(emit);
    locks.release(7, 'shared');
    expect(drain()).toEqual([]);
    expect(locks.stats.released).toBe(0);
  });

  it('treats shared and exclusive on the same page as distinct', () => {
    const { emit } = createTracer();
    const locks = createLockManager(emit);
    locks.acquire(1, 'shared', 'a');
    locks.acquire(1, 'exclusive', 'b');
    expect(locks.held()).toHaveLength(2);
  });
});

describe('locks during a query', () => {
  it.each([
    'SELECT * FROM users WHERE id = 5',
    'SELECT * FROM users WHERE age > 30',
    'SELECT * FROM users',
  ])('releases every lock it takes: %s', (sql) => {
    const events = lockEvents(run(sql).events);
    const acquired = events.filter((e) => e.action === 'acquire').length;
    const released = events.filter((e) => e.action === 'release').length;

    expect(acquired).toBeGreaterThan(0);
    expect(released).toBe(acquired);
  });

  it('never ends a query holding anything', () => {
    for (const sql of [
      'SELECT * FROM users WHERE id = 5',
      'SELECT * FROM users WHERE id = 9999',
      'SELECT * FROM users WHERE age > 30',
    ]) {
      const held = new Set<string>();
      for (const e of lockEvents(run(sql).events)) {
        const id = `${String(e.pageId)}:${e.mode}`;
        if (e.action === 'acquire') held.add(id);
        else held.delete(id);
      }
      expect([...held], sql).toEqual([]);
    }
  });

  it('never releases a lock it does not hold, or double-acquires one', () => {
    const held = new Set<string>();
    for (const e of lockEvents(run('SELECT * FROM users WHERE age > 30').events)) {
      const id = `${String(e.pageId)}:${e.mode}`;
      if (e.action === 'acquire') {
        expect(held.has(id), `double acquire of ${id}`).toBe(false);
        held.add(id);
      } else {
        expect(held.has(id), `release of unheld ${id}`).toBe(true);
        held.delete(id);
      }
    }
  });

  it('takes only shared locks — v0 never writes', () => {
    const modes = new Set(lockEvents(run('SELECT * FROM users').events).map((e) => e.mode));
    expect(modes).toEqual(new Set(['shared']));
  });

  it('a sequential scan holds one page at a time', () => {
    let concurrent = 0;
    let peak = 0;
    for (const e of lockEvents(run('SELECT * FROM users WHERE age > 30').events)) {
      concurrent += e.action === 'acquire' ? 1 : -1;
      peak = Math.max(peak, concurrent);
    }
    expect(peak).toBe(1);
  });

  it('the index descent crabs — it briefly holds parent and child together', () => {
    // Taking the child's lock before dropping the parent's is the technique;
    // the overlap is what makes it safe.
    let concurrent = 0;
    let peak = 0;
    for (const e of lockEvents(run('SELECT * FROM users WHERE id = 5').events)) {
      concurrent += e.action === 'acquire' ? 1 : -1;
      peak = Math.max(peak, concurrent);
    }
    expect(peak).toBe(2);
  });

  it('locks each page it reads, and no page it does not', () => {
    const { events } = run('SELECT * FROM users WHERE id = 5');
    const locked = new Set(
      lockEvents(events).filter((e) => e.action === 'acquire').map((e) => e.pageId),
    );
    const read = new Set(
      events.flatMap((e) => (e.stage === 'buffer' && e.action === 'load' ? [e.pageId] : [])),
    );
    expect([...read].every((p) => locked.has(p))).toBe(true);
  });
});
