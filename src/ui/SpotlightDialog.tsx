import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { MOD_KEY } from './platform.ts';
import { useThemeContext } from './ThemeContext.tsx';

export interface SpotlightDialogProps {
  onClose: () => void;
}

export type SpotlightCategory = 'tools' | 'stages' | 'docs' | 'navigation' | 'actions';
export type FilterType = 'all' | 'tools' | 'stages' | 'docs';

export interface SpotlightItem {
  id: string;
  title: string;
  category: SpotlightCategory;
  filterCategory: FilterType;
  subtitle?: string;
  description: string;
  tags?: string[];
  href?: string;
  action?: () => void;
  badge?: string;
}

const STATIC_ITEMS: readonly Omit<SpotlightItem, 'action'>[] = [
  // --- Tools (25) ---
  {
    id: 'tool-buffer-pool',
    title: 'Buffer pool sandbox',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Storage • Foundation',
    badge: '5 eviction policies',
    description: 'Type a page-reference string and watch a replacement policy decide what gets evicted: LRU, Clock, FIFO, Second-Chance, Optimal.',
    tags: ['buffer', 'pool', 'cache', 'eviction', 'lru', 'clock', 'fifo', 'memory', 'frame'],
    href: '/tools/buffer-pool',
  },
  {
    id: 'tool-page',
    title: 'Slotted page inspector',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Storage • Intermediate',
    badge: 'Byte-level memory layout',
    description: 'One heap page laid out to the byte: header, slot array, tuple data, and free space between.',
    tags: ['page', 'slotted', 'heap', 'slot', 'tuple', 'storage', 'byte', 'disk'],
    href: '/tools/page',
  },
  {
    id: 'tool-columnar',
    title: 'Row vs. column storage',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Storage • Intermediate',
    badge: 'NSM, DSM & PAX layout',
    description: 'NSM (row store), DSM (column store) and PAX hybrid laying out the same table three ways, with compression counters.',
    tags: ['columnar', 'row', 'nsm', 'dsm', 'pax', 'olap', 'oltp', 'compression'],
    href: '/tools/columnar',
  },
  {
    id: 'tool-wal',
    title: 'Write-ahead log',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Storage • Advanced',
    badge: 'Log buffer, disk & flush rule',
    description: 'A buffer pool, a disk and a log: a page may not reach disk before the log records describing it are durable.',
    tags: ['wal', 'logging', 'lsn', 'flush', 'durability', 'acid', 'transaction'],
    href: '/tools/wal',
  },
  {
    id: 'tool-recovery',
    title: 'Crash recovery (ARIES)',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Storage • Advanced',
    badge: 'Analysis, Redo & Undo phases',
    description: 'Watch ARIES restart: analysis rebuilds dirty pages, redo repeats history, undo rolls back losers.',
    tags: ['recovery', 'aries', 'crash', 'redo', 'undo', 'checkpoint', 'analysis'],
    href: '/tools/recovery',
  },
  {
    id: 'tool-btree',
    title: 'B+Tree visualizer',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Indexing • Intermediate',
    badge: 'Splits, borrows & merges',
    description: 'Insert, delete, and search keys against a live B+Tree. Observe node splits, sibling borrows, merges, and tree traversal.',
    tags: ['btree', 'b-tree', 'index', 'split', 'borrow', 'merge', 'search', 'tree', 'fan-out'],
    href: '/tools/btree',
  },
  {
    id: 'tool-hash-index',
    title: 'Hash index sandbox',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Indexing • Intermediate',
    badge: 'Extendible vs linear hashing',
    description: 'Extendible hashing (a directory that doubles) and linear hashing (round-robin split pointer).',
    tags: ['hash', 'index', 'extendible', 'linear', 'bucket', 'directory'],
    href: '/tools/hash-index',
  },
  {
    id: 'tool-vector-index',
    title: 'Vector index (HNSW / IVF)',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Indexing • Advanced',
    badge: 'Brute force, IVF & HNSW',
    description: 'Compare flat exhaustive scan, inverted file indexing (IVF) and hierarchical navigable small world (HNSW) vector graphs.',
    tags: ['vector', 'hnsw', 'ivf', 'similarity', 'embeddings', 'ai', 'graph', 'nearest-neighbor'],
    href: '/tools/vector-index',
  },
  {
    id: 'tool-sort',
    title: 'External merge sort',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Intermediate',
    badge: 'Runs & multi-way merge',
    description: 'Sort more rows than fit in memory: initial sorted runs on disk and multi-way merge passes.',
    tags: ['sort', 'merge', 'external', 'runs', 'memory', 'spill'],
    href: '/tools/sort',
  },
  {
    id: 'tool-parser',
    title: 'Parser sandbox',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Foundation',
    badge: 'Tokens & AST nodes',
    description: 'Type SQL and watch lexer tokens and the abstract syntax tree form in real time.',
    tags: ['parser', 'lexer', 'tokens', 'ast', 'syntax', 'sql'],
    href: '/tools/parser',
  },
  {
    id: 'tool-planner',
    title: 'Query planner & optimizer',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Intermediate',
    badge: 'Logical plan & rule rewrites',
    description: 'Relational operators and rule-based optimizer rewrites including predicate pushdown and projection pruning.',
    tags: ['planner', 'optimizer', 'rules', 'rewrite', 'pushdown', 'logical', 'cost'],
    href: '/tools/planner',
  },
  {
    id: 'tool-locks',
    title: 'Lock manager',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Transactions • Intermediate',
    badge: '2PL & shared / exclusive locks',
    description: 'Shared to read, exclusive to write: lock requests, conflicts, waiting queues and 2-phase locking.',
    tags: ['locks', '2pl', 'shared', 'exclusive', 'deadlock', 'concurrency'],
    href: '/tools/locks',
  },
  {
    id: 'tool-schedule',
    title: 'Transaction schedules',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Transactions • Intermediate',
    badge: 'Interleaving & conflict serializability',
    description: 'Two sessions, one database: step interleaved transactions and detect conflict serializability anomalies.',
    tags: ['schedule', 'serializability', 'conflict', 'interleaving', 'concurrency'],
    href: '/tools/schedule',
  },
  {
    id: 'tool-isolation',
    title: 'Isolation anomalies',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Transactions • Advanced',
    badge: 'The Hermitage anomaly matrix',
    description: 'Dirty read, non-repeatable read, phantom read and write skew across read uncommitted, read committed, repeatable read and serializable.',
    tags: ['isolation', 'anomalies', 'hermitage', 'dirty-read', 'phantom', 'skew', 'mvcc'],
    href: '/tools/isolation',
  },
  {
    id: 'tool-concurrency',
    title: 'Concurrency protocols',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Transactions • Advanced',
    badge: 'Strict 2PL, OCC, MVCC & SSI',
    description: 'Run the exact same transaction schedule under Strict 2PL, optimistic concurrency control (OCC), MVCC and SSI.',
    tags: ['concurrency', 'protocols', 'strict-2pl', 'occ', 'mvcc', 'ssi'],
    href: '/tools/concurrency',
  },
  {
    id: 'tool-grammar',
    title: 'SQL grammar diagrams',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Foundation',
    badge: 'Interactive railroad syntax',
    description: 'Interactive syntax railroad diagrams for supported SQL: SELECT, WHERE, JOIN, GROUP BY, ORDER BY, LIMIT.',
    tags: ['grammar', 'railroad', 'syntax', 'ebnf', 'sql'],
    href: '/tools/grammar',
  },
  {
    id: 'tool-hash-join',
    title: 'Grace hash join',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Intermediate',
    badge: 'Partition, build & probe',
    description: 'Partition both relations into hashed bucket files on disk, then build and probe each partition in RAM.',
    tags: ['join', 'hash-join', 'grace', 'partition', 'build', 'probe'],
    href: '/tools/hash-join',
  },
  {
    id: 'tool-join-order',
    title: 'Join order search',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Advanced',
    badge: 'Selinger dynamic programming',
    description: 'Selinger join order search over the subset lattice with catalog statistics and cost model evaluation.',
    tags: ['join-order', 'selinger', 'dp', 'dynamic-programming', 'cost', 'lattice'],
    href: '/tools/join-order',
  },
  {
    id: 'tool-lsm',
    title: 'Log-structured merge-tree',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Storage • Advanced',
    badge: 'MemTable & SSTable compaction',
    description: 'In-memory active MemTable, WAL, immutable flush, and multi-level SSTable compaction passes.',
    tags: ['lsm', 'sstable', 'memtable', 'compaction', 'leveldb', 'storage'],
    href: '/tools/lsm',
  },
  {
    id: 'tool-latch-crabbing',
    title: 'Latch crabbing (coupling)',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Indexing • Advanced',
    badge: 'Naive vs. lock coupling vs. optimistic',
    description: 'Concurrent B+Tree index traversal: naive locking vs. lock coupling (crabbing) vs. optimistic coupling.',
    tags: ['latch', 'crabbing', 'coupling', 'concurrency', 'multithreading', 'btree'],
    href: '/tools/latch-crabbing',
  },
  {
    id: 'tool-histograms',
    title: 'Histograms',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Intermediate',
    badge: 'Equi-depth, 1–100 buckets',
    description: 'ANALYZE with the bucket count you choose: the equi-depth histogram, a range estimate read off it, and its q-error.',
    tags: ['histogram', 'analyze', 'statistics', 'selectivity', 'cardinality', 'estimate', 'buckets'],
    href: '/tools/histograms',
  },
  {
    id: 'tool-parallel',
    title: 'Parallel execution',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Query • Advanced',
    badge: 'Morsels, up to 8 workers',
    description: 'Morsel-driven parallelism with static ranges, a shared queue or work stealing; exchange operators and a parallel hash join.',
    tags: ['parallel', 'morsel', 'workers', 'exchange', 'work-stealing', 'speedup', 'amdahl'],
    href: '/tools/parallel',
  },
  {
    id: 'tool-partitioning',
    title: 'Partitioning',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Distributed • Intermediate',
    badge: 'Hash, range, consistent hashing',
    description: 'A table spread over nodes by hash, range or consistent hashing; count the rows that move, and join across partitions.',
    tags: ['partitioning', 'sharding', 'consistent-hashing', 'distributed', 'nodes', 'shuffle', 'broadcast'],
    href: '/tools/partitioning',
  },
  {
    id: 'tool-2pc',
    title: 'Two-phase commit',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Distributed • Advanced',
    badge: 'Presumed abort, scripted failures',
    description: 'A coordinator and participants commit one transaction across machines; crash either side or lose a message.',
    tags: ['2pc', 'two-phase-commit', 'distributed', 'coordinator', 'commit', 'abort', 'in-doubt'],
    href: '/tools/2pc',
  },
  {
    id: 'tool-raft',
    title: 'Raft',
    category: 'tools',
    filterCategory: 'tools',
    subtitle: 'Distributed • Advanced',
    badge: '4 safety properties checked',
    description: 'Leader election and log replication over a scripted schedule of lost messages, partitions and crashes.',
    tags: ['raft', 'consensus', 'leader', 'election', 'replication', 'log', 'distributed'],
    href: '/tools/raft',
  },

  // --- Pipeline Stages (8) ---
  {
    id: 'stage-parse',
    title: 'Parser stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 1',
    description: 'SQL text → tokens → abstract syntax tree. Turns query string into syntax tree representation.',
    tags: ['parse', 'ast', 'lexer', 'pipeline', 'stages'],
    href: '/stages/parse',
  },
  {
    id: 'stage-plan',
    title: 'Planner stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 2',
    description: 'AST → logical plan tree. Walks syntax tree and selects relational algebra operators: scan, filter, project.',
    tags: ['plan', 'logical', 'relational', 'algebra', 'pipeline', 'stages'],
    href: '/stages/plan',
  },
  {
    id: 'stage-optimize',
    title: 'Optimizer stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 3',
    description: 'Rule-based plan rewrites such as predicate pushdown. Compares before and after execution trees.',
    tags: ['optimize', 'pushdown', 'rules', 'rewrite', 'pipeline', 'stages'],
    href: '/stages/optimize',
  },
  {
    id: 'stage-execute',
    title: 'Execution stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 4',
    description: 'Volcano-style operators pulling rows one at a time from storage to output.',
    tags: ['execute', 'volcano', 'iterator', 'pull', 'pipeline', 'stages'],
    href: '/stages/execute',
  },
  {
    id: 'stage-buffer',
    title: 'Buffer pool stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 5',
    description: 'Fixed frames of pages: cache hits, misses, and replacement policies.',
    tags: ['buffer', 'pool', 'frames', 'hit', 'miss', 'pipeline', 'stages'],
    href: '/stages/buffer',
  },
  {
    id: 'stage-index',
    title: 'B+Tree index stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 6',
    description: 'B+Tree key lookup: traversal from root to leaf following branch child pointers.',
    tags: ['index', 'btree', 'search', 'leaf', 'pipeline', 'stages'],
    href: '/stages/index',
  },
  {
    id: 'stage-lock',
    title: 'Lock stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 7',
    description: 'Coarse page-level locks taken before page access: shared to read, exclusive to write.',
    tags: ['lock', 'shared', 'exclusive', '2pl', 'pipeline', 'stages'],
    href: '/stages/lock',
  },
  {
    id: 'stage-result',
    title: 'Result stage',
    category: 'stages',
    filterCategory: 'stages',
    subtitle: 'Pipeline Stage 8',
    description: 'The rows and tuples collected and handed back to the user client.',
    tags: ['result', 'tuples', 'output', 'rows', 'pipeline', 'stages'],
    href: '/stages/result',
  },

  // --- Docs & Concepts (18) ---
  {
    id: 'doc-overview',
    title: 'Docs overview',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Documentation',
    description: 'QueryLens documentation, database architecture overview, and visual guides.',
    tags: ['docs', 'overview', 'guide', 'manual'],
    href: '/docs',
  },
  {
    id: 'doc-getting-started',
    title: 'Getting started',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Documentation',
    description: 'First steps with QueryLens: navigating the database engine visualizer and stepping queries.',
    tags: ['docs', 'start', 'tutorial', 'intro'],
    href: '/docs/getting-started',
  },
  {
    id: 'doc-faq',
    title: 'Frequently asked questions (FAQ)',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Documentation',
    description: 'Answers to common questions about QueryLens engine fidelity, supported SQL, and pedagogy.',
    tags: ['docs', 'faq', 'questions', 'help'],
    href: '/docs/faq',
  },
  {
    id: 'doc-manual-eviction',
    title: 'Watch a page get evicted',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Interactive Manual',
    description: 'Step-by-step walkthrough of buffer pool page replacement under LRU, Clock and FIFO.',
    tags: ['manual', 'eviction', 'buffer-pool', 'lru', 'clock'],
    href: '/docs/manual/eviction',
  },
  {
    id: 'doc-manual-btree-split',
    title: 'Watch a B+Tree split',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Interactive Manual',
    description: 'Step-by-step walkthrough of B+Tree node insertion, overflow, split, and parent propagation.',
    tags: ['manual', 'btree', 'split', 'index'],
    href: '/docs/manual/btree-split',
  },
  {
    id: 'doc-concept-buffer-pool',
    title: 'Buffer pool concepts',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Concepts',
    description: 'Deep dive into database buffer management, dirty pages, pinning, and replacement policies.',
    tags: ['concepts', 'buffer', 'pool', 'pinning', 'dirty'],
    href: '/docs/concepts/buffer-pool',
  },
  {
    id: 'doc-concept-btree',
    title: 'B+Tree concepts',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Concepts',
    description: 'Deep dive into B+Tree balance invariants, fan-out, leaf sibling linked lists, and range scans.',
    tags: ['concepts', 'btree', 'invariants', 'fan-out', 'range-scan'],
    href: '/docs/concepts/btree',
  },
  {
    id: 'doc-essay-index-tax',
    title: 'An index is a tax on every write',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Essays',
    description: 'Why indexes speed up reads but penalize INSERT, UPDATE and DELETE operations.',
    tags: ['essay', 'index', 'tax', 'writes', 'performance'],
    href: '/docs/essays/index-write-tax',
  },
  {
    id: 'doc-essay-scan-resistance',
    title: 'One scan can empty the cache',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Essays',
    description: 'Scan resistance: why LRU suffers from sequential scan cache pollution and how LRU-2 / 2Q solve it.',
    tags: ['essay', 'scan', 'cache', 'pollution', 'lru-2', '2q'],
    href: '/docs/essays/scan-resistance',
  },
  {
    id: 'doc-essay-repeatable-read',
    title: 'REPEATABLE READ means two things',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Essays',
    description: 'How ANSI SQL Repeatable Read differs between 2-Phase Locking and Snapshot Isolation.',
    tags: ['essay', 'isolation', 'repeatable-read', 'ansi', 'snapshot', '2pl'],
    href: '/docs/essays/repeatable-read',
  },
  {
    id: 'doc-course-map',
    title: 'Course map',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Study Guide',
    description: 'Mapping QueryLens visualizers to standard university database courses (CMU 15-445, CS 186, CS 145).',
    tags: ['study', 'course', 'curriculum', 'cmu', 'berkeley'],
    href: '/docs/study/course-map',
  },
  {
    id: 'doc-interview-roadmap',
    title: 'Database interview roadmap',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Study Guide',
    description: 'Core database internals questions frequently asked in systems engineering interviews.',
    tags: ['study', 'interview', 'systems', 'preparation'],
    href: '/docs/study/interview-roadmap',
  },
  {
    id: 'doc-reference-sql',
    title: 'Supported SQL reference',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Reference',
    description: 'Complete specification of SQL syntax, functions, operators, and dialects supported by QueryLens.',
    tags: ['reference', 'sql', 'syntax', 'keywords'],
    href: '/docs/reference/sql',
  },
  {
    id: 'doc-reference-shortcuts',
    title: 'Keyboard shortcuts',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Reference',
    badge: 'Hotkeys',
    description: 'All keyboard shortcuts for stepping, running, resetting, and navigating the engine.',
    tags: ['reference', 'shortcuts', 'keyboard', 'hotkeys'],
    href: '/docs/reference/shortcuts',
  },
  {
    id: 'doc-architecture',
    title: 'Engine architecture',
    category: 'docs',
    filterCategory: 'docs',
    subtitle: 'Architecture',
    description: 'How QueryLens runs 100% in the browser: parser, planner, VM, disk simulation, and React UI.',
    tags: ['architecture', 'engine', 'internals', 'browser', 'client-side'],
    href: '/docs/architecture',
  },

  // --- Top Navigation Pages (9) ---
  {
    id: 'nav-playground',
    title: 'Playground',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Main Visualizer',
    description: 'Watch SQL queries travel step-by-step through parser, planner, buffer pool, and B+Tree in the browser.',
    tags: ['playground', 'engine', 'sql', 'trace', 'visualizer'],
    href: '/playground',
  },
  {
    id: 'nav-stages',
    title: 'Pipeline stages overview',
    category: 'navigation',
    filterCategory: 'stages',
    subtitle: 'Stages Index',
    description: 'Browse the eight sequential stages of the database query pipeline.',
    tags: ['stages', 'pipeline', 'index'],
    href: '/stages',
  },
  {
    id: 'nav-learn',
    title: 'Learn database internals',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Curriculum',
    description: 'Interactive curriculum of guided lessons on storage, indexing, query execution, and transactions.',
    tags: ['learn', 'lessons', 'course', 'curriculum', 'education'],
    href: '/learn',
  },
  {
    id: 'nav-gallery',
    title: 'Query gallery',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Showcase',
    description: 'Curated showcase of interesting query traces, edge cases, and complex plans.',
    tags: ['gallery', 'queries', 'showcase'],
    href: '/gallery',
  },
  {
    id: 'nav-tools',
    title: 'All tools directory',
    category: 'navigation',
    filterCategory: 'tools',
    subtitle: '19 Interactive Sandboxes',
    description: 'Directory of all 19 dedicated database internals sandboxes.',
    tags: ['tools', 'sandboxes', 'directory'],
    href: '/tools',
  },
  {
    id: 'nav-compare',
    title: 'Compare plans',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Side-by-side Analysis',
    description: 'Compare two SQL queries side-by-side: plan trees, buffer pool hits/misses, and execution steps.',
    tags: ['compare', 'diff', 'plans', 'benchmarks'],
    href: '/compare',
  },
  {
    id: 'nav-examples',
    title: 'SQL examples catalog',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Query Presets',
    description: 'Library of pre-built SQL queries: joins, aggregations, subqueries, and index lookups.',
    tags: ['examples', 'queries', 'presets', 'catalog'],
    href: '/examples',
  },
  {
    id: 'nav-challenges',
    title: 'Engineering challenges',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Interactive Problems',
    description: 'Hands-on database engineering challenges to test your understanding of internals.',
    tags: ['challenges', 'problems', 'quiz', 'practice'],
    href: '/challenges',
  },
  {
    id: 'nav-progress',
    title: 'Your progress & badges',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'User Profile',
    description: 'Track completed lessons, solved challenges, and earned database engineering badges.',
    tags: ['progress', 'badges', 'profile', 'stats'],
    href: '/progress',
  },
  {
    id: 'nav-settings',
    title: 'Settings',
    category: 'navigation',
    filterCategory: 'all',
    subtitle: 'Configuration',
    description: 'Configure appearance, default buffer pool size, database tables, and saved workspaces.',
    tags: ['settings', 'preferences', 'workspace', 'config'],
    href: '/settings',
  },
];

