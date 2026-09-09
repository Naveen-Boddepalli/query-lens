import { describe, expect, it } from 'vitest';
import { createSeedDatabase, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../../engine/index.ts';
import { CHALLENGES, challengeById, challengeStats } from '../challenges.tsx';

const SEED = createSeedDatabase();
const run = (sql: string) => runQuery(sql, SEED, DEFAULT_ENGINE_OPTIONS);

describe('challenges', () => {
  it('has unique ids', () => {
    const ids = CHALLENGES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every starter query parses and does NOT already pass', () => {
    for (const c of CHALLENGES) {
      const r = run(c.starter);
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
  };

  it('accepts a known solution', () => {
    for (const c of CHALLENGES) {
      const sql = solutions[c.id];
      expect(sql, `no solution wired for ${c.id}`).toBeTruthy();
      const r = run(sql!);
      expect(r.error).toBeUndefined();
      expect(c.check(r), `${c.id} rejected its solution`).toBe(true);
    }
  });

  it('challengeById round-trips', () => {
    for (const c of CHALLENGES) expect(challengeById(c.id)).toBe(c);
    expect(challengeById('nope')).toBeUndefined();
  });

  it('challengeStats reports the numbers the page shows', () => {
    const s = challengeStats(run('SELECT * FROM users WHERE id = 5;'));
    expect(s.rows).toBe(1);
    expect(s.usesIndex).toBe(true);
    expect(s.diskReads).toBeGreaterThanOrEqual(0);
    expect(s.evictions).toBe(0);
  });
});
