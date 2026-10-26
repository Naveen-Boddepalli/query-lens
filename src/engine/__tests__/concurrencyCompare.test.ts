import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareProtocols, PROTOCOLS, runProtocol, tableChanges } from '../concurrencyCompare.ts';
import type { ProtocolId, ProtocolOutcome } from '../concurrencyCompare.ts';
import type { ScheduleStep } from '../schedule.ts';
import { runSchedule } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';
import { serialCheck, transactionsOf } from '../serialCheck.ts';

const steps = (...rows: [string, string][]): ScheduleStep[] => rows.map(([session, sql]) => ({ session, sql }));
const by = (outcomes: ProtocolOutcome[]): Record<ProtocolId, ProtocolOutcome> =>
  Object.fromEntries(outcomes.map((o) => [o.protocol.id, o])) as Record<ProtocolId, ProtocolOutcome>;

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

describe('transactionsOf', () => {
  it('names each transaction’s fate, and who ended it', () => {
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['A', 'COMMIT'],
        ['B', 'BEGIN'],
        ['B', 'UPDATE accounts SET balance = 2 WHERE id = 2'],
        ['B', 'ROLLBACK'],
        ['C', 'UPDATE accounts SET balance = 3 WHERE id = 3'],
        ['D', 'BEGIN'],
        ['D', 'SELECT * FROM accounts'],
      ),
      createAccountsDatabase(20),
    );
    const txns = transactionsOf(result);
    expect(txns.map((t) => `${t.session}:${t.fate}`)).toEqual(['A:committed', 'B:rolled-back', 'C:committed', 'D:open']);
    expect(txns.map((t) => t.explicit)).toEqual([true, true, false, true]);
    expect(txns.map((t) => t.writes)).toEqual([true, true, true, false]);
  });

  it('counts a statement the protocol refused, on its own, as an aborted transaction', () => {
    const result = runSchedule(
      steps(['A', 'BEGIN'], ['B', 'DELETE FROM accounts WHERE id = 1'], ['A', 'SELECT * FROM accounts WHERE balance > 4']),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', protocol: 'timestamp' },
    );
    expect(transactionsOf(result).map((t) => `${t.session}:${t.fate}`)).toEqual(['B:committed', 'A:aborted']);
    expect(transactionsOf(result).find((t) => t.fate === 'aborted')!.reason).toContain('too late');
  });
});

describe('serialCheck', () => {
  it('finds a write skew by what was read, though the table it leaves is one a serial run could leave', () => {
    const result = runSchedule(writeSkew, createAccountsDatabase(20), undefined, {
      granularity: 'row',
      isolation: 'repeatable-read',
      mvcc: true,
    });
    const check = serialCheck(result, 20);
    expect(check.sameTable).toBe(true);
    expect(check.differentRead).not.toBeNull();
    expect(check.differentRead!.session).toBe('B');
  });

  it('calls a run serializable when any order explains it, not only the order they committed', () => {
    // A only reads, and reads before B's write: A then B explains it, though B committed first.
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'SELECT * FROM accounts WHERE balance > 50'],
        ['B', 'UPDATE accounts SET balance = 5 WHERE id = 1'],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'repeatable-read', mvcc: true },
    );
    const check = serialCheck(result, 20, 'commit');
    // In commit order B is first, and A would then have read 5 for row 1.
    expect(check.differentRead).not.toBeNull();
    expect(check.serializable).toBe(true);
    expect(check.found).toEqual(['A', 'B']);
  });

  it('holds a write to what it affected, not only to the table it left', () => {
    // B's update sets the value the row already has, so the table is the same either way — but B was told "no rows",
    // because A's uncommitted delete hid the row, and run on its own it would have been told "1 row".
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['A', 'DELETE FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 100 WHERE id = 1'],
        ['A', 'ROLLBACK'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', protocol: 'timestamp' },
    );
    const check = serialCheck(result, 20, 'begin');
    expect(check.sameTable).toBe(true);
    expect(check.serializable).toBe(false);
  });

  it('finds an order that is neither the commit order nor the begin order, by searching', () => {
    // A read 100 before B changed it; D began first but read after B, per statement; D committed before A did.
    // Commit order is B, D, A (A would see 50); begin order is D, A, B (D would see 100); A, B, D explains it.
    const result = runSchedule(
      steps(
        ['D', 'BEGIN'],
        ['A', 'BEGIN'],
        ['A', 'SELECT balance FROM accounts WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 50 WHERE id = 1'],
        ['D', 'SELECT balance FROM accounts WHERE id = 1'],
        ['D', 'COMMIT'],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'read-committed', mvcc: true },
    );
    expect(serialCheck(result, 20, 'commit').differentRead).not.toBeNull();
    expect(serialCheck(result, 20, 'begin').differentRead).not.toBeNull();
    const check = serialCheck(result, 20, 'commit');
    expect(check.serializable).toBe(true);
    expect(check.found).toEqual(['A', 'B', 'D']);
  });

  it('holds the table that is left to the order it finds, even when no statement answered differently', () => {
    // A deletes the row B changed and has not committed. B rolls back, and A never commits, so nothing committed at
    // all — yet what survives has B's abandoned balance in it: the delete's undo put back the row as A saw it.
    const result = runSchedule(
      steps(
        ['B', 'BEGIN'],
        ['A', 'BEGIN'],
        ['B', 'UPDATE accounts SET balance = 0 WHERE id = 2'],
        ['A', 'DELETE FROM accounts WHERE id = 2'],
        ['B', 'ROLLBACK'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', protocol: 'timestamp' },
    );
    const check = serialCheck(result, 20, 'begin');
    expect(check.differentRead).toBeNull();
    expect(check.sameTable).toBe(false);
    expect(check.serializable).toBe(false);
    expect(check.exhaustive).toBe(true);
    expect(result.steps.flatMap((s) => s.anomalies.map((a) => a.kind))).toContain('dirty-write');
  });

  it('says when no order exists, and that the search covered them all', () => {

    const result = runSchedule(writeSkew, createAccountsDatabase(20), undefined, {
      granularity: 'row',
      isolation: 'repeatable-read',
      mvcc: true,
    });
    const check = serialCheck(result, 20);
    expect(check.serializable).toBe(false);
    expect(check.found).toBeNull();
    expect(check.exhaustive).toBe(true);
  });

  it('says so when the search was cut off before it could tell', () => {
    const result = runSchedule(writeSkew, createAccountsDatabase(20), undefined, {
      granularity: 'row',
      isolation: 'repeatable-read',
      mvcc: true,
    });
    const check = serialCheck(result, 20, 'commit', createAccountsDatabase(20), 1);
    expect(check.serializable).toBe(false);
    expect(check.exhaustive).toBe(false);
  });

  it('can replay in the order transactions began rather than the order they committed', () => {
    // B began after A but committed first; under timestamp order A is first.
    const result = runSchedule(
      steps(
        ['A', 'BEGIN'],
        ['B', 'BEGIN'],
        ['A', 'UPDATE accounts SET balance = 1 WHERE id = 1'],
        ['B', 'UPDATE accounts SET balance = 2 WHERE id = 2'],
        ['B', 'COMMIT'],
        ['A', 'COMMIT'],
      ),
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', protocol: 'optimistic' },
    );
    expect(serialCheck(result, 20, 'commit').order).toEqual(['B', 'A']);
    expect(serialCheck(result, 20, 'begin').order).toEqual(['A', 'B']);
  });
});

