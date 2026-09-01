import { useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import { hierarchy, tree } from 'd3-hierarchy';
import '@xyflow/react/dist/style.css';
import type { ASTNode, Span } from '../../engine/index.ts';

interface AstNodeData extends Record<string, unknown> {
  kind: string;
  label: string;
  detail?: string;
  highlighted: boolean;
}

type AstFlowNode = Node<AstNodeData, 'ast'>;

/** Colour by syntactic category, so shape and colour reinforce each other. */
const KIND_TONE: Record<string, string> = {
  SelectStatement: 'border-sky-400/70 bg-sky-400/10 text-sky-200',
  SelectList: 'border-sky-400/50 bg-sky-400/5 text-sky-200',
  From: 'border-violet-400/60 bg-violet-400/10 text-violet-200',
  Where: 'border-amber-400/60 bg-amber-400/10 text-amber-200',
  And: 'border-amber-400/50 bg-amber-400/5 text-amber-200',
  Compare: 'border-amber-400/50 bg-amber-400/5 text-amber-200',
  Column: 'border-emerald-400/50 bg-emerald-400/5 text-emerald-200',
  Table: 'border-violet-400/50 bg-violet-400/5 text-violet-200',
  Literal: 'border-edge bg-surface-3 text-ink',
  Star: 'border-edge bg-surface-3 text-ink',
};

function AstNodeView({ data }: NodeProps<AstFlowNode>) {
  const tone = KIND_TONE[data.kind] ?? 'border-edge bg-surface-3 text-ink';
  return (
    <div
      className={[
        'min-w-24 rounded-md border px-2.5 py-1.5 text-center transition-shadow',
        tone,
        data.highlighted ? 'ring-2 ring-accent shadow-[0_0_16px_-2px_var(--color-accent)]' : '',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="font-mono text-xs leading-tight">{data.label}</div>
      <div className="text-[9px] tracking-wide text-ink-dim uppercase">{data.kind}</div>
      {data.detail && <div className="text-[9px] text-ink-dim">{data.detail}</div>}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { ast: AstNodeView };

const overlaps = (a: Span | undefined, b: Span | undefined): boolean =>
  a !== undefined && b !== undefined && a.from < b.to && b.from < a.to;

function layout(root: ASTNode, highlight: Span | undefined) {
  // d3-hierarchy does the layout maths; React Flow only draws it.
  const h = hierarchy<ASTNode>(root, (d) => d.children);
  tree<ASTNode>().nodeSize([132, 92])(h);

  const nodes: AstFlowNode[] = h.descendants().map((d) => ({
    id: d.data.id,
    type: 'ast',
    position: { x: d.x ?? 0, y: d.y ?? 0 },
    data: {
      kind: d.data.kind,
      label: d.data.label,
      ...(d.data.detail === undefined ? {} : { detail: d.data.detail }),
      highlighted: overlaps(d.data.span, highlight),
    },
    draggable: false,
    selectable: false,
  }));

  const edges: Edge[] = h.links().map((l) => ({
    id: `${l.source.data.id}->${l.target.data.id}`,
    source: l.source.data.id,
    target: l.target.data.id,
    style: { stroke: 'var(--color-edge)', strokeWidth: 1.5 },
  }));

  return { nodes, edges };
}

function Canvas({ root, highlight }: { root: ASTNode; highlight?: Span }) {
  const { nodes, edges } = useMemo(() => layout(root, highlight), [root, highlight]);
  const { fitView } = useReactFlow();
  // Goes false when nodes are added and true once they have been measured.
  // Fitting before measurement clips the tree, which is what a plain timeout did.
  const measured = useNodesInitialized();

  // Refit when the tree grows — the parse stage reveals it one clause at a time.
  useEffect(() => {
    if (!measured) return;
    void fitView({ padding: 0.16, duration: 250 });
  }, [measured, nodes.length, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-edge)" />
    </ReactFlow>
  );
}

export function AstTree({
  root,
  highlight,
}: {
  root: ASTNode | null;
  highlight?: Span | undefined;
}) {
  if (!root) {
    return <p className="text-sm text-ink-dim">No AST yet — the parser has not run.</p>;
  }
  return (
    <div className="h-full min-h-56 w-full">
      <ReactFlowProvider>
        <Canvas root={root} {...(highlight === undefined ? {} : { highlight })} />
      </ReactFlowProvider>
    </div>
  );
}
