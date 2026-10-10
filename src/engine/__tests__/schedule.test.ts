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
    expect(result.steps[0]!.sessions).toEqual([{ session: 'A', transaction: 1, uncommitted: 0, waiting: false }]);
    expect(result.steps[1]!.sessions).toEqual([{ session: 'A', transaction: 1, uncommitted: 1, waiting: false }]);
    expect(result.steps[2]!.sessions).toEqual([{ session: 'A', transaction: null, uncommitted: 0, waiting: false }]);
    expect(result.steps[2]!.notes.join(' ')).toContain('now permanent');
    expect(rowsOf(result.committed)[0]!.balance).toBe(50);
  });

  it('numbers transactions in the order they begin, across sessions', () => {
    const result = runSchedule(steps(['B', 'BEGIN'], ['A', 'BEGIN']), createAccountsDatabase());
    expect(result.steps[1]!.sessions).toEqual([
      { session: 'B', transaction: 1, uncommitted: 0, waiting: false },
      { session: 'A', transaction: 2, uncommitted: 0, waiting: false },
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
    expect(result.steps[2]!.sessions).toEqual([{ session: 'A', transaction: null, uncommitted: 0, waiting: false }]);
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

describe('strict two-phase locking (plan.md §25.4 D2)', () => {
  const PAGE = { granularity: 'page' } as const;
  const ROW = { granularity: 'row' } as const;
  const run = (schedule: ScheduleStep[], locking: typeof PAGE | typeof ROW, rows = 3) =>
    runSchedule(schedule, createAccountsDatabase(rows), undefined, locking);
  const phases = (result: ReturnType<typeof runSchedule>) => result.steps.map((s) => `${s.session}${String(s.index)}:${s.phase}`);

  const blockedReader = steps(
    ['A', 'BEGIN'],
    ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
    ['B', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'COMMIT'],
  );

  it('makes a read wait for the lock a writer holds, then runs it against what the writer committed', () => {
    const result = run(blockedReader, PAGE);
    expect(phases(result)).toEqual(['A0:ran', 'A1:ran', 'B2:blocked', 'A3:ran', 'B2:resumed']);
    const blocked = result.steps[2]!;
    expect(blocked.waitingOn).toEqual(['A']);
    expect(blocked.rows).toEqual([]);
    expect(blocked.sessions.find((s) => s.session === 'B')?.waiting).toBe(true);
    expect(result.steps[4]!.rows).toEqual([{ balance: 0 }]);
    expect(result.steps[4]!.anomalies).toEqual([]);
    expect(result.stuck).toEqual([]);
  });

  it('after a rollback the waiting read sees the value that was always committed', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'SELECT balance FROM accounts WHERE id = 1'],
        ['A', 'ROLLBACK'],
      ),
      PAGE,
    );
    expect(result.steps.at(-1)!.rows).toEqual([{ balance: 100 }]);
  });

  it('the same schedule with no locking reads the uncommitted value instead', () => {
    const result = runSchedule(blockedReader, createAccountsDatabase());
    expect(result.steps[2]!.rows).toEqual([{ balance: 0 }]);
    expect(result.steps[2]!.anomalies[0]?.kind).toBe('dirty-read');
  });

  it('a page lock makes a read of another row on the same page wait; a row lock does not, once an index finds it', () => {
    const schedule = steps(
      ['A', 'BEGIN'],
      ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      ['B', 'SELECT balance FROM accounts WHERE id = 2'],
      ['A', 'COMMIT'],
    );
    expect(phases(run(schedule, PAGE, 20))).toContain('B2:blocked');
    const row = run(schedule, ROW, 20);
    expect(phases(row)).toEqual(['A0:ran', 'A1:ran', 'B2:ran', 'A3:ran']);
    expect(row.steps[2]!.rows).toEqual([{ balance: 100 }]);
  });

  it('on a table too small for the index to be used, a row lock gains nothing: the scan examines every row', () => {
    const schedule = steps(
      ['A', 'BEGIN'],
      ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      ['B', 'SELECT balance FROM accounts WHERE id = 2'],
      ['A', 'COMMIT'],
    );
    expect(phases(run(schedule, ROW, 3))).toContain('B2:blocked');
  });

  it('holds a read lock to the end, so a writer waits and the reader sees the same value twice', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 7 WHERE id = 1'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      ROW,
    );
    expect(phases(result)).toEqual(['A0:ran', 'A1:ran', 'B2:blocked', 'A3:ran', 'A4:ran', 'B2:resumed']);
    expect(result.steps[1]!.rows).toEqual(result.steps[3]!.rows);
    expect(result.final.tables.accounts!.rows[0]!.balance).toBe(7);
  });

  it('a scan locks every row it examines, so it cannot read around a row another session has changed', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'SELECT * FROM accounts WHERE balance > 50'],
        ['A', 'ROLLBACK'],
      ),
      ROW,
    );
    expect(phases(result)).toContain('B2:blocked');
    // After the rollback row 1 is back at 100, and B's scan sees it.
    expect(result.steps.at(-1)!.rows).toHaveLength(3);
  });

  it('a row another transaction has deleted stays locked until that transaction ends', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', 'DELETE FROM accounts WHERE id = 2'],
        ['B', 'SELECT * FROM accounts'],
        ['A', 'ROLLBACK'],
      ),
      ROW,
    );
    expect(phases(result)).toContain('B2:blocked');
    expect(result.steps.at(-1)!.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('a row a transaction inserted is locked by it from the start', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', "INSERT INTO accounts VALUES (4, 'di', 100)"],
        ['B', 'SELECT * FROM accounts'],
        ['A', 'COMMIT'],
      ),
      ROW,
    );
    expect(phases(result)).toContain('B2:blocked');
    expect(result.steps.at(-1)!.rows).toHaveLength(4);
  });

  it('breaks a deadlock by rolling back the youngest transaction, and lets the other finish', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['B', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 2 WHERE id = 2'],
        ['A', 'UPDATE accounts SET balance = 3 WHERE id = 2'],
        ['B', 'UPDATE accounts SET balance = 4 WHERE id = 1'],
        ['A', 'COMMIT'],
        ['B', 'UPDATE accounts SET balance = 5 WHERE id = 5'],
        ['B', 'COMMIT'],
      ),
      ROW,
      20,
    );
    expect(result.deadlocks).toBe(1);
    const victim = result.steps.find((s) => s.phase === 'victim')!;
    expect(victim.session).toBe('B');
    expect(victim.error).toContain('Deadlock');
    // B's change was undone, A's blocked statement then ran, and A committed both of its changes. B, rolled back,
    // is a session like any other and goes on to a new transaction.
    expect(result.final.tables.accounts!.rows.slice(0, 5).map((r) => r.balance)).toEqual([1, 3, 100, 100, 5]);
    expect(result.open).toEqual([]);
    expect(result.steps.at(-1)!.notes.join(' ')).toContain('no transaction open');
    // ...and its new statement is locked like anyone's, not run past the lock table.
    expect(result.steps.at(-2)!.notes.join(' ')).toContain('is granted an exclusive lock');
  });

  it('when the youngest is not the session that closed the cycle, its blocked statement is the one that fails', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['B', 'BEGIN'],
        ['A', 'SELECT balance FROM accounts WHERE id = 3'],
        ['B', 'UPDATE accounts SET balance = 2 WHERE id = 2'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 4 WHERE id = 1'],
        ['A', 'UPDATE accounts SET balance = 3 WHERE id = 2'],
        ['A', 'COMMIT'],
        ['B', 'UPDATE accounts SET balance = 5 WHERE id = 5'],
      ),
      ROW,
      20,
    );
    expect(result.deadlocks).toBe(1);
    // A closed the cycle, but B arrived first-requesting later, so B's waiting statement is the casualty.
    const victim = result.steps.find((s) => s.phase === 'victim')!;
    expect(victim.session).toBe('B');
    expect(victim.index).toBe(5);
    // B's abort handed A the lock it was asking for, so A's statement ran at once, and B went on to a fresh
    // transaction of its own.
    const closing = result.steps.find((s) => s.index === 6)!;
    expect(closing.phase).toBe('ran');
    expect(closing.error).toBeUndefined();
    expect(result.steps.find((s) => s.index === 8)?.error).toBeUndefined();
    const balances = result.final.tables.accounts!.rows.map((r) => r.balance);
    expect(balances.slice(0, 5)).toEqual([1, 3, 100, 100, 5]);
  });

  it('two readers that both try to upgrade deadlock, and one of them is rolled back', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['B', 'BEGIN'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'SELECT balance FROM accounts WHERE id = 1'],
        ['A', 'UPDATE accounts SET balance = 10 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 20 WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      ROW,
      20,
    );
    expect(result.deadlocks).toBe(1);
    expect(result.final.tables.accounts!.rows[0]!.balance).toBe(10);
  });

  it('holds a session’s later steps behind its blocked statement and runs them in order once it can', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 9 WHERE id = 1'],
        ['B', 'SELECT balance FROM accounts WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      ROW,
    );
    expect(phases(result)).toEqual(['A0:ran', 'A1:ran', 'B2:blocked', 'B3:queued', 'A4:ran', 'B2:resumed', 'B3:resumed']);
    expect(result.steps.at(-1)!.rows).toEqual([{ balance: 9 }]);
  });

  it('reports a session that never gets its lock as stuck, with its transaction still open', () => {
    const result = run(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'SELECT balance FROM accounts WHERE id = 1'],
      ),
      ROW,
    );
    expect(result.stuck).toEqual(['B']);
    expect(result.open).toEqual(['A']);
  });

  it('shows who holds and who waits for what, after every record', () => {
    const result = run(blockedReader, PAGE);
    expect(result.steps[1]!.locks).toEqual([
      { resource: 'page 0', holders: [{ session: 'A', mode: 'exclusive' }], waiters: [] },
    ]);
    expect(result.steps[2]!.locks[0]!.waiters).toEqual([{ session: 'B', mode: 'shared' }]);
    expect(result.steps.at(-1)!.locks).toEqual([]);
  });

  it('an autocommit statement takes its locks and gives them back', () => {
    const result = run(steps(['A', 'UPDATE accounts SET balance = 5 WHERE id = 1']), PAGE);
    expect(result.steps[0]!.locks).toEqual([]);
    expect(result.final.tables.accounts!.rows[0]!.balance).toBe(5);
  });

  it('is deterministic', () => {
    const first = run(blockedReader, ROW);
    const second = run(blockedReader, ROW);
    expect(first.final).toEqual(second.final);
    expect(phases(first)).toEqual(phases(second));
  });

  it('never lets a dirty read or a dirty write happen, whatever the interleaving', () => {
    const statement = fc.oneof(
      fc.constant('BEGIN'),
      fc.constant('COMMIT'),
      fc.constant('ROLLBACK'),
      fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 4, max: 7 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 1)`),
      fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts'),
      fc.integer({ min: 1, max: 4 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
    );
    const step = fc.record({ session: fc.constantFrom('A', 'B'), sql: statement });
    for (const locking of [PAGE, ROW]) {
      fc.assert(
        fc.property(fc.array(step, { maxLength: 14 }), (schedule) => {
          const result = runSchedule(schedule, createAccountsDatabase(), undefined, locking);
          for (const record of result.steps) expect(record.anomalies).toEqual([]);
        }),
        { numRuns: 300 },
      );
    }
  });
});
