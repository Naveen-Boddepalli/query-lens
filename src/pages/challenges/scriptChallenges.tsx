import type { ReactNode } from 'react';
import type { IsolationLevel } from '../../engine/transactionControl.ts';
import type { LockingMode } from '../learn/transactionScenarios.ts';

/**
 * The challenges about transactions and durability. They are not queries: the player writes a *script* — a schedule
 * of two sessions' statements, or a sequence of write-ahead-log steps — and the check is a pure predicate over what
 * the engine did with it, the same shape as `challenges.tsx`'s `check(result)`.
 *
 * This file is only the list. The checks, and the parsing and running they need, are in `scriptRunner.ts`, which
 * imports the schedule runner and the log machine; keeping them apart means the challenge index and the lesson list
 * do not carry those engines, and a script challenge loads them only when one is opened.
 */

export type ScriptSetup =
  /** Two sessions on the `accounts` table, run once under the given concurrency control. */
  | { kind: 'schedule'; locking: LockingMode; rows: 3 | 20; isolation?: IsolationLevel }
  /** The same two sessions, run under every protocol the schedule runner has. */
  | { kind: 'protocols'; rows: 3 | 20 }
  /** The write-ahead-log machine over pages 1–4, under the given policies. */
  | { kind: 'wal'; frames: 2 | 3 | 4; enforce: boolean; steal: boolean; force: boolean };

export interface ScriptChallenge {
  id: string;
  title: string;
  brief: ReactNode;
  hint: ReactNode;
  /** The script the editor opens on, one step to a line — one that does *not* pass yet. */
  starter: string;
  setup: ScriptSetup;
  /** The wrong belief this challenge exists to correct, shown once it is solved (plan.md §G3). */
  misconception: ReactNode;
}

const code = (text: string) => <code className="font-mono">{text}</code>;

const WAL_DEFAULTS = { kind: 'wal', frames: 3, enforce: true, steal: true, force: false } as const;

