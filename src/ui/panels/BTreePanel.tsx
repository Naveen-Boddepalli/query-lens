import { useMemo, useState } from 'react';
import { FlowTree } from './FlowTree.tsx';
import type { SideEdge } from './FlowTree.tsx';
import { collectSiblings, ICONS, toFlow, TONES } from './btreeTones.ts';
import type { IndexNode } from '../../engine/index.ts';

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
            {outcome === 'found' && <span className="ml-1.5 text-hit">FOUND</span>}
            {outcome === 'not-found' && <span className="ml-1.5 text-evict">NOT FOUND</span>}
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
