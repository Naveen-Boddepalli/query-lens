import { useId, type ReactNode } from 'react';
import { card } from '../primitives.ts';

export interface ToolSectionProps {
  title: ReactNode;
  /** One or two sentences on what the section shows. */
  description?: ReactNode;
  /** The section's own controls, in its header: they change this section only, not the live model above. */
  controls?: ReactNode;
  children: ReactNode;
}

/**
 * A deep-dive section below the live model (§4.1): a comparison table, the same script four ways, bushy plans. One
 * card style, a heading, and a header slot for controls that belong to this section alone.
 */
export function ToolSection({ title, description, controls, children }: ToolSectionProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={`${card} flex min-w-0 flex-col gap-3`}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-body font-semibold text-ink">
            {title}
          </h3>
          {description && <p className="mt-1 max-w-3xl text-label text-ink-dim">{description}</p>}
        </div>
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      </header>
      {children}
    </section>
  );
}
