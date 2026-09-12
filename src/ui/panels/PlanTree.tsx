import { FlowTree } from './FlowTree.tsx';
import { TONES, toFlow } from './planTreeTones.ts';
import type { PlanNode } from '../../engine/index.ts';

export function PlanTree({ root, empty }: { root: PlanNode | null; empty: string }) {
  return <FlowTree root={root ? toFlow(root) : null} tones={TONES} wide empty={empty} />;
}
