import { useId, type ReactNode } from 'react';
import { panelSurface } from '../primitives.ts';
import { Segmented, type SegmentedOption } from './Segmented.tsx';

export interface StagePanelProps<V extends string = string> {
  title: ReactNode;
  /** A key to what the colours and marks mean. */
  legend?: ReactNode;
  /** Ways to show the same model ("Diagram", "Table"): a small segmented switch in the header. */
  views?: readonly SegmentedOption<V>[];
  view?: V;
  onView?: (view: V) => void;
  /** More header controls: zoom and fit buttons, a download. */
  toolbar?: ReactNode;
  children: ReactNode;
}

/**
 * The frame the visualization sits in (§4.1): a header with its title, legend and view controls, then the canvas at
 * the full width of the stage column. Tinted by the tool family's `--stage` (`.ql-stage-panel`), and at least
 * `--stage-min-h` tall from `lg` up so the diagram, not the controls, is the biggest thing on the page.
 */
export function StagePanel<V extends string = string>({ title, legend, views, view, onView, toolbar, children }: StagePanelProps<V>) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={`${panelSurface} ql-stage-panel relative flex min-w-0 flex-col lg:min-h-(--stage-min-h)`}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge/60 px-4 py-2.5">
        <h3 id={titleId} className="text-body font-semibold text-ink">
          {title}
        </h3>
        <div className="min-w-0 flex-1 text-label text-ink-dim">{legend}</div>
        {views && view !== undefined && onView && (
          <Segmented size="sm" tone="stage" label="View" value={view} onChange={onView} options={views} />
        )}
        {toolbar && <div className="flex items-center gap-1">{toolbar}</div>}
      </header>
      <div className="flex min-w-0 flex-1 flex-col p-4">{children}</div>
    </section>
  );
}
