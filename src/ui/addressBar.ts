import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * The address bar as a page's state (plan.md §8: the URL is the app's only
 * persistence layer). The encoding lives with each page, the Playground's in
 * `urlState.ts`; this is only the writing, kept apart from that module because
 * it imports the engine, and a tool that has no use for it must not download it.
 */

/**
 * Writes a page's query string into the address bar — the one place the app
 * does. Pages reach it through `useAddressBarQuery`, or from a click handler
 * with their own `useLocation()` path.
 *
 * `replaceState`, never `pushState`: stepping a 33-event trace would otherwise
 * bury the previous page under 33 history entries and make Back useless.
 *
 * `pathname` is the page the write belongs to, and a write for any other is
 * dropped. React Router renders a navigation as a transition, so a nav-link
 * click moves the address bar at once while the page it leaves keeps running
 * until the transition commits and its effects are cleaned up. A write that
 * ran in that gap used to put the old page's parameters on the new one
 * (`/tools?q=SELECT…`).
 */
export function writeAddressBar(query: string, pathname: string): void {
  if (typeof history === 'undefined') return;
  if (location.pathname !== pathname) return;
  const next = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (next === `${location.pathname}${location.search}${location.hash}`) return;
  history.replaceState(history.state, '', next);
}

/**
 * Keeps the address bar's query string in step with a page's state, `delay` ms
 * after it last changed. A page whose state changes on every keystroke or every
 * step of playback keeps the default; one that changes only on a click passes 0
 * and writes as soon as the change commits.
 *
 * The write lands on this page or nowhere. `useLocation()` is the path this
 * page was rendered for, and it keeps that value while a navigation away is
 * still pending, when `location.pathname` has already moved on.
 */
export function useAddressBarQuery(query: string, delay = 250): void {
  const { pathname } = useLocation();

  useEffect(() => {
    if (delay === 0) {
      writeAddressBar(query, pathname);
      return;
    }
    const timer = window.setTimeout(() => { writeAddressBar(query, pathname); }, delay);
    return () => { window.clearTimeout(timer); };
  }, [query, pathname, delay]);
}
