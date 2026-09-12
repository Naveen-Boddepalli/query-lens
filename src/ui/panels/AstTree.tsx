import { FlowTree } from './FlowTree.tsx';
import { TONES } from './astTreeTones.ts';
import type { ASTNode, Span } from '../../engine/index.ts';

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
