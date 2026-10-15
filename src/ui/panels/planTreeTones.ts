import type { FlowNode } from './FlowTree.tsx';
import type { PlanNode } from '../../engine/index.ts';
const V = 'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20';

export const TONES: Record<string, string> = {
  Project: 'border-hue-sky/60 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky/90 hover:bg-hue-sky/20',
  Filter: 'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink hover:border-hue-amber/90 hover:bg-hue-amber/20',
  SeqScan: 'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink hover:border-hue-orange/90 hover:bg-hue-orange/20',
  IndexScan: 'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20',
  Sort: V,
  Limit: V,
};

export function toFlow(node: PlanNode): FlowNode {
  return {
    id: node.id,
    kind: node.op,
    label: node.label,
    ...(node.detail === undefined ? {} : { detail: node.detail }),
    ...(node.highlight === undefined ? {} : { highlight: node.highlight }),
    ...(node.estRows === undefined ? {} : { estRows: node.estRows }),
    ...(node.estBasis === undefined ? {} : { estBasis: node.estBasis }),
    ...(node.children ? { children: node.children.map(toFlow) } : {}),
  };
}
