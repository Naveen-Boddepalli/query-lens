import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_STEPS, runSchedule } from '../schedule.ts';
import { controlKindOf } from '../transactionControl.ts';
import { runQuery } from '../runQuery.ts';
import type { ScheduleStep } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';
import type { Row } from '../types.ts';

/** plan.md §25.4 D1: sessions, an interleaving the caller chose, and a shared database with no concurrency control. */

const steps = (...pairs: [string, string][]): ScheduleStep[] => pairs.map(([session, sql]) => ({ session, sql }));
const rowsOf = (db: ReturnType<typeof createAccountsDatabase>): Row[] => db.tables.accounts!.rows;
const INITIAL = rowsOf(createAccountsDatabase());

describe('transaction control statements', () => {
  it('recognises BEGIN, COMMIT and ROLLBACK with their noise words, and nothing else', () => {
    expect(controlKindOf('begin;')).toBe('begin');
    expect(controlKindOf('  Begin   Transaction ')).toBe('begin');
    expect(controlKindOf('START TRANSACTION')).toBe('begin');
    expect(controlKindOf('COMMIT -- done')).toBe('commit');
    expect(controlKindOf('/* x */ ROLLBACK WORK;')).toBe('rollback');
    expect(controlKindOf('SELECT * FROM accounts')).toBeNull();
    expect(controlKindOf('BEGIN ISOLATION LEVEL SERIALIZABLE')).toBe('malformed');
    expect(controlKindOf('SAVEPOINT a')).toBe('malformed');
  });

  it('refuses a transaction statement it does not understand, rather than guess', () => {
    const result = runSchedule(steps(['A', 'BEGIN ISOLATION LEVEL SERIALIZABLE']), createAccountsDatabase());
    expect(result.steps[0]!.error).toContain('BEGIN, COMMIT and ROLLBACK');
    expect(result.open).toEqual([]);
  });
});

describe('outside a schedule', () => {
  it('runQuery refuses BEGIN, COMMIT and ROLLBACK, and says where they work', () => {
    for (const sql of ['BEGIN', 'commit;', 'ROLLBACK WORK']) {
      const result = runQuery(sql, createAccountsDatabase());
      expect(result.error?.message).toContain('need two sessions');
      expect(result.error?.hint).toContain('/tools/schedule');
      expect(result.write).toBeUndefined();
    }
  });
});

describe('autocommit and COMMIT', () => {
  it('applies a statement outside a transaction at once, as its own committed transaction', () => {
    const result = runSchedule(
      steps(['A', 'UPDATE accounts SET balance = 50 WHERE id = 1']),
      createAccountsDatabase(),
    );
    expect(rowsOf(result.final)[0]).toEqual({ id: 1, owner: 'ada', balance: 50 });
    expect(result.steps[0]!.notes.join(' ')).toContain('autocommit');
    expect(result.open).toEqual([]);
    expect(rowsOf(result.committed)).toEqual(rowsOf(result.final));
  });

  it('keeps a transaction open until it ends, and makes its changes permanent when it commits', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(),
    );
    expect(result.steps[0]!.sessions).toEqual([{ session: 'A', transaction: 1, uncommitted: 0 }]);
    expect(result.steps[1]!.sessions).toEqual([{ session: 'A', transaction: 1, uncommitted: 1 }]);
    expect(result.steps[2]!.sessions).toEqual([{ session: 'A', transaction: null, uncommitted: 0 }]);
    expect(result.steps[2]!.notes.join(' ')).toContain('now permanent');
    expect(rowsOf(result.committed)[0]!.balance).toBe(50);
  });

  it('numbers transactions in the order they begin, across sessions', () => {
    const result = runSchedule(steps(['B', 'BEGIN'], ['A', 'BEGIN']), createAccountsDatabase());
    expect(result.steps[1]!.sessions).toEqual([
      { session: 'B', transaction: 1, uncommitted: 0 },
      { session: 'A', transaction: 2, uncommitted: 0 },
    ]);
  });

  it('says so, and changes nothing, when COMMIT, ROLLBACK or a second BEGIN has nothing to act on', () => {
    const result = runSchedule(
      steps(['A', 'COMMIT'], ['A', 'ROLLBACK'], ['A', 'BEGIN'], ['A', 'BEGIN']),
      createAccountsDatabase(),
    );
    expect(result.steps[0]!.notes.join(' ')).toContain('no transaction open');
    expect(result.steps[1]!.notes.join(' ')).toContain('no transaction open');
    expect(result.steps[3]!.notes.join(' ')).toContain('already has transaction T1 open');
    expect(result.steps[3]!.sessions[0]!.transaction).toBe(1);
  });
});

