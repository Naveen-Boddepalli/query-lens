import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive, pill } from '../ui/primitives.ts';

type ToolCategory = 'all' | 'storage' | 'query' | 'execution';

interface ToolItem {
  id: string;
  title: string;
  href: string;
  category: 'storage' | 'query' | 'execution';
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
    id: 'btree',
    title: 'B+Tree visualizer',
    href: '/tools/btree',
    category: 'storage',
    topic: 'Indexing',
    difficulty: 'Intermediate',
    metric: 'Splits, borrows & merges',
    description:
      'Insert, delete, and search keys against a live B+Tree. Observe node splits on insert, sibling borrows and merges on delete, with fan-out control and invariant checks.',
  },
  {
    id: 'parser',
    title: 'Recursive-descent parser',
    href: '/tools/parser',
    category: 'query',
    topic: 'Compilers',
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
    topic: 'Grammar',
    difficulty: 'Intermediate',
    metric: 'Complete SQL syntax graph',
    description:
      'Every rule the engine parser accepts, diagrammed directly from internal grammar definitions: keyword tokens, clickable child rules, optional brackets, and repetitions.',
  },
  {
    id: 'planner',
    title: 'Planner & optimizer',
    href: '/tools/planner',
    category: 'query',
    topic: 'Optimizer',
    difficulty: 'Advanced',
    metric: 'Rewrite rules & cost model',
    description:
      'Type a query and inspect its operator plan tree side-by-side: canonical next to optimized. Toggle rewrite rules and index paths to observe plan transformations.',
  },
  {
    id: 'sort',
    title: 'External merge sort',
    href: '/tools/sort',
    category: 'execution',
    topic: 'Execution',
    difficulty: 'Intermediate',
    metric: 'k-way merge passes & I/O',
    description:
      'Sort records exceeding memory limits: run generation followed by k-way merge passes until sorted. Adjust buffer budget to see pass counts and page I/O move.',
  },
  {
    id: 'hash-join',
    title: 'Grace hash join',
    href: '/tools/hash-join',
    category: 'execution',
    topic: 'Execution',
    difficulty: 'Advanced',
    metric: 'Partition spill & probing',
    description:
      'Grace hash join simulator: partition build and probe relations by hash key, handle recursive partition spills, construct in-memory buckets, and probe matches.',
  },
  {
    id: 'locks',
    title: 'Lock manager simulator',
    href: '/tools/locks',
    category: 'execution',
    topic: 'Concurrency',
    difficulty: 'Advanced',
    metric: '2PL & wait-for cycle abort',
    description:
      'Two concurrent transactions placing shared and exclusive lock requests. Watch conflicting requests block, track wait-for dependencies, and resolve deadlocks.',
  },
];

const CATEGORIES: { id: ToolCategory; label: string }[] = [
  { id: 'all', label: 'All sandboxes' },
  { id: 'storage', label: 'Storage & Memory' },
  { id: 'query', label: 'Query & Optimizer' },
  { id: 'execution', label: 'Execution & Concurrency' },
];

function DifficultyBadge({ level }: { level: ToolItem['difficulty'] }) {
  const color =
    level === 'Foundation'
      ? 'border-hit/40 bg-hit/10 text-hit'
      : level === 'Intermediate'
        ? 'border-accent/40 bg-accent/10 text-accent'
        : 'border-hue-violet/40 bg-hue-violet/10 text-hue-violet-ink';

  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[0.7rem] uppercase tracking-wider ${color}`}>
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
        title="Database Sandboxes"
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
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-label font-medium transition duration-150 ease-out select-none ${
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

