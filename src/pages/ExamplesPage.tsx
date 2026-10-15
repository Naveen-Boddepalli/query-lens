import { useState } from 'react';
import { PageHeader } from '../ui/PageHeader.tsx';
import {
  btnPrimary,
  panelSurface,
  pill,
  segBase,
  segOff,
  segOn,
  segmentedTrack,
} from '../ui/primitives.ts';

type Category = 'Basic Queries' | 'Joins' | 'Aggregates' | 'Mutations';

interface ExampleQuery {
  title: string;
  sql: string;
  desc: string;
  cat: Category;
  tbl: string;
  dataset?: 'orders';
}

const EXAMPLES: readonly ExampleQuery[] = [
  {
    title: 'Point Lookup',
    sql: 'SELECT * FROM users WHERE id = 5;',
    desc: 'Indexed B+Tree lookup finding one row.',
    cat: 'Basic Queries',
    tbl: 'users',
  },
  {
    title: 'Full Table Scan',
    sql: 'SELECT * FROM users WHERE age > 30;',
    desc: 'Sequential scan filtering every heap page.',
    cat: 'Basic Queries',
    tbl: 'users',
  },
  {
    title: 'Select All',
    sql: 'SELECT * FROM users;',
    desc: 'Baseline query returning all rows.',
    cat: 'Basic Queries',
    tbl: 'users',
  },
  {
    title: 'Authors & Posts Join',
    sql: 'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId;',
    desc: 'Join on foreign key across heap pages.',
    cat: 'Joins',
    tbl: 'authors, posts',
  },
  {
    title: 'Group By Status',
    sql: 'SELECT status, COUNT(*) FROM orders GROUP BY status;',
    desc: 'Groups orders with COUNT aggregate.',
    cat: 'Aggregates',
    tbl: 'orders',
    dataset: 'orders',
  },
  {
    title: 'Insert Record',
    sql: "INSERT INTO users (id, name, age) VALUES (49, 'carol', 29);",
    desc: 'Appends a tuple into the heap.',
    cat: 'Mutations',
    tbl: 'users',
  },
  {
    title: 'Delete Records',
    sql: 'DELETE FROM users WHERE age > 60;',
    desc: 'Removes matching tuples from the heap.',
    cat: 'Mutations',
    tbl: 'users',
  },
];

const CATEGORIES: readonly Category[] = ['Basic Queries', 'Joins', 'Aggregates', 'Mutations'];

function highlightSql(sql: string): string {
  return sql
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/('(?:[^']|'')*')/g, '<span class="text-hit">$1</span>')
    .replace(
      /\b(SELECT|FROM|WHERE|JOIN|ON|GROUP BY|ORDER BY|LIMIT|INSERT INTO|VALUES|DELETE|COUNT)\b/gi,
      '<span class="font-semibold text-accent">$1</span>',
    );
}

export function ExamplesPage() {
  const [activeCategory, setActiveCategory] = useState<Category>('Basic Queries');

  const filtered = EXAMPLES.filter((e) => e.cat === activeCategory);

  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
      <PageHeader title="Examples">
        Pre-built queries that demonstrate different engine behaviours. Click one to load it in
        the playground.
      </PageHeader>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className={segmentedTrack} role="tablist" aria-label="Query categories">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={activeCategory === cat}
              onClick={() => { setActiveCategory(cat); }}
              className={`${segBase} text-label py-1 px-3 ${activeCategory === cat ? segOn : segOff}`}
            >
              {cat}
            </button>
          ))}
        </div>
        <span className="text-label text-ink-dim tabular-nums">
          {filtered.length} {activeCategory.toLowerCase()}
        </span>
      </div>

      <div className="mt-6 space-y-4">
        {filtered.map((ex) => (
          <div key={ex.title} className={`${panelSurface} p-4 sm:p-5 flex flex-col justify-between`}>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-body font-semibold text-ink">{ex.title}</h3>
                <span className={`${pill} text-[11px] font-mono text-ink-dim`}>
                  table: {ex.tbl}
                </span>
              </div>
              <p className="mt-1 text-label text-ink-dim">{ex.desc}</p>

              <div className="mt-3 overflow-x-auto rounded-lg border border-edge/70 bg-surface/80 p-3 shadow-neu-track font-mono text-code text-ink">
                <code dangerouslySetInnerHTML={{ __html: highlightSql(ex.sql) }} />
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end pt-3 border-t border-edge/40">
              <a
                href={
                  ex.dataset === 'orders'
                    ? `/playground?q=${encodeURIComponent(ex.sql)}&t=orders`
                    : `/playground?q=${encodeURIComponent(ex.sql)}`
                }
                className={`${btnPrimary} text-label py-1.5 px-4`}
              >
                <span>Run in Playground</span>
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 stroke-current stroke-2"
                  fill="none"
                  aria-hidden="true"
                >
                  <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-label text-ink-dim">
        Want to compare two queries or replacement policies side by side? Check the{' '}
        <a href="/compare" className="underline underline-offset-2 hover:text-ink">
          Compare tool
        </a>
        .
      </p>
    </div>
  );
}
