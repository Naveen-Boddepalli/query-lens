import type { LessonStep } from './lessons.tsx';
import { STORAGE_SCENARIOS, storageHref } from './storageScenarios.ts';
import type { StorageScenarioName } from './storageScenarios.ts';

/**
 * The lessons for the standalone sandboxes: three on how a query's operators spend pages (the sort, the hash join and
 * the join order), and six on the storage structures that are alternatives to the heap-and-B+Tree the pipeline uses
 * (the slotted page, hash indexes, the LSM tree, columnar layouts, latch crabbing, vector indexes).
 *
 * A step's link is a scenario in `storageScenarios.ts`, and `__tests__/storageLessons.test.ts` runs every scenario on
 * the tool's own driver against the numbers its lesson quotes. The prose is copy; those numbers are not.
 */

const code = (text: string) => <code className="font-mono">{text}</code>;
const to = (name: StorageScenarioName, label: string) => ({
  href: storageHref(STORAGE_SCENARIOS[name]),
  label,
});

/** Sorting, joining and join order: the three operators whose cost is a count of pages. */
export const EXECUTION_STEPS: Record<string, LessonStep[]> = {
  'external-sort': [
    {
      heading: 'Pass 0: sorted runs',
      body: (
        <>
          Thirty-two records are 16 pages of two, and the sort has three buffer pages. It cannot hold the data, so pass
          0 sorts three pages at a time and writes each batch out as a <em>run</em>: six runs, each in order inside
          itself and unrelated to the others. Reading and writing every page once is 32 page I/Os.
        </>
      ),
      link: to('sortTight', 'Open this sort'),
    },
    {
      heading: 'Merge passes',
      body: (
        <>
          With three buffer pages, two read runs and one writes the output, so each merge combines two runs:
          6 → 3 → 2 → 1. That is three merge passes, each reading and writing every page again — four passes in all,{' '}
          <strong>128</strong> page I/Os for 16 pages of data.
        </>
      ),
      link: to('sortTight', 'Step through the passes'),
    },
    {
      heading: 'Memory is the lever',
      body: (
        <>
          Give it six buffer pages. Pass 0 makes three runs, and a merge now combines five at once, so a single merge
          pass finishes the job: <strong>64</strong> page I/Os. Twice the memory, half the I/O.
        </>
      ),
      link: to('sortRoomy', 'Open it with six buffer pages'),
      tryThis: (
        <>
          Lower the record count to 8. Four pages fit in six, so there is one run and no merge at all: 8 page I/Os, one
          read and one write for each page.
        </>
      ),
    },
  ],
  'hash-join': [
    {
      heading: 'When the build side fits',
      body: (
        <>
          Twelve build keys and twenty probe keys, six buffer pages. The build side fits in memory, so there is no
          partitioning: each side is read once, 16 page I/Os. Sixteen of the twenty probe keys find a partner; the other
          four hash to a bucket with no equal key — misses.
        </>
      ),
      link: to('hashJoinFits', 'Open this join'),
    },
    {
      heading: 'When it does not, partition both sides first',
      body: (
        <>
          Take two buffer pages away. The build side no longer fits, so both sides are hashed into three partitions and
          written out, then each pair is read back and joined: 32 page I/Os of partitioning, then 18 to build and
          probe — <strong>50</strong>, about three times the cost, for the same 16 matches.
        </>
      ),
      link: to('hashJoinSpills', 'Open it with four buffer pages'),
    },
    {
      heading: 'A partition can be too big again',
      body: (
        <>
          With only two partitions a partition can still be larger than memory, and is partitioned again with a
          different hash function. This bigger join goes two levels deep: 114 I/Os of partitioning, 147 in all, for 26
          matches.
        </>
      ),
      link: to('hashJoinDeep', 'Open the deep one'),
      tryThis: (
        <>
          Look at the buckets inside a leaf partition. Two different build keys can land in one bucket, marked as a
          collision — so the probe cannot trust a bucket alone and has to compare the values.
        </>
      ),
    },
  ],
  'join-order': [
    {
      heading: 'The order you wrote',
      body: (
        <>
          Four tables, joined hub first and then each branch as written: departments, projects, employees, timesheets.
          The estimate is <strong>1,501,542</strong> pages, for 30,000 rows out. Inner joins can be taken in any
          order and give the same rows; they do not cost the same.
        </>
      ),
      link: to('joinOrder', 'Open the join-order search'),
    },
    {
      heading: 'The subset lattice',
      body: (
        <>
          Four tables have 15 non-empty subsets. The search prices each one from the cheapest plan for the subsets one
          table smaller, adding one table last — so it never prices a whole order twice. The lattice lists every subset
          with its cheapest plan; select one to see what each choice of last table would have cost.
        </>
      ),
      link: to('joinOrder', 'Read the lattice'),
    },
    {
      heading: 'The winner',
      body: (
        <>
          Departments, employees, timesheets, and projects <em>last</em>: <strong>290,252</strong> pages, about five
          times less. Ending on any other table costs more — departments last 590,050, timesheets last 1,501,542,
          employees last 7,537,542. The big branch is finished while its intermediate result is still small.
        </>
      ),
      link: to('joinOrder', 'Open the winning order'),
    },
  ],
  histograms: [
    {
      heading: 'Ten buckets, and one of them spans a gap',
      body: (
        <>
          Three thousand values in three dense bands, with a hundred scattered between them. {code('ANALYZE')} cuts them
          into ten buckets of equal depth, and one bucket runs from the end of the first band to the start of the second.
          Asked for {code('v BETWEEN 500 AND 2000')}, the planner spreads that bucket&rsquo;s rows evenly across it and
          estimates <strong>199</strong> rows. There are <strong>29</strong>: a q-error of 6.67×.
        </>
      ),
      link: to('histogramGap', 'Open the ten buckets'),
    },
    {
      heading: 'More buckets, narrower guesses',
      body: (
        <>
          {code('ANALYZE … WITH 100 BUCKETS')}: the gap is now cut into buckets of its own, few rows each, and the estimate
          is <strong>35</strong> — 1.20×. The q-error falls as the buckets rise, from 29.87× with one bucket. Each bucket
          is one more value the planner stores and reads; PostgreSQL&rsquo;s default is a hundred.
        </>
      ),
      link: to('histogramGapFine', 'Open it with a hundred'),
    },
    {
      heading: 'But not always',
      body: (
        <>
          A narrow range, {code('2400 to 2410')}, at the start of the second band: 110 rows. With ten buckets it falls
          where one bucket ends and the next begins, the planner credits it with a sliver of each, and estimates{' '}
          <strong>1</strong> — 55.50× too few. Twenty buckets give 83. More buckets usually help; a range at a
          boundary can still be a guess.
        </>
      ),
      link: to('histogramEdge', 'Open the narrow range'),
    },
    {
      heading: 'On even data, one bucket is enough',
      body: (
        <>
          The transactions preset&rsquo;s amounts are spread almost evenly from 10 to 4,999. One bucket — the column&rsquo;s
          minimum and maximum — estimates <strong>181</strong> rows for {code('amount BETWEEN 100 AND 400')}; there are
          183. A histogram earns its buckets on a column with a shape.
        </>
      ),
      link: to('histogramEven', 'Open the even column'),
      tryThis: (
        <>
          In the Playground, on the transactions preset, run {code('ANALYZE transactions WITH 1 BUCKETS')} and then{' '}
          {code('EXPLAIN ANALYZE SELECT * FROM transactions WHERE amount BETWEEN 100 AND 400')}: the estimate beside the
          count is the one this step quotes.
        </>
      ),
    },
  ],
  parallel: [
    {
      heading: 'Four workers, four quarters',
      body: (
        <>
          The transactions totalled by status: 750 pages and 3,000 rows, <strong>3,750</strong> ticks for one worker
          alone. Give each of four workers a quarter of the pages and they finish in <strong>948</strong> — 3.96× sooner.
          Each aggregates its quarter into a partial result, and one of them merges the four: 8 ticks no number of
          workers shortens.
        </>
      ),
      link: to('parallelEven', 'Open four even workers'),
    },
    {
      heading: 'One slow worker',
      body: (
        <>
          Make the fourth worker three times slower. Its quarter now takes it three times as long, and the static split
          never moves work off it: the other three finish and wait. <strong>2,798</strong> ticks — 1.34×. An even split is
          even in pages, not in time.
        </>
      ),
      link: to('parallelSlowStatic', 'Open the slow fourth'),
    },
    {
      heading: 'Morsels from a shared queue',
      body: (
        <>
          Cut the pages into morsels of 16 and keep them in one queue: whoever is free takes the next. The slow worker
          simply takes fewer. 2.67× — better, but not the 3.96 the work allows, because a worker taking whatever comes
          next mostly reads pages that live in another&rsquo;s memory, a second tick each.
        </>
      ),
      link: to('parallelSlowShared', 'Open the shared queue'),
    },
    {
      heading: 'Work stealing',
      body: (
        <>
          Give each worker a queue of the morsels in its own quarter, and let one that runs out take the last morsel of
          whoever has the most left. Everyone reads their own pages until the end; then 6 morsels change hands.{' '}
          <strong>1,213</strong> ticks, 3.09× — the morsel-driven scheme of HyPer and its descendants.
        </>
      ),
      link: to('parallelSlowStealing', 'Open work stealing'),
      tryThis: (
        <>
          Switch to <em>One corner</em>, where only the first 600 rows match: static ranges give one worker all the
          aggregating (1.71×), stealing spreads it (3.22×). Then make the morsels one page each: 93 steals, and the
          dispatching costs more than it saves.
        </>
      ),
    },
    {
      heading: 'Amdahl’s ceiling',
      body: (
        <>
          Total by account instead — 40 groups — on eight full-speed workers, in Compare: <strong>4.66×</strong>.
          Amdahl&rsquo;s law, given the one-worker run&rsquo;s serial part (its merge, 1.04% of the ticks), promises 7.46.
          The serial part is not fixed: every worker meets all 40 accounts, so the merge folds in one partial result per
          worker and grows with them. The Karp–Flatt column, the serial fraction each speedup implies, climbs from 0.054
          to 0.102 to say so.
        </>
      ),
      link: to('compareByAccount', 'Compare serial and parallel'),
    },
  ],
  exchange: [
    {
      heading: 'Broadcast the small side',
      body: (
        <>
          200 employees against 5,000 timesheets, on four workers, each holding a quarter of both. Rows with equal keys must
          meet on one worker. Copy the employees to every worker and leave the timesheets where they are: 200 rows to three
          other workers, <strong>603</strong> rows moved, and every worker joins its own timesheets locally — 3.58× one
          worker alone.
        </>
      ),
      link: to('joinSmallBroadcast', 'Open the broadcast join'),
    },
    {
      heading: 'Or repartition both sides',
      body: (
        <>
          Hash every row of both tables on the join key and send it to that key&rsquo;s worker: equal keys meet wherever
          they started. Three quarters of every row moves — <strong>3,903</strong> rows — and the join is 2.84×. For a small
          side, copying it is cheaper than shuffling the big one.
        </>
      ),
      link: to('joinSmallRepartition', 'Open the repartition'),
    },
    {
      heading: 'Two big tables',
      body: (
        <>
          2,000 orders against 3,000 payments. Broadcasting the orders now moves 6,003 rows and leaves each worker building a
          hash table of all 2,000 — 1.60×. Repartitioning moves <strong>3,751</strong>, each worker builds a quarter, and
          the join is 2.72×. Which exchange wins depends on the sizes.
        </>
      ),
      link: to('joinBigRepartition', 'Open the big join'),
    },
    {
      heading: 'A key with five values',
      body: (
        <>
          Projects against employees on the department: five departments, eight workers. Repartitioning by department can
          fill at most five workers, and here three get nothing at all — 4.44×, where broadcasting the 30 projects keeps all
          eight busy and reaches 5.96×. A hash spreads keys, not rows.
        </>
      ),
      link: to('joinFewKeys', 'Open the five keys'),
      tryThis: (
        <>
          Pick <em>Every row back</em>: the same small-with-big join, but every joined row goes to the first worker. On four
          workers the gather alone takes 3,750 of 6,600 ticks — count where the rows are, and gather only the counts.
        </>
      ),
    },
  ],
};

