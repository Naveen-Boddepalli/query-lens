/** Components a docs page (`src/pages/DocsContent/*`) can `import` directly —
 *  the reason Astro Starlight was reopened in favour of MDX (plan.md §17.1):
 *  a page can reach into `src/ui/` with no wrapper. */

export function Steps({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-steps border-l-2 border-accent/40 pl-6 my-6 space-y-6">
      {children}
    </div>
  );
}

export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="not-prose grid gap-4 sm:grid-cols-2 my-6">
      {children}
    </div>
  );
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ql-sheen cell rounded-xl border border-edge bg-surface-2 p-4 shadow-e1 transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-e2">
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      <div className="mt-2 text-label text-ink-dim">
        {children}
      </div>
    </div>
  );
}

/**
 * The metadata line under a doc page's title — who it is for, and any other
 * fact worth knowing before reading further (a model boundary, a version).
 * `not-prose`: this is a data row, not paragraph text, so it opts out of the
 * plugin's body styling rather than being squeezed into it.
 */
export function DocMeta({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="not-prose -mt-2 mb-8 flex flex-wrap gap-x-6 gap-y-1 text-label text-ink-dim">
      {items.map((item) => (
        <p key={item.label}>
          <span className="font-medium text-ink">{item.label}:</span> {item.value}
        </p>
      ))}
    </div>
  );
}

/**
 * An on-this-page line of jump links. Written by hand per page rather than
 * derived from the MDX at build time — there is no heading tree available at
 * the point a page authors this — but each `href` lands correctly because
 * `rehype-slug` (vite.config.ts) gives every rendered heading a matching
 * kebab-case `id`.
 */
export function Contents({ items }: { items: { href: string; label: string }[] }) {
  return (
    <nav
      aria-label="On this page"
      className="not-prose mb-8 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 border-y border-edge py-3 text-label text-ink-dim"
    >
      <span className="mr-1 font-medium text-ink">Contents</span>
      {items.map((item, i) => (
        <span key={item.href}>
          {i > 0 && <span className="mr-1.5 text-ink-dim/50" aria-hidden>·</span>}
          <a href={item.href} className="underline underline-offset-2 hover:text-ink">
            {item.label}
          </a>
        </span>
      ))}
    </nav>
  );
}

/**
 * A boxed aside for the one thing on a page that must not be skimmed past —
 * the disclaimer-banner idea (plan.md §12), scoped to a single doc page
 * rather than the whole app.
 */
export function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="not-prose ql-sheen my-6 flex gap-3 rounded-xl border border-accent/40 border-l-2 border-l-accent bg-accent-soft px-4 py-3 text-body leading-relaxed text-ink shadow-e1 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold">
      <span aria-hidden className="mt-0.5 shrink-0 text-accent">
        ⓘ
      </span>
      <div>{children}</div>
    </div>
  );
}
