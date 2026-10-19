import type { LessonStep } from './lessons.tsx';
import { DISTRIBUTED_SCENARIOS, distributedHref } from './distributedScenarios.ts';
import type { DistributedScenarioName } from './distributedScenarios.ts';

/**
 * The lessons for distributed databases (plan.md §27.5 X1–X4): partitioning a table over nodes, and — as they are
 * built — committing across them, agreeing on a log, and joining across them. Each step links a scenario in
 * `distributedScenarios.ts`, and `__tests__/distributedLessons.test.ts` holds the numbers each quotes to the tool's own
 * model.
 */

const code = (text: string) => <code className="font-mono">{text}</code>;
const to = (name: DistributedScenarioName, label: string) => ({ href: distributedHref(DISTRIBUTED_SCENARIOS[name]), label });

export const DISTRIBUTED_STEPS: Record<string, LessonStep[]> = {
  partitioning: [
    {
      heading: 'Hash: even, until the cluster changes',
      body: (
        <>
          The transactions preset&rsquo;s 3,000 rows on four nodes, each row on node {code('hash(id) mod 4')}: 723, 788, 757
          and 732 — skew 1.05. Add a fifth node and the divisor changes for every row: <strong>2,399</strong> of them move,
          four times the 600 a newcomer&rsquo;s fair share would be.
        </>
      ),
      link: to('hashGrows', 'Open hash partitioning'),
    },
    {
      heading: 'Range: move only one half',
      body: (
        <>
          Cut the ids into four ranges of 750 instead. A fifth node takes the upper half of the fullest range: only{' '}
          <strong>375</strong> rows move — but the newcomer and the node it split from now hold half as much as the rest.
          And new rows arrive in id order: all of the next 300 land on the last node, a hot spot.
        </>
      ),
      link: to('rangeGrows', 'Open range partitioning'),
    },
    {
      heading: 'A ring, one point per node',
      body: (
        <>
          Consistent hashing puts each node at a point on a ring and gives every row to the first point clockwise from
          its hash. A newcomer takes only the arc before its own point. With one point per node, though, the arcs are
          uneven: skew <strong>1.96</strong>, and the fifth node lands on a long arc and takes 1,459 rows.
        </>
      ),
      link: to('ringOnePoint', 'Open the ring with one point each'),
    },
    {
      heading: 'Virtual nodes',
      body: (
        <>
          Give every node 64 points. The arcs average out: skew <strong>1.07</strong>. A fifth node takes 64 small arcs, one
          from each stretch of the ring — <strong>590</strong> rows move, all of them to it, close to the fair share of 600.
          Dynamo, Cassandra and Riak all place data this way.
        </>
      ),
      link: to('ringManyPoints', 'Open the ring with 64 points each'),
      tryThis: (
        <>
          Partition by {code('account')} instead: 40 keys of 75 rows each. Hash partitioning can only deal whole accounts
          out, and four nodes get 525, 975, 450 and 1,050 — skew 1.40. A few keys cannot be spread evenly by any hash.
        </>
      ),
    },
  ],
  'two-phase-commit': [
    {
      heading: 'Everyone votes yes',
      body: (
        <>
          The coordinator sends PREPARE to three participants. Each writes PREPARED to its log and votes yes — and from
          that moment it is <em>in doubt</em>: it has promised to commit if told to, and may not abort on its own. All three
          yeses in, the coordinator writes COMMIT at tick 2; that write is the commit. Each participant hears at tick 3, two
          ticks after it voted.
        </>
      ),
      link: to('tpcCommit', 'Open a clean commit'),
    },
    {
      heading: 'One no is enough',
      body: (
        <>
          The second participant votes no. It aborts at once — having never promised anything — and the coordinator,
          hearing the no, decides ABORT. Under <em>presumed abort</em> it writes nothing it must force and asks for no
          acknowledgements: if it forgets the transaction, the answer to anyone who asks is abort anyway.
        </>
      ),
      link: to('tpcOneNo', 'Open a no vote'),
    },
    {
      heading: 'A crash after the decision',
      body: (
        <>
          The coordinator writes COMMIT and crashes before telling anyone. The participants voted yes, so they can only
          wait — holding their locks — and ask, every four ticks, into silence. Ten ticks later the coordinator recovers,
          finds COMMIT in its log, and sends it again: everyone commits at tick 13, after <strong>12</strong> ticks in
          doubt.
        </>
      ),
      link: to('tpcAfterDecision', 'Open the crash after the decision'),
    },
    {
      heading: 'A crash before it',
      body: (
        <>
          Crash the coordinator a moment earlier — every vote in, nothing yet written. It recovers to an empty log: no
          decision was ever made, so it presumes abort, and tells each participant so when it asks. They wait just as long,
          and then abort at tick 15. Whether a transaction committed is decided by one log record on one machine.
        </>
      ),
      link: to('tpcBeforeDecision', 'Open the crash before the decision'),
    },
    {
      heading: 'When the coordinator never comes back',
      body: (
        <>
          The same crash after COMMIT, and no recovery. The participants are in doubt when the run ends, and would be
          forever: they cannot commit, since they were never told; they cannot abort, since the coordinator may have
          committed. This is why two-phase commit is called <em>blocking</em> — and why consensus (Raft, Paxos) exists.
        </>
      ),
      link: to('tpcNeverReturns', 'Open the coordinator that never returns'),
      tryThis: (
        <>
          Lose one participant&rsquo;s vote instead: the coordinator&rsquo;s five-tick timeout decides ABORT for everyone. Lose a
          COMMIT: the coordinator sends it again until it is acknowledged.
        </>
      ),
    },
  ],
  raft: [
    {
      heading: 'An election, then a log',
      body: (
        <>
          Five servers start as followers. Each waits a random 12 to 23 ticks for a leader; server 2 waits least, stands
          for term 1, and wins at tick 15 with a majority of votes. It appends a no-op, then each of the client&rsquo;s five
          commands, and copies them out every four ticks. An entry is committed once three of the five hold it: every
          server ends committed through entry <strong>6</strong>.
        </>
      ),
      link: to('raftCalm', 'Open the election'),
    },
    {
      heading: 'The leader crashes',
      body: (
        <>
          Crash server 2 at tick 50. The others hear nothing, time out, and server 3 wins term 2 at tick 66 — with every
          committed entry, because a server votes only for a candidate whose log is at least as up to date as its own. The
          command sent at tick 50, with no leader to take it, is simply lost: the client would have to try again.
        </>
      ),
      link: to('raftLeaderCrash', 'Open the crash'),
    },
    {
      heading: 'A leader cut off in a minority',
      body: (
        <>
          Cut servers 1 and 2 — the leader — off from the rest from tick 40 to 90. Server 2 still thinks it leads term 1
          and takes six more commands, but with only two of five it can commit none of them. The other three need two tries
          (split votes in terms 2 and 3) before server 4 wins term 4 at tick 84. When the network heals, server 2 sees term 4,
          steps down, and both it and server 1 <strong>drop</strong> the six uncommitted entries: they were never
          committed, so nothing that anyone was promised is lost.
        </>
      ),
      link: to('raftMinority', 'Open the partition'),
    },
    {
      heading: 'And a lossy network',
      body: (
        <>
          Lose three messages in ten. Elections and copies are slower — server 2 leads term 1, server 3 term 2 — but the four
          properties Raft promises are checked on every run, and they hold: one leader per term, logs that agree wherever
          they share an entry, every committed entry in every later leader&rsquo;s log, and no two servers applying different
          commands at the same index.
        </>
      ),
      link: to('raftLossy', 'Open the lossy network'),
      tryThis: (
        <>
          Turn off the new leader&rsquo;s no-op. Entries of an earlier term then commit only beneath one of the new term — a
          leader may not commit an old entry just by counting copies (the paper&rsquo;s Figure 8 shows why).
        </>
      ),
    },
  ],
};
