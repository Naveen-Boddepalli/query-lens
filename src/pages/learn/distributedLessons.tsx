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
};
