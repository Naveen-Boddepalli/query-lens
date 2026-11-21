import type { ReactNode } from 'react';
import { panelSurface } from '../primitives.ts';
import { useMediaQuery, WIDE } from './useMediaQuery.ts';

export interface InspectorProps {
  /** The current configuration in a few words ("LRU · 4 frames · read-ahead off"): the bar's text below `lg`. */
  summary: ReactNode;
  /** The region's name. */
  label?: string;
  /** Open the bar below `lg` on load. Off by default, so a phone sees the output before the form. */
  defaultOpen?: boolean;
  /** `ScenarioPicker` first, then `ControlGroup`s. */
  children: ReactNode;
}

/**
 * Where every parameter lives (§4.1). From `lg` up, a rail that sticks inside the layout's scroll pane and scrolls on
 * its own when long. Below `lg`, one bar that shows the configuration as a summary and expands in place; its groups
 * flow into two or three columns when the bar is wide enough (a tablet), and stack on a phone.
 *
 * Only one of the two is ever mounted, so a control's id is never duplicated.
 */
export function Inspector({ summary, label = 'Settings', defaultOpen = false, children }: InspectorProps) {
  const wide = useMediaQuery(WIDE);

  if (wide) {
    return (
      <aside
        aria-label={label}
        className={`${panelSurface} sticky top-4 flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col gap-5 overflow-y-auto p-4`}
      >
        {children}
      </aside>
    );
  }

  return (
    <details open={defaultOpen} className={`${panelSurface} group @container min-w-0`}>
      <summary className="flex cursor-pointer items-center gap-3 px-4 py-3 select-none">
        <span className="text-label font-semibold text-ink">{label}</span>
        <span className="min-w-0 flex-1 truncate text-label text-ink-dim">{summary}</span>
        <span className="shrink-0 text-label font-medium text-accent group-open:hidden">Edit</span>
        <span className="hidden shrink-0 text-label font-medium text-accent group-open:inline">Done</span>
      </summary>
      <div className="grid gap-5 border-t border-edge/60 p-4 @xl:grid-cols-2 @4xl:grid-cols-3">{children}</div>
    </details>
  );
}
