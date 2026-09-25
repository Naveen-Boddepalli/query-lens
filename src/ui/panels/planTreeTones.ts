import type { FlowNode } from './FlowTree.tsx';
import type { PlanNode } from '../../engine/index.ts';
import { raLabel } from '../../export/index.ts';

/**
 * Access methods read warm; row-shaping operators read cool.
 *
 * Hover follows plan.md §16.2 item 4's tinted rule in each operator's own hue.
 * It matters most on this panel: the optimize stage shows two plans side by
 * side, and pointing at a node in one to find its counterpart in the other is
 * the whole reading task.
 *
 * Its own file, not `PlanTree.tsx` — Fast Refresh only works on a file that
 * exports nothing but components, and `renderSvg`'s SVG export (§20.3) reuses
 * this exact map and `toFlow` (`StageDetail.tsx`) rather than duplicating them.
 */
export const TONES: Record<string, string> = {
  Project:
    'border-hue-sky/60 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky/90 hover:bg-hue-sky/20',
  Filter:
    'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink hover:border-hue-amber/90 hover:bg-hue-amber/20',
  SeqScan:
    'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink hover:border-hue-orange/90 hover:bg-hue-orange/20',
  IndexScan:
    'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20',
  // An index join's inner side is an access method too — the same green as the lookup it repeats once per outer row.
  IndexProbe:
    'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20',
  // The palette has five hues and this is the sixth operator, so Sort shares
  // Limit's violet rather than adding a token for one more panel — the two
  // are rarely adjacent (Project sits between them in the common shape), so
  // sharing a tone with Limit reads more clearly than sharing with its own
  // neighbours, Project (parent) and Filter (child).
  Sort:
    'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20',
  Limit:
    'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20',
};

/**
 * How a plan node is written (plan.md §25.4 B5): by its physical operator
 * (`Filter`, `IndexScan users.id`) or by its meaning in relational algebra
 * (`σ id = 5`). The colours follow the *operator* either way, so switching the
 * notation never changes which node is which.
 */
export type PlanNotation = 'operators' | 'algebra';

export function toFlow(node: PlanNode, notation: PlanNotation = 'operators'): FlowNode {
  // In the algebra notation the physical operator moves down to the detail line — the algebra says what
  // is computed, the operator says how, and seeing both is the point. Just the operator's own label
  // (`Filter`, `IndexScan users.id`): its predicate is already in the algebra, and a longer detail line
  // makes the node taller than the layout allots it.
  const algebra = notation === 'algebra' && node.ra ? node.ra : undefined;
  const label = algebra ? raLabel(algebra) : node.label;
  const detail = algebra ? node.label : node.detail;
  return {
    id: node.id,
    kind: node.op,
    label,
    ...(detail === undefined ? {} : { detail }),
    ...(node.highlight === undefined ? {} : { highlight: node.highlight }),
    ...(node.estRows === undefined ? {} : { estRows: node.estRows }),
    ...(node.estBasis === undefined ? {} : { estBasis: node.estBasis }),
    ...(node.children ? { children: node.children.map((c) => toFlow(c, notation)) } : {}),
  };
}
