import type { ReactNode } from 'react';
import { eyebrow as eyebrowClass } from './primitives.ts';

/**
 * The shared header block every non-Playground page opens with: a small caps
 * eyebrow, a display-size title, and an optional dim lede — one rhythm so the
 * `/stages`, `/gallery`, `/examples`, `/compare` and `/settings` pages read as
 * one product rather than five variations on `text-heading font-semibold`.
 *
 * The title level defaults to `h2` because `TopNav`'s wordmark is the page's
 * `h1`; pass `as="h1"` where a route genuinely owns the top of the document.
 */
export function PageHeader({
  eyebrow,
  title,
  as: Tag = 'h2',
  children,
  className = '',
}: {
  eyebrow?: string;
  title: ReactNode;
  as?: 'h1' | 'h2';
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ql-enter ${className}`}>
      {eyebrow && <p className={eyebrowClass}>{eyebrow}</p>}
      <Tag className="mt-2 text-display font-semibold tracking-tight text-ink text-balance">
        {title}
      </Tag>
      {children && (
        <div className="mt-3 max-w-2xl text-body text-ink-dim">{children}</div>
      )}
    </div>
  );
}
