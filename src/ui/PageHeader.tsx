import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from './documentTitle.ts';
import { eyebrow as eyebrowClass } from './primitives.ts';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export interface PageHeaderProps {
  eyebrow?: string;
  breadcrumbs?: BreadcrumbItem[];
  title: ReactNode;
  documentTitle?: string;
  as?: 'h1' | 'h2';
  blurb?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * The shared header block every non-Playground page opens with:
 * - Optional technical breadcrumbs navigation trail or category eyebrow kicker.
 * - Display-size title with subtle gradient sheen.
 * - Explanatory prose blurb or children.
 * - Optional right-aligned action toolbar slot.
 *
 * The title level defaults to `h2` because `TopNav`'s wordmark is the page's
 * `h1`; pass `as="h1"` where a route genuinely owns the top of the document.
 */
export function PageHeader({
  eyebrow,
  breadcrumbs,
  title,
  documentTitle,
  as: Tag = 'h2',
  blurb,
  children,
  actions,
  className = '',
}: PageHeaderProps) {
  const effectiveDocTitle = documentTitle ?? (typeof title === 'string' ? title : '');
  useDocumentTitle(effectiveDocTitle);

  const content = blurb ?? children;

  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumbs" className="mb-2 flex flex-wrap items-center gap-1.5 text-label font-mono">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <span key={`${crumb.label}-${idx}`} className="inline-flex items-center gap-1.5">
                  {crumb.to && !isLast ? (
                    <Link
                      to={crumb.to}
                      className="text-ink-dim transition-colors duration-150 hover:text-ink hover:underline underline-offset-2"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className={isLast ? 'text-ink font-medium' : 'text-ink-dim'}>
                      {crumb.label}
                    </span>
                  )}
                  {!isLast && (
                    <span aria-hidden="true" className="text-edge select-none">
                      /
                    </span>
                  )}
                </span>
              );
            })}
          </nav>
        ) : eyebrow ? (
          <p className={`mb-2 ${eyebrowClass}`}>{eyebrow}</p>
        ) : null}

        <Tag className="text-display font-semibold tracking-tight text-balance text-ink">
          <span className="bg-gradient-to-r from-ink via-ink to-ink-dim bg-clip-text text-transparent">
            {title}
          </span>
        </Tag>

        {content && (
          <div className="mt-3 max-w-2xl text-body text-ink-dim leading-relaxed">
            {content}
          </div>
        )}
      </div>

      {actions && (
        <div className="flex shrink-0 items-center gap-2 pt-1 sm:pt-0">
          {actions}
        </div>
      )}
    </div>
  );
}
