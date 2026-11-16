/**
 * plan.md §27.5 T2 — multi-granularity locking: IS, IX, S, SIX and X over a table → page → row hierarchy, a
 * compatibility matrix computed from what each mode lets its holder do, and lock escalation at a threshold.
 */

import { describe, expect, it } from 'vitest';
import {
  combine,
  compatibilityMatrix,
  compatibleModes,
  covers,
  emptyTable,
  LOCK_MODES,
  MODE_SHORT,
  request,
} from '../locks/lockTable.ts';
import type { LockMode } from '../locks/lockTable.ts';
import { runSchedule } from '../schedule.ts';
import type { LockingOptions, ScheduleStep } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';

const label = (r: string) => r;
const s = (session: string, sql: string): ScheduleStep => ({ session, sql });
const ROW: LockingOptions = { granularity: 'row', isolation: 'repeatable-read' };

describe('the modes (plan.md §27.5 T2)', () => {
  it('computes the textbook compatibility matrix from what each mode does', () => {
    // Gray, Lorie, Putzolu and Traiger's matrix, as every textbook prints it: row held, column requested.
    const textbook: Record<string, string> = {
      IS: 'IS IX S SIX',
      IX: 'IS IX',
      S: 'IS S',
      SIX: 'IS',
      X: '',
    };
    for (const held of LOCK_MODES) {
      const allowed = LOCK_MODES.filter((requested) => compatibleModes(held, requested)).map((m) => MODE_SHORT[m]).join(' ');
      expect(allowed, MODE_SHORT[held]).toBe(textbook[MODE_SHORT[held]]);
    }
    expect(compatibilityMatrix()).toHaveLength(25);
    // Symmetric, as a conflict is.
    for (const { held, requested, compatible } of compatibilityMatrix()) expect(compatibleModes(requested, held)).toBe(compatible);
  });

  it('knows which mode covers which, and what two together make', () => {
    expect(combine('shared', 'intention-exclusive')).toBe('shared-intention-exclusive');
    expect(combine('intention-shared', 'intention-exclusive')).toBe('intention-exclusive');
    expect(combine('shared', 'intention-shared')).toBe('shared');
    expect(combine('shared-intention-exclusive', 'exclusive')).toBe('exclusive');
    const coversAll = (held: LockMode) => LOCK_MODES.filter((m) => covers(held, m)).map((m) => MODE_SHORT[m]);
    expect(coversAll('exclusive')).toEqual(['IS', 'IX', 'S', 'SIX', 'X']);
    expect(coversAll('shared-intention-exclusive')).toEqual(['IS', 'IX', 'S', 'SIX']);
    expect(coversAll('shared')).toEqual(['IS', 'S']);
    expect(coversAll('intention-exclusive')).toEqual(['IS', 'IX']);
    expect(coversAll('intention-shared')).toEqual(['IS']);
  });

  it('upgrades a held lock to the mode that covers both, and waits when that one conflicts', () => {
    let state = emptyTable();
    state = request(state, 'T1', 'accounts', 'shared', label).state;
    state = request(state, 'T2', 'accounts', 'intention-shared', label).state;
    const six = request(state, 'T1', 'accounts', 'intention-exclusive', label);
    expect(six.kind).toBe('granted');
    expect(six.narration[0]).toBe('T1 is granted a shared-intention-exclusive (SIX) lock on accounts — with the S it holds, SIX.');
    // SIX beside IS is fine; beside IX it is not.
    const t3 = request(six.state, 'T3', 'accounts', 'intention-exclusive', label);
    expect(t3.kind).toBe('blocked');
    expect(t3.waitingOn).toEqual(['T1']);
  });

  it('IS and IX never wait for each other: what they mean to touch is locked again below', () => {
    let state = emptyTable();
    state = request(state, 'T1', 'accounts', 'intention-exclusive', label).state;
    expect(request(state, 'T2', 'accounts', 'intention-exclusive', label).kind).toBe('granted');
    expect(request(state, 'T2', 'accounts', 'shared', label).kind).toBe('blocked');
  });
});

