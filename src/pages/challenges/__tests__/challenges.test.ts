import { describe, expect, it } from 'vitest';
import { DATASETS, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../../engine/index.ts';
import { CHALLENGES, challengeById, challengeDataset, challengeStats } from '../challenges.tsx';
import type { Challenge } from '../challenges.tsx';

const runOn = (c: Challenge, sql: string) =>
  runQuery(sql, DATASETS[challengeDataset(c)].make(), DEFAULT_ENGINE_OPTIONS);

describe('challenges', () => {
  it('has unique ids', () => {
    const ids = CHALLENGES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every starter query parses and does NOT already pass', () => {
    for (const c of CHALLENGES) {
      const r = runOn(c, c.starter);
      expect(r.error, `${c.id} starter errored: ${r.error?.message ?? ''}`).toBeUndefined();
      expect(c.check(r), `${c.id} starter should not pass`).toBe(false);
    }
  });

  // One known solution per challenge — the check must accept it.
  const solutions: Record<string, string> = {
    'use-the-index': 'SELECT * FROM users WHERE id = 5;',
    'eviction-storm': 'SELECT * FROM users WHERE age > 10;',
    'exactly-one': 'SELECT * FROM users WHERE id = 5;',
    'empty-but-not-free': 'SELECT * FROM users WHERE age > 200;',
    'and-that-matches': "SELECT * FROM users WHERE id = 5 AND age > 0;",
    'push-it-down': 'SELECT * FROM users WHERE age > 30;',
    'deep-descent': 'SELECT * FROM orders WHERE id = 42;',
    'needle-in-the-skew': "SELECT * FROM logins WHERE status = 'blocked';",
  };

  it('has a solution wired for every challenge', () => {
    expect(Object.keys(solutions).sort()).toEqual(CHALLENGES.map((c) => c.id).sort());
  });

  it('accepts a known solution', () => {
    for (const c of CHALLENGES) {
      const sql = solutions[c.id];
      expect(sql, `no solution wired for ${c.id}`).toBeTruthy();
      const r = runOn(c, sql!);
      expect(r.error).toBeUndefined();
      expect(c.check(r), `${c.id} rejected its solution`).toBe(true);
    }
  });

  it('challengeById round-trips', () => {
    for (const c of CHALLENGES) expect(challengeById(c.id)).toBe(c);
    expect(challengeById('nope')).toBeUndefined();
  });

  it('challengeStats reports the numbers the page shows', () => {
    const s = challengeStats(
      runQuery('SELECT * FROM users WHERE id = 5;', DATASETS.users.make(), DEFAULT_ENGINE_OPTIONS),
    );
    expect(s.rows).toBe(1);
    expect(s.usesIndex).toBe(true);
    expect(s.diskReads).toBeGreaterThanOrEqual(0);
    expect(s.evictions).toBe(0);
  });

  it('challenges name only real datasets', () => {
    for (const c of CHALLENGES) {
      expect(DATASETS[challengeDataset(c)], `${c.id} names an unknown dataset`).toBeTruthy();
    }
  });
});
