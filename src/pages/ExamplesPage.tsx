export function ExamplesPage() {
  const EXAMPLES = [
    { title: 'Point Lookup', sql: 'SELECT * FROM users WHERE id = 5;', description: 'An indexed lookup that traverses the B+Tree to find exactly one row.' },
    { title: 'Full Table Scan', sql: 'SELECT * FROM users WHERE age > 30;', description: 'A sequential scan that reads every page in the heap.' },
    { title: 'Select All', sql: 'SELECT * FROM users;', description: 'The simplest query — every row, every column, no filter.' },
  ];

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="mb-2 text-heading font-semibold">Examples</h2>
      <p className="mb-6 text-body text-ink-dim">
        Pre-built queries that demonstrate different engine behaviours. Click one to load it
        in the playground.
      </p>

      <div className="space-y-4">
        {EXAMPLES.map((example) => (
          <a
            key={example.title}
            href={`/?sql=${encodeURIComponent(example.sql)}`}
            className="cell block rounded-lg border border-edge bg-surface-2 p-4 transition-colors hover:border-accent/50 hover:bg-surface-3"
          >
            <h3 className="text-body font-semibold text-ink">{example.title}</h3>
            <pre className="mt-1 font-mono text-code text-accent">{example.sql}</pre>
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