export const SCRIPT_CHALLENGES: ScriptChallenge[] = [
  {
    id: 'read-the-unreal',
    title: 'Read a value that never existed',
    brief: (
      <>
        No concurrency control at all: a statement sees whatever the table holds, uncommitted changes included. Write a
        schedule in which B reads a balance that A changed — and A then rolls the change back.
      </>
    ),
    hint: (
      <>
        A changes the row and has not finished. B reads it <em>now</em>. A&apos;s {code('ROLLBACK')} comes after B&apos;s
        read, not before.
      </>
    ),
    starter: [
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'A: COMMIT',
      'B: SELECT balance FROM accounts WHERE id = 1',
    ].join('\n'),
    setup: { kind: 'schedule', locking: 'none', rows: 3 },
    misconception: (
      <>
        A change that is rolled back leaves no trace, so nobody could have acted on it. Without a lock a reader sees
        uncommitted data, and a rollback only takes it away from the table — not from whatever the reader already did
        with it.
      </>
    ),
  },
  {
    id: 'make-it-wait',
    title: 'Make a statement wait',
    brief: (
      <>
        Same table, now under row locks: every statement takes its locks first and holds them to the end of its
        transaction. Write a schedule in which one of B&apos;s statements has to wait for A — and then runs, once A has
        let go. Nobody is rolled back, and nobody waits for ever.
      </>
    ),
    hint: (
      <>
        A statement waits when it wants a lock that conflicts with one another session holds. A holds a row&apos;s lock
        until {code('COMMIT')} or {code('ROLLBACK')}; B has to ask for that row in between.
      </>
    ),
    starter: [
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: SELECT balance FROM accounts WHERE id = 2',
      'A: COMMIT',
    ].join('\n'),
    setup: { kind: 'schedule', locking: 'row', rows: 20, isolation: 'repeatable-read' },
    misconception: (
      <>
        A lock that cannot be had is an error. It is not: the statement waits, and then runs against whatever the holder
        left. When nothing waits in a circle, waiting is the whole of what a lock costs.
      </>
    ),
  },
  {
    id: 'pick-the-victim',
    title: 'Make A the deadlock victim',
    brief: (
      <>
        When two sessions each wait for a lock the other holds, the engine rolls one back so the other can go on. In the
        usual example it is B. Write a schedule with a deadlock in which <strong>A</strong> is the one rolled back.
      </>
    ),
    hint: (
      <>
        The victim is the transaction in the circle whose <em>first lock request</em> is the newest. {code('BEGIN')} is
        not a lock request; the first statement that takes a lock is.
      </>
    ),
    starter: [
      'A: BEGIN',
      'B: BEGIN',
      'A: UPDATE accounts SET balance = 1 WHERE id = 1',
      'B: UPDATE accounts SET balance = 2 WHERE id = 2',
      'A: UPDATE accounts SET balance = 3 WHERE id = 2',
      'B: UPDATE accounts SET balance = 4 WHERE id = 1',
      'A: COMMIT',
      'B: COMMIT',
    ].join('\n'),
    setup: { kind: 'schedule', locking: 'row', rows: 20, isolation: 'repeatable-read' },
    misconception: (
      <>
        The victim is not whoever began last, whoever did the least, or whoever closed the circle. Here it is the one
        whose first lock request is newest — a rule chosen so that there is always exactly one answer. InnoDB prefers
        the transaction that has changed the fewest rows. Every system has a rule; it is rarely the one people guess.
      </>
    ),
  },
  {
    id: 'lose-an-update',
    title: 'Lose an update',
    brief: (
      <>
        Under row locks at {code('READ COMMITTED')}, write a schedule in which A reads a balance, B changes it, and A
        then writes a value based on what it read and commits. B&apos;s update is silently lost, and nobody is rolled
        back.
      </>
    ),
    hint: (
      <>
        A must read first and keep working from that read after B has changed the row. At {code('READ COMMITTED')} A
        gives its read lock back the moment the statement ends.
      </>
    ),
    starter: [
      'A: BEGIN',
      'A: SELECT balance FROM accounts WHERE id = 1',
      'A: UPDATE accounts SET balance = 120 WHERE id = 1',
      'A: COMMIT',
      'B: UPDATE accounts SET balance = 150 WHERE id = 1',
    ].join('\n'),
    setup: { kind: 'schedule', locking: 'row', rows: 20, isolation: 'read-committed' },
    misconception: (
      <>
        Locks make a lost update impossible. They do not, once the read lock is let go before the write: the second
        writer overwrites a value the first has since changed. {code('REPEATABLE READ')} holds the read lock, and the
        same schedule makes B wait instead.
      </>
    ),
  },
  {
    id: 'read-past-the-writer',
    title: 'Read around a writer',
    brief: (
      <>
        Under snapshots, readers take no lock. Write a schedule in which A has changed a row and not yet committed, and
        B reads that row <em>now</em>: B does not wait, and does not see A&apos;s change.
      </>
    ),
    hint: (
      <>
        B reads between A&apos;s {code('UPDATE')} and A&apos;s {code('COMMIT')}. What B sees is what had committed when
        its statement began.
      </>
    ),
    starter: [
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'A: COMMIT',
      'B: SELECT balance FROM accounts WHERE id = 1',
    ].join('\n'),
    setup: { kind: 'schedule', locking: 'mvcc', rows: 20, isolation: 'repeatable-read' },
    misconception: (
      <>
        A reader must either wait for a writer or read what the writer wrote. With versions it does neither: it reads
        the version its snapshot can see, and the writer&apos;s new one is simply not in it.
      </>
    ),
  },
  {
    id: 'write-skew',
    title: 'Commit what no order explains',
    brief: (
      <>
        Snapshots stop every anomaly you have met so far — not all of them. Write a schedule in which A and B both
        commit, and yet no way of running A and B one after the other would have returned what they returned.
      </>
    ),
    hint: (
      <>
        Each transaction reads something and then writes something the <em>other</em> one read — but not the same row,
        so neither write conflicts with the other.
      </>
    ),
    starter: [
      'A: BEGIN',
      'B: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: UPDATE accounts SET balance = 0 WHERE id = 2',
      'A: COMMIT',
      'B: COMMIT',
    ].join('\n'),
    setup: { kind: 'schedule', locking: 'mvcc', rows: 20, isolation: 'repeatable-read' },
    misconception: (
      <>
        Snapshot isolation is serializable: what PostgreSQL calls {code('REPEATABLE READ')} stops everything. It stops
        dirty, non-repeatable and phantom reads and a lost update, and not write skew. For that you need{' '}
        {code('SERIALIZABLE')}, which adds a check at commit.
      </>
    ),
  },
  {
    id: 'aborted-by-the-clock',
    title: 'Abort what locking would have allowed',
    brief: (
      <>
        Timestamp ordering never makes anyone wait — it aborts the transaction that arrives too late. Write a schedule
        that two-phase locking runs to the end, with both transactions committing, but that timestamp ordering ends one
        of.
      </>
    ),
    hint: (
      <>
        Two-phase locking can make B wait and still commit both. Timestamp ordering has no waiting: a transaction that
        touches a row a younger one has already written is out. Make A, the older, arrive late.
      </>
    ),
    starter: [
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 1 WHERE id = 1',
      'B: UPDATE accounts SET balance = 2 WHERE id = 2',
      'A: COMMIT',
    ].join('\n'),
    setup: { kind: 'protocols', rows: 20 },
    misconception: (
      <>
        Not locking means fewer transactions are thrown away. It means the cost moves: a lock makes you wait, and a
        timestamp makes you start again. Which is cheaper depends on the schedule — and here is one where the lock was.
      </>
    ),
  },
  {
    id: 'ahead-of-its-log',
    title: 'Get ahead of the log',
    brief: (
      <>
        The log-before-data rule is switched off for this one: a page may be written to disk whatever the log has made
        durable. Write a script that ends with a recovery that has <em>finished</em> — and a database that is not what
        the committed transactions left.
      </>
    ),
    hint: (
      <>
        Change a cell, write its page, and crash before anything forces the log. Recovery works from the durable log
        alone.
      </>
    ),
    starter: ['begin T1', 'set T1 a = 99', 'commit T1', 'crash', 'recover'].join('\n'),
    setup: { ...WAL_DEFAULTS, enforce: false },
    misconception: (
      <>
        The log is a record kept for later, so the order in which the log and the data reach disk does not matter as
        long as both get there. It matters exactly when the machine stops between them.
      </>
    ),
  },
  {
    id: 'redo-a-commit',
    title: 'Make recovery redo a commit',
    brief: (
      <>
        A commit makes a change durable by writing the log — not the page. Write a script after which recovery has to{' '}
        <em>redo</em> a change that committed, and ends with the database that committed.
      </>
    ),
    hint: (
      <>
        Commit, then crash before the page is written. A {code('write page 1')} after the commit would leave recovery
        nothing to do.
      </>
    ),
    starter: ['begin T1', 'set T1 a = 99', 'commit T1'].join('\n'),
    setup: WAL_DEFAULTS,
    misconception: (
      <>
        When {code('COMMIT')} returns, the change is in the database file. It is in the log; the page may still be in
        memory and the file behind. That is deliberate — it is what makes a commit one sequential write — and it is why
        recovery has a redo pass.
      </>
    ),
  },
  {
    id: 'undo-a-steal',
    title: 'Make recovery undo a change',
    brief: (
      <>
        The pool may write out a page that holds a change nobody has committed; the policy is called{' '}
        <em>steal</em>. Write a script in which a crash finds such a change on the disk, and recovery undoes it and ends
        with the database that committed.
      </>
    ),
    hint: <>Change a cell and have its page written before the transaction ends. Then crash.</>,
    starter: ['begin T1', 'set T1 a = 99', 'crash', 'recover'].join('\n'),
    setup: WAL_DEFAULTS,
    misconception: (
      <>
        Only committed data ever reaches the disk. A buffer pool that needs a frame writes a dirty page whatever is in
        it. Steal is what lets a big transaction run in a small pool, and undo is what it costs.
      </>
    ),
  },
  {
    id: 'crash-in-recovery',
    title: 'Crash while recovering',
    brief: (
      <>
        Recovery can be interrupted too. Write a script in which the machine stops partway through undoing —{' '}
        {code('recover, crash after 1')} — and a second recovery still ends with exactly the database that committed.
      </>
    ),
    hint: (
      <>
        The loser needs at least two changes to undo, so there is something left when recovery stops. The second{' '}
        {code('recover')} follows the compensation records the first one wrote.
      </>
    ),
    starter: ['begin T1', 'set T1 a = 99', 'write page 1', 'crash', 'recover'].join('\n'),
    setup: WAL_DEFAULTS,
    misconception: (
      <>
        A crash during recovery corrupts the database, or sends recovery back to the start. Undo is logged, so a second
        recovery follows the records the first one wrote and goes on from there; no change is undone twice.
      </>
    ),
  },
  {
    id: 'start-redo-late',
    title: 'Start redo in the middle of the log',
    brief: (
      <>
        Redo starts at the oldest page that might be behind the log. Write a script with changes early in the log, a
        checkpoint, a crash and a recovery in which redo starts <em>after</em> those early changes — and the database
        that committed comes back.
      </>
    ),
    hint: (
      <>
        A checkpoint writes no page; it only records which pages are dirty. For redo to start late, the early pages must
        have been <em>written</em> before the checkpoint, and something must still be owed after it.
      </>
    ),
    starter: [
      'begin T1',
      'set T1 a = 99',
      'commit T1',
      'checkpoint',
      'begin T2',
      'set T2 c = 5',
      'commit T2',
      'crash',
      'recover',
    ].join('\n'),
    setup: WAL_DEFAULTS,
    misconception: (
      <>
        A checkpoint is what makes recovery short. A fuzzy checkpoint only takes a note of what is dirty; it is the pages
        written before it that move redo&apos;s starting point — which is why a checkpoint of a pool that never writes
        saves nothing.
      </>
    ),
  },
  {
    id: 'no-steal-needs-a-pool',
    title: 'Run a no-steal pool out of frames',
    brief: (
      <>
        With no-steal, a page that holds an uncommitted change may never be written out, so it stays in the pool until
        its transaction ends. The pool has two frames. Write a script in which one transaction&apos;s changes leave a
        step <em>refused</em> because no frame could be found.
      </>
    ),
    hint: (
      <>
        Cells a and b share page 1, c and d page 2, e and f page 3. One transaction that touches three pages needs three
        frames. A refused {code('write page')} does not count — the pool, not the writer, has to be the problem.
      </>
    ),
    starter: ['begin T1', 'set T1 a = 1', 'set T1 b = 2'].join('\n'),
    setup: { kind: 'wal', frames: 2, enforce: true, steal: false, force: false },
    misconception: (
      <>
        No-steal is the simple, safe policy, and costs nothing. It costs the pool: a transaction can change no more pages
        than there are frames, which is why real systems steal.
      </>
    ),
  },
];

export function scriptChallengeById(id: string | undefined): ScriptChallenge | undefined {
  return SCRIPT_CHALLENGES.find((c) => c.id === id);
}
