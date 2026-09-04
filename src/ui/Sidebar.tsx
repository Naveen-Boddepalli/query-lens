import { NavLink } from 'react-router-dom';
import type { Stage } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';

interface SidebarGroup {
  title: string;
  stages: Stage[];
}

const GROUPS: SidebarGroup[] = [
  { title: 'Query Processing', stages: ['parse', 'plan', 'optimize'] },
  { title: 'Runtime', stages: ['execute', 'buffer', 'index'] },
  { title: 'Concurrency', stages: ['lock'] },
  { title: 'Output', stages: ['result'] },
];

export function Sidebar() {
  return (
    <aside className="sidebar-nav w-60 shrink-0 overflow-y-auto border-r border-edge bg-surface-2 p-4">
      <nav aria-label="Pipeline stages">
        {GROUPS.map((group) => (
          <div key={group.title} className="mb-4">
            <h3 className="mb-1.5 text-label font-medium text-ink-dim">{group.title}</h3>
            <ul className="space-y-0.5">
              {group.stages.map((stageId) => {
                const meta = STAGE_META[stageId];
                return (
                  <li key={stageId}>
                    <NavLink
                      to={`/stages/${stageId}`}
                      className={({ isActive }) =>
                        [
                          'cell block rounded-md px-2.5 py-1.5 text-body transition-colors',
                          isActive
                            ? 'bg-accent/15 font-medium text-ink'
                            : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
                        ].join(' ')
                      }
                    >
                      {meta.title}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
