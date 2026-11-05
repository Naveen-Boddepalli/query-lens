import { Link } from 'react-router-dom';
import { GRAMMAR } from '../../ui/grammar.ts';
import type { GrammarPart } from '../../ui/grammar.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { card } from '../../ui/primitives.ts';

function Literal({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-hue-sky/60 bg-hue-sky/10 px-2.5 py-1 font-mono text-label text-hue-sky-ink font-medium">
      {text}
    </span>
  );
}

function RuleRef({ name }: { name: string }) {
  return (
    <a
      href={`#rule-${name}`}
      className="rounded-md border border-hue-violet/60 bg-hue-violet/10 px-2.5 py-1 font-mono text-label text-hue-violet-ink transition hover:border-hue-violet hover:bg-hue-violet/20"
    >
      {name}
    </a>
  );
}

function PartsRow({ parts }: { parts: GrammarPart[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {parts.map((part, i) => (
        <PartView key={i} part={part} />
      ))}
    </div>
  );
}

function RepeatIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 text-ink-dim"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M13 8A5 5 0 1 1 8 3" />
      <path d="M13 3v5H8" />
    </svg>
  );
}

function PartView({ part }: { part: GrammarPart }) {
  switch (part.kind) {
    case 'literal':
      return <Literal text={part.text} />;
    case 'rule':
      return <RuleRef name={part.name} />;
    case 'optional':
      return (
        <span className="flex items-center gap-1.5 rounded-lg border border-dashed border-edge/80 bg-surface-2/40 px-2 py-1">
          <span aria-hidden="true" className="font-mono text-label text-ink-dim">[</span>
          <PartsRow parts={part.parts} />
          <span aria-hidden="true" className="font-mono text-label text-ink-dim">]</span>
        </span>
      );
    case 'choice':
      return (
        <span className="flex flex-col gap-1 rounded-lg border border-edge bg-surface-3/50 p-1.5">
          {part.options.map((option, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="font-mono text-label text-ink-dim">
                  |
                </span>
              )}
              <PartsRow parts={option} />
            </span>
          ))}
        </span>
      );
    case 'repeat': {
      // An empty `optional` as the separator means direct concatenation — no token between repetitions (e.g. a
      // JOIN chain) — so the badge just names the loop, with nothing to show beside it.
      const noSeparator = part.separator.kind === 'optional' && part.separator.parts.length === 0;
      return (
        <span className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-3/50 px-2 py-1">
          <PartsRow parts={part.parts} />
          <span
            aria-hidden="true"
            className="flex items-center gap-1 rounded-full border border-edge bg-surface-2/80 px-2 py-0.5 text-label text-ink-dim"
            title={noSeparator ? 'repeats, one after another' : 'repeats, separated by the token shown'}
          >
            <RepeatIcon />
            {!noSeparator && <PartView part={part.separator} />}
          </span>
        </span>
      );
    }
  }
}

export function GrammarToolPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'SQL Grammar' }]}
        title="Grammar sandbox"
      >
        Every production rule accepted by the QueryLens{' '}
        <Link to="/tools/parser" className="underline underline-offset-2 hover:text-ink">
          parser
        </Link>
        , diagrammed directly from internal grammar specifications. Rules contain keyword literals,
        clickable non-terminal references, optional bracketed phrases, and repeating sequences.
      </PageHeader>

      {/* Metrics Strip */}
      <div className="ql-sheen flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <div className="flex items-center gap-2 font-mono text-label text-ink">
          <span className="font-semibold text-accent">{GRAMMAR.length}</span>
          <span className="text-ink-dim">production rules diagrammed</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[0.78rem] text-ink-dim">
          <span>Dialect: <span className="text-ink">SQL v0</span></span>
          <span className="rounded border border-hit/40 bg-hit/10 px-2 py-0.5 text-hit">100% Tested</span>
        </div>
      </div>

      {/* Rules list */}
      <div className="flex flex-col gap-3.5">
        {GRAMMAR.map((rule) => (
          <div
            key={rule.name}
            id={`rule-${rule.name}`}
            className={`${card} scroll-mt-20 flex flex-col gap-2.5 transition-all duration-150 hover:border-ink-dim/40`}
          >
            <div className="flex items-center justify-between border-b border-edge/60 pb-1.5">
              <h3 className="font-mono text-body font-semibold text-ink">{rule.name}</h3>
              <a
                href={`#rule-${rule.name}`}
                className="font-mono text-[0.7rem] text-ink-dim/60 hover:text-accent"
              >
                #{rule.name}
              </a>
            </div>
            <PartsRow parts={rule.parts} />
          </div>
        ))}
      </div>
    </div>
  );
}

