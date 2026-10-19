/**
 * The lesson track's manifest: what each lesson is called, how long it takes, what it is about and which group it
 * belongs to. Nothing here imports the engine, the JSX of a lesson or a tool's driver, so a page that only *lists*
 * lessons — `/learn`, `/progress` — pays for a few kilobytes of text and not for the twenty-five lessons' steps and
 * the engine behind the Playground links.
 *
 * The steps themselves are in `lessons.tsx` (the query pipeline), `storageLessons.tsx` and `transactionLessons.tsx`,
 * keyed by the ids below; `lessons.tsx` joins the two into a `Lesson` and refuses to load if an id here has no
 * steps. `__tests__/lessonIndex.test.ts` holds the other direction: every set of steps belongs to a lesson here.
 * Order matters: it is the order of the track, and the order lessons are numbered in.
 */

export type LessonGroupId = 'pipeline' | 'storage' | 'transactions';

export interface LessonMeta {
  id: string;
  title: string;
  minutes: number;
  summary: string;
}

export interface LessonGroup {
  id: LessonGroupId;
  title: string;
  about: string;
  lessons: readonly LessonMeta[];
}

export const LESSON_GROUPS: readonly LessonGroup[] = [
  {
    id: 'pipeline',
    title: 'The query pipeline',
    about: 'From the text of a query to a row: the buffer pool, the B+Tree, the planner — and how a sort, a hash join and a join order spend pages.',
    lessons: [
      {
        id: 'first-query',
        title: 'Run your first query',
        minutes: 2,
        summary: 'The whole path, end to end, in one query — parse, plan, execute, result.',
      },
      {
        id: 'one-row',
        title: 'Follow one row from disk to result',
        minutes: 5,
        summary: 'The spine of the whole tool: one row, crossing every stage once.',
      },
      {
        id: 'eviction',
        title: 'Watch a page get evicted',
        minutes: 4,
        summary: 'Fill the pool, then see LRU and clock sweep pick different victims.',
      },
      {
        id: 'btree-split',
        title: 'Watch a B+Tree split',
        minutes: 4,
        summary: 'Fill a leaf, add one key, and watch the tree grow a level — a copy-up, then a push-up.',
      },
      {
        id: 'planner',
        title: 'Make the planner change its mind',
        minutes: 3,
        summary: 'One predicate becomes an index lookup; another cannot. See why.',
      },
      {
        id: 'edit-data',
        title: 'Edit the seed data',
        minutes: 3,
        summary: 'Change the rows and watch which parts of the trace change — and which do not.',
      },
      {
        id: 'predict',
        title: 'Predict before you look',
        minutes: 3,
        summary: 'Commit to an answer before each reveal — the one habit the evidence backs.',
      },
      {
        id: 'share',
        title: 'Share a moment',
        minutes: 2,
        summary: 'The URL is the save file: a query, a dataset and a step, reproducible from a link.',
      },
      {
        id: 'errors',
        title: 'When something goes wrong',
        minutes: 2,
        summary: 'A panel that breaks does not lose your trace — and the report writes itself.',
      },
      {
        id: 'nulls',
        title: 'NULL is not a value',
        minutes: 5,
        summary: 'A missing value is UNKNOWN, not false — and = NULL, <>, COUNT, AVG and NOT IN each show it a different way.',
      },
      {
        // plan.md §27.5 S1, on S2's `shop` preset.
        id: 'not-exists',
        title: 'NOT EXISTS is not NOT IN',
        minutes: 5,
        summary: 'A semi-join keeps each customer once, an anti-join finds the three who never ordered — and NOT IN, meeting a guest’s NULL, finds no one.',
      },
      {
        // plan.md §27.5 S3, on the `shop` preset.
        id: 'set-operations',
        title: 'UNION, INTERSECT, EXCEPT',
        minutes: 4,
        summary: 'Two SELECTs, one result: every row, each row once, the rows in both, the rows in one and not the other — and why a NULL does not trip EXCEPT.',
      },
      {
        // plan.md §27.5 S4, on the `shop` preset.
        id: 'outer-joins',
        title: 'RIGHT, FULL and CROSS JOIN',
        minutes: 5,
        summary: 'The rows an inner join drops, kept on the right or on both sides — and the cross product a WHERE equality turns back into a join.',
      },
      {
        id: 'tokens-and-trees',
        title: 'From text to tokens to a tree',
        minutes: 3,
        summary: 'The tokenizer, the parser and where AND ends up — and what an error looks like.',
      },
      {
        id: 'grammar-diagram',
        title: 'Read the grammar diagram',
        minutes: 3,
        summary: 'What the parser can read, why AND binds tighter than OR, and what the engine refuses anyway.',
      },
      {
        id: 'planner-rules',
        title: 'Rewrite rules need each other',
        minutes: 3,
        summary: 'Eight rules, two of which make a lookup — and what each does alone.',
      },
      {
        id: 'buffer-pool',
        title: 'Replay a page-reference string',
        minutes: 5,
        summary: 'A loop that beats LRU, a bigger pool that misses more, and a scan that sweeps the hot set.',
      },
      {
        id: 'external-sort',
        title: 'Sort more than fits in memory',
        minutes: 4,
        summary: 'Run generation, then merge passes: a sort’s cost is a number of passes, and memory is what sets it.',
      },
      {
        id: 'hash-join',
        title: 'Join by partitioning: Grace hash join',
        minutes: 4,
        summary: 'Build a hash table of one side, probe it with the other — and what to do when the build side will not fit.',
      },
      {
        id: 'join-order',
        title: 'Join order: the same tables, five times the work',
        minutes: 4,
        summary: 'Every order gives the same rows. Selinger’s search finds the cheap one without pricing every order.',
      },
      {
        id: 'histograms',
        title: 'Histograms: how many buckets an estimate needs',
        minutes: 4,
        summary: 'ANALYZE cuts a column into buckets of equal depth. Too few, and a range over a gap is guessed many times too high.',
      },
      {
        id: 'parallel',
        title: 'Parallel execution: morsels and the slow worker',
        minutes: 5,
        summary: 'Four workers, one slow: an even split waits for it, a shared queue reads remotely, work stealing gets both right.',
      },
    ],
  },
  {
    id: 'storage',
    title: 'Storage engines and access methods',
    about: 'What a page really holds, and the structures that are alternatives to a heap and a B+Tree: hashing, LSM trees, columns, latches, vectors.',
    lessons: [
      {
        id: 'slotted-page',
        title: 'Where a row lives on a page',
        minutes: 3,
        summary: 'A header, a slot array and the tuples, packed from both ends — and what “rows per page” really is.',
      },
      {
        id: 'hash-index',
        title: 'A hash index: one hop, and no ranges',
        minutes: 4,
        summary: 'Extendible and linear hashing grow a bucket array two different ways — and neither can scan a range.',
      },
      {
        id: 'lsm-tree',
        title: 'Write fast, pay later: the LSM tree',
        minutes: 5,
        summary: 'Buffer writes, flush sorted files, merge them down — and the amplification each choice puts on reads and writes.',
      },
      {
        id: 'row-vs-column',
        title: 'Rows, columns, or both',
        minutes: 5,
        summary: 'Three layouts, four encodings and one trick: what a column store saves, and what it charges for.',
      },
      {
        id: 'latch-crabbing',
        title: 'Let go early: latch crabbing',
        minutes: 5,
        summary:
          'Many threads inserting into one B+Tree: hold the whole path, release each page as soon as it is safe, or latch nothing until the write.',
      },
      {
        id: 'vector-index',
        title: 'Nearest neighbours: exact, clustered, or graph',
        minutes: 5,
        summary: 'Three ways to find the closest points, scored by what they cost and what they miss.',
      },
    ],
  },
  {
    id: 'transactions',
    title: 'Transactions and durability',
    about: 'Two sessions on one table, then a crash: locks, snapshots, the log and recovery.',
    lessons: [
      {
        id: 'lock-table',
        title: 'The lock table: share, wait, deadlock',
        minutes: 4,
        summary: 'Readers share a page, a writer waits and is promoted, and a circle of waits has a victim.',
      },
      {
        id: 'dirty-read',
        title: 'Let a dirty read happen, then stop it',
        minutes: 4,
        summary: 'Two sessions, no concurrency control — then the same schedule under locks, and a deadlock.',
      },
      {
        id: 'isolation-levels',
        title: 'Read the isolation matrix',
        minutes: 5,
        summary: 'Ten anomalies, four levels, two engines: what a cell means, and the run behind it.',
      },
      {
        id: 'snapshots',
        title: 'Readers that never wait: snapshots',
        minutes: 5,
        summary: 'Give every row a history and a reader needs no lock — then see what that does and does not buy.',
      },
      {
        id: 'protocols',
        title: 'Locks, timestamps or optimism?',
        minutes: 5,
        summary: 'One schedule under five protocols, each really run: who waited, who was thrown away, what survived.',
      },
      {
        id: 'log-first',
        title: 'Why the log goes first',
        minutes: 4,
        summary: 'The one rule that makes a log worth keeping, what a commit really writes, and what breaking the rule costs.',
      },
      {
        id: 'steal-and-force',
        title: 'Steal and force: what a crash will find',
        minutes: 5,
        summary: 'Two choices about when a page may reach disk, four combinations, and the bill each sends to recovery.',
      },
      {
        id: 'recovery',
        title: 'Survive a crash',
        minutes: 5,
        summary: 'Analysis, redo and undo on a real log — then a crash in the middle of recovery itself.',
      },
    ],
  },
];

/** Every lesson, in track order. */
export const LESSON_INDEX: readonly LessonMeta[] = LESSON_GROUPS.flatMap((group) => group.lessons);

export function lessonMeta(id: string | undefined): LessonMeta | undefined {
  return LESSON_INDEX.find((lesson) => lesson.id === id);
}
