import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parse, toDisplayTree, tokenize } from '../../engine/index.ts';
import type { ASTNode, Token, TokenType } from '../../engine/index.ts';
import { AstTree } from '../../ui/panels/AstTree.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { inputField, panelSurface } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The compilers-course standalone (plan.md §20.4, §21.3): arbitrary text →
 * token ribbon → live AST, with the parser's own error messages when it
 * cannot build one.
 *
 * The AST half already existed — the Playground builds it live as a stepped
 * reveal (`emitParseEvents`). What is new here is the **token ribbon**: the
 * tokenizer (`src/engine/parser/tokenizer.ts`) produces a stream that never
 * enters the event model, so a course that wants to see lexing before parsing
 * had nowhere to look. This renders that stream directly, and re-parses on
 * every keystroke rather than on a Run button — a parse of the v0 subset is
 * microseconds, and the point of the tool is watching the tree form as you
 * type. Stepping the parser's cursor through the ribbon is the obvious next
 * addition (it needs new event kinds; plan.md §20.4).
 *
 * URL state is one field, `src`, parsed defensively for the same reason
 * `urlState.ts` is: a pasted link is input from a stranger.
 */

const DEFAULT_SRC = "SELECT name, age FROM users WHERE age > 30 AND name < 'M'";
const MAX_SRC = 2000;

/** Syntactic category → chip classes, matching `AstTree`'s node palette so the
 *  ribbon and the tree name the same things the same colour. Both lines of a
 *  chip inherit its text colour, so every tone here has to clear 4.5:1 on its
 *  own fill (WCAG 2.2, the axe gate) — which rules out dimming with opacity. */
const TOKEN_TONE: Record<TokenType, string> = {
  keyword: 'border-hue-violet/50 bg-hue-violet/10 text-hue-violet-ink',
  identifier: 'border-hue-emerald/50 bg-hue-emerald/10 text-hue-emerald-ink',
  number: 'border-hue-amber/50 bg-hue-amber/10 text-hue-amber-ink',
  string: 'border-hue-amber/50 bg-hue-amber/10 text-hue-amber-ink',
  operator: 'border-edge bg-surface-3 text-ink',
  star: 'border-edge bg-surface-3 text-ink',
  comma: 'border-edge bg-surface-3 text-ink',
  lparen: 'border-edge bg-surface-3 text-ink',
  rparen: 'border-edge bg-surface-3 text-ink',
  semicolon: 'border-edge bg-surface-3 text-ink',
  dot: 'border-edge bg-surface-3 text-ink',
  eof: 'border-dashed border-edge/60 text-ink-dim',
};

const WAVY = {
  textDecoration: 'underline wavy var(--color-evict)',
  textUnderlineOffset: '4px',
} as const;

function readInitialSrc(): string {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const src = params.get('src');
  return src !== null && src.length > 0 && src.length <= MAX_SRC ? src : DEFAULT_SRC;
}

/** Longest root-to-leaf path in the display tree — the parser's recursion depth. */
function treeDepth(node: ASTNode): number {
  const kids = node.children ?? [];
  return kids.length === 0 ? 1 : 1 + Math.max(...kids.map(treeDepth));
}

function countNodes(node: ASTNode): number {
  return 1 + (node.children ?? []).reduce((n, c) => n + countNodes(c), 0);
}

type Lexed =
  | { ok: true; tokens: Token[] }
  | { ok: false; message: string; from: number; to: number };

function lex(src: string): Lexed {
  try {
    return { ok: true, tokens: tokenize(src) };
  } catch (err) {
    const e = err as { message?: string; from?: number; to?: number };
    return {
      ok: false,
      message: e.message ?? 'The tokenizer could not read this.',
      from: e.from ?? 0,
      to: e.to ?? src.length,
    };
  }
}

/** `src` with the range `[from, to)` wavy-underlined, for an error location. */
function MarkedSource({ src, from, to }: { src: string; from: number; to: number }) {
  const a = Math.max(0, Math.min(from, src.length));
  const b = Math.max(a, Math.min(to, src.length));
  return (
    <pre className="rounded-lg border border-edge bg-surface-3 p-2.5 font-mono text-label break-words whitespace-pre-wrap text-ink-dim">
      {src.slice(0, a)}
      <span style={WAVY} className="text-ink">
        {src.slice(a, b) || '␣'}
      </span>
      {src.slice(b)}
    </pre>
  );
}

