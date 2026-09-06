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

const itemClass = ({ isActive }: { isActive: boolean }) =>
  [
    'cell block rounded-r-md border-l-2 py-1.5 pr-2.5 pl-3 text-body transition',
    isActive
      ? 'border-accent bg-accent-soft font-medium text-ink'
      : 'border-transparent text-ink-dim hover:border-edge hover:bg-surface-3 hover:text-ink',
  ].join(' ');

export function Sidebar() {
  return (
    <aside className="sidebar-nav w-60 shrink-0 overflow-y-auto border-r border-edge bg-surface-2/40 p-4">
      <nav aria-label="Pipeline stages">
        {GROUPS.map((group) => (
          <div key={group.title} className="mb-5">
            <h3 className="mb-2 text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
              {group.title}
            </h3>
            <ul className="space-y-0.5">
              {group.stages.map((stageId) => {
                const meta = STAGE_META[stageId];
                return (
                  <li key={stageId}>
                    <NavLink to={`/stages/${stageId}`} className={itemClass}>
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
