/**
 * The single source of truth for the app's top-level navigation (plan.md §21.5
 * item 6). Before this, `TopNav`, `Footer` and `App` each carried their own
 * copy of the path/label pairs and they had already drifted — the footer
 * pointed `/docs` at a README anchor after the docs moved into the app. Now a
 * destination is named here once and shows up everywhere it should, or nowhere.
 *
 * The route *tree* still lives in `App.tsx`, written by hand: the stages and
 * docs sections have their own layouts, params and (for docs) nine MDX imports,
 * and threading that through a manifest would be less clear, not more. What is
 * shared is the navigation — what a destination is called and where it lives.
 *
 * The pipeline-stage sub-nav (`Sidebar`) is built from `STAGE_META`, the
 * canonical list of stages, and is not duplicated here.
 */
export interface NavItem {
  path: string;
  label: string;
  /** Passed to `NavLink`'s `end` — only the index route needs exact matching. */
  end?: boolean;
  /** Shown in the primary header nav. */
  nav?: boolean;
  /** Surfaced in the footer's "Project" column (plan.md §16.2 item 9). */
  footer?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  // `/` is the landing hub (reached via the wordmark), not a nav item; the
  // Playground now has its own route. Old `/?q=...` links redirect to it
  // (App.tsx's IndexRoute).
  { path: '/playground', label: 'Playground', nav: true },
  { path: '/stages', label: 'Stages', nav: true },
  { path: '/gallery', label: 'Gallery', nav: true },
  { path: '/tools', label: 'Tools', nav: true },
  { path: '/compare', label: 'Compare', nav: true },
  { path: '/examples', label: 'Examples', nav: true },
  { path: '/docs', label: 'Docs', nav: true },
  // Quiet on purpose (plan.md §21.2): settings and the assignment authoring
  // tool are for a returning visitor or an instructor, not the first fifteen
  // seconds a cold visitor sees, so neither is in the primary nav — only in
  // the footer's Project column.
  { path: '/settings', label: 'Settings', footer: true },
  { path: '/assignments/new', label: 'Create an assignment', footer: true },
] as const;
