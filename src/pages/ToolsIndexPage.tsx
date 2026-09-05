import { Link } from 'react-router-dom';

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
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="mb-2 text-heading font-semibold">Tools</h2>
      <p className="mb-6 text-body text-ink-dim">
        Individual pipeline stages, split out for courses that only need one of them.
      </p>

      <div className="space-y-4">
        {TOOLS.map((tool) =>
          tool.available && tool.href ? (
            <Link
              key={tool.title}
              to={tool.href}
              className="cell block rounded-lg border border-edge bg-surface-2 p-4 transition-colors hover:border-accent/50 hover:bg-surface-3"
            >
              <h3 className="text-body font-semibold text-ink">{tool.title}</h3>
              <p className="mt-1 text-label text-ink-dim">{tool.description}</p>
            </Link>
          ) : (
            <div
              key={tool.title}
              className="rounded-lg border border-dashed border-edge/60 p-4 opacity-70"
            >
              <h3 className="flex items-center gap-2 text-body font-semibold text-ink">
                {tool.title}
                <span className="rounded border border-edge px-1.5 py-0.5 text-label text-ink-dim">
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
