/** plan.md §27.5 P1 — morsel-driven execution: the timeline is well formed, and the merged answer is the engine's own. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DATASETS } from '../datasets.ts';
import { runParallel } from '../parallel.ts';
import type { Dispatch, ParallelOptions, ParallelResult } from '../parallel.ts';
import { runQuery } from '../runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Row } from '../types.ts';

const db = DATASETS.transactions.make();
const options = (over: Partial<ParallelOptions> = {}): ParallelOptions => ({
  workers: 4,
  morselPages: 16,
  dispatch: 'shared',
  speeds: [1, 1, 1, 1],
  rowsPerPage: DEFAULT_ENGINE_OPTIONS.rowsPerPage,
  ...over,
});
const ok = (r: ReturnType<typeof runParallel>): ParallelResult => {
  if (!r.ok) throw new Error(r.error);
  return r;
};
/** Rows as a sorted multiset, numbers to nine places — the order groups come out in is not part of the answer. */
const canonical = (rows: readonly Row[]) =>
  rows.map((row) => JSON.stringify(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? Number(v.toFixed(9)) : v]))).sort();

const GROUPED = 'SELECT status, COUNT(*), SUM(amount) FROM transactions GROUP BY status';
const SKEWED = 'SELECT COUNT(*), SUM(amount) FROM transactions WHERE id <= 600';

describe('the merged answer (plan.md §27.5 P1)', () => {
  it('is what the engine returns serially, for any query, workers, dispatch, morsel size and speeds', () => {
    const aggregate = fc.constantFrom('COUNT(*)', 'COUNT(account)', 'SUM(amount)', 'AVG(amount)', 'MIN(amount)', 'MAX(amount)', 'MAX(status)', 'MIN(id)');
    const where = fc.constantFrom('', 'WHERE amount > 2500', 'WHERE id <= 600', "WHERE status = 'failed'", 'WHERE amount < 0', 'WHERE id > 2900 OR amount < 100');
    const group = fc.constantFrom<string[]>([], ['status'], ['account'], ['status', 'account']);
    const sqlArb = fc.tuple(fc.uniqueArray(aggregate, { minLength: 1, maxLength: 3 }), where, group).map(([aggs, w, g]) => {
      const items = [...g, ...aggs].join(', ');
      return `SELECT ${items} FROM transactions ${w}${g.length > 0 ? ` GROUP BY ${g.join(', ')}` : ''}`;
    });
    fc.assert(
      fc.property(
        sqlArb,
        fc.integer({ min: 1, max: 8 }),
        fc.constantFrom<Dispatch>('static', 'shared', 'stealing'),
        fc.integer({ min: 1, max: 64 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 8, maxLength: 8 }),
        (sql, workers, dispatch, morselPages, speeds) => {
          const parallel = ok(runParallel(sql, db, options({ workers, dispatch, morselPages, speeds })));
          const serial = runQuery(sql, db, DEFAULT_ENGINE_OPTIONS);
          expect(serial.error, sql).toBeUndefined();
          expect(canonical(parallel.rows), sql).toEqual(canonical(serial.rows));
          if (serial.rows.length > 0) expect(parallel.columns, sql).toEqual(Object.keys(serial.rows[0]!));
        },
      ),
      { numRuns: 120, seed: 1 },
    );
  });

  it('refuses what cannot be split and merged, and says why', () => {
    const error = (sql: string) => {
      const r = runParallel(sql, db, options());
      return r.ok ? null : r.error;
    };
    expect(error('SELECT * FROM transactions')).toMatch(/a scan, a filter and an aggregate/);
    expect(error('SELECT COUNT(*) FROM transactions ORDER BY COUNT(*)')).toMatch(/a scan, a filter and an aggregate/);
    // The parser's own rule comes first.
    expect(error('SELECT status, COUNT(*) FROM transactions')).toBe('`status` is not aggregated.');
    expect(error('SELECT COUNT(DISTINCT account) FROM transactions')).toMatch(/cannot be merged from partial counts/);
    expect(error('SELECT COUNT(*) FROM nowhere')).toMatch(/no table named nowhere/);
  });
});

