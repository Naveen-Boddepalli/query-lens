/**
 * plan.md §27.5 T3 — next-key (gap) locks: InnoDB's answer to the phantom. A statement at REPEATABLE READ locks each
 * index record it reads and the gap below it; an insert asks for X on the gap it goes into, and waits for anyone's S.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HERMITAGE_TESTS, runHermitage } from '../hermitage.ts';
import { downgrade, emptyTable, request } from '../locks/lockTable.ts';
import { precedenceGraph } from '../precedence.ts';
import { runSchedule } from '../schedule.ts';
import type { LockingOptions, ScheduleResult, ScheduleStep } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';
import type { IsolationLevel } from '../transactionControl.ts';
import type { Database } from '../types.ts';

const s = (session: string, sql: string): ScheduleStep => ({ session, sql });
const NEXT_KEY: LockingOptions = { granularity: 'row', isolation: 'repeatable-read', nextKey: true };
const run = (steps: ScheduleStep[], locking: LockingOptions = NEXT_KEY, db: Database = createAccountsDatabase(20)) =>
  runSchedule(steps, db, undefined, locking);

/** The gaps a step's lock table holds or waits on, as `key:holders~waiters` — `+` for the gap above the last key. */
const gaps = (result: ScheduleResult, step: number): string[] =>
  (result.steps[step]!.keyLocks ?? [])
    .filter((k) => k.part === 'gap')
    .map((k) => `${k.key === null ? '+' : k.key.join()}:${k.holders.map((h) => h.session).join('')}${k.waiters.map((w) => `~${w.session}`).join('')}`);

const PHANTOM = [
  s('A', 'BEGIN'),
  s('A', 'SELECT * FROM accounts WHERE balance > 50'),
  s('B', "INSERT INTO accounts VALUES (30, 'zed', 100)"),
  s('A', 'SELECT * FROM accounts WHERE balance > 50'),
  s('A', 'COMMIT'),
];