describe('the hierarchy in a schedule (plan.md §27.5 T2)', () => {
  it('a write locks top down: IX on the table, IX on the page, X on the row', () => {
    const result = runSchedule([s('A', 'BEGIN'), s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1')], createAccountsDatabase(20), undefined, ROW);
    expect(result.steps[1]!.locks.map((l) => `${l.resource}: ${l.holders.map((h) => MODE_SHORT[h.mode]).join()}`)).toEqual([
      'the table accounts: IX',
      'page 0: IX',
      'the row of accounts with id = 1: X',
    ]);
  });

  it('a read takes IS above its S; at READ COMMITTED both go with the statement', () => {
    const rr = runSchedule([s('A', 'BEGIN'), s('A', 'SELECT balance FROM accounts WHERE id = 1')], createAccountsDatabase(20), undefined, ROW);
    expect(rr.steps[1]!.locks.map((l) => MODE_SHORT[l.holders[0]!.mode])).toEqual(['IS', 'IS', 'S']);
    const rc = runSchedule(
      [s('A', 'BEGIN'), s('A', 'SELECT balance FROM accounts WHERE id = 1')],
      createAccountsDatabase(20),
      undefined,
      { granularity: 'row', isolation: 'read-committed' },
    );
    expect(rc.steps[1]!.locks).toEqual([]);
    expect(rc.steps[1]!.notes.join(' ')).toMatch(/gives back the 1 shared lock this statement took, and the 2 intention locks above them/);
  });

  it('an INSERT says IX on the table before it writes, then locks its new row under IX on its page', () => {
    const result = runSchedule([s('A', 'BEGIN'), s('A', "INSERT INTO accounts VALUES (21, 'x', 7)")], createAccountsDatabase(20), undefined, ROW);
    expect(result.steps[1]!.locks.map((l) => `${l.resource}: ${MODE_SHORT[l.holders[0]!.mode]}`)).toEqual([
      'the table accounts: IX',
      'page 5: IX',
      'the row of accounts with id = 21: X',
    ]);
  });

  it('page locks sit under an intention on the table too', () => {
    const result = runSchedule([s('A', 'BEGIN'), s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1')], createAccountsDatabase(20), undefined, { granularity: 'page', isolation: 'repeatable-read' });
    expect(result.steps[1]!.locks.map((l) => `${l.resource}: ${MODE_SHORT[l.holders[0]!.mode]}`)).toEqual(['the table accounts: IX', 'page 0: X']);
  });
});

describe('lock escalation (plan.md §27.5 T2)', () => {
  const writes = [
    s('A', 'BEGIN'),
    s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1'),
    s('A', 'UPDATE accounts SET balance = 1 WHERE id = 2'),
    s('A', 'UPDATE accounts SET balance = 1 WHERE id = 3'),
    s('B', 'SELECT balance FROM accounts WHERE id = 10'),
  ];

  it('past the threshold, a transaction trades its row locks on a table for one table lock', () => {
    const result = runSchedule(writes, createAccountsDatabase(20), undefined, { ...ROW, escalateAt: 2 });
    const third = result.steps[3]!;
    expect(third.notes.join(' ')).toMatch(/A would hold more than 2 locks on accounts, so it escalates: it holds an exclusive lock on the whole table instead, and lets its \d+ finer locks go\./);
    expect(third.locks).toEqual([{ resource: 'the table accounts', holders: [{ session: 'A', mode: 'exclusive' }], waiters: [] }]);
  });

  it('and pays for it: a reader of a row it never touched now waits', () => {
    const escalated = runSchedule(writes, createAccountsDatabase(20), undefined, { ...ROW, escalateAt: 2 });
    expect(escalated.steps.at(-1)!.phase).toBe('blocked');
    expect(escalated.steps.at(-1)!.waitingOn).toEqual(['A']);
    // Without escalation B reads row 10 at once: nobody holds it.
    const plain = runSchedule(writes, createAccountsDatabase(20), undefined, ROW);
    expect(plain.steps.at(-1)!.phase).toBe('ran');
    expect(plain.steps.at(-1)!.rows).toEqual([{ balance: 100 }]);
  });

  it('a read-only transaction escalates to S, which other readers share', () => {
    const result = runSchedule(
      [s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE balance > 50'), s('B', 'SELECT balance FROM accounts WHERE id = 2')],
      createAccountsDatabase(3),
      undefined,
      { ...ROW, escalateAt: 2 },
    );
    expect(result.steps[1]!.locks).toEqual([{ resource: 'the table accounts', holders: [{ session: 'A', mode: 'shared' }], waiters: [] }]);
    expect(result.steps[2]!.phase).toBe('ran');
  });
});
