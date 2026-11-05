import { Link } from 'react-router-dom';
import { REPO_URL } from '../buildInfo.ts';
import { NAV_ITEMS } from '../routes.ts';
import { Logo, VersionBadge } from './Logo.tsx';

interface FooterLink {
  label: string;
  href: string;
  title?: string;
  external?: boolean;
}

const PRIMARY_NAV_LINKS: FooterLink[] = NAV_ITEMS.filter((item) => item.nav).map(
  (item) => ({ label: item.label, href: item.path }),
);

const SANDBOX_LINKS: FooterLink[] = [
  { label: 'B+Tree sandbox', href: '/tools/btree' },
  { label: 'Buffer pool sandbox', href: '/tools/buffer-pool' },
  { label: 'Parser sandbox', href: '/tools/parser' },
  { label: 'Planner sandbox', href: '/tools/planner' },
  { label: 'Slotted page inspector', href: '/tools/page' },
  { label: 'External merge sort', href: '/tools/sort' },
  { label: 'Locks sandbox', href: '/tools/locks' },
  { label: 'Hash join sandbox', href: '/tools/hash-join' },
  { label: 'Grammar sandbox', href: '/tools/grammar' },
];

const LEARNING_LINKS: FooterLink[] = [
  { label: 'Interactive lessons', href: '/learn' },
  { label: 'Challenges', href: '/challenges' },
  { label: 'Your progress', href: '/progress' },
  { label: 'Architecture guide', href: '/docs/architecture' },
  { label: 'How QueryLens works', href: '/docs' },
  { label: 'Buffer pool concept', href: '/docs/concepts/buffer-pool' },
  { label: 'B+Tree index concept', href: '/docs/concepts/btree' },
  { label: 'Supported SQL', href: '/docs/reference/sql' },
  { label: 'Engine limits', href: '/docs/reference/limits' },
  { label: 'FAQ', href: '/docs/faq' },
];

const META_LINKS: FooterLink[] = [
  { label: 'GitHub repository', href: REPO_URL, title: 'Source, issues and discussions', external: true },
  { label: 'MIT Licence', href: `${REPO_URL}/blob/main/LICENSE`, external: true },
  { label: 'Docs licence (CC BY 4.0)', href: `${REPO_URL}/blob/main/LICENSE-DOCS`, external: true },
  { label: 'Changelog', href: `${REPO_URL}/blob/main/CHANGELOG.md`, external: true },
  {
    label: 'Report an issue',
    href: `${REPO_URL}/issues/new/choose`,
    title: 'Pick a bug report, a confusing step, or a feature request on GitHub',
    external: true,
  },
  ...NAV_ITEMS.filter((item) => item.footer && item.path !== '/challenges' && item.path !== '/progress').map(
    (item) => ({ label: item.label, href: item.path }),
  ),
];

function FooterColumn({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <nav aria-label={title}>
      <h2 className="mb-3 text-label font-mono font-medium tracking-[0.14em] text-ink-dim uppercase">{title}</h2>
      <ul className="space-y-2 text-label">
        {links.map((link) =>
          link.external ? (
            <li key={link.label}>
              <a
                href={link.href}
                title={link.title}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-ink-dim underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
              >
                {link.label}
                <span aria-hidden="true" className="text-ink-dim/50">
                  ↗
                </span>
              </a>
            </li>
          ) : (
            <li key={link.label}>
              <Link
                to={link.href}
                title={link.title}
                className="text-ink-dim underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
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
    <footer className="border-t border-edge bg-surface-2/60 px-4 py-12 text-ink-dim backdrop-blur-sm sm:px-8">
      <div className="mx-auto max-w-6xl">
        {/* Brand Header Block */}
        <div className="mb-10 flex flex-col gap-4 border-b border-edge/80 pb-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link to="/" className="flex items-center gap-2.5 text-ink transition hover:opacity-90">
              <Logo className="h-7 w-7" />
              <div className="flex items-center gap-2">
                <span className="text-heading font-semibold text-ink">QueryLens</span>
                <VersionBadge />
              </div>
            </Link>
            <p className="mt-2.5 max-w-md text-label leading-relaxed text-ink-dim">
              An in-browser educational database engine that shows its working — every SQL query traced
              through the parser, planner, buffer pool, and B+Tree index, one step at a time.
            </p>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div
              className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface/80 px-3 py-1 font-mono text-xs text-ink-dim shadow-neu-rest backdrop-blur-sm select-none"
              title="Execution environment: in-memory WebAssembly / TypeScript runtime"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hit opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-hit" />
              </span>
              <span>Engine: 100% Client-Side In-Memory WASM</span>
            </div>
            <p className="font-mono text-[11px] text-ink-dim">Zero server calls · Zero analytics</p>
          </div>
        </div>

        {/* Four Navigation Columns */}
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <FooterColumn title="Primary Navigation" links={PRIMARY_NAV_LINKS} />
          <FooterColumn title="Database Sandboxes" links={SANDBOX_LINKS} />
          <FooterColumn title="Learning & Verification" links={LEARNING_LINKS} />
          <FooterColumn title="Engine & Meta" links={META_LINKS} />
        </div>

        {/* Technical Footer Bar */}
        <div className="mt-10 border-t border-edge/80 pt-6">
          <div className="flex flex-col gap-3 text-label sm:flex-row sm:items-center sm:justify-between text-ink-dim font-mono text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>MIT Licence</span>
              <span aria-hidden="true" className="text-edge">·</span>
              <span>CC BY 4.0 docs</span>
              <span aria-hidden="true" className="text-edge">·</span>
              <span>100% Client-Side In-Memory Engine</span>
              <span aria-hidden="true" className="text-edge">·</span>
              <span>No telemetry</span>
            </div>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-ink underline-offset-2 hover:underline"
            >
              GitHub repository
              <span aria-hidden="true">↗</span>
            </a>
          </div>

          <p className="mt-4 text-label text-ink-dim leading-relaxed">
            QueryLens is a simplified educational model, not a production database. See the{' '}
            <Link to="/docs/faq" className="underline underline-offset-2 hover:text-ink">
              FAQ
            </Link>{' '}
            for exactly where it diverges from a real engine.
          </p>
        </div>
      </div>
    </footer>
  );
}