describe('the timeline (plan.md §27.5 P1)', () => {
  it('runs every morsel once, covers every page once, and never gives a worker two things at once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.constantFrom<Dispatch>('static', 'shared', 'stealing'),
        fc.integer({ min: 1, max: 64 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 8, maxLength: 8 }),
        fc.constantFrom(GROUPED, SKEWED),
        (workers, dispatch, morselPages, speeds, sql) => {
          const r = ok(runParallel(sql, db, options({ workers, dispatch, morselPages, speeds })));
          expect(r.runs.map((x) => x.morsel).sort((a, b) => a - b)).toEqual(r.morsels.map((m) => m.id));
          const covered = r.morsels.flatMap((m) => Array.from({ length: m.lastPage - m.firstPage + 1 }, (_, i) => m.firstPage + i));
          expect(covered).toEqual(Array.from({ length: r.pages }, (_, i) => i));
          for (let w = 0; w < workers; w++) {
            const mine = r.runs.filter((x) => x.worker === w).sort((a, b) => a.taken - b.taken);
            for (let k = 1; k < mine.length; k++) expect(mine[k]!.taken).toBeGreaterThanOrEqual(mine[k - 1]!.end);
          }
          // A run costs its work and its remote reads at the worker's speed, after the dispatch.
          for (const run of r.runs) {
            const m = r.morsels[run.morsel]!;
            const dispatchCost = dispatch === 'static' ? 0 : run.stolenFrom === undefined ? 1 : 2;
            expect(run.start - run.taken).toBe(dispatchCost);
            expect(run.end - run.start).toBe((m.work + run.remotePages) * (speeds[run.worker] ?? 1));
          }
          expect(r.merge.start).toBe(Math.max(...r.runs.map((x) => x.end)));
          expect(r.ticks).toBe(r.merge.end);
          expect(r.serialTicks).toBe(r.morsels.reduce((s, m) => s + m.work, 0));
          expect(r.busy.map((b, w) => b + r.idle[w]!)).toEqual(r.busy.map(() => r.ticks));
          if (dispatch !== 'stealing') expect(r.steals).toBe(0);
          if (dispatch === 'static') expect(r.runs.every((x) => x.remotePages === 0)).toBe(true);
        },
      ),
      { numRuns: 150, seed: 2 },
    );
  });

  it('one worker is the serial run, plus the merge of its one partial', () => {
    const r = ok(runParallel(SKEWED, db, options({ workers: 1, dispatch: 'static' })));
    expect(r.ticks).toBe(r.serialTicks + 1);
    expect(r.serialTicks).toBe(750 + 600);
  });

  it('is the same every time: workers are a script, not threads', () => {
    expect(runParallel(GROUPED, db, options({ dispatch: 'stealing', speeds: [1, 1, 1, 3] }))).toEqual(
      runParallel(GROUPED, db, options({ dispatch: 'stealing', speeds: [1, 1, 1, 3] })),
    );
  });
});

describe('what each dispatcher is good at (plan.md §27.5 P1)', () => {
  const speedup = (sql: string, over: Partial<ParallelOptions>) => Number(ok(runParallel(sql, db, options(over))).speedup.toFixed(2));

  it('even data and equal workers: the static split wins — every read local, nothing to dispatch', () => {
    expect([
      speedup(GROUPED, { dispatch: 'static' }),
      speedup(GROUPED, { dispatch: 'shared' }),
      speedup(GROUPED, { dispatch: 'stealing' }),
    ]).toEqual([3.96, 3.34, 3.76]);
  });

  it('one worker three times slower: the static split waits for it; stealing takes its work away', () => {
    const slow = { speeds: [1, 1, 1, 3] };
    expect([
      speedup(GROUPED, { ...slow, dispatch: 'static' }),
      speedup(GROUPED, { ...slow, dispatch: 'shared' }),
      speedup(GROUPED, { ...slow, dispatch: 'stealing' }),
    ]).toEqual([1.34, 2.67, 3.09]);
  });

  it('all the matching rows in one corner: the static split gives one worker all of it', () => {
    expect([
      speedup(SKEWED, { dispatch: 'static' }),
      speedup(SKEWED, { dispatch: 'shared' }),
      speedup(SKEWED, { dispatch: 'stealing' }),
    ]).toEqual([1.71, 2.72, 3.22]);
  });

  it('morsels too small spend their time being handed out; too big, and the last one holds everyone up', () => {
    const at = (morselPages: number) => speedup(SKEWED, { dispatch: 'stealing', morselPages });
    expect([at(1), at(4), at(16), at(64)]).toEqual([2.33, 3.18, 3.22, 2.28]);
    expect(ok(runParallel(SKEWED, db, options({ dispatch: 'stealing', morselPages: 1 }))).steals).toBe(93);
  });
});