describe('ROLLBACK', () => {
  it('puts back an update, an insert and a delete, in their original places', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['A', "INSERT INTO accounts VALUES (4, 'di', 100)"],
        ['A', 'DELETE FROM accounts WHERE id = 2'],
        ['A', 'ROLLBACK'],
      ),
      createAccountsDatabase(),
    );
    expect(rowsOf(result.steps[3]!.after).map((r) => r.id)).toEqual([1, 3, 4]);
    expect(rowsOf(result.final)).toEqual(INITIAL);
    expect(result.steps[4]!.notes.join(' ')).toContain('3 changes undone');
  });

  it('ends the transaction: the session is back in autocommit, and nothing is left open', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['A', 'ROLLBACK'],
        ['A', 'UPDATE accounts SET balance = 5 WHERE id = 2'],
      ),
      createAccountsDatabase(),
    );
    expect(result.steps[2]!.sessions).toEqual([{ session: 'A', transaction: null, uncommitted: 0 }]);
    expect(result.steps[3]!.notes.join(' ')).toContain('autocommit');
    expect(result.open).toEqual([]);
    expect(rowsOf(result.committed)).toEqual(rowsOf(result.final));
  });

  it('undoes a chain of changes to one row newest first, so each restores what the next one replaced', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['A', 'UPDATE accounts SET balance = 2 WHERE id = 1'],
        ['A', 'ROLLBACK'],
      ),
      createAccountsDatabase(),
    );
    expect(rowsOf(result.final)[0]!.balance).toBe(100);
  });

  it('leaves another session’s committed work alone', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 7 WHERE id = 3'],
        ['A', 'ROLLBACK'],
      ),
      createAccountsDatabase(),
    );
    expect(rowsOf(result.final).map((r) => r.balance)).toEqual([100, 100, 7]);
  });

  it('a failed statement changes nothing and leaves the transaction open', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', "INSERT INTO accounts VALUES (1, 'dup', 5)"],
        ['A', 'UPDATE accounts SET nope = 1'],
        ['A', 'UPDATE accounts SET balance = 9 WHERE id = 3'],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(),
    );
    expect(result.steps[1]!.error).toBeDefined();
    expect(result.steps[2]!.error).toBeDefined();
    expect(result.steps[2]!.notes.join(' ')).toContain('T1 stays open');
    expect(rowsOf(result.final).map((r) => r.balance)).toEqual([100, 100, 9]);
    expect(result.steps[4]!.notes.join(' ')).toContain('1 change ');
  });

  it('a transaction never ended is reported, and the committed database leaves it out', () => {
    const result = runSchedule(
      steps(['A', 'BEGIN'], ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1']),
      createAccountsDatabase(),
    );
    expect(result.open).toEqual(['A']);
    expect(rowsOf(result.final)[0]!.balance).toBe(0);
    expect(rowsOf(result.committed)).toEqual(INITIAL);
  });
});

