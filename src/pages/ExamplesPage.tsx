import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive } from '../ui/primitives.ts';

export function ExamplesPage() {
  const EXAMPLES = [
    { title: 'Point Lookup', sql: 'SELECT * FROM users WHERE id = 5;', description: 'An indexed lookup that traverses the B+Tree to find exactly one row.' },
    { title: 'Full Table Scan', sql: 'SELECT * FROM users WHERE age > 30;', description: 'A sequential scan that reads every page in the heap.' },
    { title: 'Select All', sql: 'SELECT * FROM users;', description: 'The simplest query — every row, every column, no filter.' },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <PageHeader eyebrow="Starting points" title="Examples">
        Pre-built queries that demonstrate different engine behaviours. Click one to load it in
        the playground.
      </PageHeader>

      <div className="mt-8 space-y-3">
        {EXAMPLES.map((example) => (
          <a
            key={example.title}
            href={`/playground?q=${encodeURIComponent(example.sql)}`}
            className={cardInteractive}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-body font-semibold text-ink">{example.title}</h3>
              <span
                aria-hidden
                className="text-ink-dim transition group-hover:translate-x-0.5 group-hover:text-accent"
              >
                →
              </span>
            </div>
            <pre className="mt-2 overflow-x-auto font-mono text-code text-accent">{example.sql}</pre>
            <p className="mt-2 text-label text-ink-dim">{example.description}</p>
          </a>
        ))}
      </div>

      <p className="mt-8 text-label text-ink-dim">
        More examples coming soon — joins, subqueries, and aggregate functions.
      </p>
    </div>
  );
}
