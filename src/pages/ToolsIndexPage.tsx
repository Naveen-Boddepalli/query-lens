import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive, pill } from '../ui/primitives.ts';

type ToolCategory = 'all' | 'storage' | 'indexing' | 'query' | 'transactions';

interface ToolItem {
  id: string;
  title: string;
  href: string;
  category: Exclude<ToolCategory, 'all'>;
  topic: string;
  difficulty: 'Foundation' | 'Intermediate' | 'Advanced';
  metric: string;
  description: string;
}

const TOOLS: ToolItem[] = [
  {
    id: 'buffer-pool',
    title: 'Buffer pool sandbox',
    href: '/tools/buffer-pool',
    category: 'storage',
    topic: 'Storage',
    difficulty: 'Foundation',
    metric: '5 eviction policies',
    description:
      'Type a page-reference string and watch a replacement policy decide what gets evicted. Five policies: LRU, clock sweep, FIFO, second-chance, and the optimal bound.',
  },
  {
    id: 'page',
    title: 'Slotted page inspector',
    href: '/tools/page',
    category: 'storage',
    topic: 'Storage',
    difficulty: 'Intermediate',
    metric: 'Byte-level memory layout',
    description:
      'One heap page laid out to the byte: header, slot array, tuple data, and free space between. Dynamic page size slider reveals real-world disk storage capacity.',
  },
  {
    id: 'columnar',
    title: 'Row vs. column storage',
    href: '/tools/columnar',
    category: 'storage',
    topic: 'Storage',
    difficulty: 'Intermediate',
    metric: 'NSM, DSM & PAX layout',
    description:
      'NSM (row store), DSM (column store) and PAX (the hybrid) laying out the same table three ways, with real compressed-size counters for dictionary, RLE, delta and bit-packing.',
  },
  {
    id: 'wal',
    title: 'Write-ahead log',
    href: '/tools/wal',
    category: 'storage',
    topic: 'Storage',
    difficulty: 'Advanced',
    metric: 'Log buffer, disk & flush rule',
    description:
      'A buffer pool, a disk and a log, and the one rule that ties them: a page may not reach disk before the log records that describe it are durable.',
  },
  {
    id: 'recovery',
    title: 'Crash recovery (ARIES)',
    href: '/tools/recovery',
    category: 'storage',
    topic: 'Storage',
    difficulty: 'Advanced',
    metric: 'Analysis, Redo & Undo phases',
    description:
      'Press Crash and the pool and active transactions disappear while disk and log stay. Watch ARIES restart: analysis rebuilds dirty pages, redo repeats history, undo rolls back losers.',
  },
  {
    id: 'btree',
    title: 'B+Tree visualizer',
    href: '/tools/btree',
    category: 'indexing',
    topic: 'Indexing',
    difficulty: 'Intermediate',
    metric: 'Splits, borrows & merges',
    description:
      'Insert, delete, and search keys against a live B+Tree. Observe node splits on insert, sibling borrows and merges on delete, with fan-out control and invariant checks.',
  },
  {
    id: 'hash-index',
    title: 'Hash index sandbox',
    href: '/tools/hash-index',
    category: 'indexing',
    topic: 'Indexing',
    difficulty: 'Intermediate',
    metric: 'Extendible vs linear hashing',
    description:
      'Extendible hashing (a directory that doubles, buckets with local depth) and linear hashing (round-robin split pointer). See why neither can answer range queries.',
  },
  {
    id: 'vector-index',
    title: 'Vector index (HNSW / IVF)',
    href: '/tools/vector-index',
    category: 'indexing',
    topic: 'Indexing',
    difficulty: 'Advanced',
    metric: 'Recall & distance metrics',
    description:
      'Brute force, IVF and HNSW answering the same nearest-neighbour question, scored by distances computed and recall. Interactive 2-D scatter geometry.',
  },
  {
    id: 'latch-crabbing',
    title: 'Latch crabbing',
    href: '/tools/latch-crabbing',
    category: 'indexing',
    topic: 'Indexing',
    difficulty: 'Advanced',
    metric: 'Conservative vs optimistic coupling',
    description:
      'How concurrent threads safely descend one B+Tree while inserting. Compare naive latching, lock coupling, and optimistic coupling side-by-side.',
  },
  {
    id: 'lsm',
    title: 'LSM tree sandbox',
    href: '/tools/lsm',
    category: 'indexing',
    topic: 'Indexing',
    difficulty: 'Advanced',
    metric: 'Memtable, SSTables & compaction',
    description:
      'Log-structured merge trees: writes buffer in a memtable, flush to disk as SSTables, then compact down. Measure write, space, and read amplification.',
  },
  {
    id: 'parser',
    title: 'Recursive-descent parser',
    href: '/tools/parser',
    category: 'query',
    topic: 'Execution',
    difficulty: 'Foundation',
    metric: 'Token ribbon & AST',
    description:
      'Type SQL to see the tokenizer produce a live token ribbon and the recursive-descent parser build an AST, with recursion depth and precise error diagnostics.',
  },
  {
    id: 'grammar',
    title: 'SQL grammar explorer',
    href: '/tools/grammar',
    category: 'query',
    topic: 'Execution',
    difficulty: 'Intermediate',
    metric: 'Complete SQL syntax graph',
    description:
      'Every rule the engine parser accepts, diagrammed directly from internal grammar definitions: keyword tokens, clickable child rules, and syntax loops.',
  },
  {
    id: 'planner',
    title: 'Planner & optimizer',
    href: '/tools/planner',
    category: 'query',
    topic: 'Execution',
    difficulty: 'Advanced',
    metric: 'Rewrite rules & cost model',
    description:
      'Type a query and inspect its operator plan tree side-by-side: canonical next to optimized. Toggle rewrite rules and index paths to observe transformations.',
  },
  {
    id: 'join-order',
    title: 'Join order (Selinger DP)',
    href: '/tools/join-order',
    category: 'query',
    topic: 'Execution',
    difficulty: 'Advanced',
    metric: 'Subset lattice dynamic programming',
    description:
      'Selinger dynamic-programming join-order search over the subset lattice: cheapest way to join every subset, built smallest first with all candidate costs.',
  },
  {
    id: 'sort',
    title: 'External merge sort',
    href: '/tools/sort',
    category: 'query',
    topic: 'Execution',
    difficulty: 'Intermediate',
    metric: 'k-way merge passes & I/O',
    description:
      'Sort records exceeding memory limits: run generation followed by k-way merge passes until sorted. Adjust buffer budget to see pass counts move.',
  },
  {
    id: 'hash-join',
    title: 'Grace hash join',
    href: '/tools/hash-join',
    category: 'query',
    topic: 'Execution',
    difficulty: 'Advanced',
    metric: 'Hash partitions & probe phase',
    description:
      'Partition build and probe relations by hashing join keys, spill partitions exceeding memory, and build in-memory hash tables to complete joins.',
  },
  {
    id: 'locks',
    title: 'Locks sandbox',
    href: '/tools/locks',
    category: 'transactions',
    topic: 'Transactions',
    difficulty: 'Intermediate',
    metric: '2PL & Wait-For graph deadlock',
    description:
      'Two transactions placing real lock requests against each other. Conflicting requests block, and cycles trigger wait-for graph deadlock resolution.',
  },
  {
    id: 'schedule',
    title: 'Transaction schedules',
    href: '/tools/schedule',
    category: 'transactions',
    topic: 'Transactions',
    difficulty: 'Intermediate',
    metric: 'Dirty reads & writes',
    description:
      'Two sessions, one database, and an interleaving you choose: BEGIN, COMMIT, and ROLLBACK across shared tables demonstrating concurrency anomalies.',
  },
  {
    id: 'isolation',
    title: 'Isolation matrix',
    href: '/tools/isolation',
    category: 'transactions',
    topic: 'Transactions',
    difficulty: 'Advanced',
    metric: 'Hermitage anomaly suite',
    description:
      'Ten anomalies from the Hermitage suite across four ANSI isolation levels on three engines: 2PL locks, snapshot isolation, and MySQL InnoDB hybrid.',
  },
  {
    id: 'concurrency',
    title: 'Concurrency control compare',
    href: '/tools/concurrency',
    category: 'transactions',
    topic: 'Transactions',
    difficulty: 'Advanced',
    metric: '5 protocols evaluated',
    description:
      'One schedule under five protocols — 2PL, Timestamp Ordering, OCC, Snapshot Isolation, and Serializable Snapshots — comparing throughput and aborts.',
  },
];