describe('what no concurrency control lets through', () => {
  const dirtyRead = steps(
    ['A', 'BEGIN'],
    ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
    ['B', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'ROLLBACK'],
    ['B', 'SELECT balance FROM accounts WHERE id = 1'],
  );

  it('B reads a balance A has not committed, and says it is a dirty read', () => {
    const result = runSchedule(dirtyRead, createAccountsDatabase());
    const read = result.steps[2]!;
    expect(read.rows).toEqual([{ balance: 0 }]);
    expect(read.anomalies).toHaveLength(1);
    expect(read.anomalies[0]).toMatchObject({ kind: 'dirty-read', session: 'B', against: ['A'] });
    expect(read.anomalies[0]!.message).toContain('returns {"balance":100}');
  });

  it('the same read after the rollback is clean, and shows the value that was always committed', () => {
    const result = runSchedule(dirtyRead, createAccountsDatabase());
    expect(result.steps[4]!.rows).toEqual([{ balance: 100 }]);
    expect(result.steps[4]!.anomalies).toEqual([]);
  });

  it('a session reading its own uncommitted change, or a row nobody changed, is not a dirty read', () => {
    const own = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'SELECT balance FROM accounts WHERE id = 2'],
      ),
      createAccountsDatabase(),
    );
    expect(own.steps[2]!.anomalies).toEqual([]);
    expect(own.steps[3]!.anomalies).toEqual([]);
  });

  it('a read after the writer commits is not a dirty read', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['A', 'COMMIT'],
        ['B', 'SELECT balance FROM accounts WHERE id = 1'],
      ),
      createAccountsDatabase(),
    );
    expect(result.steps[3]!.anomalies).toEqual([]);
  });

  it('a write to a row another session has changed and not committed is a dirty write, and the rollback cannot undo it', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
        ['A', 'ROLLBACK'],
      ),
      createAccountsDatabase(),
    );
    expect(result.steps[2]!.anomalies[0]).toMatchObject({ kind: 'dirty-write', session: 'B', against: ['A'] });
    expect(result.steps[3]!.notes.join(' ')).toContain('0 of 1 change could be undone');
    expect(result.steps[3]!.notes.join(' ')).toContain('could not be put back');
    // B's write was autocommitted on top of A's; A's rollback has nothing of its own left to restore.
    expect(rowsOf(result.final)[0]!.balance).toBe(50);
  });
});

describe('the schedule as a value', () => {
  it('is deterministic and leaves the database it was given untouched', () => {
    const db = createAccountsDatabase();
    const before = structuredClone(db);
    const schedule = steps(
      ['A', 'BEGIN'],
      ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      ['B', 'SELECT * FROM accounts'],
      ['A', 'ROLLBACK'],
    );
    const first = runSchedule(schedule, db);
    const second = runSchedule(schedule, db);
    expect(db).toEqual(before);
    expect(first.final).toEqual(second.final);
    expect(first.steps.map((s) => s.anomalies)).toEqual(second.steps.map((s) => s.anomalies));
  });

  it('ignores steps past the limit, and says it did', () => {
    const long = Array.from({ length: MAX_SCHEDULE_STEPS + 5 }, () => ({
      session: 'A',
      sql: 'SELECT * FROM accounts',
    }));
    const result = runSchedule(long, createAccountsDatabase());
    expect(result.steps).toHaveLength(MAX_SCHEDULE_STEPS);
    expect(result.truncated).toBe(true);
  });

  it('a single session that rolls back leaves the database exactly as it found it, whatever it did', () => {
    const statement = fc.oneof(
      fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 500 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 1, max: 8 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 1)`),
      fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts'),
    );
    fc.assert(
      fc.property(fc.array(statement, { maxLength: 12 }), (sqls) => {
        const schedule: ScheduleStep[] = [
          { session: 'A', sql: 'BEGIN' },
          ...sqls.map((sql) => ({ session: 'A', sql })),
          { session: 'A', sql: 'ROLLBACK' },
        ];
        const result = runSchedule(schedule, createAccountsDatabase());
        expect(rowsOf(result.final)).toEqual(INITIAL);
      }),
      { numRuns: 200 },
    );
  });
});
