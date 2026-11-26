import { FlowTree } from './FlowTree.tsx';
import { TONES } from './astTreeTones.ts';
import type { ASTNode, Span } from '../../engine/index.ts';

/**
 * `minZoom`: on a phone, frame the tree no smaller than this and let it pan, rather than shrinking a deep tree to
 * fit the screen's width (docs/research/tool-layouts.md §4.5 rule 2). Fit still shows the whole tree.
 */
export function AstTree({ root, highlight, minZoom }: { root: ASTNode | null; highlight?: Span | undefined; minZoom?: number | undefined }) {
  return (
    <FlowTree
      label="Parse tree"
      root={root}
      tones={TONES}
      activeSpan={highlight}
      empty="No AST yet — the parser has not run."
      minZoom={minZoom}
    />
  );
}
