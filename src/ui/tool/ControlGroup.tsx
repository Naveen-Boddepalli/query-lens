import type { ReactNode } from 'react';

export interface ControlGroupProps {
  /** The group's name, in sentence case ("Workload", "Pool"). */
  legend: string;
  /** An expert group: collapsed behind its legend, with the number of controls it hides. */
  advanced?: boolean;
  /** How many controls an `advanced` group holds, shown as "Advanced (2)". */
  count?: number;
  defaultOpen?: boolean;
  /** `ControlRow`s. No prose: a control's help is its row's hint. */
  children: ReactNode;
}

const body = 'flex min-w-0 flex-col gap-3';
const legendClass = 'text-label font-semibold text-ink';

/**
 * A named set of parameters in the inspector. A plain group is a `fieldset`, so its legend names every control in
 * it for a screen reader. An advanced one is a disclosure whose summary is the legend.
 */
export function ControlGroup({ legend, advanced = false, count, defaultOpen = false, children }: ControlGroupProps) {
  if (advanced) {
    return (
      <details open={defaultOpen} className="group min-w-0">
        <summary className={`${legendClass} flex cursor-pointer items-center gap-1.5 select-none`}>
          <span aria-hidden="true" className="text-ink-dim transition-transform group-open:rotate-90">▸</span>
          {legend}
          {count !== undefined && <span className="font-normal text-ink-dim">({count})</span>}
        </summary>
        <div role="group" aria-label={legend} className={`${body} mt-3`}>
          {children}
        </div>
      </details>
    );
  }

  return (
    <fieldset className={`${body} m-0 border-0 p-0`}>
      <legend className={`${legendClass} mb-3 p-0`}>{legend}</legend>
      {children}
    </fieldset>
  );
}
