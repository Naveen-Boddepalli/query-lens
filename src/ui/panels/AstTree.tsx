import { FlowTree } from './FlowTree.tsx';
import type { ASTNode, Span } from '../../engine/index.ts';

/** Colour by syntactic category, so shape and colour reinforce each other. */
const TONES: Record<string, string> = {
  SelectStatement: 'border-sky-400/70 bg-sky-400/10 text-sky-200',
  SelectList: 'border-sky-400/50 bg-sky-400/5 text-sky-200',
  From: 'border-violet-400/60 bg-violet-400/10 text-violet-200',
  Where: 'border-amber-400/60 bg-amber-400/10 text-amber-200',
  And: 'border-amber-400/50 bg-amber-400/5 text-amber-200',
  Compare: 'border-amber-400/50 bg-amber-400/5 text-amber-200',
  Column: 'border-emerald-400/50 bg-emerald-400/5 text-emerald-200',
  Table: 'border-violet-400/50 bg-violet-400/5 text-violet-200',
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