const QUICK_SUGGESTIONS = [
  'Playground',
  'B+Tree',
  'Buffer Pool',
  'ARIES Recovery',
  'Learn',
  'Docs',
];

export function SpotlightDialog({ onClose }: SpotlightDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const navigate = useNavigate();
  const { choice, setChoice, theme } = useThemeContext();

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Trap focus and store previous active element
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement;
    const timer = setTimeout(() => inputRef.current?.focus(), 40);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      clearTimeout(timer);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus();
    };
  }, []);

  // Keyboard navigation within the modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }

      // Filter Hotkeys (Cmd+1, Cmd+2, Cmd+3, Cmd+4)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (e.key === '1') { e.preventDefault(); setActiveFilter('all'); return; }
        if (e.key === '2') { e.preventDefault(); setActiveFilter('tools'); return; }
        if (e.key === '3') { e.preventDefault(); setActiveFilter('stages'); return; }
        if (e.key === '4') { e.preventDefault(); setActiveFilter('docs'); return; }
      }

      // Tab trap
      if (e.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // Combine static items with dynamic actions (Theme, Tour, etc.)
  const allAvailableItems = useMemo<SpotlightItem[]>(() => {
    const actions: SpotlightItem[] = [
      {
        id: 'action-theme',
        title: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`,
        category: 'actions',
        filterCategory: 'all',
        subtitle: 'Appearance',
        badge: choice === 'system' ? 'System Theme' : 'Theme',
        description: `Currently active: ${theme} theme. Toggle to ${theme === 'dark' ? 'light' : 'dark'} mode.`,
        tags: ['theme', 'dark', 'light', 'mode', 'appearance', 'color'],
        action: () => setChoice(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'action-tour',
        title: 'Start Playground tour',
        category: 'actions',
        filterCategory: 'all',
        subtitle: 'Walkthrough',
        badge: 'Interactive Tour',
        description: 'Launch the interactive 60-second guided tour of the QueryLens query execution playground.',
        tags: ['tour', 'walkthrough', 'guide', 'tutorial', 'help'],
        action: () => { void navigate('/playground?tour=1'); },
      },
      {
        id: 'action-shortcuts',
        title: 'View keyboard shortcuts',
        category: 'actions',
        filterCategory: 'all',
        subtitle: 'Help & Reference',
        badge: `${MOD_KEY}K`,
        description: 'Open the full keyboard shortcuts manual for query stepping, playback, and navigation.',
        tags: ['shortcuts', 'hotkeys', 'keys', 'keyboard'],
        href: '/docs/reference/shortcuts',
      },
    ];

    return [...STATIC_ITEMS, ...actions];
  }, [theme, choice, setChoice, navigate]);

  // Search filter and scoring algorithm
  const filteredItems = useMemo<SpotlightItem[]>(() => {
    const q = searchQuery.trim().toLowerCase();

    // Base filter by category tab
    const categoryMatched = allAvailableItems.filter((item) => {
      if (activeFilter === 'all') return true;
      return item.filterCategory === activeFilter;
    });

    if (!q) {
      // Default view: if 'all', highlight top quick start items
      if (activeFilter === 'all') {
        const topIds = [
          'nav-playground',
          'tool-btree',
          'tool-buffer-pool',
          'tool-recovery',
          'nav-learn',
          'doc-manual-btree-split',
          'action-theme',
        ];
        return topIds
          .map((id) => allAvailableItems.find((item) => item.id === id))
          .filter((item): item is SpotlightItem => Boolean(item));
      }
      return categoryMatched.slice(0, 15);
    }

    const queryWords = q.split(/\s+/).filter(Boolean);

    interface ScoredItem {
      item: SpotlightItem;
      score: number;
    }

    const scored: ScoredItem[] = [];

    for (const item of categoryMatched) {
      const titleLower = item.title.toLowerCase();
      const descLower = item.description.toLowerCase();
      const subtitleLower = (item.subtitle ?? '').toLowerCase();
      const tagsJoined = (item.tags ?? []).join(' ').toLowerCase();

      let score = 0;

      // Exact title match gets top priority
      if (titleLower === q) score += 100;
      else if (titleLower.startsWith(q)) score += 60;
      else if (titleLower.includes(q)) score += 40;

      // Check each token
      for (const word of queryWords) {
        if (titleLower.includes(word)) score += 25;
        if (tagsJoined.includes(word)) score += 20;
        if (subtitleLower.includes(word)) score += 15;
        if (descLower.includes(word)) score += 8;
        if (item.href?.includes(word)) score += 10;
      }

      if (score > 0) {
        scored.push({ item, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 15).map((s) => s.item);
  }, [allAvailableItems, searchQuery, activeFilter]);

  // Keep selectedIndex in bounds
  const activeIndex = selectedIndex >= filteredItems.length ? 0 : selectedIndex;

  // Auto-scroll list when keyboard navigating
  useEffect(() => {
    const selectedEl = listRef.current?.querySelector('[data-selected="true"]');
    if (typeof selectedEl?.scrollIntoView === 'function') {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const runItem = useCallback(
    (item: SpotlightItem) => {
      if (item.action) {
        item.action();
      } else if (item.href) {
        void navigate(item.href);
      }
      onClose();
    },
    [navigate, onClose],
  );

  // Key navigation for results
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (filteredItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSelectedIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSelectedIndex(filteredItems.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const currentItem = filteredItems[activeIndex];
      if (currentItem) runItem(currentItem);
    }
  };

  const hasQuery = searchQuery.trim() !== '';
  const activeOptionId = filteredItems[activeIndex]
    ? `spotlight-option-${activeIndex}`
    : undefined;

  // Icon selector based on item category
  const renderItemIcon = (category: SpotlightCategory) => {
    switch (category) {
      case 'tools':
        return (
          <svg className="h-4 w-4 stroke-current stroke-2 text-stage-buffer" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 6h12M4 10h12M4 14h12" strokeLinecap="round" />
            <circle cx="7" cy="6" r="1.5" fill="currentColor" />
            <circle cx="13" cy="10" r="1.5" fill="currentColor" />
            <circle cx="9" cy="14" r="1.5" fill="currentColor" />
          </svg>
        );
      case 'stages':
        return (
          <svg className="h-4 w-4 stroke-current stroke-2 text-stage-plan" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
            <path d="M12 2l3 3-3 3M8 12l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case 'docs':
        return (
          <svg className="h-4 w-4 stroke-current stroke-2 text-accent" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 4h9a3 3 0 0 1 3 3v9a3 3 0 0 0-3-3H4V4z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 4v12a3 3 0 0 1 3-3h9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case 'actions':
        return (
          <svg className="h-4 w-4 stroke-current stroke-2 text-stage-optimize" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M11 2L4 11h6l-1 7 7-9h-6l1-7z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case 'navigation':
      default:
        return (
          <svg className="h-4 w-4 stroke-current stroke-2 text-ink-dim" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <path d="M13.5 6.5l-2.5 6-4.5 1 2.5-6 4.5-1z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] sm:pt-[12vh] px-3 sm:px-4"
      role="presentation"
    >
      {/* Click-outside Backdrop — keeps the rest of the page unblurred like macOS Spotlight */}
      <div
        onClick={handleClose}
        className="ql-liquid-backdrop fixed inset-0"
        aria-hidden="true"
      />

      {/* Liquid Glass Modal Lens */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search QueryLens"
        className="ql-liquid-glass relative z-10 flex w-full max-w-2xl flex-col overflow-hidden text-ink"
      >
        {/* Search Input Bar */}
        <div className="relative z-10 flex items-center gap-3 border-b ql-liquid-divider px-5 py-4">
          <svg
            className="h-5 w-5 shrink-0 stroke-current stroke-2 text-ink-dim"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M13 13l4.5 4.5" strokeLinecap="round" />
          </svg>

          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Search QueryLens (e.g. B+Tree, LRU, ARIES, EXPLAIN)..."
            aria-label="Search database internals, tools and documentation"
            role="combobox"
            aria-expanded={filteredItems.length > 0}
            aria-controls="spotlight-results"
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            style={{ outline: 'none', boxShadow: 'none' }}
            className="ql-spotlight-input flex-1 bg-transparent text-base sm:text-lg font-light text-ink placeholder:text-ink-dim/45 border-none outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 shadow-none focus:shadow-none focus-visible:shadow-none min-w-0"
          />

          {/* Category Filter Capsules */}
          <div className="hidden sm:flex items-center gap-1 shrink-0" role="group" aria-label="Filter results">
            {(
              [
                { id: 'all', label: 'All', shortcut: `${MOD_KEY}1` },
                { id: 'tools', label: 'Tools', shortcut: `${MOD_KEY}2` },
                { id: 'stages', label: 'Stages', shortcut: `${MOD_KEY}3` },
                { id: 'docs', label: 'Docs', shortcut: `${MOD_KEY}4` },
              ] as const
            ).map((filter) => {
              const isActive = activeFilter === filter.id;
              return (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => {
                    setActiveFilter(filter.id);
                    setSelectedIndex(0);
                    inputRef.current?.focus();
                  }}
                  aria-pressed={isActive}
                  aria-label={`${filter.label} (${filter.shortcut})`}
                  title={`${filter.label} (${filter.shortcut})`}
                  className={[
                    'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition duration-150 ease-out select-none cursor-pointer',
                    isActive
                      ? 'ql-liquid-pill-active text-ink font-semibold'
                      : 'border border-transparent text-ink-dim hover:text-ink hover:bg-white/10',
                  ].join(' ')}
                >
                  <span>{filter.label}</span>
                  <span className="opacity-55 text-[10px] font-mono">{filter.shortcut}</span>
                </button>
              );
            })}
          </div>

          {/* Close Button */}
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close search"
            className="ql-liquid-pill inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-dim hover:text-ink cursor-pointer"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4 stroke-current stroke-2" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Spotlight Quick Suggestion Chips (when no query entered) */}
        {!hasQuery && activeFilter === 'all' && (
          <div className="relative z-10 flex items-center gap-1.5 px-5 py-3 border-b ql-liquid-divider overflow-x-auto scrollbar-none">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim/65 mr-1 shrink-0">
              Suggestions:
            </span>
            {QUICK_SUGGESTIONS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => {
                  setSearchQuery(chip);
                  setSelectedIndex(0);
                  inputRef.current?.focus();
                }}
                className="ql-liquid-pill whitespace-nowrap rounded-full px-3 py-1 text-xs text-ink-dim hover:text-ink cursor-pointer"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {/* Results List */}
        <div
          ref={listRef}
          id="spotlight-results"
          role="listbox"
          aria-label="Search results"
          className="relative z-10 max-h-[55vh] overflow-y-auto p-2.5 scrollbar-none space-y-1"
        >
          {filteredItems.length === 0 ? (
            <div className="py-12 px-4 text-center">
              <p className="text-body font-medium text-ink-dim">
                No results found for &ldquo;{searchQuery}&rdquo;
              </p>
              <p className="mt-1 text-label text-ink-dim/75">
                Try searching for <span className="text-accent font-mono">btree</span>,{' '}
                <span className="text-accent font-mono">buffer</span>,{' '}
                <span className="text-accent font-mono">lru</span>,{' '}
                <span className="text-accent font-mono">aries</span>, or{' '}
                <span className="text-accent font-mono">pushdown</span>.
              </p>
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  id={`spotlight-option-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected}
                  onClick={() => runItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={[
                    'ql-liquid-row group flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left transition duration-150 ease-out cursor-pointer',
                    isSelected
                      ? 'ql-liquid-row-active text-ink'
                      : 'border border-transparent text-ink/85 hover:text-ink',
                  ].join(' ')}
                >
                  {/* Category Icon */}
                  <div
                    className={[
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition duration-150',
                      isSelected ? 'ql-liquid-pill-active text-ink' : 'ql-liquid-pill',
                    ].join(' ')}
                  >
                    {renderItemIcon(item.category)}
                  </div>

                  {/* Text details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-ink truncate">
                        {item.title}
                      </span>
                      {item.badge && (
                        <span className="ql-liquid-kbd hidden sm:inline-block rounded-full px-2 py-0.5 text-[10px] text-ink-dim shrink-0">
                          {item.badge}
                        </span>
                      )}
                      {item.subtitle && !item.badge && (
                        <span className="text-xs text-ink-dim/70 truncate shrink-0">
                          · {item.subtitle}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-dim/85 truncate mt-0.5">
                      {item.description}
                    </p>
                  </div>

                  {/* Selection Indicator */}
                  {isSelected && (
                    <div className="ql-liquid-kbd shrink-0 flex items-center gap-1 text-[11px] font-mono text-ink-dim px-2 py-0.5 rounded-full">
                      <span>Open</span>
                      <span className="text-xs">↵</span>
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Keyboard Legend Footer */}
        <div
          aria-hidden="true"
          className="relative z-10 flex items-center justify-between border-t ql-liquid-divider px-5 py-2.5 text-[11px] text-ink-dim/75 font-mono"
        >
          <div className="flex items-center gap-3 sm:gap-4">
            <span className="flex items-center gap-1">
              <kbd className="ql-liquid-kbd rounded-md px-1.5 py-0.5 text-[10px]">↑</kbd>
              <kbd className="ql-liquid-kbd rounded-md px-1.5 py-0.5 text-[10px]">↓</kbd>
              <span className="hidden sm:inline">Navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="ql-liquid-kbd rounded-md px-1.5 py-0.5 text-[10px]">↵</kbd>
              <span>Select</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="ql-liquid-kbd rounded-md px-1.5 py-0.5 text-[10px]">Esc</kbd>
              <span>Close</span>
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-2 text-ink-dim/60">
            <span>{MOD_KEY}1-{MOD_KEY}4 Category</span>
          </div>
        </div>
      </div>
    </div>
  );
}
