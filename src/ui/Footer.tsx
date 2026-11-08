import { Link } from 'react-router-dom';
import { newIssueUrl, REPO_URL } from '../buildInfo.ts';
import { DOCS_NAV } from '../docsNav.ts';
import { NAV_ITEMS } from '../routes.ts';
import { Logo } from './Logo.tsx';

/**
 * plan.md §16.2 item 9, and §19.1's fifth job.
 *
 * `DisclaimerBanner` is a top bar and stays one — §12 wants the "simplified
 * model" framing unmissable, and a disclaimer in a footer is a disclaimer
 * nobody read. This is a *separate*, real footer: the quiet way deeper, below
 * the fold, for the visitor who has watched a trace and now wants the source,
 * the docs, or a way to file a bug. (The build SHA that identifies a bug
 * report lives in the served HTML and the console banner — see index.html and
 * src/ui/errorReport.ts — not in visible footer text.)
 *
 * Four blocks — a brand block plus three labelled columns — rather than the
 * single row of links this used to be: the app now has enough real
 * destinations (§21.3) that one row would wrap illegibly. "Explore" reads
 * straight off `src/routes.ts`'s primary nav, so it cannot drift from what the
 * header itself offers; "Documentation" is a curated five of the docs site's
 * nine pages (`src/docsNav.ts` has the rest) — a footer column is a map, not
 * a table of contents.
 */

interface FooterLink {
  label: string;
  href: string;
  title?: string;
  external?: boolean;
}

const EXPLORE_LINKS: FooterLink[] = NAV_ITEMS.filter((item) => item.nav && item.path !== '/docs').map(
  (item) => ({ label: item.label, href: item.path }),
);

// The "Introduction" group's three items, verbatim from `docsNav.ts`, plus a
// hand-picked entry point into each of the other two groups — a footer column
// is a map into the docs site, not a copy of its sidebar.
const DOCS_LINKS: FooterLink[] = [
  ...(DOCS_NAV.find((g) => g.title === 'Introduction')?.items ?? []),
  { to: DOCS_NAV.find((g) => g.title === 'Concepts')?.items[0]?.to ?? '/docs', label: 'Concepts' },
  { to: DOCS_NAV.find((g) => g.title === 'Reference')?.items[0]?.to ?? '/docs', label: 'Reference' },
].map((item) => ({ label: item.label, href: item.to }));

const PROJECT_LINKS: FooterLink[] = [
  { label: 'GitHub', href: REPO_URL, title: 'Source, issues and discussions', external: true },
  {
    label: 'Licence',
    href: `${REPO_URL}/blob/main/LICENSE`,
    title: 'MIT for the code; the bundled fonts are OFL 1.1 (see NOTICE); this documentation is CC BY 4.0 (see LICENSE-DOCS)',
    external: true,
  },
  {
    label: 'Docs licence',
    href: `${REPO_URL}/blob/main/LICENSE-DOCS`,
    title: 'CC BY 4.0 — the terms for reusing this documentation\'s prose',
    external: true,
  },
  { label: 'Changelog', href: `${REPO_URL}/blob/main/CHANGELOG.md`, title: 'What changed, and when', external: true },
  {
    label: 'Report an issue',
    href: newIssueUrl('', 'What happened, and the query / step you were on when it did:\n\n'),
    title: 'Opens a pre-fillable issue on GitHub',
    external: true,
  },
  ...NAV_ITEMS.filter((item) => item.footer).map((item) => ({ label: item.label, href: item.path })),
];

function FooterColumn({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <nav aria-label={title}>
      <h2 className="mb-3 text-label font-medium tracking-[0.14em] text-ink-dim uppercase">{title}</h2>
      <ul className="space-y-2 text-label">
        {links.map((link) =>
          link.external ? (
            <li key={link.label}>
              <a
                href={link.href}
                title={link.title}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-ink-dim underline-offset-2 hover:text-ink hover:underline"
              >
                {link.label}
                <span aria-hidden="true" className="text-ink-dim/60">
                  ↗
                </span>
              </a>
            </li>
          ) : (
            <li key={link.label}>
              <Link
                to={link.href}
                title={link.title}
                className="text-ink-dim underline-offset-2 hover:text-ink hover:underline"
              >
                {link.label}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-edge bg-surface-2/30 px-4 py-10 text-ink-dim sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
        <div>
          <Link to="/" className="flex items-center gap-2.5 text-ink transition hover:opacity-90">
            <Logo className="h-7 w-7" />
            <span className="text-heading font-semibold text-ink">QueryLens</span>
          </Link>
          <p className="mt-3 max-w-xs text-label leading-relaxed">
            An in-browser toy database engine that shows its working — every SQL query, traced
            through the parser, planner, buffer pool and B+Tree index, one step at a time.
          </p>
          <p className="mt-4 inline-flex flex-wrap items-center gap-x-1.5 rounded-full border border-edge bg-surface-2 px-3 py-1 text-label text-ink-dim shadow-e1">
            <span>MIT</span>
            <span aria-hidden="true" className="text-ink-dim/50">
              ·
            </span>
            <span>CC BY 4.0 docs</span>
            <span aria-hidden="true" className="text-ink-dim/50">
              ·
            </span>
            <span>no telemetry</span>
          </p>
        </div>

        <FooterColumn title="Explore" links={EXPLORE_LINKS} />
        <FooterColumn title="Documentation" links={DOCS_LINKS} />
        <FooterColumn title="Project" links={PROJECT_LINKS} />
      </div>

      <p className="mx-auto mt-8 max-w-6xl border-t border-edge pt-4 text-label text-ink-dim/80">
        QueryLens is a simplified educational model, not a production database. See the{' '}
        <Link to="/docs/faq" className="underline underline-offset-2 hover:text-ink">
          FAQ
        </Link>{' '}
        for exactly where it diverges from a real engine.
      </p>
    </footer>
  );
}
