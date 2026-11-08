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

const STAGE_ORDER: Record<string, string> = {
  parse: '01', plan: '02', optimize: '03', execute: '04',
  buffer: '05', index: '06', lock: '07', result: '08',
};

const itemClass = ({ isActive }: { isActive: boolean }) =>
  [
    'cell group flex items-center justify-between rounded-lg border px-3 py-1.5 text-body transition duration-150',
    isActive
      ? 'border-accent bg-accent-soft font-medium text-ink shadow-e1'
      : 'border-transparent text-ink-dim hover:bg-surface-3 hover:text-ink',
  ].join(' ');

export function Sidebar({ onSelect }: { onSelect?: () => void }) {
  return (
    <aside className="sidebar-nav w-full shrink-0 border-r border-edge bg-surface-2 p-4 lg:sticky lg:top-0 lg:h-full lg:w-64 lg:overflow-y-auto">
      <nav aria-label="Pipeline stages">
        <div className="mb-4 hidden items-center justify-between lg:flex">
          <span className="font-mono text-label font-medium tracking-wide uppercase text-ink-dim">
            Stages Overview
          </span>
          <NavLink
            to="/stages"
            end
            className="text-[11px] font-mono text-accent hover:underline"
          >
            All (8)
          </NavLink>
        </div>

        {GROUPS.map((group) => (
          <div key={group.title} className="mb-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-mono text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
                {group.title}
              </h3>
              <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
                {group.stages.length}
              </span>
            </div>
            <ul className="space-y-1">
              {group.stages.map((stageId) => {
                const meta = STAGE_META[stageId];
                const idxStr = STAGE_ORDER[stageId];
                return (
                  <li key={stageId}>
                    <NavLink
                      to={`/stages/${stageId}`}
                      onClick={onSelect}
                      className={itemClass}
                    >
                      {({ isActive }) => (
                        <>
                          <div className="flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-sm"
                              style={{ background: `var(--color-stage-${stageId})` }}
                            />
                            <span className="font-mono text-[11px] text-ink-dim">{idxStr}</span>
                            <span className={isActive ? 'font-semibold text-ink' : ''}>{meta.title}</span>
                          </div>
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
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
