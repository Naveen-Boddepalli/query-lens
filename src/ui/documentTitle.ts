import { useEffect } from 'react';
import { NAV_ITEMS } from '../routes.ts';

/**
 * Each route's own browser-tab title (WCAG 2.4.2, *Page Titled*). Before this every page kept `index.html`'s, so
 * every tab, history entry and bookmark read the same and a screen reader announced the same name on every page.
 * The page names itself — `PageHeader` does it from its heading, the few pages without one call the hook — and the
 * section it sits under comes from the address, so nothing is named twice.
 *
 * Set from an effect rather than by rendering a `<title>`: React 19 hoists a rendered one into `<head>` *after*
 * `index.html`'s own, and the browser shows the first.
 */

/** `index.html`'s title, which is the landing page's: the site's name and what it does (a test holds them equal). */
export const DEFAULT_TITLE = 'QueryLens — watch a SQL query become a B+Tree traversal';

/**
 * `Crash recovery · Tools · QueryLens`: the page, then the section it sits in when it is one level down
 * (`/tools/…`, `/learn/…`, `/challenges/…`, `/stages/…`, `/docs/…` — the nav's own labels), then the site.
 */
export function titleFor(page: string, pathname: string): string {
  const [first, ...rest] = pathname.split('/').filter((s) => s !== '');
  const section = rest.length > 0 ? NAV_ITEMS.find((item) => item.path === `/${first ?? ''}`)?.label : undefined;
  return [page, section, 'QueryLens'].filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

/** Names the page in the browser tab, and again whenever `page` changes (a lesson's "next" keeps the component). */
export function useDocumentTitle(page: string): void {
  useEffect(() => {
    document.title = titleFor(page, window.location.pathname);
  }, [page]);
}

/** The landing page's title — `DEFAULT_TITLE`, set again for a visitor who arrives back at `/` from another page. */
export function useDefaultDocumentTitle(): void {
  useEffect(() => {
    document.title = DEFAULT_TITLE;
  }, []);
}
