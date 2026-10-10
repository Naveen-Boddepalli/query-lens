import { describe, expect, it } from 'vitest';
import { hermitageMatrix } from '../hermitage.ts';
import { runSchedule } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';

/**
 * What the essays say is checked here, against the engine that would otherwise be able to drift away from them.
 * (The two earlier essays' numbers are held in `twoQ.test.ts` and the B+Tree tests.)
 */
describe('/docs/essays/repeatable-read (plan.md §25.4 H2)', () => {
  const cell = (engine: 'locks' | 'mvcc', test: string) =>
    hermitageMatrix(engine).find((c) => c.test === test && c.level === 'repeatable-read')!.occurred;

  it('at REPEATABLE READ the two engines let through opposite anomalies', () => {
    expect(cell('locks', 'PMP')).toBe(true);
    expect(cell('mvcc', 'PMP')).toBe(false);
    expect(cell('locks', 'G2-item')).toBe(false);
    expect(cell('mvcc', 'G2-item')).toBe(true);
  });

  it('and agree on the rest of the essay’s table', () => {
    for (const engine of ['locks', 'mvcc'] as const) {
      expect(cell(engine, 'P4')).toBe(false);
      expect(cell(engine, 'G-single')).toBe(false);
      expect(cell(engine, 'G2')).toBe(true);
    }
  });

  it('SERIALIZABLE lets none of the ten through on either', () => {
    for (const engine of ['locks', 'mvcc'] as const) {
      expect(hermitageMatrix(engine).filter((c) => c.level === 'serializable' && c.occurred)).toEqual([]);
    }
  });

  describe('the write-skew schedule it links to', () => {
    const steps = [
      ['A', 'BEGIN'],
      ['B', 'BEGIN'],
      ['A', 'SELECT * FROM accounts WHERE id <= 2'],
      ['B', 'SELECT * FROM accounts WHERE id <= 2'],
      ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      ['B', 'UPDATE accounts SET balance = 0 WHERE id = 2'],
      ['A', 'COMMIT'],
      ['B', 'COMMIT'],
    ].map(([session, sql]) => ({ session: session!, sql: sql! }));
    const balances = (r: ReturnType<typeof runSchedule>) => r.final.tables.accounts!.rows.slice(0, 2).map((x) => x.balance);

    it('deadlocks under row locks, and the table ends 0 and 100', () => {
      const r = runSchedule(steps, createAccountsDatabase(20), undefined, { granularity: 'row', isolation: 'repeatable-read' });
      expect(r.deadlocks).toBe(1);
      expect(balances(r)).toEqual([0, 100]);
    });

    it('commits both under snapshots, and the table ends 0 and 0', () => {
      const r = runSchedule(steps, createAccountsDatabase(20), undefined, {
        granularity: 'row',
        isolation: 'repeatable-read',
        mvcc: true,
      });
      expect(r.deadlocks).toBe(0);
      expect(balances(r)).toEqual([0, 0]);
    });

    it('refuses the second commit under serializable snapshots, and the table ends 0 and 100', () => {
      const r = runSchedule(steps, createAccountsDatabase(20), undefined, {
        granularity: 'row',
        isolation: 'serializable',
        mvcc: true,
      });
      expect(r.steps.filter((s) => s.phase === 'victim').map((s) => `${s.session}:${s.kind}`)).toEqual(['B:commit']);
      expect(balances(r)).toEqual([0, 100]);
    });
  });

  describe('the phantom schedule it links to', () => {
    const steps = [
      ['A', 'BEGIN'],
      ['A', 'SELECT * FROM accounts WHERE balance > 50'],
      ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
      ['A', 'SELECT * FROM accounts WHERE balance > 50'],
      ['A', 'COMMIT'],
    ].map(([session, sql]) => ({ session: session!, sql: sql! }));
    const secondRead = (r: ReturnType<typeof runSchedule>) => r.steps.filter((s) => s.session === 'A' && s.kind === 'statement')[1]!.rows.length;

    it('shows the new row under row locks and not under snapshots', () => {
      const locks = runSchedule(steps, createAccountsDatabase(20), undefined, { granularity: 'row', isolation: 'repeatable-read' });
      const mvcc = runSchedule(steps, createAccountsDatabase(20), undefined, {
        granularity: 'row',
        isolation: 'repeatable-read',
        mvcc: true,
      });
      expect(secondRead(locks)).toBe(21);
      expect(secondRead(mvcc)).toBe(20);
    });
  });
});