export function ParserToolPage() {
  const [src, setSrc] = useState(readInitialSrc);

  const lexed = useMemo(() => lex(src), [src]);
  const parsed = useMemo(() => parse(src), [src]);
  const tree = useMemo(
    () => (parsed.ok ? toDisplayTree(parsed.ast) : null),
    [parsed],
  );

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('src', src);
    return params.toString();
  }, [src]);
  useAddressBarQuery(shareQuery);

  const visibleTokens = lexed.ok ? lexed.tokens.filter((t) => t.type !== 'eof') : [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'SQL Parser' }]}
        title="Parser sandbox"
      >
        Type SQL &mdash; including SQL QueryLens does not yet support &mdash; and watch the tokenizer
        split the input into a live token ribbon and the recursive-descent parser construct the AST.
        This provides direct visibility into lexical and syntactic analysis stages.
      </PageHeader>

      {/* SQL Source Input */}
      <div className="ql-sheen flex flex-col gap-2 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <label htmlFor="src" className="font-mono uppercase tracking-wider text-[0.75rem] text-ink-dim">
          SQL source
        </label>
        <textarea
          id="src"
          value={src}
          onChange={(e) => { setSrc(e.target.value.slice(0, MAX_SRC)); }}
          rows={3}
          spellCheck={false}
          className={`${inputField} resize-y font-mono text-[0.85rem]`}
        />
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: 'Lexed Tokens', value: String(visibleTokens.length), sub: lexed.ok ? 'token stream' : 'lexer error' },
          {
            label: 'Parser Status',
            value: parsed.ok ? 'Valid AST' : 'Parse Error',
            sub: parsed.ok ? 'statement accepted' : 'syntax rejected',
            color: parsed.ok ? 'text-hit' : 'text-evict',
          },
          { label: 'AST Nodes', value: String(tree ? countNodes(tree) : 0), sub: 'syntax nodes', color: 'text-accent' },
          { label: 'Recursion Depth', value: String(tree ? treeDepth(tree) : 0), sub: 'call stack height' },
        ].map((m) => (
          <div key={m.label} className="ql-sheen rounded-xl border border-edge bg-surface-2/60 p-3 shadow-neu-rest backdrop-blur-sm">
            <span className="block font-mono text-[0.7rem] uppercase tracking-wider text-ink-dim">{m.label}</span>
            <span className={`mt-1 block truncate text-heading font-semibold tabular-nums ${m.color ?? 'text-ink'}`}>
              {m.value}
            </span>
            <span className="text-[0.75rem] text-ink-dim">{m.sub}</span>
          </div>
        ))}
      </div>

      {/* --- token ribbon ------------------------------------------------- */}
      <section
        aria-labelledby="ribbon-h"
        className="ql-sheen flex flex-col gap-2.5 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-sm"
      >
        <div className="flex items-center justify-between border-b border-edge/60 pb-1.5">
          <h3 id="ribbon-h" className="font-mono text-[0.75rem] font-medium uppercase tracking-[0.12em] text-ink-dim">
            Tokens
          </h3>
          {lexed.ok && visibleTokens.length > 0 && (
            <span className="font-mono text-[0.72rem] text-ink-dim">
              {visibleTokens.length} tokens, then EOF.
            </span>
          )}
        </div>

        {lexed.ok ? (
          visibleTokens.length === 0 ? (
            <p className="text-label text-ink-dim">Nothing to tokenize yet. Enter SQL in the prompt above.</p>
          ) : (
            <ol className="flex flex-wrap gap-1.5">
              {visibleTokens.map((t, i) => (
                <li
                  key={`${String(t.from)}-${String(i)}`}
                  className={`flex flex-col items-center gap-0.5 rounded-lg border px-2 py-1 shadow-neu-rest backdrop-blur-sm ${TOKEN_TONE[t.type]}`}
                  title={`${t.type} &middot; chars ${String(t.from)}&ndash;${String(t.to)}`}
                >
                  <span className="font-mono text-label leading-tight break-all font-medium">
                    {t.type === 'string' ? `'${t.value}'` : t.value}
                  </span>
                  <span className="text-[0.68rem] font-mono leading-none tracking-[0.08em] uppercase opacity-75">
                    {t.type}
                  </span>
                </li>
              ))}
            </ol>
          )
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border border-evict/40 bg-evict/10 p-3.5">
            <p className="text-label font-medium text-ink">{lexed.message}</p>
            <MarkedSource src={src} from={lexed.from} to={lexed.to} />
          </div>
        )}
      </section>

      {/* --- AST / parse result --------------------------------------------- */}
      <section aria-labelledby="ast-h" className="flex flex-1 flex-col gap-2.5">
        <h3 id="ast-h" className="font-mono text-[0.75rem] font-medium uppercase tracking-[0.12em] text-ink-dim">
          Abstract Syntax Tree
        </h3>

        {parsed.ok && tree ? (
          <>
            <p className="text-label text-ink-dim tabular-nums">
              Parsed · {countNodes(tree)} nodes · recursion depth {treeDepth(tree)}
            </p>
            <div className={`${panelSurface} min-h-64 flex-1 p-5`}>
              <AstTree root={tree} />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2.5 rounded-xl border border-evict/40 bg-evict/10 p-4">
            <p className="text-label font-medium text-ink">{parsed.ok ? 'No statement.' : parsed.error.message}</p>
            {!parsed.ok && parsed.error.hint && (
              <p className="text-label text-ink-dim">{parsed.error.hint}</p>
            )}
            {!parsed.ok && parsed.error.from !== undefined && (
              <MarkedSource
                src={src}
                from={parsed.error.from}
                to={parsed.error.to ?? parsed.error.from + 1}
              />
            )}
          </div>
        )}
      </section>

      <p className="text-label leading-relaxed text-ink-dim">
        Compare this token stream and syntax tree with the{' '}
        <Link to="/tools/grammar" className="underline underline-offset-2 hover:text-ink">
          SQL grammar explorer
        </Link>{' '}
        or see the full query lifecycle in the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        .
      </p>
    </div>
  );
}
