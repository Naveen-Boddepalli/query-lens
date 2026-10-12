import { describe, expect, it } from 'vitest';
import { hermitageMatrix } from '../../engine/hermitage.ts';
import { runSchedule } from '../../engine/schedule.ts';
import { createAccountsDatabase } from '../../engine/seed.ts';
import { matrixRows } from '../isolationTable.ts';
import { scheduleRows } from '../transactionTables.ts';

const steps = (...rows: [string, string][]) => rows.map(([session, sql]) => ({ session, sql }));

describe('a schedule as rows', () => {
  const skew = steps(
    ['A', 'BEGIN'],
    ['B', 'BEGIN'],
    ['A', 'SELECT * FROM accounts WHERE id <= 2'],
    ['B', 'SELECT * FROM accounts WHERE id <= 2'],
    ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
    ['B', 'UPDATE accounts SET balance = 0 WHERE id = 2'],
    ['A', 'COMMIT'],
    ['B', 'COMMIT'],
  );

  it('is one row for each record the run made, in the order things happened', () => {
    const run = runSchedule(skew, createAccountsDatabase(20), undefined, { granularity: 'row', isolation: 'repeatable-read' });
    const rows = scheduleRows(run.steps);
    expect(rows).toHaveLength(run.steps.length);
    expect(rows.map((r) => r.session).slice(0, 4)).toEqual(['A', 'B', 'A', 'B']);
    // The blocked statement says who it waits for, the victim is rolled back, and the resumed one is its own row.
    expect(rows.find((r) => r.happened.startsWith('blocked'))!.happened).toBe('blocked on a lock held by B');
    expect(rows.find((r) => r.happened === 'rolled back')!.result).toContain('Deadlock');
    expect(rows.some((r) => r.happened === 'resumed')).toBe(true);
  });

  it('says how many rows a read returned, and what a write or a control did', () => {
    const run = runSchedule(skew, createAccountsDatabase(20));
    const rows = scheduleRows(run.steps);
    expect(rows[2]!.result).toBe('2 rows returned');
    expect(rows[0]!.result).toContain('begins transaction');
    expect(rows[4]!.result).toContain('1 row updated');
  });

  it('names an anomaly beside the statement that showed it', () => {
    const dirty = runSchedule(
      steps(['A', 'BEGIN'], ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'], ['B', 'SELECT balance FROM accounts WHERE id = 1']),
      createAccountsDatabase(3),
    );
    const rows = scheduleRows(dirty.steps);
    expect(rows.map((r) => r.flagged)).toEqual(['—', '—', 'dirty-read']);
  });

  it('is empty for an empty schedule', () => {
    expect(scheduleRows(runSchedule([], createAccountsDatabase(3)).steps)).toEqual([]);
  });
});

describe('the isolation matrix as rows', () => {
  const rows = matrixRows({ locks: hermitageMatrix('locks'), mvcc: hermitageMatrix('mvcc') });

  it('is one row for each of the ten anomalies at each of four levels on each of two engines', () => {
    expect(rows).toHaveLength(10 * 4 * 2);
    expect(new Set(rows.map((r) => r.anomaly)).size).toBe(10);
    expect(new Set(rows.map((r) => r.engine)).size).toBe(2);
    expect(new Set(rows.map((r) => r.level)).size).toBe(4);
  });

  it('agrees with the published results everywhere but the one cell that is declared', () => {
    const different = rows.filter((r) => r.agrees !== 'yes');
    expect(different).toHaveLength(1);
    expect(different[0]!.agrees).toMatch(/^no — /);
    expect(different[0]!.anomaly).toContain('OTV');
  });

  it('reads the same as the matrix: write skew at repeatable read, by engine', () => {
    const skew = rows.filter((r) => r.anomaly.startsWith('G2-item') && r.level === 'REPEATABLE READ');
    expect(skew.map((r) => `${r.engine}: ${r.happens}`).sort()).toEqual([
      'Two-phase locking: prevented',
      'Versions and snapshots: happens',
    ]);
  });
});
