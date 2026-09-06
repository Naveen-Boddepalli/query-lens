import { Link } from 'react-router-dom';
import { Hero } from '../ui/Hero.tsx';
import { cardInteractive, eyebrow } from '../ui/primitives.ts';

/**
 * The landing hub (`/`).
 *
 * Hero → a short "how it works" band → a grid of tool cards, each opening its
 * own page. The Playground itself is the hero's primary button rather than a
 * card, because it is the main act and the giant CTA already points at it; the
 * grid is for the side routes. `TOOLS` is the list to extend as more standalone
 * tools land — one entry each.
 *
 * Old `/?q=...` Playground links never reach this component: `App.tsx`'s
 * `IndexRoute` redirects anything carrying share params to `/playground` first.
 */

interface Tool {
  eyebrow: string;
  title: string;
  blurb: string;
  to: string;
}

const TOOLS: Tool[] = [
  {
    eyebrow: 'Deep links',
    title: 'Gallery',
    blurb:
      'Named moments in the pipeline — the eviction storm, the optimizer rewrite — each a link that opens the Playground already stepped to that exact point.',
    to: '/gallery',
  },
  {
    eyebrow: 'Side by side',
    title: 'Compare',
    blurb:
      'One access pattern, two eviction policies stepping together. Watch LRU and clock sweep pick a different victim from the same inputs.',
    to: '/compare',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Type a query',
    body: 'Any SELECT over the seed table — or edit the rows. The engine is pure and runs entirely in your browser.',
  },
  {
    n: '02',
    title: 'Predict the next step',
    body: 'Before each reveal the run halts and asks what happens next. A committed wrong guess teaches more than a correct animation you watched.',
  },
  {
    n: '03',
    title: 'Step through and inspect',
    body: 'Move one event at a time. The AST, the plan tree, the buffer pool, the B+Tree descent and the locks are all on screen at once.',
  },
];

export function LandingPage() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Hero />

      <section className="ql-enter border-b border-edge px-4 py-16 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className={eyebrow}>How it works</p>
          <h2 className="mt-2 max-w-2xl text-display font-semibold tracking-tight text-balance text-ink">
            One query, eight stages, nothing hidden
          </h2>
          <p className="mt-3 max-w-2xl text-body text-ink-dim">
            QueryLens is a self-built relational engine that traces a SQL query from text to
            result rows — parser, planner, optimizer, executor, buffer pool, B+Tree index and
            locks — one step at a time, with every stage&rsquo;s state visible as it changes.
          </p>

          <ol className="mt-10 grid gap-4 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li
                key={step.n}
                className="ql-sheen rounded-xl border border-edge bg-surface-2 p-4 shadow-e1"
              >
                <span className="font-mono text-label text-accent">{step.n}</span>
                <h3 className="mt-1 text-body font-semibold text-ink">{step.title}</h3>
                <p className="mt-1.5 text-label leading-relaxed text-ink-dim">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="ql-enter px-4 py-16 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className={eyebrow}>More ways in</p>
          <h2 className="mt-2 text-display font-semibold tracking-tight text-ink">Tools</h2>
          <p className="mt-3 max-w-2xl text-body text-ink-dim">
            Standalone views built on the same engine, for when you want one mechanism rather
            than the whole pipeline.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {TOOLS.map((tool) => (
              <Link key={tool.to} to={tool.to} className={cardInteractive}>
                <p className={eyebrow}>{tool.eyebrow}</p>
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <h3 className="text-heading font-semibold text-ink">{tool.title}</h3>
                  <span
                    aria-hidden
                    className="text-ink-dim transition group-hover:translate-x-0.5 group-hover:text-accent"
                  >
                    →
                  </span>
                </div>
                <p className="mt-1.5 text-label leading-relaxed text-ink-dim">{tool.blurb}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
