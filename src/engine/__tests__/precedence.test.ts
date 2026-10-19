/**
 * plan.md §27.5 T1 — the precedence graph, held against the replay check (`serialCheck.ts`): on every Hermitage cell
 * and on random schedules under every protocol, a graph with no cycle and nothing it cannot see is always a run some
 * serial order explains, and a run no serial order explains always has a cycle or something the graph cannot see.
 * Where the replay check is the only one to say serializable, the values agreed by coincidence.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROTOCOLS } from '../concurrencyCompare.ts';
import { createHermitageDatabase, HERMITAGE_LEVELS, HERMITAGE_TESTS, runHermitage } from '../hermitage.ts';
import { precedenceGraph } from '../precedence.ts';
import type { PrecedenceGraph } from '../precedence.ts';
import { runSchedule } from '../schedule.ts';
import type { LockingOptions, ScheduleStep } from '../schedule.ts';
import { createAccountsDatabase } from '../seed.ts';
import { serialCheck } from '../serialCheck.ts';

const s = (session: string, sql: string): ScheduleStep => ({ session, sql });
const run = (steps: ScheduleStep[], locking?: LockingOptions) => runSchedule(steps, createAccountsDatabase(20), undefined, locking);
/** Edges as `A -ww-> B (accounts (id = 1))`, by label, sorted — what a reader of the page sees. */
const edgesOf = (g: PrecedenceGraph): string[] => {
  const label = (id: string) => g.nodes.find((n) => n.id === id)!.label;
  return g.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)} (${e.item})`).sort();
};
const cycleOf = (g: PrecedenceGraph): string[] | null => g.cycle?.nodes.map((id) => g.nodes.find((n) => n.id === id)!.label) ?? null;

/** The two must agree, in the only directions conflict-serializability promises. */
function agrees(g: PrecedenceGraph, check: ReturnType<typeof serialCheck>): boolean {
  const flagged = g.cycle !== null || g.unseen.length > 0;
  return (flagged || check.serializable) && (check.serializable || !check.exhaustive || flagged);
}

describe('the graph of one schedule (plan.md §27.5 T1)', () => {
  it('a serial schedule: edges one way only, and the order they give', () => {
    const g = precedenceGraph(
      run([
        s('A', 'BEGIN'),
        s('A', 'UPDATE accounts SET balance = balance - 10 WHERE id = 1'),
        s('A', 'COMMIT'),
        s('B', 'BEGIN'),
        s('B', 'SELECT balance FROM accounts WHERE id = 1'),
        s('B', 'COMMIT'),
      ]),
    );
    expect(edgesOf(g)).toEqual(['A -wr-> B (accounts (id = 1))']);
    expect(g.cycle).toBeNull();
    expect(g.order?.map((id) => g.nodes.find((n) => n.id === id)!.label)).toEqual(['A', 'B']);
  });

  it('a lost update, with no locks: a cycle through all three kinds of edge', () => {
    const lost = [
      s('A', 'BEGIN'),
      s('A', 'SELECT balance FROM accounts WHERE id = 1'),
      s('B', 'BEGIN'),
      s('B', 'SELECT balance FROM accounts WHERE id = 1'),
      s('A', 'UPDATE accounts SET balance = balance + 1 WHERE id = 1'),
      s('B', 'UPDATE accounts SET balance = balance + 1 WHERE id = 1'),
      s('A', 'COMMIT'),
      s('B', 'COMMIT'),
    ];
    const g = precedenceGraph(run(lost));
    expect(edgesOf(g)).toEqual([
      'A -wr-> B (accounts (id = 1))',
      'A -ww-> B (accounts (id = 1))',
      'B -rw-> A (accounts (id = 1))',
    ]);
    expect(new Set(cycleOf(g))).toEqual(new Set(['A', 'B']));
    expect(serialCheck(run(lost), 20).serializable).toBe(false);
  });

  it('write skew under snapshots: two reads each overtaken by the other’s write — rw both ways', () => {
    const skew = [
      s('A', 'BEGIN'),
      s('B', 'BEGIN'),
      s('A', 'SELECT * FROM accounts WHERE id = 1'),
      s('B', 'SELECT * FROM accounts WHERE id = 2'),
      s('A', 'UPDATE accounts SET balance = 0 WHERE id = 2'),
      s('B', 'UPDATE accounts SET balance = 0 WHERE id = 1'),
      s('A', 'COMMIT'),
      s('B', 'COMMIT'),
    ];
    const g = precedenceGraph(run(skew, { granularity: 'row', isolation: 'repeatable-read', mvcc: true }));
    expect(edgesOf(g)).toEqual(['A -rw-> B (accounts (id = 1))', 'B -rw-> A (accounts (id = 2))']);
    expect(g.cycle).not.toBeNull();
  });

  it('a phantom: a row inserted to match a read made earlier is a conflict, though the read never saw it', () => {
    const g = precedenceGraph(
      run([
        s('A', 'BEGIN'),
        s('A', 'SELECT * FROM accounts WHERE balance > 50'),
        s('B', "INSERT INTO accounts VALUES (21, 'x', 70)"),
        s('A', 'COMMIT'),
      ]),
    );
    expect(edgesOf(g)).toEqual(['A -rw-> B (accounts (id = 21))']);
    // A row that would not have matched is no conflict at all.
    const quiet = precedenceGraph(
      run([s('A', 'BEGIN'), s('A', 'SELECT * FROM accounts WHERE balance > 50'), s('B', "INSERT INTO accounts VALUES (21, 'x', 7)"), s('A', 'COMMIT')]),
    );
    expect(quiet.edges).toEqual([]);
  });

  it('reads it cannot account for: a write that never committed (G1a), and one its own writer replaced (G1b)', () => {
    const g1a = precedenceGraph(
      run([
        s('A', 'BEGIN'),
        s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1'),
        s('B', 'SELECT balance FROM accounts WHERE id = 1'),
        s('A', 'ROLLBACK'),
      ]),
    );
    expect(g1a.unseen.map((u) => u.why)).toEqual(['uncommitted']);
    const g1b = precedenceGraph(
      run([
        s('A', 'BEGIN'),
        s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1'),
        s('B', 'SELECT balance FROM accounts WHERE id = 1'),
        s('A', 'UPDATE accounts SET balance = 2 WHERE id = 1'),
        s('A', 'COMMIT'),
      ]),
    );
    expect(g1b.unseen.map((u) => u.why)).toEqual(['intermediate']);
  });

  it('a dirty read that hides a row: an uncommitted write made a matching row stop matching', () => {
    // C's 0 keeps row 3 out of B's answer; every committed version of row 3 would have been in it.
    const g = precedenceGraph(
      run([
        s('C', 'BEGIN'),
        s('C', 'UPDATE accounts SET balance = 0 WHERE id = 3'),
        s('B', 'SELECT * FROM accounts WHERE balance > 4'),
        s('C', 'ROLLBACK'),
      ]),
    );
    expect(g.unseen).toEqual([{ node: g.nodes[0]!.id, step: 2, item: 'accounts (id = 3)', why: 'uncommitted' }]);
  });

  it('a table a rollback left holding someone else’s uncommitted write', () => {
    const g = precedenceGraph(
      run([
        s('A', 'BEGIN'),
        s('B', 'BEGIN'),
        s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1'),
        s('B', 'UPDATE accounts SET balance = 2 WHERE id = 1'),
        s('A', 'ROLLBACK'),
        s('B', 'ROLLBACK'),
      ]),
    );
    expect(g.nodes).toEqual([]);
    expect(g.unseen.map((u) => u.why)).toContain('undone');
  });

  it('cyclic, yet serializable: the replay check compares values, and these happen to agree', () => {
    const same = [
      s('A', 'BEGIN'),
      s('A', 'SELECT balance FROM accounts WHERE id = 1'),
      s('B', 'UPDATE accounts SET balance = balance WHERE id = 1'),
      s('A', 'UPDATE accounts SET balance = balance WHERE id = 1'),
      s('A', 'COMMIT'),
    ];
    const g = precedenceGraph(run(same));
    expect(g.cycle).not.toBeNull();
    const check = serialCheck(run(same), 20);
    expect(check.serializable).toBe(true);
    expect(check.found).toEqual(['B', 'A']);
  });

  it('a session that commits twice is two nodes', () => {
    const g = precedenceGraph(
      run([s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1'), s('B', 'SELECT balance FROM accounts WHERE id = 1'), s('A', 'UPDATE accounts SET balance = 2 WHERE id = 1')]),
    );
    expect(g.nodes.map((n) => n.label)).toEqual(['A #1', 'B', 'A #2']);
    // A #2's UPDATE reads the row through its WHERE before it writes it: it depends on A #1 twice over.
    expect(edgesOf(g)).toEqual([
      'A #1 -wr-> A #2 (accounts (id = 1))',
      'A #1 -wr-> B (accounts (id = 1))',
      'A #1 -ww-> A #2 (accounts (id = 1))',
      'B -rw-> A #2 (accounts (id = 1))',
    ]);
  });

  it('under optimistic control, two writers of one row never both commit — validation stops the second', () => {
    // Every UPDATE reads its row through its WHERE first, so the later committer finds that row changed and aborts:
    // a ww edge between two committed transactions cannot arise, and the graph has the one that committed.
    const result = run(
      [
        s('A', 'BEGIN'),
        s('B', 'BEGIN'),
        s('A', 'UPDATE accounts SET balance = 1 WHERE id = 1'),
        s('B', 'UPDATE accounts SET balance = 2 WHERE id = 1'),
        s('B', 'COMMIT'),
        s('A', 'COMMIT'),
      ],
      { granularity: 'row', protocol: 'optimistic' },
    );
    const g = precedenceGraph(result, true);
    expect(g.nodes.map((n) => n.label)).toEqual(['B']);
    expect(g.edges).toEqual([]);
    expect(agrees(g, serialCheck(result, 20))).toBe(true);
  });
});

describe('held against the replay check (plan.md §27.5 T1)', () => {
  it('agrees on every Hermitage schedule, at every level, on every engine', () => {
    for (const engine of ['locks', 'mvcc', 'innodb'] as const) {
      for (const test of HERMITAGE_TESTS) {
        for (const level of HERMITAGE_LEVELS) {
          const { result } = runHermitage(test, level, engine);
          const g = precedenceGraph(result);
          const check = serialCheck(result, 0, 'commit', createHermitageDatabase());
          expect(agrees(g, check), `${engine} ${test.id} ${level}`).toBe(true);
          // At SERIALIZABLE every engine delivers it: no cycle, nothing unseen.
          if (level === 'serializable') expect(g.cycle === null && g.unseen.length === 0, `${engine} ${test.id}`).toBe(true);
        }
      }
    }
  });

  it('names the cycle behind write skew (G2-item) wherever snapshots let it through', () => {
    const { result, occurred } = runHermitage(HERMITAGE_TESTS.find((t) => t.id === 'G2-item')!, 'repeatable-read', 'mvcc');
    expect(occurred).toBe(true);
    const g = precedenceGraph(result);
    expect(g.cycle?.edges.map((e) => e.kind)).toEqual(['rw', 'rw']);
  });

  it('agrees on random schedules under every protocol', () => {
    const op = fc.oneof(
      fc.record({ id: fc.integer({ min: 1, max: 3 }), balance: fc.integer({ min: 0, max: 9 }) }).map(
        ({ id, balance }) => `UPDATE accounts SET balance = ${String(balance)} WHERE id = ${String(id)}`,
      ),
      fc.integer({ min: 1, max: 3 }).map((id) => `UPDATE accounts SET balance = balance + 1 WHERE id = ${String(id)}`),
      fc.integer({ min: 21, max: 22 }).map((id) => `INSERT INTO accounts VALUES (${String(id)}, 'x', 7)`),
      fc.integer({ min: 1, max: 3 }).map((id) => `DELETE FROM accounts WHERE id = ${String(id)}`),
      fc.constant('SELECT * FROM accounts WHERE balance > 4'),
      fc.integer({ min: 1, max: 3 }).map((id) => `SELECT balance FROM accounts WHERE id = ${String(id)}`),
    );
    // Three transactions — BEGIN, a few statements, COMMIT (or now and then ROLLBACK) — interleaved at random.
    const txn = (session: string) =>
      fc
        .tuple(fc.array(op, { minLength: 1, maxLength: 3 }), fc.integer({ min: 0, max: 4 }))
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
    const modes: { locking: LockingOptions | undefined; deferred: boolean }[] = [
      { locking: undefined, deferred: false },
      { locking: { granularity: 'row', isolation: 'read-uncommitted' }, deferred: false },
      { locking: { granularity: 'page', isolation: 'read-committed' }, deferred: false },
      { locking: { granularity: 'row', isolation: 'read-committed', mvcc: true }, deferred: false },
      { locking: { granularity: 'row', isolation: 'repeatable-read', mvcc: true, currentWrites: true }, deferred: false },
      ...PROTOCOLS.map((p) => ({ locking: p.locking, deferred: p.locking.protocol === 'optimistic' })),
    ];
    fc.assert(
      fc.property(schedule, (steps) => {
        for (const { locking, deferred } of modes) {
          const result = run(steps, locking);
          expect(agrees(precedenceGraph(result, deferred), serialCheck(result, 20)), JSON.stringify({ locking, steps })).toBe(true);
        }
      }),
      { numRuns: 120, seed: 27 },
    );
  }, 60_000);
});
