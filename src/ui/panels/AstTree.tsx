import { FlowTree } from './FlowTree.tsx';
import type { ASTNode, Span } from '../../engine/index.ts';

/** Colour by syntactic category, so shape and colour reinforce each other. */
const TONES: Record<string, string> = {
  SelectStatement: 'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink',
  SelectList: 'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink',
  From: 'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink',
  Where: 'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink',
  And: 'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink',
  Compare: 'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink',
  Column: 'border-hue-emerald/50 bg-hue-emerald/5 text-hue-emerald-ink',
  Table: 'border-hue-violet/50 bg-hue-violet/5 text-hue-violet-ink',
  Literal: 'border-edge bg-surface-3 text-ink',
  Star: 'border-edge bg-surface-3 text-ink',
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
