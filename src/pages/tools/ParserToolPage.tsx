import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { compoundDisplayTree, parseQueryStatement, toDisplayTree, tokenize } from '../../engine/index.ts';
import type { ASTNode, Token, TokenType } from '../../engine/index.ts';
import { AstTree } from '../../ui/panels/AstTree.tsx';
import { controlLabel, inputField, panelSurface } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import { ScenarioPicker, StagePanel, ToolHeader, ToolShell, useMediaQuery } from '../../ui/tool/index.ts';

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
 * Laid out on the tool workbench (`src/ui/tool/`) without an inspector: the SQL is the only input, so it sits in
 * the command region with a menu of examples, and the stage holds the token ribbon over the tree, framed at a readable zoom that pans. No readout:
 * the counts are in the stage's own header, and a rejection is the error box in place of the tree.
 *
 * URL state is one field, `src`, parsed defensively for the same reason
 * `urlState.ts` is: a pasted link is input from a stranger.
 */

const DEFAULT_SRC = "SELECT name, age FROM users WHERE age > 30 AND name < 'M'";
const MAX_SRC = 2000;
/**
 * The tree is never framed smaller than this on its own: node labels stay readable, and a wider tree pans, with Fit
 * to see all of it. A clause-heavy statement is wide, and fitting it to the stage drew 5px labels even on a desktop.
 */
const MIN_ZOOM = 0.7;
const PHONE_MIN_ZOOM = 0.8;

