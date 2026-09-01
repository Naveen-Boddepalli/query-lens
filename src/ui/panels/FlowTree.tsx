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
import type { Span } from '../../engine/index.ts';

/** The display shape every tree in the app renders through. */
export interface FlowNode {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  /** Source range, for highlighting alongside the editor. */
  span?: Span;
  /** Set directly by the producer, e.g. a node an optimizer rule created. */
  highlight?: boolean;
  children?: FlowNode[];
}

interface NodeData extends Record<string, unknown> {
  kind: string;
  label: string;
  detail?: string;
  highlighted: boolean;
  tone: string;
  wide: boolean;
}

type TreeFlowNode = Node<NodeData, 'tree'>;

function NodeView({ data }: NodeProps<TreeFlowNode>) {
  return (
    <div
      className={[
        'rounded-md border px-2.5 py-1.5 text-center transition-shadow',
        data.wide ? 'w-44' : 'min-w-24',
        data.tone,
        data.highlighted ? 'ring-2 ring-accent shadow-[0_0_16px_-2px_var(--color-accent)]' : '',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="font-mono text-xs leading-tight break-words">{data.label}</div>
      <div className="text-[9px] tracking-wide text-ink-dim uppercase">{data.kind}</div>
      {data.detail && (
        <div className="mt-0.5 font-mono text-[9px] break-words text-ink-dim">{data.detail}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { tree: NodeView };

const overlaps = (a: Span | undefined, b: Span | undefined): boolean =>
  a !== undefined && b !== undefined && a.from < b.to && b.from < a.to;

export interface FlowTreeProps {
  root: FlowNode | null;
  /** kind → Tailwind classes. */
  tones: Record<string, string>;
  activeSpan?: Span | undefined;
  /** Wider nodes for plan operators, which carry longer detail lines. */
  wide?: boolean;
  empty?: string;
}

function build(root: FlowNode, props: Required<Pick<FlowTreeProps, 'tones' | 'wide'>>, activeSpan: Span | undefined) {
  // d3-hierarchy does the layout maths; React Flow only draws it.
  const h = hierarchy<FlowNode>(root, (d) => d.children);
  tree<FlowNode>().nodeSize([props.wide ? 200 : 132, 96])(h);

  const nodes: TreeFlowNode[] = h.descendants().map((d) => ({
    id: d.data.id,
    type: 'tree',
    position: { x: d.x ?? 0, y: d.y ?? 0 },
    data: {
      kind: d.data.kind,
      label: d.data.label,
      ...(d.data.detail === undefined ? {} : { detail: d.data.detail }),
      highlighted: d.data.highlight === true || overlaps(d.data.span, activeSpan),
      tone: props.tones[d.data.kind] ?? 'border-edge bg-surface-3 text-ink',
      wide: props.wide,
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

function Canvas({ root, tones, wide, activeSpan }: FlowTreeProps & { wide: boolean }) {
  const { nodes, edges } = useMemo(
    () => build(root!, { tones, wide }, activeSpan),
    [root, tones, wide, activeSpan],
  );
  const { fitView } = useReactFlow();
  // Goes false when nodes are added and true once they have been measured.
  // Fitting before measurement clips the tree.
  const measured = useNodesInitialized();

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
      fitViewOptions={{ padding: 0.16 }}
      minZoom={0.15}
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

export function FlowTree({ root, tones, activeSpan, wide = false, empty }: FlowTreeProps) {
  if (!root) {
    return <p className="text-sm text-ink-dim">{empty ?? 'Nothing to show yet.'}</p>;
  }
  return (
    <div className="h-full min-h-48 w-full">
      <ReactFlowProvider>
        <Canvas root={root} tones={tones} wide={wide} activeSpan={activeSpan} />
      </ReactFlowProvider>
    </div>
  );
}
