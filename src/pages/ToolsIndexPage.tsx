import { Link } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive } from '../ui/primitives.ts';

/**
 * plan.md §20.4 / §21.3. Standalone modules split out of the pipeline for
 * courses that only need one stage — a DSA class wants the B+Tree, an OS
 * class wants the buffer pool, neither wants a SQL parser in the way.
 */
const TOOLS = [
  {
    title: 'Buffer pool sandbox',
    href: '/tools/buffer-pool',
    description:
      'Type a page-reference string and watch a replacement policy decide what gets evicted. Five policies — LRU, clock sweep, FIFO, second-chance and the optimal bound. No SQL: the OS-course version of the pipeline\'s buffer pool.',
    available: true,
  },
  {
    title: 'Parser sandbox',
    href: '/tools/parser',
    description:
      'Type arbitrary SQL — supported or not — and watch the tokenizer build the token stream and the recursive-descent parser build the AST, with recursion depth and the parser\'s own error messages.',
    available: true,
  },
  {
    title: 'B+Tree sandbox',
    href: '/tools/btree',
    description:
      'insert, delete and find against a live B+Tree — watch it split on insert, and borrow from a sibling or merge on delete, with a fan-out slider and the structural invariants checked after every edit.',
    available: true,
  },
  {
    title: 'Slotted page inspector',
    href: '/tools/page',
    description:
      'One heap page laid out to the byte — header, slot array, tuple data and the free space between. A size slider shows how much a real 4 KB page would actually hold, next to the handful of rows the engine keeps per page for legibility.',
    available: true,
  },
  {
    title: 'External merge sort',
    href: '/tools/sort',
    description:
      'Sort more records than fit in memory: run generation, then k-way merge passes until one sorted run remains, with the page-I/O cost broken out. Change the buffer budget and watch the pass count and the I/O move — the classic "why sorting is expensive" lesson.',
    available: true,
  },
  {
    title: 'Planner sandbox',
    href: '/tools/planner',
    description:
      'Type a query and see its plan tree, canonical next to optimized. Toggle each rewrite rule — predicate pushdown, index selection — and the id index on or off, and watch the plan change. The optimize stage from the pipeline, with the rules on switches.',
    available: true,
  },
  {
    title: 'Locks sandbox',
    href: '/tools/locks',
    description:
      'Two transactions placing real lock requests against each other — unlike the Playground, which runs one query at a time and never contends with itself. A conflicting request genuinely blocks; block each other in a cycle and watch the wait-for graph resolve, aborting the transaction that arrived more recently.',
    available: true,
  },
  {
    title: 'Transaction schedules',
    href: '/tools/schedule',
    description:
      'Two sessions, one database, and an interleaving you choose: BEGIN, COMMIT and ROLLBACK across a shared table. With no concurrency control yet, one session reads what the other has not committed (a dirty read) or overwrites it (a dirty write), and the page names it. The first piece of the transactions subject; locks, isolation levels and MVCC build on the same schedule.',
    available: true,
  },
  {
    title: 'Isolation matrix',
    href: '/tools/isolation',
    description:
      'Ten anomalies from the Hermitage suite — dirty writes, aborted and intermediate reads, lost update, read skew, write skew and more — at four isolation levels, on three engines: locks, snapshots, and InnoDB’s mixture of the two. Every cell is a schedule that was run and judged by what its transactions saw, held against the results PostgreSQL, SQL Server and MySQL publish, and opens the run behind it.',
    available: true,
  },
  {
    title: 'Concurrency-control compare',
    href: '/tools/concurrency',
    description:
      'One schedule under five protocols — two-phase locking, timestamp ordering, optimistic validation, snapshots, and serializable snapshots — each really running it. The table is the bill: who waited, who was aborted and how much work went with them, what was let through, and whether what survived is what running the committed transactions one at a time would have left.',
    available: true,
  },
  {
    title: 'Write-ahead log',
    href: '/tools/wal',
    description:
      'A buffer pool, a disk and a log, and the one rule that ties them: a page may not reach disk before the log records that describe it are durable. Write a script of changes, commits and rollbacks and watch what is appended, what is forced and what is written — then switch the rule off and see the page that got to disk ahead of its log.',
    available: true,
  },
  {
    title: 'Crash recovery',
    href: '/tools/recovery',
    description:
      'Press Crash and the pool, the log buffer and every transaction are gone; the disk and the durable log stay. Then watch ARIES restart from the last checkpoint: analysis rebuilds the dirty page table and the transaction table, redo repeats history and skips what a page already has, undo rolls the losers back with compensation records — and a crash during recovery never undoes a change twice.',
    available: true,
  },
  {
    title: 'Grammar sandbox',
    href: '/tools/grammar',
    description:
      'Every rule the parser accepts, diagrammed straight from the same data its own test checks against the real tokenizer and parser — a keyword pill, a clickable box for a rule it calls, a dashed bracket for anything optional, a loop glyph for anything repeated.',
    available: true,
  },
  {
    title: 'Hash join',
    href: '/tools/hash-join',
    description:
      'Grace hash join: partition a build side and a probe side by hashing the join key, split further whatever still doesn\'t fit in memory, then build an in-memory hash table over each partition and probe it — hash collisions and partition spill both on display.',
    available: true,
  },
  {
    title: 'Join order',
    href: '/tools/join-order',
    description:
      'Selinger\'s dynamic-programming join-order search over the subset lattice: the cheapest way to join every subset of a query\'s tables, built up smallest first, with every candidate the DP considered for each one — not just the winner. A written query still runs in the order it names; this only ever shows what a cost-based search would have picked instead.',
    available: true,
  },
  {
    title: 'Histograms',
    href: '/tools/histograms',
    description:
      'ANALYZE with the bucket count you choose: the equi-depth histogram it builds over a column, a range estimate read off it, and the q-error at every bucket count from 1 to 100 — on the transactions preset\'s amounts, and on a skewed and a clustered column where the count matters.',
    available: true,
  },
  {
    title: 'Parallel execution',
    href: '/tools/parallel',
    description:
      'Morsel-driven parallelism: a scan and an aggregate cut into morsels of pages and run by up to eight workers, each aggregating into a partial result that one of them merges. Static ranges, a shared queue, or work stealing — with worker speeds you script, the timeline drawn, and the speedup measured in ticks.',
    available: true,
  },
  {
    title: 'LSM tree',
    href: '/tools/lsm',
    description:
      'Log-structured merge trees: writes buffer in a memtable, flush to disk as an immutable, sorted SSTable, then compact into fewer, larger files at the next level down. Change the memtable size or a level\'s capacity and watch the cascade — and the write, space and read amplification it costs.',
    available: true,
  },
  {
    title: 'Hash index',
    href: '/tools/hash-index',
    description:
      'Extendible hashing (a directory that doubles, buckets with their own local depth) and linear hashing (no directory, a round-robin split pointer growing the bucket array one at a time). Switch schemes on the same writes to compare them, and see exactly why neither can answer a range query.',
    available: true,
  },
  {
    title: 'Row vs. column storage',
    href: '/tools/columnar',
    description:
      'NSM (row store), DSM (column store) and PAX (the hybrid) laying out the same table three ways, with real compressed-size counters for dictionary, RLE, delta and bit-packing — and the late-materialization trick a column store only actually pays off with.',
    available: true,
  },
  {
    title: 'Latch crabbing',
    href: '/tools/latch-crabbing',
    description:
      'How concurrent threads can safely descend one B+Tree while inserting. Naive latching holds every page on the path and funnels every thread through the root; lock coupling releases each ancestor as soon as the child below it is safe; optimistic coupling latches nothing on the way down and starts again when another thread got there first. Same scripted workload, all three protocols, side by side.',
    available: true,
  },
  {
    title: 'Vector index',
    href: '/tools/vector-index',
    description:
      'Brute force, IVF and HNSW answering the same nearest-neighbour question, scored by distances computed and recall. HNSW is a layered proximity graph you can see; IVF is a set of clusters. A 2-D scatter makes the geometry visible.',
    available: true,
  },
] as const;

export function ToolsIndexPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <PageHeader title="Tools">
        Individual pipeline stages, split out for courses that only need one of them.
      </PageHeader>

      <div className="mt-8 space-y-3">
        {TOOLS.map((tool) =>
          tool.available && tool.href ? (
            <Link key={tool.title} to={tool.href} className={cardInteractive}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-body font-semibold text-ink">{tool.title}</h3>
                <span
                  aria-hidden
                  className="text-ink-dim transition group-hover:translate-x-0.5 group-hover:text-accent"
                >
                  →
                </span>
              </div>
              <p className="mt-1 text-label text-ink-dim">{tool.description}</p>
            </Link>
          ) : (
            <div
              key={tool.title}
              /* No `opacity-70` here: it dropped the description and the pill
                 below the 4.5:1 contrast floor (the axe gate). The dashed
                 border and the "coming later" pill already say "not a link". */
              className="rounded-xl border border-dashed border-edge/60 p-4"
            >
              <h3 className="flex items-center gap-2 text-body font-semibold text-ink">
                {tool.title}
                <span className="rounded-full border border-edge px-2 py-0.5 text-label text-ink-dim">
                  coming later
                </span>
              </h3>
              <p className="mt-1 text-label text-ink-dim">{tool.description}</p>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
