import { BUILD_SHA, BUILD_TIME, REPO_URL } from '../buildInfo.ts';

/**
 * plan.md §16.2 item 9, and §19.1's fifth job.
 *
 * `DisclaimerBanner` is a top bar and stays one — §12 wants the "simplified
 * model" framing unmissable, and a disclaimer in a footer is a disclaimer
 * nobody read. This is a *separate*, real footer: the quiet way deeper, below
 * the fold, for the visitor who has watched a trace and now wants the source,
 * the licence, or a way to file a bug.
 *
 * The build SHA is the reason this is not merely decorative. It makes every bug
 * report self-identifying — "it does X on 4f2a1c" is actionable in a way that
 * "it does X" is not — and it is the single clearest signal that an engineer
 * built the thing, which is exactly what §16 is for.
 */

/** One row of the link list. `external` is every one of them, for now. */
interface FooterLink {
  label: string;
  href: string;
  title: string;
}

const LINKS: FooterLink[] = [
  {
    label: 'Docs',
    // Points at the README until M11 builds the docs site, at which point this
    // becomes `/docs` and stops leaving the origin. Naming it "Docs" now rather
    // than after the site exists is deliberate: the link that is missing is the
    // one nobody clicks, and §19.1 counts an absent docs route as a failure.
    href: `${REPO_URL}#readme`,
    title: 'How QueryLens works, and what it deliberately simplifies',
  },
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

export function Footer() {
  const commitUrl = BUILD_SHA === 'unknown' ? null : `${REPO_URL}/commit/${BUILD_SHA}`;

  return (
    <footer className="border-t border-edge px-4 py-3 text-label text-ink-dim">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p>
          <span className="font-medium text-ink">QueryLens</span> — a toy database engine
          that shows its working.
        </p>

        <nav aria-label="Project links" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {LINKS.map((link) => (
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

        {/* Right-aligned and monospace: it is a machine identifier, and dressing
            it as prose would invite reading it as one. `tabular-nums` comes from
            the root rule, so the hex does not shuffle between builds. */}
        <p className="ml-auto font-mono" title={`Built ${BUILD_TIME}`}>
          build{' '}
          {commitUrl ? (
            <a
              href={commitUrl}
              className="cell underline-offset-2 hover:text-ink hover:underline"
            >
              {BUILD_SHA}
            </a>
          ) : (
            // A local build with no git and no CI. Saying so beats printing a
            // plausible-looking wrong SHA into someone's bug report.
            <span>unknown</span>
          )}
        </p>
      </div>
    </footer>
  );
}
