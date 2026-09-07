import { Link } from 'react-router-dom';
import { Hero } from '../ui/Hero.tsx';

/**
 * The landing hub (`/`): the hero, a short account of what the engine is, how
 * to read a trace, and where to go. One column, one surface, no rules between
 * bands — it should read as a page someone wrote, not a stack of cards.
 *
 * `START` is the list to extend as more standalone tools land. Old `/?q=...`
 * Playground links never reach this component — `App.tsx`'s `IndexRoute`
 * redirects anything carrying share params to `/playground` first.
 */

const START: { title: string; blurb: string; to: string }[] = [
  {
    title: 'Playground',
    blurb: 'Type SQL, predict, and step the whole pipeline from parse to result.',
    to: '/playground',
  },
  {
    title: 'Gallery',
    blurb: 'Named moments — the eviction storm, the optimizer rewrite — each a link straight to that step.',
    to: '/gallery',
  },
  {
    title: 'Compare',
    blurb: 'Any two replacement policies on the same access pattern, stepping together until they disagree.',
    to: '/compare',
  },
];

const STEPS = [
  ['Type a query.', 'Any SELECT over the seed table — or edit the rows and watch every number downstream change.'],
  ['Predict before each step.', 'The run halts and asks what happens next. Committing to a wrong guess is the part that teaches.'],
  ['Step through it.', 'One event at a time. The AST, the plan, the buffer pool, the B+Tree descent and the locks are all on screen at once.'],
];

export function LandingPage() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Hero />

      <div className="mx-auto w-full max-w-2xl px-4 pb-24 sm:px-8">
        <p className="text-body leading-relaxed text-ink-dim">
          It is a real engine, just a small one — a recursive-descent parser, a Volcano
          executor, a buffer pool doing LRU and clock sweep, a B+Tree that crabs its latches.
          Small enough to watch end to end, and honest about it: every number on screen is{' '}
          <em className="text-ink">this</em> engine&rsquo;s, not Postgres&rsquo;s.
        </p>

        <h2 className="mt-14 text-heading font-semibold tracking-tight text-ink">
          Reading a trace
        </h2>
        <ol className="mt-4 space-y-4">
          {STEPS.map(([lead, rest], i) => (
            <li key={lead} className="flex gap-4">
              <span className="mt-0.5 shrink-0 font-mono text-label text-ink-dim tabular-nums">
                {i + 1}
              </span>
              <p className="text-body leading-relaxed text-ink-dim">
                <span className="font-medium text-ink">{lead}</span> {rest}
              </p>
            </li>
          ))}
        </ol>

        <h2 className="mt-14 text-heading font-semibold tracking-tight text-ink">Where to start</h2>
        <ul className="mt-3 divide-y divide-edge border-y border-edge">
          {START.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className="group -mx-3 flex flex-col gap-1 rounded-md px-3 py-4 transition hover:bg-surface-2/50 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <span className="w-28 shrink-0 font-medium text-ink transition group-hover:text-accent">
                  {item.title}
                </span>
                <span className="text-label leading-relaxed text-ink-dim">{item.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-label text-ink-dim">
          Also here:{' '}
          <Link to="/stages" className="underline underline-offset-2 hover:text-ink">
            the eight stages
          </Link>{' '}
          one at a time,{' '}
          <Link to="/examples" className="underline underline-offset-2 hover:text-ink">
            example queries
          </Link>
          , and standalone sandboxes for the{' '}
          <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
            buffer pool
          </Link>
          , the{' '}
          <Link to="/tools/parser" className="underline underline-offset-2 hover:text-ink">
            parser
          </Link>{' '}
          and the{' '}
          <Link to="/tools/btree" className="underline underline-offset-2 hover:text-ink">
            B+Tree
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
