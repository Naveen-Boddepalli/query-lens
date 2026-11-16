/** plan.md §27.5 P3 — serial against parallel: Amdahl's law, the Karp–Flatt metric, and a query measured against itself. */

import { describe, expect, it } from 'vitest';
import { DATASETS } from '../datasets.ts';
import { amdahlSpeedup, karpFlatt, scaling } from '../parallel.ts';
import type { Scaling } from '../parallel.ts';

const db = DATASETS.transactions.make();
const run = (sql: string): Scaling => {
  const s = scaling(sql, db, { dispatch: 'stealing', morselPages: 16, rowsPerPage: 4 }, 8);
  if ('ok' in s) throw new Error(s.error);
  return s;
};

describe('Amdahl and Karp–Flatt (plan.md §27.5 P3)', () => {
  it('Amdahl: no serial part scales linearly, all of it not at all, and half of it never past two', () => {
    expect(amdahlSpeedup(0, 8)).toBe(8);
    expect(amdahlSpeedup(1, 8)).toBe(1);
    expect(amdahlSpeedup(0.5, 1_000_000)).toBeCloseTo(2, 4);
  });

  it('Karp–Flatt recovers the serial fraction Amdahl’s law was given', () => {
    for (const f of [0, 0.05, 0.3, 0.9]) {
      for (let n = 2; n <= 8; n++) expect(karpFlatt(amdahlSpeedup(f, n), n)).toBeCloseTo(f, 10);
    }
    expect(karpFlatt(1, 1)).toBeNull();
  });
});

describe('one query on one to eight workers (plan.md §27.5 P3)', () => {
  it('is measured against itself on one worker, so one worker is 1×', () => {
    const s = run('SELECT status, COUNT(*), SUM(amount) FROM transactions GROUP BY status');
    expect(s.points[0]).toMatchObject({ workers: 1, speedup: 1, efficiency: 1, amdahl: 1, karpFlatt: null });
    expect(s.points.map((p) => p.workers)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('every worker seeing all 40 accounts: the merge grows with the workers, and the serial fraction climbs', () => {
    const s = run('SELECT account, COUNT(*), SUM(amount) FROM transactions GROUP BY account');
    const kf = s.points.slice(1).map((p) => p.karpFlatt!);
    expect(kf.at(-1)!).toBeGreaterThan(kf[0]! * 1.5);
    expect(s.points[7]!.speedup).toBeLessThan(s.points[7]!.amdahl * 0.7);
    expect(s.points[7]!.speedup.toFixed(2)).toBe('4.66');
  });

  it('every id its own group: the merge is the same 3,000 groups however many workers, and Amdahl explains the run', () => {
    const s = run('SELECT id, COUNT(*) FROM transactions GROUP BY id');
    expect(s.serialFraction).toBeGreaterThan(0.4);
    const kf = s.points.slice(1).map((p) => p.karpFlatt!);
    expect(Math.max(...kf) - Math.min(...kf)).toBeLessThan(0.01);
    for (const p of s.points) expect(Math.abs(p.speedup - p.amdahl) / p.amdahl).toBeLessThan(0.03);
  });
});
