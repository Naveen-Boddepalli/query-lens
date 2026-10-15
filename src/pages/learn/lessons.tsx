/* eslint-disable react-refresh/only-export-components --
   This is a data module, not a component module: it exports the lesson list
   and a link-builder. The lesson prose carries JSX, which is why the file is
   `.tsx`, but nothing here is a React component to hot-reload. */
import type { ReactNode } from 'react';
import { createSeedDatabase, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../engine/index.ts';
import type { PredictionPrompt, ReplacementPolicyName, StepEvent } from '../../engine/index.ts';
import { encodeShareState } from '../../ui/urlState.ts';

/**
 * The §17.2 manual tasks as an ordered, in-app track (plan.md §21.3 `/learn`).
 * Each lesson is short and task-shaped; each step that references the Playground
 * computes its deep link from a *real* run of the engine — `findIndex` against
 * the same trace the Playground would produce — so an engine change that moves
 * a step fails to build a lesson rather than shipping a link to the wrong
 * place. Same discipline as `GalleryPage`.
 */

const SEED = createSeedDatabase();

const POINT_LOOKUP = 'SELECT *\nFROM users\nWHERE id = 5;';
const SEQ_SCAN = 'SELECT *\nFROM users\nWHERE age > 30;';

export type LessonDifficulty = 'Beginner' | 'Intermediate' | 'Advanced';
export type LessonCategory = 'Foundations' | 'Storage' | 'Optimizer' | 'Workflows';

interface OpenSpec {
  sql: string;
  policy?: ReplacementPolicyName;
  predictOn?: boolean;
  /** Returns the 0-based event index to land *after*; `at` adds 1. */
  find: (events: readonly StepEvent[]) => number;
  label?: string;
}

export interface LessonStep {
  heading: string;
  body: ReactNode;
  /** Drives the Playground; the step is computed from a real run. */
  open?: OpenSpec;
  /** A fixed link for a step that points somewhere other than the Playground —
   *  a `/tools/*` sandbox, the docs — so it cannot carry a stale step number. */
  link?: { href: string; label: string };
  tryThis?: ReactNode;
  checkpointPrediction?: PredictionPrompt;
}

export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  difficulty: LessonDifficulty;
  category: LessonCategory;
  summary: string;
  steps: LessonStep[];
}

function at(events: readonly StepEvent[], find: (e: StepEvent) => boolean): number {
  const i = events.findIndex(find);
  if (i === -1) throw new Error('learn: no matching event — a lesson is out of sync with the engine');
  return i + 1;
}

const END = (events: readonly StepEvent[]) => events.length;

/** `/playground?…` for an `OpenSpec`, with the step computed from a real run. */
export function stepLink(spec: OpenSpec): { href: string; label: string } {
  const policy = spec.policy ?? 'lru';
  const result = runQuery(spec.sql, SEED, { ...DEFAULT_ENGINE_OPTIONS, policy });
  const step = spec.find(result.events);
  const query = encodeShareState(
    { sql: spec.sql, policy, predictOn: spec.predictOn ?? false, step },
    undefined,
  );
  return { href: `/playground?${query}`, label: spec.label ?? 'Open this in the Playground' };
}

