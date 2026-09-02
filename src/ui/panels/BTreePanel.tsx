import { useMemo } from 'react';
import { FlowTree } from './FlowTree.tsx';
import type { FlowNode, SideEdge } from './FlowTree.tsx';
import type { IndexNode } from '../../engine/index.ts';

/**
 * Pink internal, green leaf — the convention CMU 15-445 students already have
 * in their heads from BusTub's tree printer. Free familiarity (RESEARCH.md §4).
 */
const TONES: Record<string, string> = {
  internal: 'border-[var(--color-node-internal)]/70 bg-[var(--color-node-internal)]/10 text-[var(--color-node-internal)]',
  leaf: 'border-[var(--color-node-leaf)]/70 bg-[var(--color-node-leaf)]/10 text-[var(--color-node-leaf)]',
};

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
      <p className="text-sm text-ink-dim">
        No index traversal yet. A plan has to choose an <span className="font-mono">IndexScan</span>{' '}
        before the B+Tree is opened.
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-dim">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--color-node-internal)]" /> internal
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--color-node-leaf)]" /> leaf
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 border-t border-dashed border-[var(--color-node-leaf)]" />
          sibling chain
        </span>
        <span className="ml-auto text-ink-dim/70">drag to pan · scroll to zoom</span>
        {path.length > 0 && (
          <span className="font-mono">
            {path.join(' → ')}
            {outcome === 'found' && <span className="ml-1.5 text-hit">✓ found</span>}
            {outcome === 'not-found' && <span className="ml-1.5 text-evict">✗ not found</span>}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <FlowTree
          root={root}
          tones={TONES}
          sideEdges={sideEdges}
          /* Only the current hop: the whole root-to-leaf path spans nearly the
             full width of a wide tree, so framing all of it is unreadable.
             Parent-plus-child is a tight box that follows the descent. */
          focusIds={path.slice(-2)}
          compact
          controls
        />
      </div>
    </div>
  );
}
