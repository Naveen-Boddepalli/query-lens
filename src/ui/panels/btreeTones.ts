import type { FlowNode, SideEdge } from './FlowTree.tsx';
import type { IndexNode } from '../../engine/index.ts';

/**
 * Pink internal, green leaf — the convention CMU 15-445 students already have
 * in their heads from BusTub's tree printer. Free familiarity (RESEARCH.md §4).
 *
 * `ICONS` is the always-on second channel that does not lean on that hue
 * (plan.md §22.6): a filled disc for internal, a hollow ring for leaf — a
 * textbook colour-vision-safe pair — shown before the INTERNAL / LEAF label in
 * every node and echoed in the legend.
 *
 * Its own file, not `BTreePanel.tsx` — Fast Refresh only works on a file that
 * exports nothing but components, and `renderSvg`'s SVG export (§20.3) reuses
 * this exact map, `toFlow` and `collectSiblings` (`StageDetail.tsx`) rather
 * than duplicating them.
 */
export const TONES: Record<string, string> = {
  internal:
    'border-[var(--color-node-internal)]/70 bg-[var(--color-node-internal)]/10 text-[var(--color-node-internal)] ' +
    // plan.md §16.2 item 4, in the node's own hue. This panel is where hover
    // pays for itself most: a B+Tree over a real table is wide enough that the
    // view zooms to the current hop, and everything outside it is a row of
    // near-identical boxes you navigate by pointing.
    'hover:border-[var(--color-node-internal)] hover:bg-[var(--color-node-internal)]/20',
  leaf:
    'border-[var(--color-node-leaf)]/70 bg-[var(--color-node-leaf)]/10 text-[var(--color-node-leaf)] ' +
    'hover:border-[var(--color-node-leaf)] hover:bg-[var(--color-node-leaf)]/20',
};

export const ICONS: Record<string, string> = { internal: '●', leaf: '○' };

export function toFlow(node: IndexNode, path: ReadonlySet<string>): FlowNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    detail: `page ${node.pageId}`,
    ...(path.has(node.id) ? { highlight: true } : {}),
    ...(node.children ? { children: node.children.map((c) => toFlow(c, path)) } : {}),
  };
}

export function collectSiblings(node: IndexNode, into: SideEdge[]): void {
  if (node.next) into.push({ source: node.id, target: node.next });
  node.children?.forEach((c) => { collectSiblings(c, into); });
}