describe('comparing protocols on one schedule', () => {
  it('the five protocols are the ones the runner implements, each distinct', () => {
    expect(PROTOCOLS.map((p) => p.id)).toEqual([
      'two-phase',
      'timestamp',
      'optimistic',
      'snapshot',
      'serializable-snapshot',
    ]);
  });

  it('a lost update: nobody that claims serializability loses it, and each pays differently', () => {
    const outcomes = by(compareProtocols(lostUpdate, 20));
    for (const o of Object.values(outcomes)) {
      if (o.protocol.claimsSerializable) expect(o.serializable).toBe(true);
    }
    // Locking makes someone wait; the protocols that never wait abort someone instead.
    expect(outcomes['two-phase'].waits + outcomes['two-phase'].result.deadlocks).toBeGreaterThan(0);
    expect(outcomes.timestamp.waits).toBe(0);
    expect(outcomes.optimistic.waits).toBe(0);
    expect(outcomes.timestamp.aborted.length).toBeGreaterThan(0);
    expect(outcomes.optimistic.aborted.length).toBe(1);
    // Snapshots refuse the second writer too: first committer wins.
    expect(outcomes.snapshot.aborted.length).toBe(1);
  });

  it('optimistic validation throws away the whole transaction, and says how much work went with it', () => {
    const o = by(compareProtocols(lostUpdate, 20)).optimistic;
    expect(o.aborted.map((t) => t.session)).toEqual(['B']);
    expect(o.wasted).toBe(2);
    expect(o.changes).toEqual(['id 1: balance 100 → 110']);
  });

  it('write skew: snapshots let it through and the check says so; the serializable ones do not', () => {
    const outcomes = by(compareProtocols(writeSkew, 20));
    expect(outcomes.snapshot.serializable).toBe(false);
    expect(outcomes.snapshot.aborted).toEqual([]);
    expect(outcomes.snapshot.committed).toBe(2);
    for (const id of ['two-phase', 'timestamp', 'optimistic', 'serializable-snapshot'] as const) {
      expect(outcomes[id].serializable).toBe(true);
      expect(outcomes[id].committed + outcomes[id].aborted.length).toBe(2);
      expect(outcomes[id].committed).toBeLessThan(2);
    }
  });

  it('timestamp ordering is shown what it lets through: a dirty write, then a rollback it cannot undo', () => {
    const o = by(
      compareProtocols(
        steps(
          ['A', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
          ['B', 'UPDATE accounts SET balance = balance + 1 WHERE id = 1'],
          ['A', 'ROLLBACK'],
        ),
        20,
      ),
    ).timestamp;
    expect(o.serializable).toBe(false);
    expect(o.anomalies).toContain('dirty-write');
    expect(o.anomalies).toContain('dirty-read');
    expect(o.rolledBack).toBe(1);
    // Two-phase locking makes B wait for A instead, and ends with 101.
    const locking = by(
      compareProtocols(
        steps(
          ['A', 'BEGIN'],
          ['A', 'UPDATE accounts SET balance = 0 WHERE id = 1'],
          ['B', 'UPDATE accounts SET balance = balance + 1 WHERE id = 1'],
          ['A', 'ROLLBACK'],
        ),
        20,
      ),
    )['two-phase'];
    expect(locking.serializable).toBe(true);
    expect(locking.waits).toBe(1);
    expect(locking.changes).toEqual(['id 1: balance 100 → 101']);
  });

  it('snapshots read from one moment, so read skew and a reader beside a writer are serializable after all', () => {
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
    const o = by(compareProtocols(readSkew, 20)).snapshot;
    expect(o.serializable).toBe(true);
    expect(o.check.found).toEqual(['A', 'B']);
    expect(o.aborted).toEqual([]);
    // Without a snapshot the same reads come from two different moments, and nothing explains them.
    const readCommitted = runSchedule(readSkew, createAccountsDatabase(20), undefined, {
      granularity: 'row',
      isolation: 'read-committed',
      mvcc: true,
    });
    expect(serialCheck(readCommitted, 20).serializable).toBe(false);
  });

  it('counts an anomaly a protocol caught at commit as seen, not as let through', () => {
    const phantom = steps(
      ['A', 'BEGIN'],
      ['A', 'SELECT * FROM accounts WHERE balance > 50'],
      ['B', "INSERT INTO accounts VALUES (30, 'zed', 100)"],
      ['A', 'SELECT * FROM accounts WHERE balance > 50'],
      ['A', 'COMMIT'],
    );
    const o = by(compareProtocols(phantom, 20));
    expect(o.optimistic.aborted.map((t) => t.session)).toEqual(['A']);
    expect(o.optimistic.anomalies).toEqual([]);
    expect(o.optimistic.result.steps.flatMap((s) => s.anomalies.map((a) => a.kind))).toContain('phantom');
  });

  it('an empty schedule costs nobody anything', () => {
    for (const o of compareProtocols([], 3)) {
      expect(o.committed).toBe(0);
      expect(o.aborted).toEqual([]);
      expect(o.waits).toBe(0);
      expect(o.serializable).toBe(true);
      expect(o.changes).toEqual([]);
    }
  });

  it('whatever the schedule, a protocol that claims serializability delivers it, or says why not', () => {
    const statement = fc.oneof(
      fc.constant('BEGIN'),
      fc.constant('COMMIT'),
      fc.constant('ROLLBACK'),
      fc.record({ id: fc.integer({ min: 1, max: 4 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 1, max: 4 }).map((id) => `UPDATE accounts SET balance = balance + 1 WHERE id = ${String(id)}`),
      fc.integer({ min: 21, max: 24 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 7)`),
      fc.integer({ min: 1, max: 4 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
      fc.integer({ min: 1, max: 4 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
    );
    const step = fc.record({ session: fc.constantFrom('A', 'B', 'C'), sql: statement });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 18 }), (schedule) => {
        for (const o of compareProtocols(schedule, 20)) {
          if (!o.protocol.claimsSerializable) continue;
          const dirty = o.anomalies.includes('dirty-read') || o.anomalies.includes('dirty-write');
          // Only timestamp ordering is allowed an excuse, and it must be a dirty read or write.
          expect(o.serializable || (o.protocol.id === 'timestamp' && dirty)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('runProtocol and compareProtocols agree', () => {
    const all = compareProtocols(lostUpdate, 3);
    const one = runProtocol(PROTOCOLS[2]!, lostUpdate, 3);
    expect(one.changes).toEqual(all[2]!.changes);
    expect(one.committed).toBe(all[2]!.committed);
  });
});

describe('tableChanges', () => {
  const before = [
    { id: 1, owner: 'a', balance: 100 },
    { id: 2, owner: 'b', balance: 100 },
    { id: 3, owner: 'c', balance: 100 },
  ];
  it('says nothing when nothing changed', () => {
    expect(tableChanges(before, before)).toEqual([]);
  });
  it('names a changed value, a removed row and an added row', () => {
    const after = [
      { id: 1, owner: 'a', balance: 90 },
      { id: 3, owner: 'c', balance: 100 },
      { id: 9, owner: 'z', balance: 1 },
    ];
    expect(tableChanges(before, after)).toEqual(['id 1: balance 100 → 90', 'added (9, z, 1)', 'id 2 removed']);
  });
  it('shortens a long list', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, owner: 'x', balance: 1 }));
    const after = many.map((r) => ({ ...r, balance: 2 }));
    const notes = tableChanges(many, after, 3);
    expect(notes).toHaveLength(4);
    expect(notes[3]).toBe('and 7 more');
  });
});
