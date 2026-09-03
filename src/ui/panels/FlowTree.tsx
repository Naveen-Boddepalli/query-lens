import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import { hierarchy, tree } from 'd3-hierarchy';
import '@xyflow/react/dist/style.css';
import type { Span } from '../../engine/index.ts';
import { useReducedMotion } from '../useReducedMotion.ts';

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
      <div className="text-3xs tracking-wide text-ink-dim uppercase">{data.kind}</div>
      {data.detail && (
        <div className="mt-0.5 font-mono text-3xs break-words text-ink-dim">{data.detail}</div>
      )}
      <Handle id="out" type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle id="next" type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { tree: NodeView };

// 24px minimum on both axes — WCAG 2.2 SC 2.5.8, the rule that also set the
// scrubber's size (plan.md §15.1 item 8). React Flow's own buttons are 16px.
const ZOOM_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded border border-edge bg-surface-3 text-sm ' +
  'leading-none text-ink-dim transition-colors hover:border-accent/70 hover:text-ink';

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
   * Where to put the zoom buttons. React Flow's own <Controls> float in a
   * corner of the pane, and for a B+Tree that corner is the leaf row — they
   * overlapped the nodes they exist to help you read. Rendering them into the
   * panel's own header instead costs no canvas height, which a strip above the
   * graph did: it clipped the bottom row by exactly its own height.
   */
  toolbarTarget?: HTMLElement | null;
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
  toolbarTarget,
  focusIds,
}: FlowTreeProps & { wide: boolean; compact: boolean; sideEdges: readonly SideEdge[] }) {
  const { nodes, edges } = useMemo(
    () => build(root!, { tones, wide, compact }, activeSpan, sideEdges),
    [root, tones, wide, compact, activeSpan, sideEdges],
  );
  const { setCenter, zoomIn, zoomOut } = useReactFlow();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const focusKey = focusIds?.join(',') ?? '';

  // Viewport moves are JavaScript, so the CSS media query cannot reach them:
  // snap instead of tweening when the viewer asks for reduced motion.
  const reduced = useReducedMotion();
  const glide = reduced ? 0 : 1;

  /**
   * React Flow's own measurement of its container, read from its store.
   *
   * Every viewport call — `setCenter` included — is a no-op while this is 0,
   * silently. Since the app runs its first trace on load (plan.md §15.1 item
   * 1), this canvas now mounts during the very first render, before the grid
   * containing it has been laid out: the fit fired, did nothing, and the tree
   * sat unframed in the corner until something else re-ran it. Measuring our
   * own element would not help — React Flow measures asynchronously, so the
   * number that matters is *its* width, not ours. Refitting on resize comes
   * free with it.
   */
  const rfWidth = useStore((state) => state.width);

  /**
   * Centre on the focused nodes, computed from the layout we already hold.
   *
   * React Flow's own `fitView` and `useNodesInitialized` both depend on
   * measured node dimensions, and these graphs never report as measured — so
   * both silently do nothing. d3 gave us exact positions, so use those.
   * `requestAnimationFrame` is unreliable here too (throttled when the pane is
   * not painting); a short timeout fires regardless.
   *
   * That applies to the unfocused case as much as the focused one, which is
   * why the fallback frames every node through the same maths rather than
   * handing off to `fitView`. Since the app now runs its first trace on load
   * (plan.md §15.1 item 1), the very first paint *is* the unfocused case — and
   * it was the one path still asking React Flow to measure something.
   */
  /** Frames a set of nodes, from the d3 positions rather than measured DOM. */
  const frame = useCallback(
    (targets: TreeFlowNode[]) => {
      const pane = paneRef.current;
      if (targets.length === 0 || !pane) return;

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
        duration: 400 * glide,
      });
    },
    [setCenter, wide, compact, glide],
  );

  useEffect(() => {
    if (rfWidth === 0) return;
    const timer = window.setTimeout(() => {
      const focus = new Set(focusKey ? focusKey.split(',') : []);
      const focused = nodes.filter((n) => focus.has(n.id));
      frame(focused.length > 0 ? focused : nodes);
    }, 60);

    return () => { window.clearTimeout(timer); };
    // `nodes` is read for positions; its length gates a full refit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, focusKey, frame, rfWidth]);

  const zoomOpts = { duration: 200 * glide };

  const toolbar = (
    <>
      <button
        type="button"
        onClick={() => { void zoomOut(zoomOpts); }}
        aria-label="Zoom out"
        className={ZOOM_BUTTON}
      >
        <span aria-hidden>−</span>
      </button>
      <button
        type="button"
        onClick={() => { void zoomIn(zoomOpts); }}
        aria-label="Zoom in"
        className={ZOOM_BUTTON}
      >
        <span aria-hidden>+</span>
      </button>
      <button
        type="button"
        // Our own maths, not React Flow's `fitView`: that needs measured node
        // dimensions, which these graphs never report.
        onClick={() => { frame(nodes); }}
        aria-label="Fit the whole tree"
        className={`${ZOOM_BUTTON} w-auto px-2 text-2xs`}
      >
        Fit
      </button>
    </>
  );

  return (
    <>
      {controls && toolbarTarget && createPortal(toolbar, toolbarTarget)}

      <div ref={paneRef} className="h-full w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          // No `fitView` prop: it lands late, once React Flow has measured, and
          // then overrides the framing the effect above computed deliberately.
          minZoom={0.08}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-edge)" />
        </ReactFlow>
      </div>
    </>
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
  toolbarTarget = null,
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
          toolbarTarget={toolbarTarget}
          focusIds={focusIds}
        />
      </ReactFlowProvider>
    </div>
  );
}