export const LESSONS: Lesson[] = [
  {
    id: 'first-query',
    title: 'Run your first query',
    minutes: 2,
    difficulty: 'Beginner',
    category: 'Foundations',
    summary: 'The whole path, end to end, in one query — parse, plan, execute, result.',
    steps: [
      {
        heading: 'Open the Playground',
        body: (
          <>
            The editor is on the left, the trace on the right. It opens on a real query already —{' '}
            <code className="font-mono">SELECT * FROM users WHERE id = 5</code> — so there is
            something to look at before you touch anything.
          </>
        ),
        open: { sql: POINT_LOOKUP, find: () => 1, label: 'Open the Playground here' },
      },
      {
        heading: 'Step through it',
        body: (
          <>
            Press <kbd className="rounded border border-edge px-1">Space</kbd> to play, or{' '}
            <kbd className="rounded border border-edge px-1">→</kbd> to move one event at a time. The
            row of chips across the top is the pipeline; each lights as its stage runs.
          </>
        ),
        open: { sql: POINT_LOOKUP, find: (e) => at(e, (x) => x.stage === 'index'), label: 'Jump to the index descent' },
      },
      {
        heading: 'Read the result',
        body: 'The last step hands back the rows. One row, because `id` is unique — but the buffer pool and the B+Tree still did real work to find it.',
        open: { sql: POINT_LOOKUP, find: END, label: 'Jump to the result' },
        checkpointPrediction: {
          question: 'If WHERE id = 999 is queried, does the engine still search the index?',
          options: [
            { id: 'yes', label: 'Yes: descends B+Tree to confirm key absence' },
            { id: 'no', label: 'No: skips traversal' },
          ],
          correctOptionId: 'yes',
          explanation: 'The B+Tree index must be traversed from root to leaf to verify whether the key exists.',
        },
        tryThis: (
          <>
            Change <code className="font-mono">id = 5</code> to <code className="font-mono">id = 999</code>{' '}
            and run it again. How many rows come back — and did the engine still read pages to find
            that out?
          </>
        ),
      },
    ],
  },
  {
    id: 'one-row',
    title: 'Follow one row from disk to result',
    minutes: 5,
    difficulty: 'Beginner',
    category: 'Foundations',
    summary: 'The spine of the whole tool: one row, crossing every stage once.',
    steps: [
      {
        heading: 'Parse: text becomes a tree',
        body: 'The SQL string is tokenised and parsed into an abstract syntax tree. Nothing has been executed yet — this is only structure.',
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'plan'),
          label: 'Jump to the end of parsing',
        },
      },
      {
        heading: 'Plan and optimise: the scan becomes a lookup',
        body: (
          <>
            The planner builds a logical plan, then the optimiser rewrites it: because{' '}
            <code className="font-mono">id</code> is indexed and the predicate is an equality on it,
            the sequential scan becomes a B+Tree lookup. Watch the before/after trees.
          </>
        ),
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'optimize'),
          label: 'Jump to the optimiser rewrite',
        },
        checkpointPrediction: {
          question: 'Why does the optimizer turn SELECT * FROM users WHERE id = 5 into an IndexScan?',
          options: [
            { id: 'rule', label: 'id has a B+Tree index and the predicate is an equality on it' },
            { id: 'rows', label: 'The table has fewer than 100 rows' },
          ],
          correctOptionId: 'rule',
          explanation: 'The index-selection rule looks for equality predicates matching an indexed column, replacing a sequential table scan with a logarithmic tree descent.',
        },
      },
      {
        heading: 'Descend the B+Tree',
        body: 'From the root to a leaf, one node read per level. The leaf holds a pointer to the row — a heap page and a slot — not the row itself.',
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'index' && x.action === 'found'),
          label: 'Jump to the moment the key is found',
        },
      },
      {
        heading: 'Buffer pool and result',
        body: 'That heap page is fetched through the buffer pool — a disk read if it is not already resident — and the row is read from its slot and handed back.',
        open: { sql: POINT_LOOKUP, find: END, label: 'Jump to the result' },
        tryThis: (
          <>
            Run <code className="font-mono">WHERE name = &apos;grace&apos;</code> instead.{' '}
            <code className="font-mono">name</code> is not indexed — so which stage looks different,
            and how much more work does it do?
          </>
        ),
      },
    ],
  },
  {
    id: 'eviction',
    title: 'Watch a page get evicted',
    minutes: 4,
    difficulty: 'Intermediate',
    category: 'Storage',
    summary: 'Fill the pool, then see LRU and clock sweep pick different victims.',
    steps: [
      {
        heading: 'Fill every frame',
        body: (
          <>
            A sequential scan reads every page of the table. There are more pages than frames, so
            once the pool is full the next read has to evict something. The run stops and asks you
            which frame dies.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          predictOn: true,
          find: (e) => at(e, (x) => x.stage === 'buffer' && x.action === 'evict'),
          label: 'Jump to the first eviction (LRU)',
        },
        checkpointPrediction: {
          question: 'Why does a 12-page table scan with 8 frames force evictions?',
          options: [
            { id: 'overflow', label: 'Working set pages exceed available buffer frames' },
            { id: 'timeout', label: 'Frames expire by elapsed timer' },
          ],
          correctOptionId: 'overflow',
          explanation: 'When active working set exceeds frame capacity, the engine must evict victim pages.',
        },
      },
      {
        heading: 'The same scan, a different policy',
        body: (
          <>
            Clock sweep is what PostgreSQL actually does. Identical access pattern — but it protects
            recently-used pages differently, so on a skewed pattern it picks a different victim. On
            this uniform scan it happens to agree; the contrast shows up when some pages are hotter.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          policy: 'clock',
          find: (e) => at(e, (x) => x.stage === 'buffer' && x.action === 'evict'),
          label: 'Jump to the first eviction (clock sweep)',
        },
        tryThis: (
          <>
            Note the victim page number here, then go back to the LRU step and compare. Then open{' '}
            the <strong>Compare</strong> tool, which steps both policies together on a pattern built
            to make them disagree.
          </>
        ),
      },
    ],
  },
  {
    id: 'btree-split',
    title: 'Watch a B+Tree split',
    minutes: 4,
    difficulty: 'Intermediate',
    category: 'Storage',
    summary: 'Fill a leaf, add one key, and watch the tree grow a level — a copy-up, then a push-up.',
    steps: [
      {
        heading: 'Start with a full leaf',
        body: (
          <>
            Open the B+Tree sandbox with four keys and a fan-out of four, so this one leaf is exactly
            full. There is no SQL here — you insert and delete keys directly and the tree rebalances
            as you go.
          </>
        ),
        link: { href: '/tools/btree?keys=1,2,3,4&fanout=4', label: 'Open the B+Tree sandbox' },
      },
      {
        heading: 'Add one key',
        body: (
          <>
            Type <code className="font-mono">5</code> and press Insert. The leaf overflows and
            splits: <code className="font-mono">1, 2, 3</code> stay, <code className="font-mono">4</code>{' '}
            and <code className="font-mono">5</code> move to a new leaf, and <code className="font-mono">4</code>{' '}
            is <em>copied</em> up to become the root&apos;s separator. A leaf split copies its
            separator up — the key still lives in a leaf, because a leaf is the only place a row
            pointer can hang.
          </>
        ),
        checkpointPrediction: {
          question: 'When a full B+Tree leaf overflows and splits, where does the separator key go?',
          options: [
            { id: 'copied', label: 'Copied up into the parent while remaining in the leaf' },
            { id: 'moved', label: 'Moved completely out of the leaf' },
          ],
          correctOptionId: 'copied',
          explanation: 'In B+Trees, all record pointers remain in leaves, so split keys are copied up.',
        },
      },
      {
        heading: 'Go deeper: an internal split',
        body: (
          <>
            Open a taller tree and keep inserting — <code className="font-mono">16</code>,{' '}
            <code className="font-mono">17</code>, <code className="font-mono">18</code>… — until the
            root node itself overflows. This time the middle key is <em>pushed</em> up, not copied: a
            separator is not a row, so it moves out entirely, and the tree gains a level.
          </>
        ),
        link: {
          href: '/tools/btree?keys=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15&fanout=4',
          label: 'Open a two-level tree',
        },
        tryThis: (
          <>
            The badge under the tree re-checks every B+Tree invariant after each edit (plan.md §7.6).
            Now delete keys until a node drops below half full, and watch it borrow from a sibling or
            merge — a split run backwards.
          </>
        ),
      },
    ],
  },
  {
    id: 'planner',
    title: 'Make the planner change its mind',
    minutes: 3,
    difficulty: 'Intermediate',
    category: 'Optimizer',
    summary: 'One predicate becomes an index lookup; another cannot. See why.',
    steps: [
      {
        heading: 'An equality on the indexed column',
        body: (
          <>
            <code className="font-mono">id = 5</code> is an equality on the indexed column, so the
            optimiser swaps the scan for an <code className="font-mono">IndexScan</code>. The
            before/after trees are on screen together.
          </>
        ),
        open: {
          sql: POINT_LOOKUP,
          find: (e) => at(e, (x) => x.stage === 'optimize'),
          label: 'Jump to the index-selection rewrite',
        },
      },
      {
        heading: 'A range on a column with no index',
        body: (
          <>
            <code className="font-mono">age &gt; 30</code> cannot use an index the table does not
            have, so the only rewrite is predicate pushdown — the filter folds into the scan, which
            still reads every page.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          find: (e) => at(e, (x) => x.stage === 'optimize'),
          label: 'Jump to the pushdown rewrite',
        },
        checkpointPrediction: {
          question: 'Will WHERE age > 30 trigger index selection on users?',
          options: [
            { id: 'no', label: 'No: age column is not indexed' },
            { id: 'yes', label: 'Yes: index is generated automatically' },
          ],
          correctOptionId: 'no',
          explanation: 'Index selection requires an existing index on the predicate column.',
        },
        tryThis: (
          <>
            Try <code className="font-mono">WHERE id &gt; 5</code> — a range on the{' '}
            <em>indexed</em> column. Does it become an <code className="font-mono">IndexScan</code>?
            (It does not: the rule needs an equality.)
          </>
        ),
      },
    ],
  },
  {
    id: 'edit-data',
    title: 'Edit the seed data',
    minutes: 3,
    difficulty: 'Beginner',
    category: 'Foundations',
    summary: 'Change the rows and watch which parts of the trace change — and which do not.',
    steps: [
      {
        heading: 'Open the data editor',
        body: (
          <>
            Under the query, <strong>Edit data</strong> opens the 48 seed rows as a grid. Add a row,
            change an <code className="font-mono">age</code>, delete one — then apply and re-run.
          </>
        ),
        open: { sql: SEQ_SCAN, find: () => 1, label: 'Open the Playground' },
      },
      {
        heading: 'What changes',
        body: (
          <>
            More rows means more pages, so the sequential scan does more disk reads and evicts more
            often — the buffer pool panel and the result count both move. The row you added shows up
            in the result if it matches <code className="font-mono">age &gt; 30</code>.
          </>
        ),
      },
      {
        heading: 'What does not',
        body: (
          <>
            The parser and the planner never look at a single row — the AST and the plan tree are
            identical no matter what the data says. Editing data changes <em>execution</em>, not the
            shape of the query.
          </>
        ),
        tryThis: (
          <>
            Delete every row with <code className="font-mono">age &gt; 30</code>, then run it. The
            plan is unchanged, the scan still reads every remaining page, and the result is empty —
            work done to prove there is nothing to return. Your edits ride in the link, so you can
            share that exact table.
          </>
        ),
      },
    ],
  },
  {
    id: 'predict',
    title: 'Predict before you look',
    minutes: 3,
    difficulty: 'Intermediate',
    category: 'Workflows',
    summary: 'Commit to an answer before each reveal — the one habit the evidence backs.',
    steps: [
      {
        heading: 'A question, before the step',
        body: (
          <>
            With <strong>Ask me to predict</strong> on, the playhead stops just before a
            consequential step and asks what will happen. Here it is the optimiser: sequential scan,
            or index lookup?
          </>
        ),
        open: {
          sql: POINT_LOOKUP,
          predictOn: true,
          find: (e) => at(e, (x) => x.predictable !== undefined),
          label: 'Open a step that asks you to predict',
        },
        checkpointPrediction: {
          question: 'Why commit to a prediction before the step reveal?',
          options: [
            { id: 'active', label: 'Commitment stimulates deeper mental models' },
            { id: 'speed', label: 'It makes the query execute in fewer cycles' },
          ],
          correctOptionId: 'active',
          explanation: 'Active cognitive commitment before revelation stimulates deeper retention.',
        },
      },
      {
        heading: 'Commit, then reveal',
        body: (
          <>
            Pick an option. The step runs and tells you whether you were right, with a sentence on
            why. A wrong guess you committed to is worth more than a correct animation you watched —
            that is the finding this mode rests on (see RESEARCH.md §1).
          </>
        ),
      },
      {
        heading: 'Turning it off for a room',
        body: (
          <>
            Demonstrating to a class, the prompts get in the way. Uncheck the box, or share a link
            with <code className="font-mono">x=0</code>. An assignment link (<code className="font-mono">l=1</code>)
            does the opposite — it seals the reveal until the learner answers.
          </>
        ),
        tryThis: (
          <>
            Answer this one wrong on purpose and read the explanation. Then visit{' '}
            <code className="font-mono">/assignments/new</code> to build a locked version to set as
            homework.
          </>
        ),
      },
    ],
  },
  {
    id: 'share',
    title: 'Share a moment',
    minutes: 2,
    difficulty: 'Beginner',
    category: 'Workflows',
    summary: 'The URL is the save file: a query, a dataset and a step, reproducible from a link.',
    steps: [
      {
        heading: 'A link to an exact step',
        body: (
          <>
            <strong>Copy link to this step</strong> under the editor captures where you are:{' '}
            <code className="font-mono">q</code> the query, <code className="font-mono">p</code> the
            policy, <code className="font-mono">s</code> the step,{' '}
            <code className="font-mono">d</code> the rows if you edited them. Omit one and it falls
            back to the default.
          </>
        ),
        open: {
          sql: SEQ_SCAN,
          find: (e) => at(e, (x) => x.stage === 'buffer' && x.action === 'evict'),
          label: 'Open the Playground at the first eviction',
        },
      },
      {
        heading: 'A stranger wrote this link',
        body: (
          <>
            The URL is the one input the app takes from someone else, so it is parsed defensively: a
            dataset that does not match the schema is dropped whole rather than half-restored, because
            a half-restored table would render a trace that is simply a lie. The full parameter table
            is in the docs, under{' '}
            <code className="font-mono">/docs/reference/url-parameters</code>.
          </>
        ),
        tryThis: (
          <>
            Copy the link, change <code className="font-mono">&amp;s=</code> to a smaller number by
            hand, and open it. For a dataset too large for a URL, <strong>Download trace</strong>{' '}
            saves the same moment as a file that <strong>Load trace</strong> restores.
          </>
        ),
      },
    ],
  },
  {
    id: 'errors',
    title: 'When something goes wrong',
    minutes: 2,
    difficulty: 'Advanced',
    category: 'Workflows',
    summary: 'A panel that breaks does not lose your trace — and the report writes itself.',
    steps: [
      {
        heading: 'The trace survives a broken panel',
        body: (
          <>
            If one stage view hits a bug, only that panel is replaced — with a red box, not a blank
            screen. The narration, the playback controls and the SQL you typed are all still there;
            step away from that stage and the rest keeps working.
          </>
        ),
        open: { sql: POINT_LOOKUP, find: () => 1, label: 'Open the Playground' },
      },
      {
        heading: 'The report is already written',
        body: (
          <>
            The box carries <strong>Copy report</strong> and <strong>Open an issue</strong>. Both
            include a <code className="font-mono">Reproduce</code> block — the SQL, policy, step and
            any edited rows. The engine is deterministic, so those four values reproduce the crash on
            the first try. That block <em>is</em> the bug report.
          </>
        ),
        tryThis: (
          <>
            A query that will not parse is not a crash — it shows an error beside the editor and the
            trace simply does not build. The red box is for an unexpected failure while rendering a
            panel; if you ever see one, paste the repro into an issue.
          </>
        ),
      },
    ],
  },
];

export function lessonById(id: string | undefined): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}
