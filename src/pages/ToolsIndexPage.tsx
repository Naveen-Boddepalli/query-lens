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
    title: 'Grammar sandbox',
    href: '/tools/grammar',
    description:
      'Every rule the parser accepts, diagrammed straight from the same data its own test checks against the real tokenizer and parser — a keyword pill, a clickable box for a rule it calls, a dashed bracket for anything optional, a loop glyph for anything repeated.',
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
