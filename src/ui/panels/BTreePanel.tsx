import { useMemo, useState } from 'react';
import { FlowTree } from './FlowTree.tsx';
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
 */
const TONES: Record<string, string> = {
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

const ICONS: Record<string, string> = { internal: '●', leaf: '○' };

function toFlow(node: IndexNode, path: ReadonlySet<string>): FlowNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    detail: `page ${node.pageId}`,
    ...(path.has(node.id) ? { highlight: true } : {}),
    ...(node.children ? { children: node.children.map((c) => toFlow(c, path)) } : {}),
  };
}

function collectSiblings(node: IndexNode, into: SideEdge[]): void {
  if (node.next) into.push({ source: node.id, target: node.next });
  node.children?.forEach((c) => { collectSiblings(c, into); });
}

export interface BTreePanelProps {
  tree: IndexNode | null;
  path: readonly string[];
  outcome: 'searching' | 'found' | 'not-found' | null;
}

export function BTreePanel({ tree, path, outcome }: BTreePanelProps) {
  // The element FlowTree portals its zoom buttons into (see the header below).
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

  const pathSet = useMemo(() => new Set(path), [path]);
  const root = useMemo(() => (tree ? toFlow(tree, pathSet) : null), [tree, pathSet]);
  const sideEdges = useMemo(() => {
    if (!tree) return [];
    const edges: SideEdge[] = [];
    collectSiblings(tree, edges);
    return edges;
  }, [tree]);

  if (!root) {
    return (
      <p className="text-body text-ink-dim">
        No index traversal yet. A plan has to choose an <span className="font-mono">IndexScan</span>{' '}
        before the B+Tree is opened.
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-ink-dim">
        {/* Filled disc vs hollow ring — a colour-independent pair (plan.md
            §22.6), carried in the glyph so the legend teaches hue and shape at
            once, and echoed before the label inside every node. */}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="text-[var(--color-node-internal)]">●</span> internal
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="text-[var(--color-node-leaf)]">○</span> leaf
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 border-t border-dashed border-[var(--color-node-leaf)]" />
          sibling chain
        </span>
        <span className="ml-auto rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-ink-dim">
          drag to pan · scroll to zoom
        </span>
        {path.length > 0 && (
          <span className="font-mono">
            {path.join(' → ')}
            {outcome === 'found' && <span className="ml-1.5 text-hit">✓ found</span>}
            {outcome === 'not-found' && <span className="ml-1.5 text-evict">✗ not found</span>}
          </span>
        )}
        {/* The zoom buttons render in here, via a portal from FlowTree. They
            belong beside the sentence that describes them, and putting them in
            this row costs the canvas no height — a strip above the graph clipped
            the leaf row by exactly its own height. Last in the row and
            `shrink-0`, so a lengthening path pushes the text left rather than
            sliding the buttons out from under the cursor. A callback ref into
            state, because a plain ref is still null on the render that needs it. */}
        <div ref={setToolbar} className="flex shrink-0 items-center gap-1" />
      </div>

      <div className="min-h-0 flex-1">
        <FlowTree
          root={root}
          tones={TONES}
          kindIcons={ICONS}
          sideEdges={sideEdges}
          /* Only the current hop: the whole root-to-leaf path spans nearly the
             full width of a wide tree, so framing all of it is unreadable.
             Parent-plus-child is a tight box that follows the descent. */
          focusIds={path.slice(-2)}
          compact
          controls
          toolbarTarget={toolbar}
        />
      </div>
    </div>
  );
}
