import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { DOCS_NAV } from '../docsNav.ts';

const itemClass = ({ isActive }: { isActive: boolean }) =>
  [
    'cell block rounded-r-md border-l-2 py-1.5 pr-2.5 pl-3 text-body transition',
    isActive
      ? 'border-accent bg-accent-soft font-medium text-ink'
      : 'border-transparent text-ink-dim hover:border-edge hover:bg-surface-3 hover:text-ink',
  ].join(' ');

export function DocsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="sidebar-nav w-60 shrink-0 overflow-y-auto border-r border-edge bg-surface-2/40 p-4">
        <nav aria-label="Docs navigation">
          {DOCS_NAV.map((group) => (
            <div key={group.title} className="mb-5">
              <h3 className="mb-2 text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
                {group.title}
              </h3>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.to === '/docs'} className={itemClass}>
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
        {/* No `prose-invert`: `.prose` is themed onto the app's own semantic
            tokens in index.css, which already flip with the theme, so the
            docs read correctly in light and dark without a second variant. */}
        {/* `data-print` (plan.md §22.6): Ctrl-P on a docs page prints the
            article, not a blank sheet — the nav and sidebar drop away. */}
        <div data-print className="prose">
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