const CATEGORIES: { id: ToolCategory; label: string }[] = [
  { id: 'all', label: 'All Tools' },
  { id: 'storage', label: 'Storage' },
  { id: 'indexing', label: 'Indexing' },
  { id: 'query', label: 'Query & Execution' },
  { id: 'transactions', label: 'Transactions' },
];

function DifficultyBadge({ level }: { level: ToolItem['difficulty'] }) {
  const styles = {
    Foundation: 'border-edge bg-surface-3/80 text-ink-dim',
    Intermediate: 'border-accent/40 bg-accent/10 text-accent',
    Advanced: 'border-hue-violet-ink/30 bg-hue-violet-soft text-ink',
  }[level];

  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[0.68rem] uppercase tracking-wider ${styles}`}
    >
      {level}
    </span>
  );
}

export function ToolsIndexPage() {
  const [activeCategory, setActiveCategory] = useState<ToolCategory>('all');

  const filteredTools =
    activeCategory === 'all'
      ? TOOLS
      : TOOLS.filter((tool) => tool.category === activeCategory);

  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Directory', to: '/tools' }, { label: 'Standalone Tools' }]}
        title="Tools"
      >
        Isolated database engine components split out of the pipeline for targeted study and
        demonstrations. Each sandbox runs independently without requiring full SQL execution.
      </PageHeader>

      {/* Category filter tabs */}
      <div className="mt-6 flex flex-wrap items-center gap-1.5 rounded-xl border border-edge bg-surface/80 p-1 shadow-neu-track backdrop-blur-sm">
        {CATEGORIES.map((cat) => {
          const isActive = activeCategory === cat.id;
          const count = cat.id === 'all' ? TOOLS.length : TOOLS.filter((t) => t.category === cat.id).length;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => { setActiveCategory(cat.id); }}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-label font-medium transition duration-150 ease-out select-none cursor-pointer ${
                isActive
                  ? 'border border-accent bg-accent-soft text-ink shadow-neu-rest backdrop-blur-sm'
                  : 'text-ink-dim hover:bg-surface-3 hover:text-ink'
              }`}
            >
              <span>{cat.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.2 font-mono text-[0.68rem] tabular-nums ${
                  isActive ? 'bg-accent/20 text-ink' : 'bg-surface-3 text-ink-dim'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Grid of sandboxes */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredTools.map((tool) => (
          <Link
            key={tool.id}
            to={tool.href}
            className={`${cardInteractive} flex flex-col justify-between`}
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className={pill}>
                  <span className="font-mono text-[0.7rem] uppercase tracking-wider">{tool.topic}</span>
                </span>
                <DifficultyBadge level={tool.difficulty} />
              </div>

              <h3 className="mt-3 text-body font-semibold text-ink group-hover:text-accent transition-colors duration-150">
                {tool.title}
              </h3>

              <p className="mt-1.5 text-label text-ink-dim leading-relaxed line-clamp-3">
                {tool.description}
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-edge/60 flex items-center justify-between text-label">
              <span className="font-mono text-ink-dim/90 text-[0.75rem]">
                {tool.metric}
              </span>
              <span
                aria-hidden="true"
                className="text-ink-dim transition-transform duration-150 group-hover:translate-x-1 group-hover:text-accent font-mono"
              >
                &rarr;
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
