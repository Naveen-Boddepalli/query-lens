import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const DOCS_NAV = [
  {
    title: 'Introduction',
    items: [
      { to: '/docs', label: 'Overview' },
      { to: '/docs/getting-started', label: 'Getting Started' },
      { to: '/docs/faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Concepts',
    items: [
      { to: '/docs/concepts/buffer-pool', label: 'Buffer Pool' },
      { to: '/docs/concepts/btree', label: 'B+Tree' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { to: '/docs/reference/sql', label: 'SQL Supported' },
      { to: '/docs/reference/url-parameters', label: 'URL Parameters' },
      { to: '/docs/reference/shortcuts', label: 'Keyboard Shortcuts' },
      { to: '/docs/reference/limits', label: 'Limits' },
    ],
  },
];

export function DocsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="sidebar-nav w-60 shrink-0 overflow-y-auto border-r border-edge bg-surface-2 p-4">
        <nav aria-label="Docs navigation">
          {DOCS_NAV.map((group) => (
            <div key={group.title} className="mb-4">
              <h3 className="mb-1.5 text-label font-medium text-ink-dim">{group.title}</h3>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/docs'}
                      className={({ isActive }) =>
                        [
                          'cell block rounded-md px-2.5 py-1.5 text-body transition-colors',
                          isActive
                            ? 'bg-accent/15 font-medium text-ink'
                            : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
                        ].join(' ')
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      
      <div className="min-h-0 flex-1 overflow-y-auto p-6 lg:p-10">
        <div className="prose prose-invert max-w-3xl">
          {/* Its own boundary, so moving between docs pages (each its own lazy
              chunk) does not drop this sidebar while the next page loads. The
              outer boundary in App.tsx only covers the first `/docs` hit. */}
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
