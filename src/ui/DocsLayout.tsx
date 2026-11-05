import { Suspense, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { DOCS_NAV } from '../docsNav.ts';
import { useDocumentTitle } from './documentTitle.ts';

const itemClass = ({ isActive }: { isActive: boolean }) =>
  [
    'cell group flex items-center justify-between rounded-lg border px-3 py-1.5 text-body transition duration-150',
    isActive
      ? 'border-accent bg-accent-soft font-medium text-ink shadow-neu-rest backdrop-blur-sm'
      : 'border-transparent text-ink-dim hover:border-edge hover:bg-surface-3/80 hover:text-ink',
  ].join(' ');

/** The sidebar's label for a docs page names its tab; `/docs` itself is just "Docs". */
function docsPageTitle(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/docs') return 'Docs';
  return DOCS_NAV.flatMap((group) => group.items).find((item) => item.to === path)?.label ?? 'Docs';
}

function getBreadcrumbs(pathname: string) {
  const current = pathname.replace(/\/$/, '') || '/docs';
  for (const group of DOCS_NAV) {
    for (const item of group.items) {
      const itemPath = item.to.replace(/\/$/, '') || '/docs';
      if (itemPath === current) {
        return { groupTitle: group.title, pageTitle: item.label };
      }
    }
  }
  return { groupTitle: 'Documentation', pageTitle: 'Overview' };
}

export function DocsLayout() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useDocumentTitle(docsPageTitle(location.pathname));
  const activeBreadcrumbs = getBreadcrumbs(location.pathname);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* Mobile nav header */}
      <div className="flex items-center justify-between border-b border-edge bg-surface-2/80 px-4 py-2.5 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => { setMobileMenuOpen((o) => !o); }}
          className="inline-flex items-center gap-2 rounded-lg border border-edge bg-surface-3/60 px-3 py-1.5 text-label font-medium text-ink shadow-neu-rest backdrop-blur-sm transition hover:border-accent/40"
          aria-expanded={mobileMenuOpen}
          aria-label="Toggle documentation navigation"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4 text-ink-dim"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            {mobileMenuOpen ? (
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            ) : (
              <path d="M2.5 4h11M2.5 8h11M2.5 12h11" strokeLinecap="round" />
            )}
          </svg>
          <span>Docs Menu</span>
        </button>
        <span className="truncate text-label font-medium text-ink-dim">{activeBreadcrumbs.pageTitle}</span>
      </div>

      {/* Responsive sticky sidebar */}
      <aside
        className={`sidebar-nav shrink-0 border-r border-edge bg-surface-2/80 backdrop-blur-md lg:sticky lg:top-0 lg:h-full lg:w-64 lg:overflow-y-auto lg:block ${
          mobileMenuOpen ? 'block' : 'hidden lg:block'
        } p-4 shadow-neu-rest`}
      >
        <nav aria-label="Docs navigation">
          {DOCS_NAV.map((group) => (
            <div key={group.title} className="mb-5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-label font-mono font-medium tracking-[0.12em] text-ink-dim uppercase">
                  {group.title}
                </h3>
                <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
                  {group.items.length}
                </span>
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/docs'}
                      onClick={() => { setMobileMenuOpen(false); }}
                      className={itemClass}
                    >
                      {({ isActive }) => (
                        <>
                          <span>{item.label}</span>
                          {isActive && (
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-accent"
                              aria-hidden="true"
                            />
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto p-6 lg:p-10">
        {/* Breadcrumb navigation */}
        <nav aria-label="Breadcrumbs" className="mb-6 flex flex-wrap items-center gap-2 text-label text-ink-dim">
          <Link to="/docs" className="transition hover:text-ink">
            Docs
          </Link>
          <span className="text-ink-dim/40" aria-hidden="true">/</span>
          <span className="text-ink-dim">{activeBreadcrumbs.groupTitle}</span>
          <span className="text-ink-dim/40" aria-hidden="true">/</span>
          <span className="font-medium text-ink" aria-current="page">
            {activeBreadcrumbs.pageTitle}
          </span>
        </nav>

        {/* No `prose-invert`: `.prose` is themed onto the app's own semantic
            tokens in index.css, which already flip with the theme, so the
            docs read correctly in light and dark without a second variant. */}
        {/* `data-print` (plan.md §22.6): Ctrl-P on a docs page prints the
            article, not a blank sheet — the nav and sidebar drop away. */}
        <div data-print className="prose max-w-3xl">
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
