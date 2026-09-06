import { Link } from 'react-router-dom';
import { STAGES } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';
import { btnPrimary, btnSecondary } from './primitives.ts';

/**
 * The landing page's opening.
 *
 * One line saying what this is — the sentence the <title>, the OG card and the
 * old header already shared — then the way in. No hard rule under it: the
 * landing is meant to read as one page, so the hero just fades into the prose
 * below on the same surface.
 *
 * The big line is a styled `<p>`, not a heading: the wordmark in `TopNav` is
 * the document's `<h1>` and this only restates the title.
 */
export function Hero() {
  return (
    <section className="relative isolate overflow-hidden px-4 pt-16 pb-12 sm:px-8 lg:pt-24 lg:pb-16">
      <div aria-hidden className="ql-hero-backdrop" />

      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col items-start">
        <p className="text-hero font-semibold text-balance text-ink">
          Watch a SQL query become a B+Tree traversal.
        </p>

        <p className="mt-5 max-w-xl text-body text-ink-dim">
          A toy relational engine you can watch think. Type a query and it traces the whole
          thing — parser, planner, optimizer, executor, buffer pool, B+Tree, locks — one step at
          a time, stopping to ask what you think happens next.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link to="/playground" className={btnPrimary}>
            Open the playground
            <span aria-hidden>→</span>
          </Link>
          <Link to="/docs" className={btnSecondary}>
            Read the docs
          </Link>
        </div>

        <p className="mt-10 font-mono text-label text-ink-dim">
          {STAGES.map((stage, i) => (
            <span key={stage}>
              {i > 0 && <span className="text-ink-dim/50"> → </span>}
              {STAGE_META[stage].title.toLowerCase()}
            </span>
          ))}
        </p>
      </div>
    </section>
  );
}
