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
    href: null,
    description:
      'insert(), delete(), find() against a live B+Tree, watching it split, borrow and merge. Waiting on B+Tree deletion in the engine (plan.md §20.4).',
    available: false,
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
