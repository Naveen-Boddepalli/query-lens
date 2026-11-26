import { FlowTree } from './FlowTree.tsx';
import { TONES, toFlow } from './planTreeTones.ts';
import type { PlanNotation } from './planTreeTones.ts';
import type { PlanNode } from '../../engine/index.ts';

/** `minZoom`: frame the plan no smaller than this and let it pan, as `AstTree` does on a phone. */
export function PlanTree({
  root,
  empty,
  notation = 'operators',
  minZoom,
}: {
  root: PlanNode | null;
  empty: string;
  notation?: PlanNotation;
  minZoom?: number | undefined;
}) {
  return <FlowTree label="Query plan" root={root ? toFlow(root, notation) : null} tones={TONES} wide empty={empty} minZoom={minZoom} />;
}
