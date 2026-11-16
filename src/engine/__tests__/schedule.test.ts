import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_STEPS, runSchedule } from '../schedule.ts';
import type { LockingOptions } from '../schedule.ts';
import { controlKindOf, isolationLevelOf } from '../transactionControl.ts';
import { runQuery } from '../runQuery.ts';
import type { ScheduleStep } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';
import { serialCheck } from '../serialCheck.ts';
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
    expect(controlKindOf('BEGIN ISOLATION LEVEL SERIALIZABLE')).toBe('begin');
    expect(controlKindOf('begin transaction isolation level read committed;')).toBe('begin');
    expect(controlKindOf('BEGIN ISOLATION LEVEL CHAOS')).toBe('malformed');
    expect(controlKindOf('SAVEPOINT a')).toBe('malformed');
  });

  it('refuses a transaction statement it does not understand, rather than guess', () => {
    const result = runSchedule(steps(['A', 'BEGIN ISOLATION LEVEL CHAOS']), createAccountsDatabase());
    expect(result.steps[0]!.error).toContain('BEGIN, COMMIT and ROLLBACK');
    expect(result.open).toEqual([]);
  });
});

describe('isolation level clauses', () => {
  it('reads the level a BEGIN asks for, in any spelling', () => {
    expect(isolationLevelOf('BEGIN ISOLATION LEVEL READ UNCOMMITTED')).toBe('read-uncommitted');
    expect(isolationLevelOf('begin work isolation level  repeatable   read ;')).toBe('repeatable-read');
    expect(isolationLevelOf('START TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe('serializable');
    expect(isolationLevelOf('BEGIN')).toBeNull();
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
    expect(result.steps[0]!.sessions).toEqual([{ session: 'A', transaction: 1, uncommitted: 0, waiting: false, xid: null }]);
    expect(result.steps[1]!.sessions).toEqual([{ session: 'A', transaction: 1, uncommitted: 1, waiting: false, xid: null }]);
    expect(result.steps[2]!.sessions).toEqual([{ session: 'A', transaction: null, uncommitted: 0, waiting: false, xid: null }]);
    expect(result.steps[2]!.notes.join(' ')).toContain('now permanent');
    expect(rowsOf(result.committed)[0]!.balance).toBe(50);
  });

  it('numbers transactions in the order they begin, across sessions', () => {
    const result = runSchedule(steps(['B', 'BEGIN'], ['A', 'BEGIN']), createAccountsDatabase());
    expect(result.steps[1]!.sessions).toEqual([
      { session: 'B', transaction: 1, uncommitted: 0, waiting: false, xid: null },
      { session: 'A', transaction: 2, uncommitted: 0, waiting: false, xid: null },
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
    expect(result.steps[2]!.sessions).toEqual([{ session: 'A', transaction: null, uncommitted: 0, waiting: false, xid: null }]);
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

  it('a write that works from an uncommitted value is a dirty read, in its write form', () => {
    // B adds one to a balance A has set and not committed: what B writes rests on a number that may never exist.
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = balance + 1 WHERE id = 1'],
      ),
      createAccountsDatabase(),
    );
    const kinds = result.steps[2]!.anomalies.map((a) => a.kind);
    expect(kinds).toContain('dirty-read');
    expect(kinds).toContain('dirty-write');
    expect(result.steps[2]!.anomalies.find((a) => a.kind === 'dirty-read')!.message).toContain('would have written');
  });

  it('a write whose WHERE misses a row because of an uncommitted change is a dirty read too', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'DELETE FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 5 WHERE id = 1'],
      ),
      createAccountsDatabase(),
    );
    const read = result.steps[2]!.anomalies.find((a) => a.kind === 'dirty-read')!;
    expect(read.session).toBe('B');
    expect(read.message).toContain('would have written');
  });

  it('a write that does not depend on what another session left uncommitted is not a dirty read', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 7 WHERE id = 2'],
        ['B', 'UPDATE accounts SET balance = 9 WHERE id = 1'],
      ),
      createAccountsDatabase(),
    );
    expect(result.steps[2]!.anomalies).toEqual([]);
    // Constant over a row A changed: a dirty write, but it read nothing of A's.
    expect(result.steps[3]!.anomalies.map((a) => a.kind)).toEqual(['dirty-write']);
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
    // An intention lock on the table above the page lock (plan.md §27.5 T2): B's IS there is granted beside A's IX, and
    // B waits on the page itself.
    expect(result.steps[1]!.locks).toEqual([
      { resource: 'the table accounts', holders: [{ session: 'A', mode: 'intention-exclusive' }], waiters: [] },
      { resource: 'page 0', holders: [{ session: 'A', mode: 'exclusive' }], waiters: [] },
    ]);
    expect(result.steps[2]!.locks.find((l) => l.resource === 'the table accounts')!.holders).toEqual([
      { session: 'A', mode: 'intention-exclusive' },
      { session: 'B', mode: 'intention-shared' },
    ]);
    expect(result.steps[2]!.locks.find((l) => l.resource === 'page 0')!.waiters).toEqual([{ session: 'B', mode: 'shared' }]);
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
          // Phantoms and the like are the isolation level's business (D3); a lock rules these two out at any level.
          for (const record of result.steps) {
            expect(record.anomalies.filter((a) => a.kind === 'dirty-read' || a.kind === 'dirty-write')).toEqual([]);
          }
        }),
        { numRuns: 300 },
      );
    }
  });
});

