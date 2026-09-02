import { useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
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
      <Handle id="in" type="target" position={Position.Top} className="!opacity-0" />
      <Handle id="prev" type="target" position={Position.Left} className="!opacity-0" />
      <div className="font-mono text-xs leading-tight break-words">{data.label}</div>
      <div className="text-[9px] tracking-wide text-ink-dim uppercase">{data.kind}</div>
      {data.detail && (
        <div className="mt-0.5 font-mono text-[9px] break-words text-ink-dim">{data.detail}</div>
      )}
      <Handle id="out" type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle id="next" type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { tree: NodeView };

const overlaps = (a: Span | undefined, b: Span | undefined): boolean =>
  a !== undefined && b !== undefined && a.from < b.to && b.from < a.to;

/** A non-hierarchical link, e.g. the B+Tree's leaf sibling chain. */
export interface SideEdge {
  source: string;
  target: string;
}

export interface FlowTreeProps {
  root: FlowNode | null;
  /** kind → Tailwind classes. */
  tones: Record<string, string>;
  activeSpan?: Span | undefined;
  /** Wider nodes for plan operators, which carry longer detail lines. */
  wide?: boolean;
  /** Tighter horizontal spacing, for trees with many leaves. */
  compact?: boolean;
  sideEdges?: readonly SideEdge[];
  /** Zoom/fit buttons — worth it on a tree too big to read at fit scale. */
  controls?: boolean;
  /**
   * Zoom to these nodes rather than the whole tree. A B+Tree over a real table
   * is far too wide to read at fit scale; the root-to-leaf path is the part
   * that carries the lesson, so the view follows it.
   */
  focusIds?: readonly string[] | undefined;
  empty?: string;
}

function build(
  root: FlowNode,
  props: { tones: Record<string, string>; wide: boolean; compact: boolean },
  activeSpan: Span | undefined,
  sideEdges: readonly SideEdge[],
) {
  // d3-hierarchy does the layout maths; React Flow only draws it.
  const h = hierarchy<FlowNode>(root, (d) => d.children);
  const width = props.wide ? 200 : props.compact ? 104 : 132;
  tree<FlowNode>().nodeSize([width, props.compact ? 84 : 96])(h);

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

  const present = new Set(nodes.map((n) => n.id));

  const edges: Edge[] = [
    ...h.links().map((l) => ({
      id: `${l.source.data.id}->${l.target.data.id}`,
      source: l.source.data.id,
      target: l.target.data.id,
      sourceHandle: 'out',
      targetHandle: 'in',
      style: { stroke: 'var(--color-edge)', strokeWidth: 1.5 },
    })),
    ...sideEdges
      .filter((e) => present.has(e.source) && present.has(e.target))
      .map((e) => ({
        id: `side-${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        sourceHandle: 'next',
        targetHandle: 'prev',
        style: {
          stroke: 'var(--color-node-leaf)',
          strokeWidth: 1,
          strokeDasharray: '3 3',
          opacity: 0.55,
        },
      })),
  ];

  return { nodes, edges };
}

function Canvas({
  root,
  tones,
  wide,
  compact,
  activeSpan,
  sideEdges,
  controls,
  focusIds,
}: FlowTreeProps & { wide: boolean; compact: boolean; sideEdges: readonly SideEdge[] }) {
  const { nodes, edges } = useMemo(
    () => build(root!, { tones, wide, compact }, activeSpan, sideEdges),
    [root, tones, wide, compact, activeSpan, sideEdges],
  );
  const { fitView, setCenter } = useReactFlow();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const focusKey = focusIds?.join(',') ?? '';

  /**
   * Centre on the focused nodes, computed from the layout we already hold.
   *
   * React Flow's own `fitView({ nodes })` and `useNodesInitialized` both depend
   * on measured node dimensions, and these graphs never report as measured — so
   * both silently do nothing. d3 gave us exact positions, so use those.
   * `requestAnimationFrame` is unreliable here too (throttled when the pane is
   * not painting); a short timeout fires regardless.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const focus = new Set(focusKey ? focusKey.split(',') : []);
      const targets = nodes.filter((n) => focus.has(n.id));
      const pane = paneRef.current;

      if (targets.length === 0 || !pane) {
        void fitView({ padding: 0.16, duration: 250 });
        return;
      }

      const paneW = pane.clientWidth || 600;
      const paneH = pane.clientHeight || 320;
      const nodeW = wide ? 200 : compact ? 104 : 132;
      const nodeH = 62;

      const minX = Math.min(...targets.map((n) => n.position.x));
      const maxX = Math.max(...targets.map((n) => n.position.x)) + nodeW;
      const minY = Math.min(...targets.map((n) => n.position.y));
      const maxY = Math.max(...targets.map((n) => n.position.y)) + nodeH;

      const margin = 1.35;
      const zoom = Math.min(
        paneW / Math.max(maxX - minX, 1) / margin,
        paneH / Math.max(maxY - minY, 1) / margin,
        1.15,
      );

      void setCenter((minX + maxX) / 2, (minY + maxY) / 2, {
        zoom: Math.max(zoom, 0.1),
        duration: 400,
      });
    }, 60);

    return () => { window.clearTimeout(timer); };
    // `nodes` is read for positions; its length gates a full refit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, focusKey, fitView, setCenter, wide, compact]);

  return (
    <div ref={paneRef} className="h-full w-full">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.16 }}
      minZoom={0.08}
      maxZoom={1.6}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-edge)" />
      {controls && <Controls showInteractive={false} position="bottom-right" />}
    </ReactFlow>
    </div>
  );
}

const NO_SIDE_EDGES: readonly SideEdge[] = [];

export function FlowTree({
  root,
  tones,
  activeSpan,
  wide = false,
  compact = false,
  sideEdges = NO_SIDE_EDGES,
  controls = false,
  focusIds,
  empty,
}: FlowTreeProps) {
  if (!root) {
    return <p className="text-sm text-ink-dim">{empty ?? 'Nothing to show yet.'}</p>;
  }
  return (
    <div className="h-full min-h-48 w-full">
      <ReactFlowProvider>
        <Canvas
          root={root}
          tones={tones}
          wide={wide}
          compact={compact}
          activeSpan={activeSpan}
          sideEdges={sideEdges}
          controls={controls}
          focusIds={focusIds}
        />
      </ReactFlowProvider>
    </div>
  );
}
