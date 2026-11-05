import React from 'react';

/** Components a docs page (`src/pages/DocsContent/*`) can `import` directly —
 *  the reason Astro Starlight was reopened in favour of MDX (plan.md §17.1):
 *  a page can reach into `src/ui/` with no wrapper. */

export function Steps({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-steps my-6 relative border-l-2 border-accent/40 pl-6 space-y-6">
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
    <div className="ql-sheen rounded-xl border border-edge bg-surface-2/85 p-4 shadow-neu-rest backdrop-blur-sm transition duration-150 ease-out hover:-translate-y-0.5 hover:border-accent/50 hover:bg-surface-3/90 hover:shadow-neu-hover">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
        <h3 className="text-body font-semibold text-ink">{title}</h3>
      </div>
      <div className="mt-2 text-label text-ink-dim leading-relaxed">
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
    <div className="not-prose -mt-2 mb-8 flex flex-wrap gap-2 text-label text-ink-dim">
      {items.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2/80 px-2.5 py-1 text-label shadow-neu-rest backdrop-blur-sm"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">{item.label}:</span>
          <span className="font-medium text-ink">{item.value}</span>
        </span>
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
      className="not-prose ql-sheen mb-8 rounded-xl border border-edge bg-surface-2/80 p-3 shadow-neu-rest backdrop-blur-sm"
    >
      <div className="mb-2 flex items-center gap-2">
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 text-accent"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2.5 4h11M2.5 8h7M2.5 12h10" strokeLinecap="round" />
        </svg>
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">Contents</span>
        <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
          {items.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="inline-flex items-center gap-1 rounded-md border border-edge/60 bg-surface/60 px-2 py-1 text-label text-ink-dim transition duration-150 hover:border-accent/40 hover:bg-surface-3 hover:text-ink"
          >
            <span className="font-mono text-[10px] text-ink-dim/40" aria-hidden="true">#</span>
            <span>{item.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}

export type CalloutType = 'note' | 'tip' | 'warning' | 'info';

interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: React.ReactNode;
}

/**
 * A boxed aside for the one thing on a page that must not be skimmed past —
 * the disclaimer-banner idea (plan.md §12), scoped to a single doc page
 * rather than the whole app. STRICTLY ZERO EMOJIS — clean SVG line icons only.
 */
export function Callout({ type = 'note', title, children }: CalloutProps) {
  const styles: Record<CalloutType, { border: string; bg: string; iconColor: string; label: string }> = {
    note: {
      border: 'border-accent/60',
      bg: 'bg-accent-soft/40',
      iconColor: 'text-accent',
      label: 'Note',
    },
    tip: {
      border: 'border-stage-optimize/60',
      bg: 'bg-stage-optimize/10',
      iconColor: 'text-stage-optimize',
      label: 'Tip',
    },
    warning: {
      border: 'border-evict/60',
      bg: 'bg-evict/10',
      iconColor: 'text-evict',
      label: 'Warning',
    },
    info: {
      border: 'border-stage-buffer/60',
      bg: 'bg-stage-buffer/10',
      iconColor: 'text-stage-buffer',
      label: 'Important',
    },
  };

  const style = styles[type] ?? styles.note;

  return (
    <div
      role="note"
      className={`not-prose ql-sheen my-6 rounded-xl border ${style.border} ${style.bg} p-4 shadow-neu-rest backdrop-blur-sm text-body leading-relaxed text-ink [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold`}
    >
      <div className="mb-2 flex items-center gap-2">
        <svg
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 ${style.iconColor}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          {type === 'warning' ? (
            <path d="M8 2.5L14 13.5H2L8 2.5ZM8 6V9M8 11.5V12" strokeLinecap="round" strokeLinejoin="round" />
          ) : type === 'tip' ? (
            <path d="M8 2A4 4 0 004 6c0 1.5.8 2.8 2 3.5V11a1 1 0 001 1h2a1 1 0 001-1V9.5c1.2-.7 2-2 2-3.5a4 4 0 00-4-4zM6.5 14h3" strokeLinecap="round" />
          ) : (
            <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 5v.5M8 7.5V11" strokeLinecap="round" />
          )}
        </svg>
        <span className="font-mono text-label font-semibold tracking-wide uppercase text-ink">
          {title ?? style.label}
        </span>
      </div>
      <div className="text-body text-ink/90">
        {children}
      </div>
    </div>
  );
}
