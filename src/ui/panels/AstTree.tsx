import { FlowTree } from './FlowTree.tsx';
import type { ASTNode, Span } from '../../engine/index.ts';

/**
 * Colour by syntactic category, so shape and colour reinforce each other.
 *
 * The `hover:` half is plan.md §16.2 item 4's tinted rule: fill one step
 * deeper, border one step brighter, in the node's own hue rather than a shared
 * neutral. A `Where` that turned grey on hover would be saying something false
 * about itself for as long as the cursor sat on it.
 */
const TONES: Record<string, string> = {
  SelectStatement:
    'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky hover:bg-hue-sky/20',
  SelectList:
    'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink hover:border-hue-sky/80 hover:bg-hue-sky/15',
  From: 'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20',
  Where:
    'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink hover:border-hue-amber/90 hover:bg-hue-amber/20',
  And: 'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink hover:border-hue-amber/80 hover:bg-hue-amber/15',
  Compare:
    'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink hover:border-hue-amber/80 hover:bg-hue-amber/15',
  Column:
    'border-hue-emerald/50 bg-hue-emerald/5 text-hue-emerald-ink hover:border-hue-emerald/80 hover:bg-hue-emerald/15',
  Table:
    'border-hue-violet/50 bg-hue-violet/5 text-hue-violet-ink hover:border-hue-violet/80 hover:bg-hue-violet/15',
  Literal: 'border-edge bg-surface-3 text-ink hover:border-ink-dim/50 hover:bg-surface-4',
  Star: 'border-edge bg-surface-3 text-ink hover:border-ink-dim/50 hover:bg-surface-4',
  Limit:
    'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink hover:border-hue-orange/90 hover:bg-hue-orange/20',
  // Shares Column's tone — an ORDER BY clause is fundamentally naming one.
  OrderBy:
    'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20',
};

export function AstTree({ root, highlight }: { root: ASTNode | null; highlight?: Span | undefined }) {
  return (
    <FlowTree
      root={root}
      tones={TONES}
      activeSpan={highlight}
      empty="No AST yet — the parser has not run."
    />
  );
}
