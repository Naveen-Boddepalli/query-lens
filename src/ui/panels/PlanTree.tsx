import { FlowTree } from './FlowTree.tsx';
import type { FlowNode } from './FlowTree.tsx';
import type { PlanNode } from '../../engine/index.ts';

/** Access methods read warm; row-shaping operators read cool. */
const TONES: Record<string, string> = {
  Project: 'border-sky-400/60 bg-sky-400/10 text-sky-200',
  Filter: 'border-amber-400/60 bg-amber-400/10 text-amber-200',
  SeqScan: 'border-orange-400/60 bg-orange-400/10 text-orange-200',
  IndexScan: 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200',
};

function toFlow(node: PlanNode): FlowNode {
  return {
    id: node.id,
    kind: node.op,
    label: node.label,
    ...(node.detail === undefined ? {} : { detail: node.detail }),
    ...(node.highlight === undefined ? {} : { highlight: node.highlight }),
    ...(node.children ? { children: node.children.map(toFlow) } : {}),
  };
}

export function PlanTree({ root, empty }: { root: PlanNode | null; empty: string }) {
  return <FlowTree root={root ? toFlow(root) : null} tones={TONES} wide empty={empty} />;
}
