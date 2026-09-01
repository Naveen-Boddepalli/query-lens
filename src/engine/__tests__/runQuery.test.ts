import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { IMPLEMENTED_STAGES } from '../types.ts';
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

  it('walks parse → plan → optimize in order', () => {
    expect(stages(run('SELECT * FROM users WHERE id = 5').events)).toEqual([
      'parse',
      'plan',
      'optimize',
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

  it('produces a longer trace for the indexed query than the scan', () => {
    // plan.md §9: the two queries are meant to be contrasted side by side.
    const indexed = run('SELECT * FROM users WHERE id = 5').events.length;
    const scan = run('SELECT * FROM users WHERE age > 30').events.length;
    expect(indexed).toBeGreaterThan(scan);
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