/** The slotted page, and the structures that are alternatives to the engine's heap and B+Tree. */
export const STORAGE_STEPS: Record<string, LessonStep[]> = {
  'slotted-page': [
    {
      heading: 'Header, slots, tuples, free space',
      body: (
        <>
          Page 0 of {code('users')} holds four rows. At 4,096 bytes that is a 24-byte header, a four-byte slot for each
          row, and the tuples — 36 to 44 bytes each — packed in from the far end: 202 bytes used and 3,894 free, room
          for another 87 rows like these.
        </>
      ),
      link: to('pageRoomy', 'Open this page'),
    },
    {
      heading: 'The slots and the tuples grow toward each other',
      body: (
        <>
          Slots fill from the front and tuples from the back. The tuple for slot 0 starts at byte 4,060; the next, 38
          bytes lower, at 4,022; then 3,978 and 3,934. A row is addressed as (page, slot), not as a byte offset, so the
          tuple behind a slot can move within its page — to close a gap — without any index entry changing.
        </>
      ),
      link: to('pageRoomy', 'Select a tuple'),
    },
    {
      heading: 'Shrink the page until the rows do not fit',
      body: (
        <>
          At 256 bytes the same four rows leave 54 free: one more fits. At 192 they do not fit at all, and the
          inspector says so — the tuples would run into the slot array. “Rows per page” is not a constant; it comes out
          of the page size and the width of the row.
        </>
      ),
      link: to('pageTight', 'Open it at 256 bytes'),
      tryThis: (
        <>
          Set the size to 192 and watch the last tuple’s offset: it lands below the end of the slot array. Then widen the
          page and see how many rows fit before the free space is gone.
        </>
      ),
    },
  ],
  'hash-index': [
    {
      heading: 'A directory that doubles',
      body: (
        <>
          Sixty writes, 31 distinct keys, four to a bucket. A full bucket splits on one more bit of the hash, and if it
          was already using every bit the directory has, the directory doubles first. Four doublings here: 16 slots
          pointing at 10 buckets, so several slots share a bucket — a bucket’s <em>local depth</em> is how many bits it
          actually needs.
        </>
      ),
      link: to('hashExtendible', 'Open extendible hashing'),
    },
    {
      heading: 'Linear hashing: split the next bucket, not the full one',
      body: (
        <>
          There is no directory. A bucket that overflows grows an overflow page, and the bucket that <em>splits</em> is
          whichever one the split pointer has reached, in order — not the one that overflowed. Seven inserts overflowed
          a bucket and seven splits followed; in two of them the bucket that split was a different one. Growth stays
          predictable, and a hot bucket just keeps a longer chain (the longest here is two pages).
        </>
      ),
      link: to('hashLinear', 'Open linear hashing'),
    },
    {
      heading: 'Neighbours are strangers',
      body: (
        <>
          Keys 43 to 52 are ten consecutive values. A B+Tree would find them side by side along its leaf chain. Here
          they land in buckets 0, 3, 0, 2, 5, 6, 5, 5, 3 and 3. A range scan has no chain to walk and would have to hash
          every value in the range — the trade is one hop for {code('id = 7')} and nothing at all for{' '}
          {code('id > 7')}.
        </>
      ),
      link: to('hashExtendible', 'See where the keys land'),
    },
  ],
  'lsm-tree': [
    {
      heading: 'Writes go to memory, then to sorted files',
      body: (
        <>
          Sixty writes are buffered four at a time and flushed as an immutable, sorted table: fifteen flushes. When level
          0 holds three tables they are merged into level 1, and a level that outgrows its capacity is merged into the
          next: twelve compactions. Sixty writes were only 31 distinct keys, and a merge keeps the newest value of each —
          which is why merging exists at all.
        </>
      ),
      link: to('lsmLeveled', 'Open the LSM tree'),
    },
    {
      heading: 'A write is written many times',
      body: (
        <>
          Add up every entry a flush or a merge wrote and divide by the writes you made: <strong>3.9</strong>. That is
          write amplification — a write is rewritten each time it moves down a level. The other side is space
          amplification: 39 entries on disk for 31 live keys, 1.26, the stale copies a later merge has not reached.
        </>
      ),
      link: to('lsmLeveled', 'Read the amplification'),
    },
    {
      heading: 'Tiered: write less, read more',
      body: (
        <>
          Switch to tiered compaction and a merge no longer rewrites what the next level already holds. The same 60
          writes now cost <strong>2.3</strong> per write instead of 3.9. The price is overlap: a lookup may have to
          check 3 tables in the worst case instead of 2, and 45 entries sit on disk for the 31 keys.
        </>
      ),
      link: to('lsmTiered', 'Open it tiered'),
    },
    {
      heading: 'A Bloom filter buys the reads back',
      body: (
        <>
          Each table carries a Bloom filter, asked before the table is: a “no” skips it. At two bits per key it says
          “maybe” to 64% of the keys that are not there, and a lookup checks 1.4 tables on average. At eight bits that
          is 6% and 0.5 tables — within a hair of what leveled compaction manages.
        </>
      ),
      link: to('lsmTieredTwoBits', 'Open it at two bits per key'),
      tryThis: (
        <>
          Raise the bits per key to 8, then 16. The false-positive rate falls to nothing on this data. What does it
          cost? The filter is sixteen bits for every key in every table.
        </>
      ),
    },
  ],
  'row-vs-column': [
    {
      heading: 'Reading one column',
      body: (
        <>
          Five hundred rows of four columns are 32 pages of 256 bytes. A query that needs one column reads all 32 in a
          row store (NSM): the other three columns come along on every page. Switch to DSM, a column store, and the same
          query reads <strong>8</strong>.
        </>
      ),
      link: to('columnarNsm', 'Open the row store'),
    },
    {
      heading: '…and what a column store charges',
      body: (
        <>
          Each column has its own pages, so a column scan reads only its own 8. Rebuilding one whole row now means
          visiting four regions — one per column — where a row store visits one. That is the cost on a{' '}
          {code('SELECT *')}.
        </>
      ),
      link: to('columnarDsm', 'Open the column store'),
      tryThis: (
        <>
          Choose PAX. Rows are grouped and each group is laid out by column: one column still costs 8 pages, and one row
          needs a single region again.
        </>
      ),
    },
    {
      heading: 'Each column wants its own encoding',
      body: (
        <>
          {code('id')} is sorted, so delta coding stores it in 129 bytes of 2,000. A status held in blocks takes 24
          bytes under run-length encoding. The same values shuffled would take 2,166 under RLE — <em>more</em> than not
          compressing at all — and bit-packing wins at 125. A column of random amounts resists everything: the best
          saves 3%.
        </>
      ),
      link: to('columnarDsm', 'Compare the encodings'),
    },
    {
      heading: 'Late materialization',
      body: (
        <>
          Filter on one column, return another. Rebuilding every row first touches 8,000 bytes. Reading the filter column
          and then fetching the other column only for the 103 rows that matched touches 2,412. Where the filter is
          selective, that gap is the column store earning its keep.
        </>
      ),
      link: to('columnarDsm', 'See the materialization'),
    },
  ],
  'latch-crabbing': [
    {
      heading: 'Latches, and the naive way',
      body: (
        <>
          A latch is a short physical hold on one index page while a thread reads or changes it; it is not a transaction
          lock. Naive latching holds every page on the path from the root down until the insert is written, so every
          insert holds the root. Four threads inserting six keys each take <strong>104</strong> ticks, and 224
          thread-ticks are spent blocked.
        </>
      ),
      link: to('latchCrowded', 'Open the workload'),
    },
    {
      heading: 'Crabbing: let go when the child is safe',
      body: (
        <>
          A page is <em>safe</em> when it has room for one more key, so a split below cannot reach it. Crabbing latches
          the child and releases everything above it as soon as the child is safe. The same 24 inserts finish in{' '}
          <strong>82</strong> ticks with 148 blocked, and up to 5 latches are held across threads at once rather than 3:
          threads are no longer all queued behind the root. The tree that results is the same one, and the engine’s own
          validator passes it.
        </>
      ),
      link: to('latchCrowded', 'Compare the two timelines'),
    },
    {
      heading: 'Wider pages make more of them safe',
      body: (
        <>
          With six keys to a page most pages have room, so a crabbing thread never holds more than two at once where a
          naive thread holds three. The tree is also shallower, so there is less to save: crabbing finishes 15 ticks
          sooner here, 22 at fan-out four and 27 at fan-out three.
        </>
      ),
      link: to('latchWide', 'Open it at fan-out six'),
      tryThis: (
        <>
          Step the fan-out down to 3 and compare the two columns. More splits mean more unsafe pages, so a crabbing
          thread’s most latches at once rises from two to three.
        </>
      ),
    },
    {
      heading: 'Optimistic: read first, latch only to write',
      body: (
        <>
          Optimistic lock coupling takes no latch on the way down. A thread reads each page and remembers its version,
          and after each step checks that the page above has not changed; only then does it latch the pages it will
          change, usually the leaf alone. If a page it read has changed since, or the page it wants is held, the insert{' '}
          <em>restarts</em> from the root. The same 24 inserts finish in <strong>78</strong> ticks with{' '}
          <strong>18</strong> blocked, against crabbing’s 148, and 8 of them restarted.
        </>
      ),
      link: to('latchCrowdedOptimistic', 'Open the optimistic timeline'),
    },
    {
      heading: 'A restart costs a whole descent',
      body: (
        <>
          The bet is that two inserts rarely meet. When they do not, nothing waits; when they do, the loser pays for
          the path again. Two threads of two inserts at five keys to a page: <strong>19</strong> ticks against
          crabbing’s 15, for one restart. Optimism pays where threads would otherwise queue — six keys to a page, four
          threads, six inserts each: <strong>59</strong> ticks against <strong>72</strong>, for ten restarts.
        </>
      ),
      link: to('latchQuiet', 'Open it with two threads'),
      tryThis: (
        <>
          Raise the threads to 4 and the inserts to 6 and read the optimistic column against the crabbing one again: the
          restarts grow, and the ticks it saves by not waiting grow faster.
        </>
      ),
    },
  ],
  'vector-index': [
    {
      heading: 'Exact is expensive',
      body: (
        <>
          Four hundred points, and the twenty nearest to a query. Brute force computes the distance to every point: 400
          computations, and the answer is exact by construction. Everything else is a way of computing fewer of them and
          accepting that a true neighbour may be missed.
        </>
      ),
      link: to('vectorBig', 'Open the comparison'),
    },
    {
      heading: 'IVF: look only in the nearest clusters',
      body: (
        <>
          The points are grouped around 20 centroids. A query ranks the centroids and searches only the nearest few
          clusters. Probing one costs about 43 distance computations and finds 74% of the true twenty; probing two costs
          about 63 and finds 98%. Probing all twenty costs 420 — more than brute force, because the twenty centroid
          comparisons come on top.
        </>
      ),
      link: to('vectorBig', 'Read the curve'),
    },
    {
      heading: 'HNSW: walk a graph',
      body: (
        <>
          Every point is on layer 0 and, with falling probability, on higher layers — 400, 65, 7 and 1 points on layers
          0 to 3 — so the top is a sparse highway. A query descends it and then searches layer 0 with a beam of width{' '}
          {code('ef')}. A beam as wide as k, 20, costs about 75 computations and finds 95%; a beam of 64 costs about 117
          and finds them all.
        </>
      ),
      link: to('vectorBig', 'Read the curve'),
      tryThis: (
        <>
          These points are two-dimensional so that the clusters are visible; the numbers are this toy’s, and not a claim
          about 768-dimensional embeddings. Change the seed with <strong>Reshuffle</strong> and watch which settings
          keep full recall.
        </>
      ),
    },
  ],
};
