import { useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';

/**
 * Layout for the /stages section — sidebar + page content.
 */
export function StagesLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { stageId } = useParams<{ stageId?: string }>();
  const title = stageId ? stageId.charAt(0).toUpperCase() + stageId.slice(1) : 'Overview';

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-edge bg-surface-2 px-4 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => { setMobileOpen((o) => !o); }}
          className="rounded-lg border border-edge bg-surface-3 px-2.5 py-1 text-label font-medium text-ink shadow-e1"
          aria-expanded={mobileOpen}
          aria-label="Toggle pipeline stages navigation"
        >
          {mobileOpen ? 'Close Menu' : 'Stages Menu'}
        </button>
        <div className="flex items-center gap-1.5 text-label">
          <NavLink
            to="/stages"
            end
            onClick={() => { setMobileOpen(false); }}
            className="text-ink-dim hover:text-ink"
          >
            Stages
          </NavLink>
          <span className="text-ink-dim/40" aria-hidden="true">/</span>
          <span className="truncate font-medium text-ink">{title}</span>
        </div>
      </div>

      <div className={mobileOpen ? 'block lg:block' : 'hidden lg:block'}>
        <Sidebar onSelect={() => { setMobileOpen(false); }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
