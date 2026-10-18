/**
 * `src/export/` — pure, on the same rules as `src/engine/`.
 *
 * A plan as **relational algebra** (plan.md §25.4 B5): the notation a database
 * course opens with, σ π ⋈ γ — and ⋉ ▷ for `EXISTS` (§27.5 S1) — derived from the plan the engine actually built.
 * The plan tree says *how* a query runs (a `SeqScan` with a filter, an
 * `IndexScan`, a `HashJoin`); the algebra says *what* it computes — so both
 * `SeqScan users` + a filter and an index lookup read as `σ_{id = 5}(users)`.
 * Seeing the two side by side is the on-ramp from "Filter above SeqScan" to a
 * lecture-one expression, and back.
 *
 * Works on the display tree (`PlanNode`), whose `ra` field the engine fills in.
 */

import type { PlanNode, RaInfo } from '../engine/index.ts';

/** A node's label in the tree view: `σ age > 30`, `π id, name`, `users`. */
export function raLabel(ra: RaInfo): string {
  if (ra.symbol === 'rel') return ra.rel ?? '';
  return ra.sub === undefined ? ra.symbol : `${ra.symbol} ${ra.sub}`;
}

const isScanSelection = (ra: RaInfo): boolean => ra.symbol === 'σ' && ra.rel !== undefined;

/**
 * The binary operators, written between their two arguments: a join, a semi- or anti-join (plan.md §27.5 S1), and the
 * set operators ∪ ∩ − (§27.5 S3).
 */
const BINARY: ReadonlySet<RaInfo['symbol']> = new Set(['⋈', '⋉', '▷', '∪', '∩', '−']);
const isJoin = (ra: RaInfo | undefined): boolean => ra !== undefined && BINARY.has(ra.symbol);

/** `σ_{p}` — the operator and its subscript, without its argument. */
function head(ra: RaInfo): string {
  return ra.sub === undefined ? ra.symbol : `${ra.symbol}_{${ra.sub}}`;
}

/** The whole expression on one line. */
function inline(node: PlanNode): string {
  const ra = node.ra;
  if (!ra) return node.label;
  if (ra.symbol === 'rel') return ra.rel ?? '';
  if (isScanSelection(ra)) return `${head(ra)}(${ra.rel ?? ''})`;

  const [first, second] = node.children ?? [];
  if (isJoin(ra) && first && second) {
    const side = (n: PlanNode): string => (isJoin(n.ra) ? `(${inline(n)})` : inline(n));
    return `${side(first)} ${head(ra)} ${side(second)}`;
  }
  if (!first) return head(ra);
  // `π_{*}` keeps every column, which relational algebra leaves unwritten.
  if (ra.symbol === 'π' && ra.sub === '*') return inline(first);
  return `${head(ra)}(${inline(first)})`;
}

/** Break an expression across lines once it is wider than `width`, one operator per level. */
function pretty(node: PlanNode, indent: string, width: number): string {
  const flat = inline(node);
  if (indent.length + flat.length <= width) return flat;

  const ra = node.ra;
  const [first, second] = node.children ?? [];
  if (!ra || !first) return flat;

  if (isJoin(ra) && second) {
    const side = (n: PlanNode) => pretty(n, `${indent}  `, width);
    return `${side(first)}\n${indent}${head(ra)}\n${indent}${side(second)}`;
  }
  if (ra.symbol === 'π' && ra.sub === '*') return pretty(first, indent, width);
  const inner = `${indent}  `;
  return `${head(ra)}(\n${inner}${pretty(first, inner, width)}\n${indent})`;
}

/**
 * The plan as a relational-algebra expression in Unicode, e.g.
 * `π_{name}(σ_{age > 30}(users))`, broken over lines when it is wide. Not
 * fenced: it is meant to be pasted into a document or a proof, not a code review.
 */
export function planToRelationalAlgebra(root: PlanNode, width = 78): string {
  return `${pretty(root, '', width)}\n`;
}

/* ----- LaTeX ---------------------------------------------------------------- */

const LATEX_SYMBOL: Record<Exclude<RaInfo['symbol'], 'rel'>, string> = {
  σ: '\\sigma',
  π: '\\pi',
  '⋈': '\\bowtie',
  '⋉': '\\ltimes',
  '▷': '\\triangleright',
  '∪': '\\cup',
  '∩': '\\cap',
  '−': '\\setminus',
  γ: '\\gamma',
  τ: '\\tau',
  λ: '\\lambda',
  δ: '\\delta',
};

/** Plain characters LaTeX treats specially, and the logic words the algebra writes as symbols. */
function latexText(text: string): string {
  return text
    .replace(/[\\{}]/g, (c) => `\\${c}`)
    .replace(/[_%$#&]/g, (c) => `\\${c}`)
    .replace(/>=/g, '\\ge ')
    .replace(/<=/g, '\\le ')
    .replace(/<>/g, '\\ne ')
    .replace(/\bAND\b/g, '\\wedge ')
    .replace(/\bOR\b/g, '\\vee ')
    .replace(/\bNOT\b/g, '\\neg ')
    .replace(/↑/g, '\\uparrow ')
    .replace(/↓/g, '\\downarrow ')
    .replace(/\s+/g, ' ')
    .trim();
}

function latexHead(ra: RaInfo): string {
  if (ra.symbol === 'rel') return '';
  const symbol = LATEX_SYMBOL[ra.symbol];
  return ra.sub === undefined ? symbol : `${symbol}_{${latexText(ra.sub)}}`;
}

const latexRel = (name: string): string => `\\text{${latexText(name)}}`;

function latexInline(node: PlanNode): string {
  const ra = node.ra;
  if (!ra) return `\\text{${latexText(node.label)}}`;
  if (ra.symbol === 'rel') return latexRel(ra.rel ?? '');
  if (isScanSelection(ra)) return `${latexHead(ra)}\\left(${latexRel(ra.rel ?? '')}\\right)`;

  const [first, second] = node.children ?? [];
  if (isJoin(ra) && first && second) {
    const side = (n: PlanNode): string => (isJoin(n.ra) ? `(${latexInline(n)})` : latexInline(n));
    return `${side(first)} ${latexHead(ra)} ${side(second)}`;
  }
  if (!first) return latexHead(ra);
  if (ra.symbol === 'π' && ra.sub === '*') return latexInline(first);
  return `${latexHead(ra)}\\left(${latexInline(first)}\\right)`;
}

/** The same expression as LaTeX math, ready to drop between `$…$` or `\[ … \]` in a write-up. */
export function planToLatex(root: PlanNode): string {
  return `${latexInline(root)}\n`;
}
