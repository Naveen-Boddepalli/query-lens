import { Link } from 'react-router-dom';
import { STAGES } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';
import { HeroPrism } from './HeroPrism.tsx';
import { btnPrimary, btnSecondary } from './primitives.ts';

/**
 * The landing page's opening.
 *
 * One line saying what this is — the sentence the <title>, the OG card and the
 * old header already shared — then the way in, and beside it the prism
 * (`HeroPrism`) splitting a query into the eight stages. The stage chips under
 * the buttons are the same eight colours, and each one is a link to that
 * stage's own page, so the picture doubles as a table of contents.
 *
 * The big line is a styled `<p>`, not a heading: the wordmark in `TopNav` is
 * the document's `<h1>` and this only restates the title.
 */
export function Hero() {
  return (
    <section className="relative isolate overflow-hidden px-4 pt-14 pb-12 sm:px-8 lg:pt-20 lg:pb-16">
      <div aria-hidden="true" className="ql-hero-backdrop" />
      <div aria-hidden="true" className="ql-hero-grid" />

      <div className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
        <div className="flex flex-col items-start">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-edge bg-surface-2/70 px-3 py-1 text-label text-ink-dim shadow-e1 backdrop-blur">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-stage-result shadow-[0_0_8px_var(--color-stage-result)]" />
            A real engine, small enough to watch
          </p>

          <p className="text-hero font-semibold text-balance text-ink">
            Watch a SQL query become a{' '}
            <span className="ql-spectrum-text">B+Tree traversal.</span>
          </p>

          <p className="mt-5 max-w-xl text-body text-ink-dim">
            A toy relational engine you can watch think. Type a query and it traces the whole
            thing — parser, planner, optimizer, executor, buffer pool, B+Tree, locks — one step at
            a time, stopping to ask what you think happens next.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/playground" className={`${btnPrimary} px-5 py-2.5`}>
              Open the playground
              <span aria-hidden="true">→</span>
            </Link>
            <Link to="/docs" className={btnSecondary}>
              Read the docs
            </Link>
          </div>

          <nav aria-label="The eight stages" className="mt-10">
            <ul className="flex flex-wrap gap-1.5">
              {STAGES.map((stage) => {
                const meta = STAGE_META[stage];
                return (
                  <li key={stage}>
                    <Link
                      to={meta.doc}
                      title={meta.blurb}
                      className={`group inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2/60 px-2.5 py-1 font-mono text-label transition hover:-translate-y-px hover:border-current hover:bg-surface-3 ${meta.tone}`}
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      <span className="text-ink-dim transition-colors group-hover:text-ink">
                        {meta.title.toLowerCase()}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        <div className="hidden md:block">
          <HeroPrism />
        </div>
      </div>
    </section>
  );
}
