import { Link } from 'react-router-dom';
import { STAGES } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';
import { btnPrimary, btnSecondary, eyebrow } from './primitives.ts';

/**
 * The landing page's opening band.
 *
 * It answers "what is this" in one line — the canonical sentence the <title>,
 * the OG card and the old header already shared — then points at the tool: the
 * primary button opens `/playground`, which runs its first trace on load
 * (plan.md §15.1 item 1).
 *
 * Rendered by `LandingPage`, inside the (non-fixed, on `/`) app shell, so the
 * hero, the intro and the tool cards below it scroll as one normal document.
 * Height is reserved with `min-h` so the webfont swap cannot shift it. The big
 * line is a styled `<p>`, not a heading: the wordmark in `TopNav` is the
 * document's `<h1>` and this line only restates the title.
 */
export function Hero() {
  return (
    <section
      aria-label="QueryLens"
      className="relative isolate flex flex-col justify-center overflow-x-clip border-b border-edge bg-surface px-4 py-14 sm:px-8 lg:min-h-[56vh] lg:py-16"
    >
      <div aria-hidden className="ql-hero-backdrop" />

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-start">
        <p className={`ql-enter ql-enter-1 ${eyebrow}`}>Interactive database internals</p>

        <p className="ql-enter ql-enter-2 mt-4 max-w-3xl text-hero font-semibold text-balance text-ink">
          Watch a SQL query become a B+Tree traversal.
        </p>

        <p className="ql-enter ql-enter-3 mt-5 max-w-xl text-body text-ink-dim">
          A toy relational engine that shows its working — your query, traced one
          step at a time through the parser, planner, optimizer, executor, buffer
          pool, index and locks. Predict what happens next, then watch it run.
        </p>

        <div className="ql-enter ql-enter-4 mt-8 flex flex-wrap items-center gap-3">
          <Link to="/playground" className={btnPrimary}>
            Open the playground
            <span aria-hidden>→</span>
          </Link>
          <Link to="/docs" className={btnSecondary}>
            Read the docs
          </Link>
        </div>

        <ol
          aria-label="The pipeline a query passes through"
          className="ql-enter ql-enter-4 mt-12 flex flex-wrap items-center gap-x-2 gap-y-2 text-label text-ink-dim"
        >
          {STAGES.map((stage, i) => (
            <li key={stage} className="flex items-center gap-2">
              {i > 0 && (
                <span aria-hidden className="text-ink-dim/40">
                  →
                </span>
              )}
              <span className="rounded-full border border-edge bg-surface-2/60 px-2.5 py-1 backdrop-blur-sm">
                {STAGE_META[stage].title}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
