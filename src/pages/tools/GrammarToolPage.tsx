import { Link } from 'react-router-dom';
import { GRAMMAR } from '../../ui/grammar.ts';
import type { GrammarPart } from '../../ui/grammar.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { card } from '../../ui/primitives.ts';

/**
 * plan.md §22.3: a diagram of the v0 SQL subset, generated from
 * `src/ui/grammar.ts` — the same data `__tests__/grammar.test.ts` checks
 * against the real tokenizer's keywords and the real parser's own behaviour,
 * so a wrong claim here fails a test rather than quietly shipping.
 *
 * A literal keyword is a filled pill; a reference to another rule is an
 * outlined box you can click to jump to that rule's own row; `[optional]`
 * parts sit in a dashed bracket; a repeated part shows its separator next to
 * a loop glyph. Simpler than a curved-arrow railroad diagram, but the same
 * information: what comes next, in what order, and what is skippable.
 */

function Literal({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-hue-sky/60 bg-hue-sky/10 px-2.5 py-1 font-mono text-label text-hue-sky-ink">
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

function PartView({ part }: { part: GrammarPart }) {
  switch (part.kind) {
    case 'literal':
      return <Literal text={part.text} />;
    case 'rule':
      return <RuleRef name={part.name} />;
    case 'optional':
      return (
        <span className="flex items-center gap-1.5 rounded-lg border border-dashed border-edge px-2 py-1">
          <span aria-hidden className="text-label text-ink-dim">[</span>
          <PartsRow parts={part.parts} />
          <span aria-hidden className="text-label text-ink-dim">]</span>
        </span>
      );
    case 'choice':
      return (
        <span className="flex flex-col gap-1 rounded-lg border border-edge bg-surface-3/50 p-1.5">
          {part.options.map((option, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden className="font-mono text-label text-ink-dim">
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
            aria-hidden
            className="flex items-center gap-1 rounded-full border border-edge px-1.5 py-0.5 text-label text-ink-dim"
            title={noSeparator ? 'repeats, one after another' : 'repeats, separated by the token shown'}
          >
            ↻ {!noSeparator && <PartView part={part.separator} />}
          </span>
        </span>
      );
    }
  }
}

export function GrammarToolPage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <PageHeader title="Grammar sandbox">
        Every rule the{' '}
        <Link to="/tools/parser" className="underline underline-offset-2 hover:text-ink">
          parser
        </Link>{' '}
        accepts, diagrammed straight from the data its own consistency test checks against the real
        tokenizer and the real parser — a keyword pill, a clickable box for a rule it calls, a
        dashed bracket for anything optional, and a loop glyph with its separator for anything
        repeated.
      </PageHeader>

      <div className="mt-8 flex flex-col gap-4">
        {GRAMMAR.map((rule) => (
          <div key={rule.name} id={`rule-${rule.name}`} className={`${card} scroll-mt-20`}>
            <h3 className="mb-2 font-mono text-body font-semibold text-ink">{rule.name}</h3>
            <PartsRow parts={rule.parts} />
          </div>
        ))}
      </div>
    </div>
  );
}
