import type { ReactNode } from 'react';

/**
 * The challenges for the sort, the hash join, the join order, the slotted page, hash indexes, the LSM tree, columnar
 * layouts, latch crabbing and the vector index. Not queries and not scripts: the player sets a few numbers — the
 * same ones the tool itself takes — and the check is a predicate over what the tool's own driver makes of them.
 *
 * This file is only the list, and imports nothing of any driver, for the reason `scriptChallenges.tsx` does not:
 * the challenge index should not carry eight drivers to list ten titles. The checks and the running are in
 * `settingsRunner.ts`, loaded when one of these is opened. A control's range is written here and held against the
 * tool's own limits in `__tests__/settingsChallenges.test.ts` — a setting a tool does not accept opens it at its
 * default, so the ranges must not drift.
 */

export type Control =
  | { kind: 'number'; key: string; label: string; min: number; max: number; note?: string }
  | { kind: 'select'; key: string; label: string; options: readonly { value: string; label: string }[] };

export type SettingsTool =
  | 'sort'
  | 'hash-join'
  | 'join-order'
  | 'page'
  | 'hash-index'
  | 'lsm'
  | 'columnar'
  | 'latch-crabbing'
  | 'vector-index';

export interface SettingsChallenge {
  id: string;
  title: string;
  /** The tool whose driver runs the settings, and whose page the solved run links to. */
  tool: SettingsTool;
  brief: ReactNode;
  hint: ReactNode;
  /** What passing takes, in one line, shown beside a miss. */
  needs: string;
  controls: readonly Control[];
  /** The values the form opens on — a setting that runs and does not pass yet. */
  starter: Readonly<Record<string, string>>;
  /** The wrong belief this challenge exists to correct, shown once it is solved (plan.md §G3). */
  misconception: ReactNode;
}

const code = (text: string) => <code className="font-mono">{text}</code>;

const STRATEGY = {
  kind: 'select',
  key: 'strategy',
  label: 'Compaction',
  options: [
    { value: 'leveled', label: 'Leveled' },
    { value: 'tiered', label: 'Tiered' },
  ],
} as const;

const TABLES = [
  { value: 'departments', label: 'departments' },
  { value: 'projects', label: 'projects' },
  { value: 'employees', label: 'employees' },
  { value: 'timesheets', label: 'timesheets' },
] as const;

