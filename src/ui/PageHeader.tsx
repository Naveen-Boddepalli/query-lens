import type { ReactNode } from 'react';
import { useDocumentTitle } from './documentTitle.ts';
import { eyebrow as eyebrowClass } from './primitives.ts';

/**
 * The shared header block every non-Playground page opens with: an optional
 * quiet kicker, a display-size title, and an optional dim lede — one rhythm so
 * the `/stages`, `/gallery`, `/examples`, `/compare` and `/settings` pages read
 * as one product rather than five variations on `text-heading font-semibold`.
 *
 * The title level defaults to `h2` because `TopNav`'s wordmark is the page's
 * `h1`; pass `as="h1"` where a route genuinely owns the top of the document.
 *
 * The title also names the browser tab (`documentTitle.ts`) — or `documentTitle`
 * does, where the heading says something a tab should not (an error message).
 */
export function PageHeader({
  eyebrow,
  title,
  documentTitle,
  as: Tag = 'h2',
  children,
  className = '',
}: {
  eyebrow?: string;
  title: string;
  documentTitle?: string;
  as?: 'h1' | 'h2';
  children?: ReactNode;
  className?: string;
}) {
  useDocumentTitle(documentTitle ?? title);
  return (
    <div className={className}>
      {eyebrow && <p className={`mb-2 ${eyebrowClass}`}>{eyebrow}</p>}
      <Tag className="text-display font-semibold tracking-tight text-balance text-ink">
        {title}
      </Tag>
      {children && (
        <div className="mt-3 max-w-2xl text-body text-ink-dim">{children}</div>
      )}
    </div>
  );
}
