import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DEFAULT_ENGINE_OPTIONS, IMPLEMENTED_STAGES } from '../types.ts';
import type { StepEvent } from '../types.ts';

const db = createSeedDatabase();
const run = (sql: string) => runQuery(sql, db);
const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
const rules = (events: StepEvent[]) =>
  events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));

describe('runQuery', () => {
  it('emits only stages the engine actually implements', () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT * FROM users WHERE id = 5',
      'SELECT name FROM users WHERE age > 30',
    ]) {
      for (const stage of stages(run(sql).events)) {
        expect(IMPLEMENTED_STAGES, sql).toContain(stage);
      }
    }
  });

  it('walks the pipeline in order for an indexed lookup', () => {
    expect(stages(run('SELECT * FROM users WHERE id = 5').events)).toEqual([
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

  it('walks the pipeline in order for a sequential scan — no index stage', () => {
    expect(stages(run('SELECT * FROM users WHERE age > 30').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('gives every event a sequential id and a non-empty label', () => {
    const { events } = run('SELECT * FROM users WHERE id = 5');
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.label.trim().length > 0)).toBe(true);
  });

  it('applies both rules for an indexed equality', () => {
    expect(rules(run('SELECT * FROM users WHERE id = 5').events)).toEqual([
      'predicate-pushdown',
      'index-selection',
    ]);
  });

  it('applies only pushdown for a range predicate — the scan stays sequential', () => {
    expect(rules(run('SELECT * FROM users WHERE age > 30').events)).toEqual([
      'predicate-pushdown',
    ]);
  });

  it('says so explicitly when no rule fires', () => {
    const { events } = run('SELECT * FROM users');
    expect(rules(events)).toEqual(['none']);
    const optimize = events.find((e) => e.stage === 'optimize');
    expect(optimize?.label).toMatch(/no rewrite/i);
  });

  it('gives the indexed query one more optimizer step than the scan', () => {
    // plan.md §9: the two queries are meant to be contrasted side by side.
    expect(rules(run('SELECT * FROM users WHERE id = 5').events)).toHaveLength(2);
    expect(rules(run('SELECT * FROM users WHERE age > 30').events)).toHaveLength(1);
  });

  it('makes the scan read every page, and evict', () => {
    const { events } = run('SELECT * FROM users WHERE age > 30');
    const loads = events.filter((e) => e.stage === 'buffer' && e.action === 'load');
    const evictions = events.filter((e) => e.stage === 'buffer' && e.action === 'evict');
    const pages = Math.ceil(db.tables.users!.rows.length / DEFAULT_ENGINE_OPTIONS.rowsPerPage);

    expect(loads).toHaveLength(pages);
    expect(evictions).toHaveLength(pages - DEFAULT_ENGINE_OPTIONS.bufferFrames);
  });

  it('reads dramatically fewer pages through the index than through a scan', () => {
    // plan.md §9: this contrast is the demo. The scan reads every page; the
    // lookup reads one node per tree level plus the heap page holding the row.
    const diskReads = (sql: string) =>
      run(sql).events.filter((e) => e.stage === 'buffer' && e.action === 'load').length;

    const indexed = diskReads('SELECT * FROM users WHERE id = 5');
    const scan = diskReads('SELECT * FROM users WHERE age > 30');

    expect(indexed).toBeLessThan(scan / 2);
    expect(scan).toBe(Math.ceil(db.tables.users!.rows.length / DEFAULT_ENGINE_OPTIONS.rowsPerPage));
  });

  it('the index lookup never evicts — it touches too few pages to fill the pool', () => {
    const { events } = run('SELECT * FROM users WHERE id = 5');
    expect(events.filter((e) => e.stage === 'buffer' && e.action === 'evict')).toHaveLength(0);
  });

  it('finds a key that exists and reports a miss for one that does not', () => {
    const found = run('SELECT * FROM users WHERE id = 5').events;
    expect(found.some((e) => e.stage === 'index' && e.action === 'found')).toBe(true);

    const absent = run('SELECT * FROM users WHERE id = 9999').events;
    expect(absent.some((e) => e.stage === 'index' && e.action === 'not-found')).toBe(true);
  });

  it('opens the tree exactly once, before traversing it', () => {
    const indexEvents = run('SELECT * FROM users WHERE id = 5').events.filter(
      (e) => e.stage === 'index',
    );
    expect(indexEvents.filter((e) => e.action === 'open')).toHaveLength(1);
    expect(indexEvents[0]?.action).toBe('open');
  });

  it('a LIMIT reads fewer pages than the unbounded scan it caps', () => {
    const pagesLoaded = (sql: string) =>
      run(sql).events.filter((e) => e.stage === 'buffer' && e.action === 'load').length;
    expect(pagesLoaded('SELECT * FROM users LIMIT 1')).toBeLessThan(pagesLoaded('SELECT * FROM users'));
  });

  it('a LIMIT past the whole table reads exactly as many pages as the unbounded scan', () => {
    const pagesLoaded = (sql: string) =>
      run(sql).events.filter((e) => e.stage === 'buffer' && e.action === 'load').length;
    expect(pagesLoaded('SELECT * FROM users LIMIT 9999')).toBe(pagesLoaded('SELECT * FROM users'));
  });

  it('an ORDER BY still walks the same named stages — Sort adds no new stage of its own', () => {
    expect(stages(run('SELECT * FROM users ORDER BY age').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('an ORDER BY on the indexed equality still walks the index', () => {
    expect(stages(run('SELECT * FROM users WHERE id = 5 ORDER BY age').events)).toEqual([
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

  it('ORDER BY writes real spill pages through the buffer pool, competing with the heap for frames', () => {
    const { events } = run('SELECT * FROM users ORDER BY age');
    const writes = events.filter((e) => e.stage === 'buffer' && e.action === 'write');
    const evictions = events.filter((e) => e.stage === 'buffer' && e.action === 'evict');
    expect(writes.length).toBeGreaterThan(0);
    // Every write has a distinct page id — never overwrites a still-needed page.
    const writtenIds = writes.map((e) => (e.stage === 'buffer' && e.action === 'write' ? e.pageId : -1));
    expect(new Set(writtenIds).size).toBe(writtenIds.length);
    // The spill and the heap scan share only 8 frames, so eviction is real.
    expect(evictions.length).toBeGreaterThan(0);
  });

  it('a plain query with no ORDER BY writes nothing', () => {
    const { events } = run('SELECT * FROM users WHERE id = 5');
    expect(events.filter((e) => e.stage === 'buffer' && e.action === 'write')).toHaveLength(0);
  });
});

describe('runQuery — errors', () => {
  it('returns no events at all when parsing fails', () => {
    const out = run('SELECT * FROM');
    expect(out.events).toEqual([]);
    expect(out.error?.message).toMatch(/table name/i);
  });

  it('rejects an unknown table and names the ones that exist', () => {
    const out = run('SELECT * FROM widgets');
    expect(out.error?.message).toMatch(/no table called `widgets`/);
    expect(out.error?.hint).toMatch(/users/);
    expect(out.events).toEqual([]);
  });

  it('rejects an unknown column in the SELECT list, pointing at it', () => {
    const sql = 'SELECT id, nope FROM users';
    const out = run(sql);
    expect(out.error?.message).toMatch(/no column called `nope`/);
    expect(sql.slice(out.error?.from, out.error?.to)).toBe('nope');
  });

  it('rejects an unknown column in the WHERE clause', () => {
    const out = run('SELECT * FROM users WHERE missing = 1');
    expect(out.error?.message).toMatch(/no column called `missing`/);
    expect(out.error?.hint).toMatch(/id, name, email, age/);
  });

  it('accepts every column the seed table declares', () => {
    for (const column of db.tables.users!.columns) {
      expect(run(`SELECT ${column} FROM users`).error, column).toBeUndefined();
    }
  });
});
