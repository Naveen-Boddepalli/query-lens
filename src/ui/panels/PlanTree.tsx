import { FlowTree } from './FlowTree.tsx';
import type { FlowNode } from './FlowTree.tsx';
import type { PlanNode } from '../../engine/index.ts';

/** Access methods read warm; row-shaping operators read cool. */
const TONES: Record<string, string> = {
  Project: 'border-hue-sky/60 bg-hue-sky/10 text-hue-sky-ink',
  Filter: 'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink',
  SeqScan: 'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink',
  IndexScan: 'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink',
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
