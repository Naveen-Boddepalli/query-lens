import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { durationMs } from '../motion.ts';
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
  /** A colour-independent glyph before the kind label (plan.md §22.6). */
  kindIcon?: string;
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
      /* plan.md §16.2 item 4. Every tree in the app — AST, plan, B+Tree —
         renders through this component, so one hover rule here is three panels
         covered. The tone maps in AstTree/PlanTree/BTreePanel each carry their
         own `hover:` pair, because a Filter node and a B+Tree leaf do not share
         a palette; what they share is the timing, which `.cell` fixes.

         No `cursor-pointer`: the canvas is explicitly `nodesDraggable={false}`
         and `elementsSelectable={false}`, so a node is a thing to read, not a
         control. The hover still earns its keep — a wide B+Tree at fit scale is
         a field of near-identical boxes, and pointing at one to confirm which
         is which is exactly what a reader does. */
      className={[
        'cell ql-sheen rounded-lg border px-2.5 py-1.5 text-center shadow-e1',
        data.wide ? 'w-44' : 'min-w-24',
        data.tone,
        data.highlighted ? 'z-10 scale-[1.03] shadow-glow' : '',
      ].join(' ')}
    >
      <Handle id="in" type="target" position={Position.Top} className="!opacity-0" />
      <Handle id="prev" type="target" position={Position.Left} className="!opacity-0" />
      <div className="font-mono text-label leading-tight break-words">{data.label}</div>
      <div className="text-label tracking-wide text-ink-dim uppercase">
        {data.kindIcon && <span aria-hidden>{data.kindIcon} </span>}
        {data.kind}
      </div>
      {data.detail && (
        <div className="mt-0.5 font-mono text-label break-words text-ink-dim">{data.detail}</div>
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
  'flex h-6 w-6 items-center justify-center rounded-md border border-edge bg-surface-3 text-body ' +
  'leading-none text-ink-dim shadow-e1 transition hover:border-accent/70 hover:text-ink';

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
  /**
   * kind → a short glyph shown before the kind label — a colour-independent
   * second channel for readers with colour-vision deficiency or a washed-out
   * projector (plan.md §22.6). Only supplied where the kinds are otherwise told
   * apart by hue alone (the B+Tree's internal vs leaf).
   */
  kindIcons?: Record<string, string>;
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
  props: {
    tones: Record<string, string>;
    kindIcons: Record<string, string>;
    wide: boolean;
    compact: boolean;
  },
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
      ...(props.kindIcons[d.data.kind] === undefined
        ? {}
        : { kindIcon: props.kindIcons[d.data.kind] }),
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
  const lit = new Set(nodes.filter((n) => n.data.highlighted).map((n) => n.id));

  const edges: Edge[] = [
    ...h.links().map((l) => {
      // An edge whose both ends are lit is on the active path (a B+Tree hop,
      // an optimizer rewrite) — give it the animated dash via the global
      // `.is-active` rule in index.css.
      const active = lit.has(l.source.data.id) && lit.has(l.target.data.id);
      return {
        id: `${l.source.data.id}->${l.target.data.id}`,
        source: l.source.data.id,
        target: l.target.data.id,
        sourceHandle: 'out',
        targetHandle: 'in',
        ...(active ? { className: 'is-active' } : {}),
        style: { stroke: 'var(--color-flow-edge)', strokeWidth: 1.5 },
      };
    }),
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
  kindIcons,
  wide,
  compact,
  activeSpan,
  sideEdges,
  controls,
  toolbarTarget,
  focusIds,
}: FlowTreeProps & {
  kindIcons: Record<string, string>;
  wide: boolean;
  compact: boolean;
  sideEdges: readonly SideEdge[];
}) {
  const { nodes, edges } = useMemo(
    () => build(root!, { tones, kindIcons, wide, compact }, activeSpan, sideEdges),
    [root, tones, kindIcons, wide, compact, activeSpan, sideEdges],
  );
  const { setViewport, zoomIn, zoomOut } = useReactFlow();
  const focusKey = focusIds?.join(',') ?? '';

  // Viewport moves are JavaScript, so the CSS media query cannot reach them:
  // snap instead of tweening when the viewer asks for reduced motion.
  //
  // `durationMs` reads the same `--dur-*` tokens the stylesheet uses, and the
  // reduced-motion block already collapses those to 0ms — so this hook is now
  // belt and braces rather than the only line of defence, and stays because
  // `useReducedMotion` also re-renders when the setting changes mid-session.
  const reduced = useReducedMotion();
  const glide = reduced ? 0 : 1;

  /**
   * The pane element, held in state rather than a ref so its arrival is a
   * render — something the effect below can depend on. A ref hands us the node
   * without telling us when, which is the gap the old 60ms timeout papered over.
   */
  const [pane, setPane] = useState<HTMLDivElement | null>(null);

  /**
   * Our own measurement of the pane, and the reason we no longer ask React Flow
   * for one.
   *
   * Its store does `width: size.width || 500` (and the same for height), so a
   * container it has measured at zero is indistinguishable from one genuinely
   * 500px wide. That is not hypothetical: instrumenting the failure showed the
   * store reporting 798 wide while the pane's own `clientWidth` was 0, and
   * framing against that invented number centres the tree on a point that does
   * not exist. Observing the element ourselves gives a number that is either
   * real or zero, and re-fitting on resize comes free with it.
   */
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!pane) return;
    const measure = () => {
      const { clientWidth: w, clientHeight: h } = pane;
      // Same-value writes are skipped, so `size` keeps a stable identity and
      // the framing effect below does not re-run on every observer callback.
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => { observer.disconnect(); };
  }, [pane]);

  /**
   * React Flow's pan/zoom instance — the thing that actually moves the viewport.
   *
   * Every viewport call does nothing at all while this is null, silently, and it
   * stays null until React Flow's own mount effect has built it. Depending on
   * the instance rather than on elapsed time is what makes the framing below
   * deterministic instead of a race against a timeout; depending on its
   * *identity* also catches it being rebuilt, which resets the transform to the
   * origin — StrictMode's double mount does exactly that in development.
   */
  const panZoom = useStore((state) => state.panZoom);

  /**
   * Frames a set of nodes, from the d3 positions rather than measured DOM.
   *
   * React Flow's own `fitView` and `useNodesInitialized` both depend on measured
   * node dimensions, and these graphs never report as measured — so both
   * silently do nothing. d3 gave us exact positions, so use those. That applies
   * to the unfocused case as much as the focused one, which is why the fallback
   * frames every node through the same maths rather than handing off to
   * `fitView`.
   *
   * `setViewport` rather than `setCenter`: `setCenter` derives the translation
   * from React Flow's own measured width, which is the number we just
   * established cannot be trusted. We know the box and the pane, so compute the
   * transform outright and hand over the finished answer.
   *
   * Returns whether it had enough information to frame anything.
   */
  const frame = useCallback(
    (targets: TreeFlowNode[], animate: boolean) => {
      if (targets.length === 0 || size.w === 0 || size.h === 0) return false;

      const nodeW = wide ? 200 : compact ? 104 : 132;
      const nodeH = 62;

      const minX = Math.min(...targets.map((n) => n.position.x));
      const maxX = Math.max(...targets.map((n) => n.position.x)) + nodeW;
      const minY = Math.min(...targets.map((n) => n.position.y));
      const maxY = Math.max(...targets.map((n) => n.position.y)) + nodeH;

      const margin = 1.35;
      const zoom = Math.max(
        Math.min(
          size.w / Math.max(maxX - minX, 1) / margin,
          size.h / Math.max(maxY - minY, 1) / margin,
          1.15,
        ),
        0.1,
      );

      /**
       * Whether this move may be a *transition* — the other half of the fix.
       *
       * A duration makes React Flow move the viewport through a d3 transition,
       * and d3 transitions only advance on `requestAnimationFrame`. A tab that
       * is not painting never fires one, so the transition is created and never
       * ticks: the call returns cleanly, nothing moves, and nothing tries again.
       *
       * The first framing is therefore always instant — it is the diagram
       * arriving at its correct position, and §16.1 constraint 5 rules out
       * animating on load for decoration anyway, so the fix and the constraint
       * want the same thing.
       *
       * `document.hidden` covers the *later* framings for the same reason. A
       * link posted to HN, Reddit or a course page is routinely opened into a
       * background tab, and playback timers keep running there — so a B+Tree
       * hop can re-frame while the tab is hidden, and an animated move would be
       * lost exactly as the first one was. Read at call time rather than
       * subscribed to, because the only question is whether *this* move can
       * animate.
       */
      const canAnimate = animate && !document.hidden;

      void setViewport(
        {
          x: size.w / 2 - ((minX + maxX) / 2) * zoom,
          y: size.h / 2 - ((minY + maxY) / 2) * zoom,
          zoom,
        },
        {
          // The whole diagram re-frames itself: the longest journey anything in
          // the app makes, so it takes the slow step (§16.2 item 5). Was a
          // literal 400 that matched nothing else on screen.
          duration: canAnimate ? durationMs('--dur-slow') * glide : 0,
        },
      );
      return true;
    },
    [setViewport, wide, compact, glide, size],
  );

  /**
   * The panZoom instance the current transform was framed for, so a re-frame
   * can be told from a first frame — and so a rebuilt instance, which arrives
   * with the transform reset to the origin, is treated as a first frame again.
   */
  const framedFor = useRef<typeof panZoom>(null);

  useEffect(() => {
    if (!panZoom) return;
    const focus = new Set(focusKey ? focusKey.split(',') : []);
    const focused = nodes.filter((n) => focus.has(n.id));
    if (frame(focused.length > 0 ? focused : nodes, framedFor.current === panZoom)) {
      framedFor.current = panZoom;
    }
    // `nodes` is read for positions; its length gates a full refit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, focusKey, frame, panZoom]);

  // A zoom button is a deliberate control action rather than a layout settling,
  // so it takes the base step — one notch quicker than the re-frame above.
  const zoomOpts = { duration: durationMs('--dur-base') * glide };

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
        // Animated: a button press is the most causal move there is, and the
        // viewer is by definition looking at the tab when they press it.
        onClick={() => { frame(nodes, true); }}
        aria-label="Fit the whole tree"
        className={`${ZOOM_BUTTON} w-auto px-2 text-label`}
      >
        Fit
      </button>
    </>
  );

  return (
    <>
      {controls && toolbarTarget && createPortal(toolbar, toolbarTarget)}

      <div ref={setPane} className="h-full w-full">
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
const NO_KIND_ICONS: Record<string, string> = {};

export function FlowTree({
  root,
  tones,
  kindIcons = NO_KIND_ICONS,
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
    return <p className="text-body text-ink-dim">{empty ?? 'Nothing to show yet.'}</p>;
  }
  return (
    <div className="h-full min-h-48 w-full">
      <ReactFlowProvider>
        <Canvas
          root={root}
          tones={tones}
          kindIcons={kindIcons}
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
