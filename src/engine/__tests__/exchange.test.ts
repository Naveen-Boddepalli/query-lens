/** plan.md §27.5 P2 — exchange operators and a parallel hash join: the rows meet, the count is right, the moves add up. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashWorker, runParallelJoin } from '../exchange.ts';
import type { JoinExchange, ParallelJoinResult } from '../exchange.ts';
import type { Database } from '../types.ts';

const ok = (r: ReturnType<typeof runParallelJoin>): ParallelJoinResult => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('a parallel hash join (plan.md §27.5 P2)', () => {
  it('on any two tables: the right count, every row where its exchange says, and the moves that add up', () => {
    const rowsArb = (name: string) =>
      fc.array(fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }), { maxLength: 40 }).map((keys) => ({
        name,
        columns: ['id', 'k'],
        rows: keys.map((k, i) => ({ id: i + 1, k })),
      }));
    fc.assert(
      fc.property(rowsArb('a'), rowsArb('b'), fc.integer({ min: 1, max: 8 }), fc.constantFrom<JoinExchange>('broadcast', 'repartition'), (a, b, workers, strategy) => {
        const db: Database = { tables: { a, b } };
        const r = ok(runParallelJoin('SELECT COUNT(*) FROM a JOIN b ON a.k = b.k', db, { workers, strategy }));
        let naive = 0;
        for (const x of a.rows) for (const y of b.rows) if (x.k !== null && x.k === y.k) naive += 1;
        expect(r.count).toBe(naive);
        const build = r.build.table === 'a' ? a : b;
        const probe = r.build.table === 'a' ? b : a;
        expect(r.build.rows).toBeLessThanOrEqual(r.probe.rows);
        if (strategy === 'broadcast') {
          expect(r.held.build.every((h) => h === build.rows.length)).toBe(true);
          expect(r.held.probe.reduce((s, x) => s + x, 0)).toBe(probe.rows.length);
          expect(r.moved.exchange).toBe(build.rows.length * (workers - 1));
        } else {
          expect(r.held.build.reduce((s, x) => s + x, 0)).toBe(build.rows.length);
          expect(r.held.probe.reduce((s, x) => s + x, 0)).toBe(probe.rows.length);
          // Equal keys meet: every row of a key is on that key's worker.
          for (let w = 0; w < workers; w++) expect(r.traffic[w]![w]).toBe(0);
        }
        expect(r.moved.exchange).toBe(r.traffic.flat().reduce((s, x) => s + x, 0));
        expect(r.moved.gather).toBe(workers - 1);
        expect(r.ticks).toBe(r.phases.reduce((s, p) => s + p.ticks, 0));
        expect(r.serialTicks).toBe(a.rows.length + b.rows.length + naive);
      }),
      { numRuns: 200, seed: 9 },
    );
  });

  it('hashes a key to the same worker every time, and spreads many keys over all of them', () => {
    expect(hashWorker(42, 4)).toBe(hashWorker(42, 4));
    const used = new Set(Array.from({ length: 200 }, (_, i) => hashWorker(i + 1, 8)));
    expect(used.size).toBe(8);
  });

  it('refuses what is not one equi-join of two tables, counted or listed', () => {
    const db: Database = {
      tables: {
        employees: { name: 'employees', columns: ['id'], rows: [{ id: 1 }] },
        timesheets: { name: 'timesheets', columns: ['id', 'employeeId', 'hours'], rows: [{ id: 1, employeeId: 1, hours: 3 }] },
      },
    };
    const error = (sql: string) => {
      const r = runParallelJoin(sql, db, { workers: 4, strategy: 'broadcast' });
      return r.ok ? null : r.error;
    };
    expect(error('SELECT COUNT(*) FROM employees')).toMatch(/two tables and one equality/);
    expect(error('SELECT COUNT(*) FROM employees LEFT JOIN timesheets ON employees.id = timesheets.employeeId')).toMatch(/two tables/);
    expect(error('SELECT employees.id FROM employees JOIN timesheets ON employees.id = timesheets.employeeId')).toMatch(/two tables/);
    expect(error('SELECT COUNT(*) FROM employees JOIN timesheets ON employees.id = timesheets.employeeId WHERE timesheets.hours > 2')).toMatch(/two tables/);
  });
});