export const SETTINGS_CHALLENGES: SettingsChallenge[] = [
  {
    id: 'one-merge-pass',
    title: 'Sort in a single merge pass',
    tool: 'sort',
    brief: (
      <>
        An external merge sort writes sorted runs and then merges them, pass after pass, until one run is left. Choose
        the number of records, the records on a page and the buffer pages so that at least 48 records are sorted with{' '}
        <strong>exactly one</strong> merge pass.
      </>
    ),
    hint: (
      <>
        One merge pass can combine as many runs as there are buffer pages less one. Pass 0 makes one run for every
        buffer-pool-full of records, so more pages, or more records to a page, mean fewer runs to merge.
      </>
    ),
    needs: 'at least 48 records, and exactly one merge pass',
    controls: [
      { kind: 'number', key: 'n', label: 'Records', min: 6, max: 64 },
      { kind: 'number', key: 'page', label: 'Records per page', min: 2, max: 4 },
      { kind: 'number', key: 'mem', label: 'Buffer pages', min: 3, max: 6 },
    ],
    starter: { n: '64', page: '2', mem: '3' },
    misconception: (
      <>
        An external sort is one read and one write of the data, and memory only changes how quickly. Its cost is a number
        of passes, and memory sets the number: too few buffer pages leave more runs than one merge can take, and every
        extra pass reads and writes every page again.
      </>
    ),
  },
  {
    id: 'more-memory-more-io',
    title: 'Give a join more memory and make it slower',
    tool: 'hash-join',
    brief: (
      <>
        More memory should never make a join cost more. Find a join of two key lists, a page size and a number of
        buffer pages where a Grace hash join given <strong>one more</strong> buffer page does <strong>more</strong>{' '}
        page I/O than it does with the number you chose.
      </>
    ),
    hint: (
      <>
        Look at where the two costs differ. Partitioning reads and writes every page whatever the number of partitions;
        what changes is how many partly filled pages the build and probe phase then has to read.
      </>
    ),
    needs: 'more total page I/O with one more buffer page than with the number chosen',
    controls: [
      { kind: 'number', key: 'build', label: 'Build keys', min: 6, max: 24 },
      { kind: 'number', key: 'probe', label: 'Probe keys', min: 6, max: 32 },
      { kind: 'number', key: 'page', label: 'Keys per page', min: 2, max: 4 },
      { kind: 'number', key: 'mem', label: 'Buffer pages (then one more)', min: 3, max: 5 },
    ],
    starter: { build: '12', probe: '20', page: '2', mem: '5' },
    misconception: (
      <>
        More memory never makes a hash join slower. One more buffer page is one more partition, and every partition is read
        back in whole pages, the last of them partly empty. The partitioning cost is the same; the reading back can cost
        a page or two more.
      </>
    ),
  },
  {
    id: 'cheapest-order',
    title: 'Pick the join order',
    tool: 'join-order',
    brief: (
      <>
        Four tables, three join predicates, and every order returns the same rows. Choose the order — first table to
        last — whose estimated cost is within 5% of the cheapest one the search finds.
      </>
    ),
    hint: (
      <>
        Look at the sizes in the tool: {code('timesheets')} is far the biggest, and it hangs off {code('employees')}{' '}
        alone. A table that is joined early multiplies every join after it; which table is best left until the end?
      </>
    ),
    needs: 'an order within 5% of the cheapest, and each table exactly once',
    controls: [
      { kind: 'select', key: 'first', label: 'First', options: TABLES },
      { kind: 'select', key: 'second', label: 'Second', options: TABLES },
      { kind: 'select', key: 'third', label: 'Third', options: TABLES },
      { kind: 'select', key: 'fourth', label: 'Fourth', options: TABLES },
    ],
    starter: { first: 'departments', second: 'projects', third: 'employees', fourth: 'timesheets' },
    misconception: (
      <>
        Join the tables in the order the query names them, or smallest first. Any order returns the same rows; the order
        decides how big the intermediate results get. The cheapest orders here all finish on {code('projects')} — the
        written order joins it second, and pays for it in every join after.
      </>
    ),
  },
  {
    id: 'tightest-page',
    title: 'Find the smallest page that holds the rows',
    tool: 'page',
    brief: (
      <>
        A slotted page has a header, a slot array and the tuples, which have headers of their own. Choose a page of{' '}
        {code('users')} and a page size in bytes so that the page is full: <strong>every row fits and no byte is left
        over</strong>.
      </>
    ),
    hint: (
      <>
        The inspector reports the bytes used and the bytes free. A page that is too small says overflow; one that is too
        big has free bytes. The answer is the size that sits exactly between.
      </>
    ),
    needs: 'a page size with no overflow and no free bytes',
    controls: [
      { kind: 'number', key: 'page', label: 'Heap page', min: 0, max: 11 },
      { kind: 'number', key: 'bytes', label: 'Page size in bytes', min: 128, max: 16384 },
    ],
    starter: { page: '0', bytes: '4096' },
    misconception: (
      <>
        A page holds exactly its rows&apos; data. About a third of one of these is not the rows at all: the 24-byte
        header, the four-byte slot for each row and the eight-byte header on each tuple come out of the same page, which
        is why a page holds fewer rows than its size divided by the width of a row.
      </>
    ),
  },
  {
    id: 'split-the-other-bucket',
    title: 'Split a bucket that did not overflow',
    tool: 'hash-index',
    brief: (
      <>
        Some hash indexes split the bucket that filled up; one of them does not. Choose settings so that the index splits
        a bucket <strong>other than the one that overflowed</strong> at least three times.
      </>
    ),
    hint: (
      <>
        Only one of the two schemes has overflow pages at all. In it, a split goes to the bucket the split pointer has
        reached, in order — and small buckets and few of them make overflows come sooner.
      </>
    ),
    needs: 'at least three splits of a bucket other than the one that overflowed',
    controls: [
      { kind: 'number', key: 'n', label: 'Writes', min: 10, max: 200 },
      {
        kind: 'select',
        key: 'strategy',
        label: 'Scheme',
        options: [
          { value: 'extendible', label: 'Extendible' },
          { value: 'linear', label: 'Linear' },
        ],
      },
      { kind: 'number', key: 'cap', label: 'Bucket capacity', min: 2, max: 8 },
      { kind: 'number', key: 'init', label: 'Initial buckets', min: 1, max: 4 },
    ],
    starter: { n: '60', strategy: 'extendible', cap: '4', init: '2' },
    misconception: (
      <>
        A hash bucket splits when it is full. Extendible hashing does; linear hashing splits whichever bucket the split
        pointer has reached, in turn, whether or not it overflowed — and the bucket that did overflow keeps a chain until
        its turn comes. That is what keeps growth steady.
      </>
    ),
  },
  {
    id: 'cheap-writes-cheap-reads',
    title: 'Cheap writes and cheap reads',
    tool: 'lsm',
    brief: (
      <>
        Compaction decides what a write costs, and the Bloom filters what a read costs. Choose settings for a run of at
        least 40 writes with write amplification <strong>at most 2.5</strong> and the average number of tables a lookup
        checks <strong>at most 0.6</strong>.
      </>
    ),
    hint: (
      <>
        One strategy rewrites data less. Its price is overlapping tables, which a lookup has to check — unless the
        filters say no first. How many bits per key does that take?
      </>
    ),
    needs: 'at least 40 writes, write amplification ≤ 2.5 and average read amplification ≤ 0.6',
    controls: [
      { kind: 'number', key: 'n', label: 'Writes', min: 10, max: 200 },
      STRATEGY,
      { kind: 'number', key: 'mem', label: 'Memtable entries', min: 2, max: 8 },
      { kind: 'number', key: 'trigger', label: 'Tables that trigger a merge', min: 2, max: 6 },
      { kind: 'number', key: 'bits', label: 'Filter bits per key', min: 2, max: 20 },
    ],
    starter: { n: '60', strategy: 'leveled', mem: '4', trigger: '3', bits: '8' },
    misconception: (
      <>
        An LSM tree has to choose between cheap writes and cheap reads. The compaction strategy sets what a write costs
        and the number of overlapping tables; a Bloom filter then decides how many of those a lookup has to open. The
        two are separate dials, and one setting of each gets both.
      </>
    ),
  },
  {
    id: 'write-amp-below-one',
    title: 'Write less than you were asked to',
    tool: 'lsm',
    brief: (
      <>
        Write amplification is every entry physically written divided by the writes you made, and it is supposed to be
        at least 1. Choose settings that make it fall <strong>below 1</strong>.
      </>
    ),
    hint: (
      <>
        Some of the writes are to a key that was just written. If they meet in the memtable, only the newest of them is
        ever flushed. What helps them meet — and what keeps the merges from rewriting everything again?
      </>
    ),
    needs: 'write amplification below 1',
    controls: [
      { kind: 'number', key: 'n', label: 'Writes', min: 10, max: 200 },
      STRATEGY,
      { kind: 'number', key: 'mem', label: 'Memtable entries', min: 2, max: 8 },
      { kind: 'number', key: 'trigger', label: 'Tables that trigger a merge', min: 2, max: 6 },
    ],
    starter: { n: '60', strategy: 'leveled', mem: '4', trigger: '3' },
    misconception: (
      <>
        Every write is written at least once, so write amplification cannot be below 1. A memtable absorbs repeated
        writes of one key: only the newest is ever flushed, so a store that is hit hard on hot keys can write fewer
        entries than it was asked to.
      </>
    ),
  },
  {
    id: 'column-store-saving',
    title: 'Make the column store pay off',
    tool: 'columnar',
    brief: (
      <>
        A column layout is meant to read fewer pages when a query needs one column. Choose a table size, a page size and
        a layout so that scanning one column reads <strong>at most 30%</strong> of the pages of a full scan, over a table
        of <strong>at least 8 pages</strong>, and rebuilding a row visits <strong>a single region</strong>.
      </>
    ),
    hint: (
      <>
        Two of the three layouts fail on their own: one cannot skip columns, and one scatters a row across a region for
        every column. And a table that fits in a page or two has nothing to skip.
      </>
    ),
    needs: 'a full scan of at least 8 pages, a one-column scan of at most 30% of it, and one region per row',
    controls: [
      { kind: 'number', key: 'n', label: 'Rows', min: 50, max: 2000 },
      { kind: 'number', key: 'page', label: 'Page size in bytes', min: 64, max: 1024 },
      {
        kind: 'select',
        key: 'layout',
        label: 'Layout',
        options: [
          { value: 'NSM', label: 'NSM (rows)' },
          { value: 'DSM', label: 'DSM (columns)' },
          { value: 'PAX', label: 'PAX (hybrid)' },
        ],
      },
    ],
    starter: { n: '50', page: '1024', layout: 'PAX' },
    misconception: (
      <>
        A column store always reads fewer pages. It reads fewer only once the table spans several: below that, every
        layout reads the same page or two. And the plain column store buys its saving with storage regions — one per
        column for each row it rebuilds — which the hybrid layout does not charge.
      </>
    ),
  },
  {
    id: 'crabbing-saves-a-fifth',
    title: 'Make crabbing save a fifth of the time',
    tool: 'latch-crabbing',
    brief: (
      <>
        Threads inserting into one B+Tree finish sooner when they let go of a page as soon as the child below is safe.
        Choose a fan-out, a number of threads and inserts per thread so that crabbing takes <strong>at least 20%
        fewer ticks</strong> than naive latching on the same inserts.
      </>
    ),
    hint: (
      <>
        Crabbing helps where threads contend and where there is a long path to hold. More threads and more inserts
        contend more. Does a wider page give naive latching more to hold, or less?
      </>
    ),
    needs: 'crabbing finishing in at most 80% of naive latching’s ticks',
    controls: [
      { kind: 'number', key: 'fanout', label: 'Keys per page', min: 3, max: 6 },
      { kind: 'number', key: 'threads', label: 'Threads', min: 2, max: 4 },
      { kind: 'number', key: 'ops', label: 'Inserts per thread', min: 1, max: 6 },
    ],
    starter: { fanout: '6', threads: '2', ops: '2' },
    misconception: (
      <>
        Room on a page makes more pages safe, so crabbing must help more with a wider tree. More pages are safe, and
        the tree is also shallower, so naive latching has less path to hold in the first place. The saving is largest
        where the tree is narrow and the threads are many.
      </>
    ),
  },
  {
    id: 'recall-for-a-quarter',
    title: 'Beat brute force by four to one',
    tool: 'vector-index',
    brief: (
      <>
        An approximate index trades recall for fewer distance computations. Choose a table, a method and its setting so
        that, averaged over the 20 queries, the index finds <strong>at least 95%</strong> of the true nearest neighbours
        for <strong>at most a quarter</strong> of the distance computations brute force makes.
      </>
    ),
    hint: (
      <>
        IVF&apos;s knob is how many clusters to probe, HNSW&apos;s the beam width. Probing every cluster costs more than
        brute force, and so does a beam as wide as the table. Try a few hundred points.
      </>
    ),
    needs: 'recall of at least 95% with at most a quarter of the points compared',
    controls: [
      { kind: 'number', key: 'n', label: 'Points', min: 60, max: 400 },
      { kind: 'number', key: 'k', label: 'Neighbours (k)', min: 3, max: 20 },
      {
        kind: 'select',
        key: 'method',
        label: 'Method',
        options: [
          { value: 'ivf', label: 'IVF — clusters to probe' },
          { value: 'hnsw', label: 'HNSW — beam width' },
        ],
      },
      { kind: 'number', key: 'parameter', label: 'Clusters probed, or beam width', min: 1, max: 400 },
    ],
    starter: { n: '400', k: '20', method: 'ivf', parameter: '1' },
    misconception: (
      <>
        An approximate index always beats brute force. On a small table the clusters and the graph leave little to skip,
        and the bar — high recall for a quarter of the work — cannot be met by any setting; it takes a few hundred points
        before there is room to save a distance computation without losing a neighbour.
      </>
    ),
  },
];

export function settingsChallengeById(id: string | undefined): SettingsChallenge | undefined {
  return SETTINGS_CHALLENGES.find((c) => c.id === id);
}
