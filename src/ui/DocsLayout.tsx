import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { DOCS_NAV } from '../docsNav.ts';

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
        {/* No `prose-invert`: `.prose` is themed onto the app's own semantic
            tokens in index.css, which already flip with the theme, so the
            docs read correctly in light and dark without a second variant. */}
        <div className="prose">
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
