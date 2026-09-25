import { FlowTree } from './FlowTree.tsx';
import { TONES, toFlow } from './planTreeTones.ts';
import type { PlanNotation } from './planTreeTones.ts';
import type { PlanNode } from '../../engine/index.ts';

export function PlanTree({
  root,
  empty,
  notation = 'operators',
}: {
  root: PlanNode | null;
  empty: string;
  notation?: PlanNotation;
}) {
  return <FlowTree root={root ? toFlow(root, notation) : null} tones={TONES} wide empty={empty} />;
}
