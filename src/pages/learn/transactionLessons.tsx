import type { Lesson } from './lessons.tsx';
import { SCENARIOS, scenarioHref } from './transactionScenarios.ts';
import type { ScenarioName } from './transactionScenarios.ts';

/**
 * The transaction and durability half of the `/learn` track: the schedule runner, the isolation matrix, the protocol
 * comparison, the write-ahead log and recovery, each walked through on the tool that shows it. A step's link is a
 * scenario from `transactionScenarios.ts`, and every scenario is run on the real engine in
 * `__tests__/transactionLessons.test.ts` against the sentence the lesson says about it.
 */

const code = (text: string) => <code className="font-mono">{text}</code>;
const to = (name: ScenarioName, label: string) => ({ href: scenarioHref(SCENARIOS[name]), label });

export const TRANSACTION_LESSONS: Lesson[] = [
  {
    id: 'dirty-read',
    title: 'Let a dirty read happen, then stop it',
    minutes: 4,
    summary: 'Two sessions, no concurrency control — then the same schedule under locks, and a deadlock.',
    steps: [
      {
        heading: 'No locks: read a change that never happened',
        body: (
          <>
            Two sessions share the {code('accounts')} table. A changes account 1 to 0 and has not committed. B reads
            account 1 and sees <strong>0</strong> — and the run flags it as a <em>dirty read</em>. Then A rolls back, and
            B&apos;s next read shows 100. B acted on a number that never existed.
          </>
        ),
        link: to('dirtyRead', 'Open this schedule'),
      },
      {
        heading: 'The same schedule under row locks',
        body: (
          <>
            Now every statement takes a lock first and keeps it to the end of its transaction. B&apos;s read asks for a
            shared lock on a row A holds exclusively, so it <em>waits</em>; the step says who it is waiting for. When A
            rolls back the lock is released, B&apos;s statement runs, and it reads <strong>100</strong>. Nothing wrong
            was read, and B paid for that with a wait.
          </>
        ),
        link: to('dirtyReadLocked', 'Open it under row locks'),
      },
      {
        heading: 'Waiting in a circle: a deadlock',
        body: (
          <>
            Each session holds a row the other wants. Neither can go first, so the lock table finds the cycle and rolls
            one back — B, here, because B made its first lock request most recently. The other session&apos;s statement
            then resumes and commits.
          </>
        ),
        link: to('deadlock', 'Open the deadlock'),
        tryThis: (
          <>
            Move B&apos;s <code className="font-mono">UPDATE … WHERE id = 2</code> up so that B asks for a lock{' '}
            <em>before</em> A does, and run it again. Who is rolled back now? <code className="font-mono">BEGIN</code>{' '}
            does not count — only a transaction&apos;s first lock request does.
          </>
        ),
      },
    ],
  },
  {
    id: 'isolation-levels',
    title: 'Read the isolation matrix',
    minutes: 5,
    summary: 'Ten anomalies, four levels, two engines: what a cell means, and the run behind it.',
    steps: [
      {
        heading: 'A grid of runs, not a table of claims',
        body: (
          <>
            The anomalies run down the side and the isolation levels across, once for locking and once for snapshots.
            Each cell is a schedule that was <em>run</em> on this engine and judged by what its transactions saw and
            wrote. Beside it is what the published runs of PostgreSQL and SQL Server say; where the two part company the
            cell is outlined and says why. There is exactly one.
          </>
        ),
        link: to('matrix', 'Open the matrix'),
      },
      {
        heading: 'A level is a rule about how long a read lock is held',
        body: (
          <>
            At {code('READ COMMITTED')} A&apos;s read lock is given back the moment the statement ends, so B&apos;s
            update goes straight through and A&apos;s second read returns <strong>50</strong>: the same query, two
            answers, inside one transaction. The run names it a <em>non-repeatable read</em>.
          </>
        ),
        link: to('nonRepeatableRead', 'Open this schedule'),
        tryThis: (
          <>
            Change the level to <strong>Repeatable read</strong> and run it again. A keeps its read lock to the end, so
            B&apos;s update is blocked and A reads 100 both times. The anomaly is gone; B is paying for it with a wait.
          </>
        ),
      },
      {
        heading: 'A phantom: a lock cannot lock a row that is not there',
        body: (
          <>
            A reads every account over 50 and holds its read locks to the end. B inserts a new account that matches.
            There was no row to lock, so the insert goes through and A&apos;s second read has an extra row — a{' '}
            <em>phantom</em>. Only {code('SERIALIZABLE')} adds a predicate lock, a lock on the {code('WHERE')} itself.
          </>
        ),
        link: to('phantom', 'Open this schedule'),
        tryThis: (
          <>
            Set the level to <strong>Serializable</strong>. B&apos;s {code('INSERT')} would match A&apos;s predicate, so it
            waits until A commits — and A reads the same rows twice.
          </>
        ),
      },
    ],
  },
  {
    id: 'snapshots',
    title: 'Readers that never wait: snapshots',
    minutes: 5,
    summary: 'Give every row a history and a reader needs no lock — then see what that does and does not buy.',
    steps: [
      {
        heading: 'A reader sees its snapshot',
        body: (
          <>
            The same schedule as the non-repeatable read, now with versions. A&apos;s transaction takes a snapshot at its
            first statement. B&apos;s update writes a <em>new version</em> of the row and commits; A&apos;s second read
            still returns <strong>100</strong>, because the version B wrote is not in A&apos;s snapshot. The read took no
            lock and nothing waited.
          </>
        ),
        link: to('snapshotRead', 'Open this schedule'),
      },
      {
        heading: 'Writers still collide: first committer wins',
        body: (
          <>
            A read the row, B changed it and committed, and now A tries to change it. Writing over a row that has moved
            since A&apos;s snapshot would silently lose B&apos;s update, so the engine refuses: A is rolled back with a
            serialization failure. The first committer wins, and the second one retries.
          </>
        ),
        link: to('firstCommitterWins', 'Open this schedule'),
      },
      {
        heading: 'What a snapshot cannot see: write skew',
        body: (
          <>
            Each session reads rows 1 and 2, then changes a <em>different</em> one. They write different rows, so no
            write conflicts and both commit. But each decided from what it read, and no one-at-a-time order of the two
            would have shown both of them what they saw. That is <em>write skew</em>, and a snapshot has no way to
            notice it.
          </>
        ),
        link: to('writeSkew', 'Open this schedule'),
        tryThis: (
          <>
            Set the level to <strong>Serializable</strong>. The engine now also checks, at {code('COMMIT')}, that nothing
            the transaction read has changed — and the second commit is refused.
          </>
        ),
      },
      {
        heading: 'What it costs: dead versions',
        body: (
          <>
            Every update leaves the old version behind, and so does a transaction that rolls back. Three updates and one
            rollback leave four dead versions, so the heap needs six pages where five would do; only {code('VACUUM')},
            once no snapshot can still see them, gives the space back.
          </>
        ),
        link: to('deadTuples', 'Open this schedule'),
      },
    ],
  },
  {
    id: 'protocols',
    title: 'Locks, timestamps or optimism?',
    minutes: 5,
    summary: 'One schedule under five protocols, each really run: who waited, who was thrown away, what survived.',
    steps: [
      {
        heading: 'Same schedule, five bills',
        body: (
          <>
            A reads a balance, B overwrites it, and A writes a value based on what it read. Two-phase locking makes B
            wait once and commits both. Timestamp ordering never waits: it aborts A the moment A arrives too late.
            Optimistic validation lets A do all of its work and refuses it at {code('COMMIT')}. Both snapshot protocols
            refuse A&apos;s write — first committer wins. Every one of them leaves a result that some one-at-a-time order
            explains. Compare the waits, the aborts and the <em>wasted</em> statements.
          </>
        ),
        link: to('protocolsLostUpdate', 'Open the comparison'),
      },
      {
        heading: 'When a protocol lets an anomaly through',
        body: (
          <>
            The write-skew schedule, under the same five. Snapshots commit both transactions — nothing waited, nothing
            was thrown away — and the serial check says no one-at-a-time order explains what they read. Two-phase
            locking, timestamp ordering, optimistic validation and serializable snapshots each end one of the two.
          </>
        ),
        link: to('protocolsWriteSkew', 'Open the comparison'),
      },
      {
        heading: 'How the verdict is reached',
        body: (
          <>
            The check replays the committed transactions one at a time, in the order the protocol promises, and compares
            what every statement returned and the table that is left. It judges <em>one run</em>; it is not a proof about
            the protocol, and when it cannot search every order it says so instead of claiming a proof. Run it on a
            schedule with a non-repeatable read: snapshots commit both transactions and are still serializable.
          </>
        ),
        link: to('protocolsNonRepeatable', 'Open the comparison'),
        tryThis: (
          <>
            Count the aborts in that run. Three of the five end A, and all five are serializable. An abort is not
            evidence of an anomaly, and a commit is not evidence of its absence — the verdict is the check, not the
            protocol&apos;s reputation.
          </>
        ),
      },
    ],
  },
  {
    id: 'log-first',
    title: 'Why the log goes first',
    minutes: 4,
    summary: 'The one rule that makes a log worth keeping, what a commit really writes, and what breaking the rule costs.',
    steps: [
      {
        heading: 'A page waits for its log',
        body: (
          <>
            T1 changes a cell on page 1, and the background writer writes the page out. Before it does, the log is forced
            through the record that describes the change — find the <em>log forced</em> effect in the step. Without that
            a crash would find a change on disk and nothing in the log to say what it was, or to undo it.
          </>
        ),
        link: to('ruleEnforced', 'Open this script'),
      },
      {
        heading: 'Break the rule',
        body: (
          <>
            Log-before-data is off. The page goes to disk with its change; the log record is still in the buffer, and the
            crash drops the buffer. Recovery finds an empty log, no losers and nothing to undo — and the database holds{' '}
            <strong>99</strong>, a change nobody committed. The page says so.
          </>
        ),
        link: to('ruleOff', 'Open the broken run'),
      },
      {
        heading: 'A commit is a log write',
        body: (
          <>
            {code('COMMIT')} forces the log through the commit record and touches no data page. The page is still dirty
            in the pool, and the crash image shows a committed change the disk does not have. That is cheap, and it is
            safe, because the log holds what recovery needs. What it owes is the next lesson.
          </>
        ),
        link: to('commitIsALogWrite', 'Open this script'),
      },
    ],
  },
  {
    id: 'steal-and-force',
    title: 'Steal and force: what a crash will find',
    minutes: 5,
    summary: 'Two choices about when a page may reach disk, four combinations, and the bill each sends to recovery.',
    steps: [
      {
        heading: 'No-force: the commit owes pages',
        body: (
          <>
            The commit writes only the log. T1&apos;s three pages are still in the pool and the disk is three changes
            behind: if the machine stopped now, recovery would have to <em>redo</em> each one.
          </>
        ),
        link: to('noForce', 'Open this script'),
      },
      {
        heading: 'Force: the commit pays',
        body: (
          <>
            The same script with <strong>Force</strong>: every page T1 changed is written inside the commit — three
            random writes — and nothing is owed. Recovery never has to redo, and every commit is slow.
          </>
        ),
        link: to('force', 'Open it with force'),
      },
      {
        heading: 'Steal: a frame is worth an uncommitted change',
        body: (
          <>
            Two frames. T1 changes page 1, then the script reads pages 2 and 3. The pool needs a frame and evicts
            T1&apos;s page, so an uncommitted change reaches disk. The step says what a crash would find there, and
            recovery would have to <em>undo</em> it.
          </>
        ),
        link: to('steal', 'Open this script'),
      },
      {
        heading: 'No-steal: nowhere to put it',
        body: (
          <>
            With <strong>No-steal</strong> the page is pinned until T1 ends. Nothing uncommitted is ever on disk, so there
            is nothing to undo — and the third page has no frame, so the step is refused. A transaction that changes
            more pages than the pool has frames cannot run.
          </>
        ),
        link: to('noSteal', 'Open this script'),
        tryThis: (
          <>
            The table under the steps runs your script under all four combinations. Which would you pick for a small
            pool and big transactions? ARIES, and most engines that followed it, steal and do not force.
          </>
        ),
      },
    ],
  },
  {
    id: 'recovery',
    title: 'Survive a crash',
    minutes: 5,
    summary: 'Analysis, redo and undo on a real log — then a crash in the middle of recovery itself.',
    steps: [
      {
        heading: 'Analysis sorts winners from losers',
        body: (
          <>
            T1 committed and T2 did not. T2&apos;s first change sits on page 2, which was written; T1&apos;s change and
            T2&apos;s second are on pages that were not. After the crash, recovery reads the log forward:{' '}
            <em>analysis</em> rebuilds which pages might be behind and which transactions were running, and names the
            losers — T2, the one with no commit record.
          </>
        ),
        link: to('bothAtOnce', 'Open this recovery'),
      },
      {
        heading: 'Redo repeats history; undo takes the losers back',
        body: (
          <>
            <em>Redo</em> goes through the log from the oldest page that might be behind and applies each record its page
            does not already have: T1&apos;s change is put back, T2&apos;s first is skipped because page 2 holds it, and
            T2&apos;s second is put back too — history is repeated whether or not it committed. <em>Undo</em> then walks
            the loser&apos;s records newest first and writes a compensation record for each, so that undoing is itself
            logged.
          </>
        ),
        link: to('bothAtOnce', 'Read the three passes'),
      },
      {
        heading: 'A checkpoint is a bookmark, not a flush',
        body: (
          <>
            A fuzzy checkpoint writes no page and stops nobody: it copies the transaction table and the dirty-page table
            into the log. Here every page changed before it was written <em>first</em>, so analysis starts at the
            checkpoint and redo starts at T2&apos;s own change, far from the start of the log. The same checkpoint
            without those page writes shortens nothing.
          </>
        ),
        link: to('checkpoint', 'Open this recovery'),
        tryThis: (
          <>
            Delete the two {code('write page')} steps and run it again. Analysis still starts at the checkpoint, but redo
            goes back to the first change in the log.
          </>
        ),
      },
      {
        heading: 'A crash in the middle of recovery',
        body: (
          <>
            Recovery stops after two undo records. The second restart finds the compensation records already in the log:
            it redoes them, follows them to where undo had got to, and undoes only what is left. No change is undone
            twice — that is the reason undo is logged at all.
          </>
        ),
        link: to('crashDuringRecovery', 'Open this recovery'),
      },
      {
        heading: 'The same machine, behind a real UPDATE',
        body: (
          <>
            In the Playground, a write you run is also a transaction in a log over the table&apos;s own pages — one row to
            a cell. Open the {code('UPDATE')}, press <strong>Run</strong> to make the edit, then press{' '}
            <strong>Durability</strong> to commit it or leave it open, write a page, crash, and recover.
          </>
        ),
        open: {
          sql: "UPDATE users SET name = 'edited' WHERE id = 5;",
          find: (events) => events.length,
          label: 'Open the UPDATE in the Playground',
        },
        tryThis: (
          <>
            Commit the statement and crash without writing a page: recovery redoes it and the edit is back. Leave it open
            and crash: it is gone, whether or not its page had reached the disk.
          </>
        ),
      },
    ],
  },
];
