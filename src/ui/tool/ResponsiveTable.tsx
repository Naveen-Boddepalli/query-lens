import type { ReactNode } from 'react';
import { ScrollRegion } from '../ScrollRegion.tsx';

/**
 * A table that survives a phone (§4.5 rule 3): it scrolls inside its card, the edge with more behind it fades, and
 * the first column (the row's name) stays put while the rest scrolls under it. `label` names the scroll region for
 * the keyboard and a screen reader; give the table its own `<caption>` too.
 */
export function ResponsiveTable({
  label,
  stickyFirstColumn = true,
  children,
}: {
  label: string;
  stickyFirstColumn?: boolean;
  children: ReactNode;
}) {
  return (
    <ScrollRegion label={label} className="min-w-0 overflow-x-auto" stickyFirst={stickyFirstColumn}>
      {children}
    </ScrollRegion>
  );
}
