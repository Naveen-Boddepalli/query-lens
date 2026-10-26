import type { ReactNode } from 'react';

/**
 * A table that is wider than its column scrolls, and a box that scrolls has to be reachable from the keyboard
 * (WCAG 2.1.1; axe's `scrollable-region-focusable`): a table of plain text has nothing focusable inside it, so
 * without a tab stop on the box its overflow cannot be reached without a pointer. This is that tab stop, with a name
 * so the region is announced as what it holds.
 *
 * `className` is the whole of the box's classes, overflow included: some of these scroll on both axes, some on one.
 */
export function ScrollRegion({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label={label} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
