import { Link } from 'react-router-dom';
import { Hero, Icon, StageIcon } from '../ui/Hero.tsx';
import { cardInteractive } from '../ui/primitives.ts';
import { STAGE_META } from '../ui/stageMeta.ts';
import type { Stage } from '../engine/index.ts';
import { useDefaultDocumentTitle } from '../ui/documentTitle.ts';

const SUBSYSTEM_KEYS: [stage: Stage, num: string, to: string][] = [
  ['parse', 'Stage 01', '/tools/parser'],
  ['plan', 'Stage 02', '/tools/planner'],
  ['optimize', 'Stage 03', '/stages/optimize'],
  ['buffer', 'Stage 04', '/tools/buffer-pool'],
  ['index', 'Stage 05', '/tools/btree'],
];

const QUICK_START: [title: string, cat: string, to: string, blurb: string][] = [
  ['Playground', 'Live', '/playground', 'Type SQL and step pipeline.'],
  ['Gallery', 'Moments', '/gallery', 'Eviction storms and rewrites.'],
  ['Compare', 'Diff', '/compare', 'Step policies side-by-side.'],
  ['Stages', 'Specs', '/stages', 'Explore all 8 stages.'],
  ['Examples', 'SQL', '/examples', 'Scans, joins, and aggregates.'],
  ['Sandboxes', 'Tools', '/tools/buffer-pool', 'Subsystem sandboxes.'],
];

const STEPS: [num: string, lead: string, rest: string][] = [
  ['01', 'Type a query.', 'Run SELECT or edit rows to watch changes.'],
  ['02', 'Predict before each step.', 'The run halts to ask what happens next.'],
  ['03', 'Step through it.', 'Inspect AST, plan, buffer pool, and B+Tree.'],
];

const boxClass = 'ql-glass-panel ql-sheen rounded-xl border border-edge bg-surface-2/85 p-5 shadow-neu-rest backdrop-blur-sm';
const gridClass = 'mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';

function SectionHead({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <div className="mt-16 flex flex-col items-start gap-1 sm:mt-24">
      <span className="font-mono text-micro font-semibold uppercase tracking-wider text-accent">{kicker}</span>
      <h2 className="text-display font-semibold tracking-tight text-ink sm:text-3xl">{title}</h2>
      <p className="max-w-2xl text-body leading-relaxed text-ink-dim">{sub}</p>
    </div>
  );
}

function Card({ to, tag, stage, title, desc }: { to: string; tag: string; stage?: Stage; title: string; desc: string }) {
  return (
    <Link to={to} className={cardInteractive}>
      <div className="flex items-center justify-between gap-2">
        {stage ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge bg-surface/80 text-accent shadow-neu-track">
            <StageIcon stage={stage} />
          </div>
        ) : (
          <span className="font-mono text-micro font-medium uppercase tracking-wider text-accent">{tag}</span>
        )}
        {stage && <span className="font-mono text-micro text-ink-dim">{tag}</span>}
      </div>

      <h3 className="mt-3 text-heading font-semibold tracking-tight text-ink transition group-hover:text-accent">
        {title}
      </h3>
      <p className="mt-2 text-label leading-relaxed text-ink-dim">{desc}</p>

      <div className="mt-4 flex items-center gap-1.5 text-label font-medium text-accent">
        Explore <Icon d="M6 4l4 4-4 4" />
      </div>
    </Link>
  );
}

export function LandingPage() {
  useDefaultDocumentTitle();
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Hero />

      <div className="mx-auto w-full max-w-5xl px-4 pb-24 sm:px-8">
        <SectionHead
          kicker="Architecture"
          title="How QueryLens Works"
          sub="Every stage of a relational database executed in-memory in your browser."
        />

        <div className={gridClass}>
          {SUBSYSTEM_KEYS.map(([stage, num, to]) => {
            const meta = STAGE_META[stage];
            return (
              <Card
                key={stage}
                to={to}
                tag={num}
                stage={stage}
                title={meta.title}
                desc={meta.blurb}
              />
            );
          })}
        </div>

        <SectionHead
          kicker="Entry Points"
          title="Quick Start"
          sub="Curated interactive pathways into QueryLens."
        />

        <div className={gridClass}>
          {QUICK_START.map(([title, cat, to, blurb]) => (
            <Card
              key={title}
              to={to}
              tag={cat}
              title={title}
              desc={blurb}
            />
          ))}
        </div>

        <SectionHead
          kicker="Methodology"
          title="Reading a trace"
          sub="How to predict and step through query execution to build an intuitive mental model."
        />

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {STEPS.map(([step, lead, rest]) => (
            <div key={step} className={boxClass}>
              <span className="font-mono text-display font-bold text-accent/80 tabular-nums">{step}</span>
              <h3 className="mt-3 text-heading font-semibold text-ink">{lead}</h3>
              <p className="mt-2 text-label leading-relaxed text-ink-dim">{rest}</p>
            </div>
          ))}
        </div>

        {/* Engine Transparency Callout & Navigation Hub */}
        <div className={`mt-16 sm:mt-24 ${boxClass}`}>
          <p className="text-body leading-relaxed text-ink-dim">
            A real, compact engine: recursive-descent parser, Volcano executor,
            LRU buffer pool, and latch-crabbing B+Tree. Every metric is{' '}
            <em className="font-medium text-ink">this</em> engine&rsquo;s, not Postgres&rsquo;s.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-label text-ink-dim">
            {[
              ['/stages', 'stages'],
              ['/examples', 'examples'],
              ['/tools/buffer-pool', 'buffer pool'],
              ['/tools/parser', 'parser'],
              ['/tools/btree', 'B+Tree'],
              ['/docs', 'docs'],
            ].map(([to, label]) => (
              <Link key={to} to={to!} className="underline underline-offset-2 hover:text-ink">
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
