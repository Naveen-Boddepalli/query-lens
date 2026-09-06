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
      'Type a page-reference string and watch LRU or clock sweep decide what gets evicted. No SQL — the OS-course version of the pipeline\'s buffer pool.',
    available: true,
  },
  {
    title: 'B+Tree sandbox',
    href: null,
    description:
      'insert(), delete(), find() against a live B+Tree, watching it split, borrow and merge. Waiting on B+Tree deletion in the engine (plan.md §20.4).',
    available: false,
  },
  {
    title: 'Parser sandbox',
    href: null,
    description:
      'Type arbitrary SQL and watch the tokenizer and the recursive-descent parser build the AST, including the token stream. Most of this already exists in the Playground; this adds the token ribbon.',
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
              className="rounded-xl border border-dashed border-edge/60 p-4 opacity-70"
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