/** Starting points, each showing the parser doing something different. Editing the SQL reads "Custom". */
const EXAMPLES: readonly { id: string; title: string; blurb: string; sql: string }[] = [
  { id: 'filter', title: 'A filtered SELECT', blurb: 'Two columns and a WHERE with AND: the clauses become the root’s children.', sql: DEFAULT_SRC },
  {
    id: 'join',
    title: 'A join',
    blurb: 'Two tables under aliases, joined ON an equality: the FROM clause grows a join node.',
    sql: 'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 50',
  },
  {
    id: 'group',
    title: 'Grouping',
    blurb: 'GROUP BY, HAVING, ORDER BY and LIMIT: every clause the subset knows, in one statement.',
    sql: 'SELECT age, COUNT(*) FROM users GROUP BY age HAVING COUNT(*) > 1 ORDER BY age DESC LIMIT 5',
  },
  {
    id: 'union',
    title: 'A UNION',
    blurb: 'Two SELECTs joined by UNION ALL: one root names the operator, with a subtree per SELECT.',
    sql: 'SELECT id FROM users UNION ALL SELECT id FROM logins',
  },
  {
    id: 'subquery',
    title: 'A subquery',
    blurb: 'A scalar subquery in the WHERE: a whole SELECT, drawn inside the comparison.',
    sql: 'SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)',
  },
  {
    id: 'unsupported',
    title: 'Not supported yet',
    blurb: 'JOIN … USING tokenizes fine, and the parser says by name what it does not handle.',
    sql: 'SELECT * FROM users JOIN logins USING (id)',
  },
];

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
  // A SELECT, or several joined by UNION, INTERSECT or EXCEPT (plan.md §27.5 S3), each drawn as its own subtree.
  const parsed = useMemo(() => parseQueryStatement(src), [src]);
  const tree = useMemo(
    () => (parsed.ok ? (parsed.ast.kind === 'compound' ? compoundDisplayTree(parsed.ast) : toDisplayTree(parsed.ast)) : null),
    [parsed],
  );

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('src', src);
    return params.toString();
  }, [src]);
  useAddressBarQuery(shareQuery);

  const visibleTokens = lexed.ok ? lexed.tokens.filter((t) => t.type !== 'eof') : [];
  const phone = !useMediaQuery('(min-width: 640px)');
  const example = EXAMPLES.find((x) => x.sql === src);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="query"
        header={
          <ToolHeader
            id="parser"
            title="Parser sandbox"
            summary="Type SQL and watch the tokenizer split it and the parser build its syntax tree, live."
            about={
              <p>
                Any SQL works here, including SQL QueryLens does not run yet: the tokenizer and the recursive-descent
                parser report what they cannot read in their own words. Compare the tree with the{' '}
                <Link to="/tools/grammar" className="underline underline-offset-2 hover:text-ink">
                  SQL grammar explorer
                </Link>
                , or follow a query through every stage in the{' '}
                <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
                  Playground
                </Link>
                .
              </p>
            }
          />
        }
        command={
          <div className={`${panelSurface} grid min-w-0 gap-4 p-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]`}>
            <ScenarioPicker
              id="parser-example"
              label="Example"
              scenarios={EXAMPLES}
              value={example?.id ?? null}
              onPick={(id) => {
                const picked = EXAMPLES.find((x) => x.id === id);
                if (picked) setSrc(picked.sql);
              }}
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="src" className={controlLabel}>
                SQL source
              </label>
              <textarea
                id="src"
                value={src}
                onChange={(e) => { setSrc(e.target.value.slice(0, MAX_SRC)); }}
                rows={3}
                spellCheck={false}
                className={`${inputField} w-full resize-y font-mono`}
              />
            </div>
          </div>
        }
        stage={
          <StagePanel
            title="Syntax tree"
            legend={parsed.ok && tree ? `Parsed · ${String(countNodes(tree))} nodes · recursion depth ${String(treeDepth(tree))}` : undefined}
          >
            <section aria-labelledby="ribbon-h" className="mb-4 flex flex-col gap-2 border-b border-edge/60 pb-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 id="ribbon-h" className="text-label font-semibold text-ink">
                  Tokens
                </h4>
                {lexed.ok && visibleTokens.length > 0 && (
                  <span className="text-label text-ink-dim">{visibleTokens.length} tokens, then EOF.</span>
                )}
              </div>
              {lexed.ok ? (
                visibleTokens.length === 0 ? (
                  <p className="text-label text-ink-dim">Nothing to tokenize yet. Type some SQL above.</p>
                ) : (
                  <ol className="flex flex-wrap gap-1.5">
                    {visibleTokens.map((t, i) => (
                      <li
                        key={`${String(t.from)}-${String(i)}`}
                        className={`flex flex-col items-center gap-0.5 rounded-lg border px-2 py-1 ${TOKEN_TONE[t.type]}`}
                        title={`${t.type} · chars ${String(t.from)}–${String(t.to)}`}
                      >
                        <span className="font-mono text-label leading-tight font-medium break-all">
                          {t.type === 'string' ? `'${t.value}'` : t.value}
                        </span>
                        <span className="font-mono text-[0.68rem] leading-none tracking-[0.08em] uppercase opacity-75">
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

            {parsed.ok && tree ? (
              <div
                className="h-[26rem] min-h-0 sm:h-(--tree-h)"
                // The tree's depth sets the canvas height from `sm` up; a fixed height fitted a 14-node tree to a third of its size.
                style={{ '--tree-h': `${String(Math.min(560, Math.max(288, treeDepth(tree) * 72 + 96)))}px` } as CSSProperties}
              >
                <AstTree root={tree} minZoom={phone ? PHONE_MIN_ZOOM : MIN_ZOOM} />
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 rounded-xl border border-evict/40 bg-evict/10 p-4">
                <p className="text-label font-medium text-ink">{parsed.ok ? 'No statement.' : parsed.error.message}</p>
                {!parsed.ok && parsed.error.hint && <p className="text-label text-ink-dim">{parsed.error.hint}</p>}
                {!parsed.ok && parsed.error.from !== undefined && (
                  <MarkedSource src={src} from={parsed.error.from} to={parsed.error.to ?? parsed.error.from + 1} />
                )}
              </div>
            )}
          </StagePanel>
        }
      />
    </div>
  );
}