describe('the phantom, kept out at REPEATABLE READ (plan.md §27.5 T3)', () => {
  it('without gap locks the insert goes through and the re-read sees it; with them the insert waits', () => {
    const plain = run(PHANTOM, { granularity: 'row', isolation: 'repeatable-read' });
    expect(plain.steps.some((st) => st.anomalies.some((a) => a.kind === 'phantom'))).toBe(true);
    expect(precedenceGraph(plain).cycle).not.toBeNull();

    const nextKey = run(PHANTOM);
    expect(nextKey.steps[2]!.phase).toBe('blocked');
    expect(nextKey.steps[2]!.waitingOn).toEqual(['A']);
    expect(nextKey.steps[2]!.notes.join(' ')).toMatch(/requests an exclusive lock on the gap above the last key in accounts\.id, held by A/);
    expect(nextKey.steps.some((st) => st.anomalies.length > 0)).toBe(false);
    expect(nextKey.steps[3]!.rows).toHaveLength(20);
    // A's commit lets the insert in, after A has finished reading.
    expect(nextKey.steps.at(-1)!.phase).toBe('resumed');
    expect(nextKey.final.tables.accounts!.rows).toHaveLength(21);
    expect(precedenceGraph(nextKey).cycle).toBeNull();
  });

  it('a full scan walks the whole index: every record and every gap, the one above the last included', () => {
    const result = run(PHANTOM);
    expect(gaps(result, 1)).toHaveLength(21);
    expect(gaps(result, 1)).toContain('+:A');
    expect(result.steps[1]!.notes.join(' ')).toMatch(/A also locks 21 gaps in accounts\.id/);
    // Their release is told once, not twenty-one times.
    const commit = result.steps.find((st) => st.kind === 'commit')!;
    expect(commit.notes.filter((n) => n.includes('gap') && n.includes('released'))).toEqual(["A's 21 gap locks are released."]);
  });

  it('a range locks only its own keys and gaps: a row outside it is free, an insert past it waits', () => {
    const result = run([
      s('A', 'BEGIN'),
      s('A', 'SELECT * FROM accounts WHERE id > 18'),
      s('B', 'UPDATE accounts SET balance = 0 WHERE id = 5'),
      s('B', "INSERT INTO accounts VALUES (25, 'zed', 100)"),
      s('A', 'SELECT * FROM accounts WHERE id > 18'),
      s('A', 'COMMIT'),
    ]);
    expect(gaps(result, 1)).toEqual(['19:A', '20:A', '+:A']);
    expect(result.steps[2]!.phase).toBe('ran');
    expect(result.steps[3]!.phase).toBe('blocked');
    expect(gaps(result, 3)).toContain('+:A~B');
    expect(result.steps[4]!.rows.map((r) => r.id)).toEqual([19, 20]);
  });

  it('a whole unique key that is there locks just its row; one that is not locks the gap it would be in', () => {
    const hit = run([s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE id = 3')]);
    expect(gaps(hit, 1)).toEqual([]);
    expect(hit.steps[1]!.keyLocks!.filter((k) => k.part === 'record').map((k) => k.key)).toEqual([[3]]);
    const miss = run([s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE id = 25'), s('B', "INSERT INTO accounts VALUES (25, 'zed', 1)")]);
    expect(gaps(miss, 1)).toEqual(['+:A']);
    expect(miss.steps[2]!.phase).toBe('blocked');
  });

  it('SERIALIZABLE takes no predicate lock under next-key locking: the gaps already do its work', () => {
    const result = run(PHANTOM, { ...NEXT_KEY, isolation: 'serializable' });
    expect(result.steps.flatMap((st) => st.locks).some((l) => l.resource.includes(' that A read'))).toBe(false);
    expect(result.steps[2]!.phase).toBe('blocked');
  });
});

describe('inserts and the gaps they go into (plan.md §27.5 T3)', () => {
  it('READ COMMITTED takes no gap locks, but its insert still waits for the gap locks of others', () => {
    const rc = run([s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE id > 18')], { ...NEXT_KEY, isolation: 'read-committed' });
    expect(gaps(rc, 1)).toEqual([]);
    // Not even for the length of the statement: what it gives back is its two rows.
    expect(rc.steps[1]!.notes.join(' ')).toMatch(/gives back the 2 shared locks this statement took/);
    const result = run([
      s('A', 'BEGIN'),
      s('A', 'SELECT * FROM accounts WHERE id > 18'),
      s('B', 'BEGIN ISOLATION LEVEL READ COMMITTED'),
      s('B', "INSERT INTO accounts VALUES (25, 'zed', 1)"),
    ]);
    expect(result.steps[3]!.phase).toBe('blocked');
  });

  it('two inserts into one gap do not wait for each other, and hold no gap afterwards', () => {
    const result = run([
      s('A', 'BEGIN'),
      s('B', 'BEGIN'),
      s('A', "INSERT INTO accounts VALUES (21, 'a', 1)"),
      s('B', "INSERT INTO accounts VALUES (22, 'b', 1)"),
    ]);
    expect(result.steps.map((st) => st.phase)).toEqual(['ran', 'ran', 'ran', 'ran']);
    expect(result.steps[2]!.notes).toContain("A's insert goes into the gap above the last key in accounts.id, which no other transaction has locked.");
    expect(gaps(result, 3)).toEqual([]);
  });

  it('a transaction inserts into its own gap, and keeps both halves of it locked', () => {
    const result = run([
      s('A', 'BEGIN'),
      s('A', 'SELECT * FROM accounts WHERE id > 18'),
      s('A', "INSERT INTO accounts VALUES (25, 'a', 1)"),
      s('B', "INSERT INTO accounts VALUES (23, 'b', 1)"),
      s('B', "INSERT INTO accounts VALUES (30, 'b', 1)"),
    ]);
    expect(result.steps[2]!.phase).toBe('ran');
    expect(gaps(result, 2)).toEqual(['19:A', '20:A', '+:A', '25:A']);
    // 23 would land below 25, 30 above it: both halves are A's.
    expect(result.steps[3]!.phase).toBe('blocked');
    expect(result.steps[4]!.phase).toBe('queued');
  });

  it('an update that moves a key into a locked range is an insert there, and waits', () => {
    const result = run([s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE id > 18'), s('B', 'UPDATE accounts SET id = 25 WHERE id = 5')]);
    expect(result.steps[2]!.phase).toBe('blocked');
    expect(gaps(result, 2)).toContain('+:A~B');
  });

  it('a deleted key stays in the index, so the gap below it does not widen out from under a lock', () => {
    const result = run([
      s('C', 'DELETE FROM accounts WHERE id = 10'),
      s('A', 'BEGIN'),
      s('A', 'SELECT * FROM accounts WHERE id = 10'),
      s('C', 'DELETE FROM accounts WHERE id = 11'),
      s('B', "INSERT INTO accounts VALUES (10, 'b', 1)"),
      s('A', 'SELECT * FROM accounts WHERE id = 10'),
      s('A', 'COMMIT'),
    ]);
    expect(gaps(result, 2)).toEqual(['11:A']);
    expect(result.steps[3]!.phase).toBe('ran');
    expect(result.steps[4]!.phase).toBe('blocked');
    expect(result.steps[5]!.rows).toEqual([]);
  });

  it('two readers of one range that each insert into it deadlock, as InnoDB’s do', () => {
    const result = run([
      s('A', 'BEGIN'),
      s('B', 'BEGIN'),
      s('A', 'SELECT * FROM accounts WHERE balance > 50'),
      s('B', 'SELECT * FROM accounts WHERE balance > 50'),
      s('A', "INSERT INTO accounts VALUES (30, 'a', 100)"),
      s('B', "INSERT INTO accounts VALUES (31, 'b', 100)"),
      s('A', 'COMMIT'),
    ]);
    expect(result.deadlocks).toBe(1);
    expect(result.final.tables.accounts!.rows.map((r) => r.id)).toContain(30);
    expect(result.final.tables.accounts!.rows.map((r) => r.id)).not.toContain(31);
  });

  it('escalation trades the gaps too: a table lock covers them', () => {
    const result = run(
      [s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE id > 18'), s('A', 'SELECT * FROM accounts WHERE id = 5')],
      { ...NEXT_KEY, escalateAt: 2 },
    );
    expect(gaps(result, 1)).toEqual(['19:A', '20:A', '+:A']);
    expect(result.steps[2]!.locks).toEqual([{ resource: 'the table accounts', holders: [{ session: 'A', mode: 'shared' }], waiters: [] }]);
    // Two rows, the page above them, and three gaps.
    expect(result.steps[2]!.notes.join(' ')).toMatch(/lets its 6 finer locks go/);
  });

  it('the lock table can trade an X back for the S it covers, without letting anyone in between', () => {
    let state = emptyTable();
    state = request(state, 'T1', 'g', 'shared', (r) => r).state;
    state = request(state, 'T1', 'g', 'exclusive', (r) => r).state;
    state = request(state, 'T2', 'g', 'exclusive', (r) => r).state;
    const back = downgrade(state, 'T1', 'g', 'shared', (r) => r);
    expect(back.state.holders.g).toEqual([{ transaction: 'T1', mode: 'shared' }]);
    expect(back.state.waiters.g?.map((w) => w.transaction)).toEqual(['T2']);
  });
});

describe('InnoDB’s SERIALIZABLE in the Hermitage matrix (plan.md §27.5 T3)', () => {
  it('keeps the phantom (G2) out with gap locks, not a predicate lock: both inserts go for one gap and deadlock', () => {
    const { result, occurred } = runHermitage(HERMITAGE_TESTS.find((t) => t.id === 'G2')!, 'serializable', 'innodb');
    expect(occurred).toBe(false);
    expect(result.deadlocks).toBe(1);
    expect(result.steps.some((st) => (st.keyLocks ?? []).some((k) => k.part === 'gap' && k.waiters.length > 0))).toBe(true);
    expect(result.steps.flatMap((st) => st.locks).some((l) => / that T\d read$/.test(l.resource))).toBe(false);
  });

  it('and PMP: the insert of a row the first read would match waits on a gap until that transaction commits', () => {
    const { result, occurred } = runHermitage(HERMITAGE_TESTS.find((t) => t.id === 'PMP')!, 'serializable', 'innodb');
    expect(occurred).toBe(false);
    const insert = result.steps.find((st) => st.session === 'T2' && st.phase === 'blocked')!;
    expect(insert.sql).toBe('INSERT INTO test VALUES (3, 30)');
    expect(insert.notes.join(' ')).toMatch(/requests an exclusive lock on the gap below id = 101 in test\.id, held by T1/);
  });
});

describe('next-key locking is serializable (plan.md §27.5 T3)', () => {
  // Keys ten apart, so inserts and moved keys have gaps inside the range to land in.
  const spaced = (): Database => {
    const db = createAccountsDatabase(20);
    const table = db.tables.accounts!;
    return { tables: { accounts: { ...table, rows: table.rows.map((r, i) => ({ ...r, id: (i + 1) * 10 })) } } };
  };

  it('no random schedule at REPEATABLE READ has a cycle, a phantom or a changed re-read', () => {
    const id = fc.integer({ min: 1, max: 21 }).map((n) => n * 10);
    const near = fc.integer({ min: 0, max: 215 });
    const op = fc.oneof(
      fc.tuple(near, fc.integer({ min: 0, max: 60 })).map(([lo, w]) => `SELECT * FROM accounts WHERE id BETWEEN ${String(lo)} AND ${String(lo + w)}`),
      near.map((lo) => `SELECT * FROM accounts WHERE id > ${String(lo)}`),
      near.map((k) => `SELECT balance FROM accounts WHERE id = ${String(k)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
      near.map((k) => `INSERT INTO accounts VALUES (${String(k)}, 'x', 7)`),
      fc.tuple(id, near).map(([from, to]) => `UPDATE accounts SET id = ${String(to)} WHERE id = ${String(from)}`),
      id.map((k) => `UPDATE accounts SET balance = balance + 1 WHERE id = ${String(k)}`),
      id.map((k) => `DELETE FROM accounts WHERE id = ${String(k)}`),
      fc.tuple(near, fc.integer({ min: 0, max: 40 })).map(([lo, w]) => `DELETE FROM accounts WHERE id BETWEEN ${String(lo)} AND ${String(lo + w)}`),
    );
    const txn = (session: string) =>
      fc
        .tuple(fc.array(op, { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 4 }))
        .map(([ops, end]) => [s(session, 'BEGIN'), ...ops.map((sql) => s(session, sql)), s(session, end === 0 ? 'ROLLBACK' : 'COMMIT')]);
    const schedule = fc
      .tuple(txn('A'), txn('B'), txn('C'), fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 30, maxLength: 30 }))
      .map(([a, b, c, picks]) => {
        const queues = [a, b, c].map((q) => [...q]);
        const out: ScheduleStep[] = [];
        for (const p of picks) {
          const q = queues[p]!.length > 0 ? queues[p]! : queues.find((x) => x.length > 0);
          if (q) out.push(q.shift()!);
        }
        for (const q of queues) out.push(...q);
        return out;
      });
    fc.assert(
      fc.property(schedule, fc.constantFrom<IsolationLevel>('repeatable-read', 'serializable'), (steps, isolation) => {
        const result = run(steps, { ...NEXT_KEY, isolation }, spaced());
        const g = precedenceGraph(result);
        const said = JSON.stringify({ isolation, steps });
        expect(g.cycle, said).toBeNull();
        expect(g.unseen, said).toEqual([]);
        expect(result.steps.flatMap((st) => st.anomalies).map((a) => a.kind), said).toEqual([]);
      }),
      { numRuns: 300, seed: 31 },
    );
  }, 120_000);
});
