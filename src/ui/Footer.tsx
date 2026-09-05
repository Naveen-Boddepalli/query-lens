import { Link } from 'react-router-dom';
import { REPO_URL } from '../buildInfo.ts';
import { NAV_ITEMS } from '../routes.ts';

/**
 * plan.md §16.2 item 9, and §19.1's fifth job.
 *
 * `DisclaimerBanner` is a top bar and stays one — §12 wants the "simplified
 * model" framing unmissable, and a disclaimer in a footer is a disclaimer
 * nobody read. This is a *separate*, real footer: the quiet way deeper, below
 * the fold, for the visitor who has watched a trace and now wants the source,
 * the licence, or a way to file a bug. (The build SHA that identifies a bug
 * report lives in the served HTML and the console banner — see index.html and
 * src/ui/errorReport.ts — not in visible footer text.)
 *
 * The internal links come from `src/routes.ts` (the `footer` flag), the same
 * source the top nav reads, so "Docs" cannot mean two different paths in the
 * two places (plan.md §21.5 item 6).
 */

interface ExternalLink {
  label: string;
  href: string;
  title: string;
}

const EXTERNAL_LINKS: ExternalLink[] = [
  { label: 'GitHub', href: REPO_URL, title: 'Source, issues and discussions' },
  {
    label: 'Licence',
    href: `${REPO_URL}/blob/main/LICENSE`,
    title: 'MIT for the code; the bundled fonts are OFL 1.1 (see NOTICE)',
  },
  {
    label: 'Changelog',
    href: `${REPO_URL}/blob/main/CHANGELOG.md`,
    title: 'What changed, and when',
  },
];

const INTERNAL_LINKS = NAV_ITEMS.filter((item) => item.footer);

export function Footer() {
  return (
    <footer className="border-t border-edge px-4 py-3 text-label text-ink-dim">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p>
          <span className="font-medium text-ink">QueryLens</span> — a toy database engine
          that shows its working.
        </p>

        <nav aria-label="Project links" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {INTERNAL_LINKS.map((link) => (
            <Link
              key={link.path}
              to={link.path}
              className="cell underline-offset-2 hover:text-ink hover:underline"
            >
              {link.label}
            </Link>
          ))}
          {EXTERNAL_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              title={link.title}
              className="cell underline-offset-2 hover:text-ink hover:underline"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