describe('isolation levels as lock durations (plan.md §25.4 D3)', () => {
  type Level = 'read-uncommitted' | 'read-committed' | 'repeatable-read' | 'serializable';
  const at = (schedule: ScheduleStep[], isolation: Level, granularity: 'page' | 'row' = 'row', rows = 20) =>
    runSchedule(schedule, createAccountsDatabase(rows), undefined, { granularity, isolation });
  const phases = (result: ReturnType<typeof runSchedule>) => result.steps.map((s) => `${s.session}${String(s.index)}:${s.phase}`);
  const kinds = (result: ReturnType<typeof runSchedule>) => result.steps.flatMap((s) => s.anomalies.map((a) => a.kind));

  const dirtyRead = steps(
    ['A', 'BEGIN'],
    ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
    ['B', 'BEGIN'],
    ['B', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'ROLLBACK'],
    ['B', 'COMMIT'],
  );
  const nonRepeatable = steps(
    ['A', 'BEGIN'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['B', 'BEGIN'],
    ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
    ['B', 'COMMIT'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'COMMIT'],
  );
  const phantom = steps(
    ['A', 'BEGIN'],
    ['A', 'SELECT * FROM accounts WHERE balance > 50'],
    ['B', 'BEGIN'],
    ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
    ['B', 'COMMIT'],
    ['A', 'SELECT * FROM accounts WHERE balance > 50'],
    ['A', 'COMMIT'],
  );
  const lostUpdate = steps(
    ['A', 'BEGIN'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['B', 'BEGIN'],
    ['B', 'UPDATE accounts SET balance = 150 WHERE id = 1'],
    ['B', 'COMMIT'],
    ['A', 'UPDATE accounts SET balance = 120 WHERE id = 1'],
    ['A', 'COMMIT'],
  );

  it('READ UNCOMMITTED reads without asking, so it reads a change that is later rolled back', () => {
    const result = at(dirtyRead, 'read-uncommitted');
    expect(phases(result)).not.toContain('B3:blocked');
    expect(result.steps[3]!.rows).toEqual([{ balance: 0 }]);
    expect(kinds(result)).toEqual(['dirty-read']);
  });

  it('READ UNCOMMITTED still holds write locks, so two writers cannot overwrite each other', () => {
    const result = at(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
        ['A', 'ROLLBACK'],
      ),
      'read-uncommitted',
    );
    expect(phases(result)).toContain('B2:blocked');
    expect(kinds(result)).not.toContain('dirty-write');
  });

  it('READ COMMITTED waits for an uncommitted change instead of reading it', () => {
    const result = at(dirtyRead, 'read-committed');
    expect(phases(result)).toContain('B3:blocked');
    expect(kinds(result)).toEqual([]);
    expect(result.steps.find((s) => s.index === 3 && s.phase === 'resumed')!.rows).toEqual([{ balance: 100 }]);
  });

  it('READ COMMITTED gives its read locks back when the statement ends, so a repeated read can change', () => {
    const result = at(nonRepeatable, 'read-committed');
    expect(phases(result)).not.toContain('B3:blocked');
    expect(result.steps[1]!.locks).toEqual([]);
    expect(result.steps[1]!.notes.join(' ')).toContain('gives back');
    expect(result.steps[5]!.rows).toEqual([{ balance: 50 }]);
    expect(kinds(result)).toEqual(['non-repeatable-read']);
  });

  it('REPEATABLE READ holds its read locks, so the writer waits and the second read matches the first', () => {
    const result = at(nonRepeatable, 'repeatable-read');
    expect(phases(result)).toContain('B3:blocked');
    expect(result.steps.find((s) => s.index === 5)!.rows).toEqual([{ balance: 100 }]);
    expect(kinds(result)).toEqual([]);
  });

  it('REPEATABLE READ cannot see a phantom coming: the new row goes in and the second read has it', () => {
    const result = at(phantom, 'repeatable-read');
    expect(phases(result)).not.toContain('B3:blocked');
    expect(kinds(result)).toEqual(['phantom']);
    expect(result.steps[5]!.rows).toHaveLength(21);
  });

  it('SERIALIZABLE holds the read’s WHERE as a lock, so the insert waits and there is no phantom', () => {
    const result = at(phantom, 'serializable');
    expect(phases(result)).toContain('B3:blocked');
    expect(result.steps.find((s) => s.index === 3 && s.phase === 'blocked')!.waitingOn).toEqual(['A']);
    expect(result.steps.find((s) => s.index === 5)!.rows).toHaveLength(20);
    expect(kinds(result)).toEqual([]);
    // The insert goes in once A has committed.
    expect(result.final.tables.accounts!.rows).toHaveLength(21);
  });

  it('a predicate lock ends with its transaction', () => {
    const result = at(phantom, 'serializable');
    const afterRead = result.steps[1]!;
    expect(afterRead.locks.some((l) => l.resource.includes('balance > 50'))).toBe(true);
    expect(afterRead.notes.join(' ')).toContain('predicate lock');
    expect(result.steps.at(-1)!.locks).toEqual([]);
  });

  it('once its transaction has ended a predicate is forgotten, and no later write is made to wait on it', () => {
    const result = at(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['A', 'COMMIT'],
        ['B', 'BEGIN'],
        ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
        ['B', 'COMMIT'],
      ),
      'serializable',
    );
    expect(result.steps[4]!.locks.some((l) => l.resource.includes('balance > 50'))).toBe(false);
    expect(phases(result).every((p) => p.endsWith(':ran'))).toBe(true);
  });

  it('a predicate lock only stops a write that would match it', () => {
    const result = at(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE balance > 500'],
        ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
        ['A', 'COMMIT'],
      ),
      'serializable',
    );
    expect(phases(result)).toEqual(['A0:ran', 'A1:ran', 'B2:ran', 'A3:ran']);
  });

  it('a statement outside any transaction waits for a predicate too, and so does a writer at a lower level', () => {
    const insert = "INSERT INTO accounts VALUES (30, 'zed', 100)";
    const autocommit = at(
      steps(['A', 'BEGIN'], ['A', 'SELECT * FROM accounts WHERE balance > 50'], ['B', insert], ['A', 'COMMIT']),
      'serializable',
    );
    expect(phases(autocommit)).toContain('B2:blocked');

    const lower = at(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['B', 'BEGIN ISOLATION LEVEL READ UNCOMMITTED'],
        ['B', insert],
        ['A', 'COMMIT'],
        ['B', 'COMMIT'],
      ),
      'serializable',
    );
    expect(phases(lower)).toContain('B3:blocked');
  });

  it('READ COMMITTED loses an update that REPEATABLE READ prevents', () => {
    const rc = at(lostUpdate, 'read-committed');
    expect(kinds(rc)).toEqual(['lost-update']);
    expect(rc.final.tables.accounts!.rows[0]!.balance).toBe(120);

    const rr = at(lostUpdate, 'repeatable-read');
    expect(kinds(rr)).toEqual([]);
    // B's update waited for A, so both land and B's is the last: nothing was overwritten unseen.
    expect(rr.final.tables.accounts!.rows[0]!.balance).toBe(150);
  });

  it('a session’s own change between two identical reads is not a phantom or a non-repeatable read', () => {
    const result = at(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['A', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['A', 'COMMIT'],
      ),
      'read-committed',
    );
    expect(kinds(result)).toEqual([]);
  });

  it('each transaction can ask for its own level, whatever the schedule’s default', () => {
    const result = at(
      steps(
        ['A', 'BEGIN ISOLATION LEVEL READ COMMITTED'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 7 WHERE id = 1'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      'serializable',
    );
    expect(result.steps[0]!.notes.join(' ')).toContain('at READ COMMITTED');
    expect(phases(result)).not.toContain('B2:blocked');
    expect(kinds(result)).toEqual(['non-repeatable-read']);
  });

  it('says a level changes nothing when there is no locking to enforce it', () => {
    const result = runSchedule(
      steps(['A', 'BEGIN ISOLATION LEVEL SERIALIZABLE']),
      createAccountsDatabase(),
    );
    expect(result.steps[0]!.notes.join(' ')).toContain('changes nothing');
  });

  it('a lookup for a row another transaction has deleted waits for that transaction, at either granularity', () => {
    // The index no longer holds the key, so the lookup touches no page: the deleted row's old image has to be locked.
    const schedule = steps(
      ['B', 'BEGIN'],
      ['B', 'DELETE FROM accounts WHERE id = 2'],
      ['A', 'SELECT balance FROM accounts WHERE id = 2'],
      ['B', 'ROLLBACK'],
    );
    for (const granularity of ['page', 'row'] as const) {
      const result = at(schedule, 'repeatable-read', granularity);
      expect(phases(result)).toContain('A2:blocked');
      expect(result.steps.at(-1)!.rows).toEqual([{ balance: 100 }]);
      expect(kinds(result)).toEqual([]);
    }
  });

  it('a lookup for a key another transaction has changed waits too, and then finds nothing once it commits', () => {
    const schedule = steps(
      ['B', 'BEGIN'],
      ['B', 'UPDATE accounts SET id = 99 WHERE id = 2'],
      ['A', 'SELECT balance FROM accounts WHERE id = 2'],
      ['B', 'COMMIT'],
    );
    for (const granularity of ['page', 'row'] as const) {
      const result = at(schedule, 'repeatable-read', granularity);
      expect(phases(result)).toContain('A2:blocked');
      expect(result.steps.at(-1)!.rows).toEqual([]);
    }
  });

  it('SERIALIZABLE lets no anomaly through, whatever the interleaving; REPEATABLE READ lets only phantoms', () => {
    const statement = fc.oneof(
      fc.record({ id: fc.integer({ min: 1, max: 4 }), to: fc.integer({ min: 30, max: 32 }) }).map(
        ({ id, to }) => `UPDATE accounts SET id = ${String(to)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 30, max: 32 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
      fc.constant('BEGIN'),
      fc.constant('COMMIT'),
      fc.constant('ROLLBACK'),
      fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 21, max: 24 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 7)`),
      fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
      fc.integer({ min: 1, max: 4 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
    );
    const step = fc.record({ session: fc.constantFrom('A', 'B'), sql: statement });
    for (const rows of [3, 20]) {
      for (const granularity of ['page', 'row'] as const) {
        fc.assert(
          fc.property(fc.array(step, { maxLength: 14 }), (schedule) => {
            expect(kinds(at(schedule, 'serializable', granularity, rows))).toEqual([]);
            const rr = kinds(at(schedule, 'repeatable-read', granularity, rows)).filter((k) => k !== 'phantom');
            expect(rr).toEqual([]);
          }),
          { numRuns: 150 },
        );
      }
    }
  });
});

describe('multi-version concurrency control (plan.md §25.4 D4)', () => {
  type Level = 'read-uncommitted' | 'read-committed' | 'repeatable-read' | 'serializable';
  const mvcc = (schedule: ScheduleStep[], isolation: Level = 'repeatable-read', rows = 20) =>
    runSchedule(schedule, createAccountsDatabase(rows), undefined, { granularity: 'row', isolation, mvcc: true });
  const phases = (result: ReturnType<typeof runSchedule>) => result.steps.map((s) => `${s.session}${String(s.index)}:${s.phase}`);
  const kinds = (result: ReturnType<typeof runSchedule>) => result.steps.flatMap((s) => s.anomalies.map((a) => a.kind));
  const balances = (db: ReturnType<typeof createAccountsDatabase>, n = 3) =>
    db.tables.accounts!.rows.slice(0, n).map((r) => r.balance);

  const uncommittedWrite = steps(
    ['A', 'BEGIN'],
    ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
    ['B', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'ROLLBACK'],
  );
  const repeatedRead = steps(
    ['A', 'BEGIN'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'COMMIT'],
  );
  const staleWrite = steps(
    ['A', 'BEGIN'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['B', 'BEGIN'],
    ['B', 'UPDATE accounts SET balance = 150 WHERE id = 1'],
    ['B', 'COMMIT'],
    ['A', 'UPDATE accounts SET balance = 120 WHERE id = 1'],
    ['A', 'COMMIT'],
  );
  const writeSkew = steps(
    ['A', 'BEGIN'],
    ['B', 'BEGIN'],
    ['A', 'SELECT * FROM accounts WHERE id <= 2'],
    ['B', 'SELECT * FROM accounts WHERE id <= 2'],
    ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
    ['B', 'UPDATE accounts SET balance = 0 WHERE id = 2'],
    ['A', 'COMMIT'],
    ['B', 'COMMIT'],
  );

  it('a reader never waits for a writer and sees only what was committed', () => {
    const result = mvcc(uncommittedWrite, 'read-committed');
    expect(phases(result)).toEqual(['A0:ran', 'A1:ran', 'B2:ran', 'A3:ran']);
    expect(result.steps[2]!.rows).toEqual([{ balance: 100 }]);
    // The writer's X on the row sits under its IX on the page and the table (plan.md §27.5 T2); the reader took nothing.
    expect(result.steps[2]!.locks).toEqual([
      { resource: 'the table accounts', holders: [{ session: 'A', mode: 'intention-exclusive' }], waiters: [] },
      { resource: 'page 0', holders: [{ session: 'A', mode: 'intention-exclusive' }], waiters: [] },
      { resource: 'the row of accounts with id = 1', holders: [{ session: 'A', mode: 'exclusive' }], waiters: [] },
    ]);
    expect(kinds(result)).toEqual([]);
  });

  it('READ COMMITTED takes a snapshot per statement, so a repeated read sees the commit in between', () => {
    const result = mvcc(repeatedRead, 'read-committed');
    expect(result.steps[3]!.rows).toEqual([{ balance: 50 }]);
    expect(kinds(result)).toEqual(['non-repeatable-read']);
  });

  it('REPEATABLE READ takes one snapshot for the transaction, so both reads agree', () => {
    const result = mvcc(repeatedRead, 'repeatable-read');
    expect(result.steps[1]!.rows).toEqual(result.steps[3]!.rows);
    expect(result.steps[3]!.rows).toEqual([{ balance: 100 }]);
    expect(kinds(result)).toEqual([]);
    // The change is not lost: it is simply not in A's snapshot.
    expect(balances(result.final)[0]).toBe(50);
  });

  it('a snapshot has no phantoms: rows committed after it was taken do not appear', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['A', 'COMMIT'],
      ),
    );
    expect(result.steps[3]!.rows).toHaveLength(20);
    expect(kinds(result)).toEqual([]);
    expect(result.final.tables.accounts!.rows).toHaveLength(21);
  });

  it('first committer wins: writing over a row committed since the snapshot fails instead of losing the change', () => {
    const result = mvcc(staleWrite, 'repeatable-read');
    const loser = result.steps.find((s) => s.phase === 'victim')!;
    expect(loser.session).toBe('A');
    expect(loser.error).toContain('concurrent update');
    expect(balances(result.final)[0]).toBe(150);
    expect(kinds(result)).toEqual([]);
  });

  it('READ COMMITTED writes on top of the newer version instead, which is a lost update', () => {
    const result = mvcc(staleWrite, 'read-committed');
    expect(phases(result)).not.toContain('A5:victim');
    expect(kinds(result)).toEqual(['lost-update']);
    expect(balances(result.final)[0]).toBe(120);
  });

  it('two writers to one row still wait for each other, and the snapshot one then fails', () => {
    const schedule = steps(
      ['A', 'BEGIN'],
      ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
      ['B', 'BEGIN'],
      ['B', 'UPDATE accounts SET balance = 2 WHERE id = 1'],
      ['A', 'COMMIT'],
      ['B', 'COMMIT'],
    );
    const snapshot = mvcc(schedule, 'repeatable-read');
    expect(phases(snapshot)).toContain('B3:blocked');
    expect(snapshot.steps.find((s) => s.index === 3 && s.phase === 'victim')!.error).toContain('concurrent update');
    expect(balances(snapshot.final)[0]).toBe(1);

    const readCommitted = mvcc(schedule, 'read-committed');
    expect(phases(readCommitted)).toContain('B3:resumed');
    expect(balances(readCommitted.final)[0]).toBe(2);
  });

  it('write skew gets through snapshot isolation: two transactions read the same rows and change different ones', () => {
    const result = mvcc(writeSkew, 'repeatable-read');
    expect(result.steps.some((s) => s.phase === 'victim')).toBe(false);
    expect(balances(result.final, 3)).toEqual([0, 0, 100]);
  });

  it('SERIALIZABLE refuses the commit whose reads have been changed since its snapshot', () => {
    const result = mvcc(writeSkew, 'serializable');
    const refused = result.steps.find((s) => s.phase === 'victim')!;
    expect(refused.session).toBe('B');
    expect(refused.kind).toBe('commit');
    expect(refused.error).toContain('Could not serialize');
    expect(balances(result.final, 3)).toEqual([0, 100, 100]);
  });

  it('SERIALIZABLE lets a transaction commit when nothing it read has changed', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 5 WHERE id = 7'],
        ['A', 'UPDATE accounts SET balance = 9 WHERE id = 2'],
        ['A', 'COMMIT'],
      ),
      'serializable',
    );
    expect(result.steps.some((s) => s.phase === 'victim')).toBe(false);
  });

  it('stamps every version with the transaction that made and the one that removed it', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['A', 'COMMIT'],
        ['B', 'DELETE FROM accounts WHERE id = 2'],
      ),
    );
    const first = result.steps.at(-1)!.versions.filter((v) => v.table === 'accounts' && (v.rid === 1 || v.rid === 2));
    // Row 1: the original (xmin 0) was replaced by transaction 1, whose version is the live one.
    const row1 = first.filter((v) => v.rid === 1);
    expect(row1.map((v) => [v.xmin, v.xmax, v.live])).toEqual([
      [0, 1, false],
      [1, null, true],
    ]);
    // Row 2 was deleted by an autocommit statement, which took the next id.
    expect(first.find((v) => v.rid === 2)!.xmax).toBe(2);
  });

  it('a transaction sees its own changes, and not its own deletions', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['A', 'DELETE FROM accounts WHERE id = 2'],
        ['A', 'SELECT balance FROM accounts WHERE id <= 3'],
        ['B', 'SELECT balance FROM accounts WHERE id <= 3'],
      ),
    );
    // Row 1 as A changed it, row 2 gone, row 3 untouched; B, who has seen none of it, still sees all three.
    expect(result.steps[3]!.rows).toEqual([{ balance: 0 }, { balance: 100 }]);
    expect(result.steps[4]!.rows).toHaveLength(3);
  });

  it('a rollback undoes nothing: its versions stop being visible, and linger as dead tuples until VACUUM', () => {
    const result = mvcc(
      steps(['A', 'BEGIN'], ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'], ['A', 'ROLLBACK']),
      'read-committed',
    );
    expect(balances(result.final)[0]).toBe(100);
    expect(result.bloat).toEqual({ dead: 1, pages: 6, pagesAfterVacuum: 5 });
    const vacuumed = mvcc(
      steps(['A', 'BEGIN'], ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'], ['A', 'ROLLBACK'], ['A', 'VACUUM']),
      'read-committed',
    );
    expect(vacuumed.bloat).toEqual({ dead: 0, pages: 5, pagesAfterVacuum: 5 });
    expect(vacuumed.steps.at(-1)!.notes.join(' ')).toContain('removed 1 dead version');
  });

  it('VACUUM keeps a version some open snapshot can still see', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
        ['B', 'VACUUM'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['A', 'COMMIT'],
        ['B', 'VACUUM'],
      ),
      'repeatable-read',
    );
    // A's snapshot still needs the old version, so the first VACUUM cannot take it; the second can.
    expect(result.steps[3]!.notes.join(' ')).toContain('removed 0 dead versions');
    expect(result.steps[4]!.rows).toEqual([{ balance: 100 }]);
    expect(result.steps.at(-1)!.notes.join(' ')).toContain('removed 1 dead version');
  });

  it('VACUUM without versions says there is nothing for it to do', () => {
    const result = runSchedule(steps(['A', 'VACUUM']), createAccountsDatabase());
    expect(result.steps[0]!.error).toContain('without MVCC');
  });

  it('a deadlock between two writers is still a deadlock', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['B', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 2 WHERE id = 2'],
        ['A', 'UPDATE accounts SET balance = 3 WHERE id = 2'],
        ['B', 'UPDATE accounts SET balance = 4 WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      'read-committed',
    );
    expect(result.deadlocks).toBe(1);
    expect(balances(result.final, 3)).toEqual([1, 3, 100]);
  });

  it('reports what each session would see now: its own snapshot inside a snapshot transaction, everything otherwise', () => {
    const result = mvcc(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
      ),
      'repeatable-read',
    );
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.session, s]));
    // A's snapshot was taken before B's autocommit transaction (xid 2) committed.
    expect(byName.A).toEqual({ session: 'A', xid: 1, committed: [0] });
    expect(byName.B).toEqual({ session: 'B', xid: null, committed: [0, 2] });
    expect(runSchedule(steps(['A', 'SELECT * FROM accounts']), createAccountsDatabase()).snapshots).toEqual([]);
  });

  it('REPEATABLE READ and SERIALIZABLE let no anomaly through, and READ COMMITTED only its own three', () => {
    const statement = fc.oneof(
      fc.constant('BEGIN'),
      fc.constant('COMMIT'),
      fc.constant('ROLLBACK'),
      fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 21, max: 24 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 7)`),
      fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
      fc.integer({ min: 1, max: 4 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
      fc.constant('VACUUM'),
    );
    const step = fc.record({ session: fc.constantFrom('A', 'B'), sql: statement });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 14 }), (schedule) => {
        for (const level of ['repeatable-read', 'serializable'] as const) {
          expect(kinds(mvcc(schedule, level))).toEqual([]);
        }
        const rc = kinds(mvcc(schedule, 'read-committed')).filter(
          (k) => k !== 'non-repeatable-read' && k !== 'phantom' && k !== 'lost-update',
        );
        expect(rc).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('protocols that never wait (plan.md §25.4 D6)', () => {
  const timestamp = (schedule: ScheduleStep[], rows = 20) =>
    runSchedule(schedule, createAccountsDatabase(rows), undefined, { granularity: 'row', protocol: 'timestamp' });
  const optimistic = (schedule: ScheduleStep[], rows = 20) =>
    runSchedule(schedule, createAccountsDatabase(rows), undefined, { granularity: 'row', protocol: 'optimistic' });
  const kinds = (result: ReturnType<typeof runSchedule>) => result.steps.flatMap((s) => s.anomalies.map((a) => a.kind));
  const aborted = (result: ReturnType<typeof runSchedule>) =>
    result.steps.filter((s) => s.phase === 'victim').map((s) => `${s.session}:${s.kind}`);
  const bal = (result: ReturnType<typeof runSchedule>, n = 3) =>
    result.final.tables.accounts!.rows.slice(0, n).map((r) => r.balance);

  const lostUpdate = steps(
    ['A', 'BEGIN'],
    ['B', 'BEGIN'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['B', 'SELECT balance FROM accounts WHERE id = 1'],
    ['A', 'UPDATE accounts SET balance = 110 WHERE id = 1'],
    ['B', 'UPDATE accounts SET balance = 120 WHERE id = 1'],
    ['A', 'COMMIT'],
    ['B', 'COMMIT'],
  );
  const readSkew = steps(
    ['A', 'BEGIN'],
    ['B', 'BEGIN'],
    ['A', 'SELECT balance FROM accounts WHERE id = 1'],
    ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
    ['B', 'UPDATE accounts SET balance = 150 WHERE id = 2'],
    ['B', 'COMMIT'],
    ['A', 'SELECT balance FROM accounts WHERE id = 2'],
    ['A', 'COMMIT'],
  );

  describe('timestamp ordering', () => {
    it('refuses the older transaction’s write once a younger one has read the row, and never waits', () => {
      const result = timestamp(lostUpdate);
      expect(aborted(result)).toEqual(['A:statement']);
      expect(result.steps.some((s) => s.phase === 'blocked')).toBe(false);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('too late');
      expect(bal(result)[0]).toBe(120);
    });

    it('refuses a read that comes after a younger transaction has written the row', () => {
      const result = timestamp(readSkew);
      expect(aborted(result)).toEqual(['A:statement']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('already written it');
      // The younger transaction's work stands.
      expect(bal(result, 2)).toEqual([50, 150]);
    });

    it('lets operations through that arrive in timestamp order, and records each on the row', () => {
      const result = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['A', 'SELECT balance FROM accounts WHERE id = 1'],
          ['A', 'UPDATE accounts SET balance = 7 WHERE id = 1'],
          ['A', 'COMMIT'],
          ['B', 'BEGIN'],
          ['B', 'UPDATE accounts SET balance = 8 WHERE id = 1'],
          ['B', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual([]);
      expect(bal(result)[0]).toBe(8);
    });

    it('lets a transaction go back to a row it has already written or read', () => {
      const result = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 7 WHERE id = 1'],
          ['A', 'SELECT balance FROM accounts WHERE id = 1'],
          ['A', 'UPDATE accounts SET balance = 8 WHERE id = 1'],
          ['A', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual([]);
      expect(bal(result)[0]).toBe(8);
    });

    it('refuses an older transaction a table from which a younger one has since removed a row', () => {
      // A began first, so in timestamp order it runs first and must see row 1; B's delete has already taken it away.
      const result = timestamp(
        steps(['A', 'BEGIN'], ['B', 'DELETE FROM accounts WHERE id = 1'], ['A', 'SELECT * FROM accounts WHERE balance > 4']),
      );
      expect(aborted(result)).toEqual(['A:statement']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('changed or removed a row');
    });

    it('catches a row a younger transaction re-keyed, which an id lookup would otherwise just not find', () => {
      const result = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['B', 'UPDATE accounts SET id = 30 WHERE id = 3'],
          ['A', 'SELECT balance FROM accounts WHERE id = 3'],
        ),
      );
      expect(aborted(result)).toEqual(['A:statement']);
    });

    it('lets an older transaction past removed rows its WHERE would not have matched', () => {
      const result = timestamp(
        steps(['A', 'BEGIN'], ['B', 'DELETE FROM accounts WHERE id = 1'], ['A', 'SELECT balance FROM accounts WHERE id = 2']),
      );
      expect(aborted(result)).toEqual([]);
    });

    it('refuses a phantom: an older transaction adding a row a younger one’s scan would have picked up', () => {
      const result = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['B', 'SELECT * FROM accounts WHERE balance > 4'],
          ['A', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
        ),
      );
      expect(aborted(result)).toEqual(['A:statement']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('would have seen it');
    });

    it('lets an older transaction add a row the younger one’s scan would not have matched', () => {
      const result = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['B', 'SELECT * FROM accounts WHERE balance > 500'],
          ['A', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
        ),
      );
      expect(aborted(result)).toEqual([]);
    });

    it('is not strict: a younger transaction can read or overwrite what an older one has not committed', () => {
      const dirty = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['B', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
          ['B', 'SELECT balance FROM accounts WHERE id = 1'],
          ['A', 'ROLLBACK'],
        ),
      );
      expect(kinds(dirty)).toEqual(['dirty-read']);
      const overwrite = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['B', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
          ['B', 'UPDATE accounts SET balance = 2 WHERE id = 1'],
        ),
      );
      expect(kinds(overwrite)).toEqual(['dirty-write']);
    });

    it('stamps a row an insert makes, so an older transaction cannot read it', () => {
      const result = timestamp(
        steps(
          ['A', 'BEGIN'],
          ['B', 'BEGIN'],
          ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
          ['A', 'SELECT * FROM accounts WHERE id = 30'],
        ),
      );
      expect(aborted(result)).toEqual(['A:statement']);
    });
  });

  describe('optimistic concurrency control', () => {
    it('keeps a transaction’s writes private until it commits', () => {
      const result = optimistic(
        steps(
          ['A', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
          ['A', 'SELECT balance FROM accounts WHERE id = 1'],
          ['B', 'SELECT balance FROM accounts WHERE id = 1'],
          ['A', 'COMMIT'],
          ['B', 'SELECT balance FROM accounts WHERE id = 1'],
        ),
      );
      // A reads its own write; B does not see it until the commit.
      expect(result.steps[2]!.rows).toEqual([{ balance: 0 }]);
      expect(result.steps[3]!.rows).toEqual([{ balance: 100 }]);
      expect(result.steps[5]!.rows).toEqual([{ balance: 0 }]);
      expect(result.steps.some((s) => s.phase === 'blocked')).toBe(false);
    });

    it('lets both transactions run and refuses the second to commit, having done all its work', () => {
      const result = optimistic(lostUpdate);
      expect(aborted(result)).toEqual(['B:commit']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('Could not serialize');
      expect(bal(result)[0]).toBe(110);
    });

    it('refuses a transaction whose reads were changed by one that committed since it began', () => {
      const result = optimistic(readSkew);
      expect(aborted(result)).toEqual(['A:commit']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('a row this transaction read was changed by');
      expect(bal(result, 2)).toEqual([50, 150]);
    });

    it('commits a transaction whose reads were not touched', () => {
      const result = optimistic(
        steps(
          ['A', 'BEGIN'],
          ['A', 'SELECT balance FROM accounts WHERE id = 1'],
          ['B', 'UPDATE accounts SET balance = 5 WHERE id = 7'],
          ['A', 'UPDATE accounts SET balance = 9 WHERE id = 2'],
          ['A', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual([]);
      expect(bal(result)[1]).toBe(9);
    });

    it('catches a phantom: a row committed that matches a predicate it read', () => {
      const result = optimistic(
        steps(
          ['A', 'BEGIN'],
          ['A', 'SELECT * FROM accounts WHERE balance > 50'],
          ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
          ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
          ['A', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual(['A:commit']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('a row matching');
    });

    it('refuses a blind write over a row another transaction has since committed a change to', () => {
      const result = optimistic(
        steps(
          ['A', 'BEGIN'],
          ['B', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 1 WHERE id = 3'],
          ['B', 'UPDATE accounts SET balance = 2 WHERE id = 3'],
          ['A', 'COMMIT'],
          ['B', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual(['B:commit']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('a row this transaction wrote was changed by');
      expect(result.final.tables.accounts!.rows.find((r) => r.id === 3)!.balance).toBe(1);
    });

    it('refuses a write over a row another transaction has since deleted', () => {
      const result = optimistic(
        steps(
          ['A', 'BEGIN'],
          ['B', 'BEGIN'],
          ['A', 'DELETE FROM accounts WHERE id = 3'],
          ['B', 'UPDATE accounts SET balance = 2 WHERE id = 3'],
          ['A', 'COMMIT'],
          ['B', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual(['B:commit']);
      expect(result.steps.find((s) => s.phase === 'victim')!.error).toContain('a row this transaction wrote was changed by');
      expect(result.final.tables.accounts!.rows.some((r) => r.id === 3)).toBe(false);
    });

    it('does not count a transaction that committed before this one began as a conflict', () => {
      const result = optimistic(
        steps(
          ['A', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 1 WHERE id = 3'],
          ['A', 'COMMIT'],
          ['B', 'BEGIN'],
          ['B', 'UPDATE accounts SET balance = 2 WHERE id = 3'],
          ['B', 'COMMIT'],
        ),
      );
      expect(aborted(result)).toEqual([]);
      expect(result.final.tables.accounts!.rows.find((r) => r.id === 3)!.balance).toBe(2);
    });

    it('a rolled-back transaction leaves nothing behind', () => {
      const result = optimistic(
        steps(['A', 'BEGIN'], ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'], ['A', 'ROLLBACK']),
      );
      expect(bal(result)[0]).toBe(100);
      expect(result.committed.tables.accounts!.rows).toEqual(result.final.tables.accounts!.rows);
    });
  });

  it('neither ever waits, queues, or deadlocks, whatever the interleaving', () => {
    const statement = fc.oneof(
      fc.constant('BEGIN'),
      fc.constant('COMMIT'),
      fc.constant('ROLLBACK'),
      fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 21, max: 24 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 7)`),
      fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
      fc.integer({ min: 1, max: 4 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
    );
    const step = fc.record({ session: fc.constantFrom('A', 'B', 'C'), sql: statement });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 16 }), (schedule) => {
        for (const run of [timestamp, optimistic]) {
          const result = run(schedule);
          expect(result.deadlocks).toBe(0);
          expect(result.stuck).toEqual([]);
          expect(result.steps.every((s) => s.phase !== 'blocked' && s.phase !== 'queued')).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

const byId = (rows: Row[]): Row[] => [...rows].sort((a, b) => (a.id as number) - (b.id as number));

describe('what committed means, whatever the protocol (plan.md §25.4 D6)', () => {
  const statement = fc.oneof(
    fc.constant('BEGIN'),
    fc.constant('COMMIT'),
    fc.constant('ROLLBACK'),
    fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
      ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
    ),
    fc.integer({ min: 1, max: 4 }).map((id) => `UPDATE accounts SET balance = balance + 1 WHERE id = ${String(id)}`),
    fc.record({ id: fc.integer({ min: 1, max: 4 }), to: fc.integer({ min: 30, max: 32 }) }).map(
      ({ id, to }) => `UPDATE accounts SET id = ${String(to)} WHERE id = ${String(id)}`,
    ),
    fc.integer({ min: 21, max: 24 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 7)`),
    fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
    fc.constant('SELECT * FROM accounts WHERE balance > 4'),
    fc.integer({ min: 1, max: 4 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
  );
  const step = fc.record({ session: fc.constantFrom('A', 'B', 'C'), sql: statement });
  // `reads` says whether the protocol promises serializability, and so that no committed transaction's reads can have
  // differed from a serial run's. Repeatable read does not: it lets a phantom through, and the check names it.
  const protocols: [string, LockingOptions, boolean][] = [
    ['strict two-phase locking, rows', { granularity: 'row', isolation: 'serializable' }, true],
    ['strict two-phase locking, pages', { granularity: 'page', isolation: 'serializable' }, true],
    ['repeatable read, pages', { granularity: 'page', isolation: 'repeatable-read' }, false],
    ['optimistic validation', { granularity: 'row', protocol: 'optimistic' }, true],
    ['serializable snapshots', { granularity: 'row', isolation: 'serializable', mvcc: true }, true],
  ];

  for (const [name, locking, reads] of protocols) {
    it(`${name}: what survives is what the committed transactions do when run one after another, in commit order`, () => {
      for (const rows of [3, 20]) {
        fc.assert(
          fc.property(fc.array(step, { maxLength: 18 }), (schedule) => {
            const result = runSchedule(schedule, createAccountsDatabase(rows), undefined, locking);
            const check = serialCheck(result, rows);
            expect(byId(result.committed.tables.accounts!.rows)).toEqual(byId(check.rows));
            // And nothing a committed transaction read would have been different run serially.
            if (reads) expect(check.differentRead).toBeNull();
          }),
          { numRuns: 150 },
        );
      }
    });
  }

  it('timestamp ordering is serializable in the order of its timestamps, except where a dirty read or write says otherwise', () => {
    for (const rows of [3, 20]) {
      fc.assert(
        fc.property(fc.array(step, { maxLength: 22 }), (schedule) => {
          const result = runSchedule(schedule, createAccountsDatabase(rows), undefined, {
            granularity: 'row',
            protocol: 'timestamp',
          });
          const dirty = result.steps.some((s) =>
            s.anomalies.some((a) => a.kind === 'dirty-read' || a.kind === 'dirty-write'),
          );
          if (dirty) return;
          const check = serialCheck(result, rows, 'begin');
          expect(check.sameTable).toBe(true);
          expect(check.differentRead).toBeNull();
        }),
        { numRuns: 400 },
      );
    }
  });

  it('basic timestamp ordering is the exception: it is not strict, so what it reads may be rolled back under it', () => {
    // B reads A's uncommitted value and builds on it; A then rolls back. B's work rests on data that never existed.
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = balance + 1 WHERE id = 1'],
        ['A', 'ROLLBACK'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', protocol: 'timestamp' },
    );
    expect(result.steps.flatMap((s) => s.anomalies.map((a) => a.kind))).toContain('dirty-write');
    // Serially, B's increment lands on 100; here it landed on A's uncommitted 0, and A's rollback could not undo it.
    expect(result.committed.tables.accounts!.rows[0]!.balance).toBe(1);
    expect(serialCheck(result, 20).rows[0]!.balance).toBe(101);
  });
});

describe('bugs a fuzz found while comparing protocols (plan.md §25.4 D6)', () => {
  it('a rolled-back delete goes back where it was, even after rows ahead of it were deleted and others updated', () => {
    const result = runSchedule(
      steps(
        ['B', 'BEGIN'],
        ['C', 'BEGIN'],
        ['C', 'DELETE FROM accounts WHERE id = 3'],
        ['B', 'DELETE FROM accounts WHERE id = 4'],
        ['A', 'DELETE FROM accounts WHERE id = 1'],
        ['A', 'UPDATE accounts SET balance = balance + 1 WHERE id = 5'],
        ['C', 'ROLLBACK'],
        ['B', 'ROLLBACK'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'repeatable-read' },
    );
    expect(result.final.tables.accounts!.rows.slice(0, 5).map((r) => r.id)).toEqual([2, 3, 4, 5, 6]);
  });

  it('under snapshots, two transactions cannot both add the same unique key: the second waits, then is refused', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', "INSERT INTO accounts VALUES (30, 'a', 1)"],
        ['B', "INSERT INTO accounts VALUES (30, 'b', 2)"],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'read-committed', mvcc: true },
    );
    expect(result.steps.some((s) => s.session === 'B' && s.phase === 'blocked')).toBe(true);
    const refused = result.steps.find((s) => s.session === 'B' && s.phase === 'resumed')!;
    expect(refused.error).toContain('Duplicate key');
    expect(result.final.tables.accounts!.rows.filter((r) => r.id === 30)).toHaveLength(1);
  });

  it('a snapshot does not hide a committed duplicate from the unique index', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE id = 1'],
        ['B', "INSERT INTO accounts VALUES (30, 'b', 2)"],
        ['A', "INSERT INTO accounts VALUES (30, 'a', 1)"],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'repeatable-read', mvcc: true },
    );
    expect(result.steps.at(-1)!.error).toContain('duplicate key');
  });

  it('under optimistic control the second to commit a key is refused at commit', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['B', 'BEGIN'],
        ['A', "INSERT INTO accounts VALUES (30, 'a', 1)"],
        ['B', "INSERT INTO accounts VALUES (30, 'b', 2)"],
        ['A', 'COMMIT'],
        ['B', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', protocol: 'optimistic' },
    );
    const refused = result.steps.find((s) => s.phase === 'victim')!;
    expect(refused.session).toBe('B');
    expect(refused.error).toContain('unique key');
    expect(result.final.tables.accounts!.rows.filter((r) => r.id === 30)).toHaveLength(1);
  });

  it('the victim of a deadlock gets its waiting steps run before the statement that closed the cycle is carried out', () => {
    // C's SELECT waits on B's uncommitted insert, with its UPDATE queued behind it. B's update then closes a cycle,
    // C is chosen, and its queued UPDATE runs. B's statement must not overwrite that with a result it worked out first.
    const result = runSchedule(
      steps(
        ['B', 'BEGIN'],
        ['B', "INSERT INTO accounts VALUES (21, 'x', 7)"],
        ['C', 'SELECT * FROM accounts WHERE balance > 4'],
        ['C', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 0 WHERE id = 2'],
        ['B', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'serializable' },
    );
    const rows = result.final.tables.accounts!.rows;
    expect(rows.find((r) => r.id === 1)?.balance).toBe(0);
    expect(rows.find((r) => r.id === 2)?.balance).toBe(0);
  });

  it('a page lock follows the row to the page it was made on, not to where a later delete shifts it', () => {
    // Twenty rows fill five pages exactly, so A's insert opens a sixth. B's delete then moves every row up one place,
    // and A's row lands on the fifth, which A never locked.
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', "INSERT INTO accounts VALUES (21, 'x', 7)"],
        ['B', 'DELETE FROM accounts WHERE id = 1'],
        ['B', 'SELECT * FROM accounts WHERE balance > 4'],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'page', isolation: 'serializable' },
    );
    expect(result.steps.flatMap((s) => s.anomalies.map((a) => a.kind))).toEqual([]);
    expect(result.steps.some((s) => s.session === 'B' && s.phase === 'blocked')).toBe(true);
  });
});

describe('a table read under an alias (plan.md §27.5 S7, found in T3)', () => {
  it('is locked as the stored table it is', () => {
    const result = runSchedule(
      steps(['A', 'BEGIN'], ['A', 'SELECT a.balance FROM accounts AS a WHERE a.id = 1'], ['B', 'UPDATE accounts SET balance = 0 WHERE id = 1']),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'repeatable-read' },
    );
    expect(result.steps[1]!.error).toBeUndefined();
    expect(result.steps[1]!.locks.map((l) => l.resource)).toContain('the row of accounts with id = 1');
    expect(result.steps[2]!.phase).toBe('blocked');
  });
});
