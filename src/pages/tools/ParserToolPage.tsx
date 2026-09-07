import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parse, toDisplayTree, tokenize } from '../../engine/index.ts';
import type { ASTNode, Token, TokenType } from '../../engine/index.ts';
import { AstTree } from '../../ui/panels/AstTree.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { inputField, panelSurface } from '../../ui/primitives.ts';

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
    <pre className="overflow-x-auto rounded-lg border border-edge bg-surface-3 p-2.5 font-mono text-label text-ink-dim">
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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      params.set('src', src);
      const next = `${location.pathname}?${params.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [src]);

  const visibleTokens = lexed.ok ? lexed.tokens.filter((t) => t.type !== 'eof') : [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Parser sandbox">
        Type SQL — including SQL QueryLens does not support — and watch the tokenizer split it
        into a stream and the recursive-descent parser build the AST, or explain why it cannot.
        This is the parse stage from the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        , with the token stream it normally hides.
      </PageHeader>

      <label htmlFor="src" className="mt-4 flex flex-col gap-1 text-label text-ink-dim">
        SQL source
        <textarea
          id="src"
          value={src}
          onChange={(e) => { setSrc(e.target.value.slice(0, MAX_SRC)); }}
          rows={3}
          spellCheck={false}
          className={`${inputField} resize-y font-mono`}
        />
      </label>

      {/* --- token ribbon ------------------------------------------------- */}
      <section aria-labelledby="ribbon-h" className="flex flex-col gap-2">
        <h3 id="ribbon-h" className="text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
          Tokens
        </h3>
        {lexed.ok ? (
          visibleTokens.length === 0 ? (
            <p className="text-label text-ink-dim">Nothing to tokenize yet.</p>
          ) : (
            <ol className="flex flex-wrap gap-1.5">
              {visibleTokens.map((t, i) => (
                <li
                  key={`${String(t.from)}-${String(i)}`}
                  className={`flex flex-col items-center gap-0.5 rounded-md border px-2 py-1 ${TOKEN_TONE[t.type]}`}
                  title={`${t.type} · chars ${String(t.from)}–${String(t.to)}`}
                >
                  <span className="font-mono text-label leading-tight break-all">
                    {t.type === 'string' ? `'${t.value}'` : t.value}
                  </span>
                  <span className="text-[0.7rem] leading-none tracking-[0.08em] uppercase">
                    {t.type}
                  </span>
                </li>
              ))}
            </ol>
          )
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-evict/40 bg-evict/10 p-3">
            <p className="text-label text-ink">{lexed.message}</p>
            <MarkedSource src={src} from={lexed.from} to={lexed.to} />
          </div>
        )}
        {lexed.ok && visibleTokens.length > 0 && (
          <p className="text-label text-ink-dim tabular-nums">
            {visibleTokens.length} tokens, then EOF.
          </p>
        )}
      </section>

      {/* --- AST / parse result --------------------------------------------- */}
      <section aria-labelledby="ast-h" className="flex flex-1 flex-col gap-2">
        <h3 id="ast-h" className="text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
          Abstract syntax tree
        </h3>

        {parsed.ok && tree ? (
          <>
            <p className="text-label text-ink-dim tabular-nums">
              Parsed · {countNodes(tree)} nodes · recursion depth {treeDepth(tree)}
            </p>
            <div className={`${panelSurface} min-h-64 flex-1 p-4`}>
              <AstTree root={tree} />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-evict/40 bg-evict/10 p-3">
            <p className="text-label text-ink">{parsed.ok ? 'No statement.' : parsed.error.message}</p>
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
    </div>
  );
}
