/**
 * plan.md §20.3: a real vector export for the AST, plan and B+Tree trees —
 * `<rect>`/`<text>`/`<path>`, not `html-to-image`'s `toSvg`, which wraps HTML
 * in a `<foreignObject>` that Illustrator, Inkscape and PowerPoint all import
 * inconsistently. This is a screenshot with extra steps; a paper or a slide
 * deck needs the real thing.
 *
 * Reuses the exact d3-hierarchy layout `FlowTree.tsx`'s `build()` already
 * computes — same `nodeSize`, so an exported tree matches what was on screen
 * — but never touches the DOM for geometry: node dimensions come from
 * deterministic monospace text-wrapping (every label/detail line in the app
 * is `font-mono`, so a fixed character-width estimate is exact enough to wrap
 * correctly, with no text measurement needed).
 *
 * Colour is the one place this can't stay fully pure: each tree's `tones` map
 * is the same Tailwind class strings `FlowTree` already renders with (e.g.
 * `'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink ...'` or, for the
 * B+Tree, `'border-[var(--color-node-internal)]/70 ...'`) — reused as-is so
 * there is exactly one source of truth for "what colour is a Filter node,"
 * never a second colour map to drift out of sync. `resolveTone` only
 * *classifies* that string (which CSS variable it names); turning a variable
 * into a concrete colour is `resolveColor`, injected so the geometry and
 * text-wrapping above stay unit-testable without a real DOM, while the real
 * button (`DownloadSvgButton.tsx`) supplies a browser-backed resolver that
 * also converts `oklch()`/`color-mix()` down to `rgb()` — the one format
 * every destination app actually imports, unlike the CSS colour functions
 * this app's own design tokens use.
 */

import { hierarchy, tree } from 'd3-hierarchy';
import type { FlowNode, SideEdge } from './panels/FlowTree.tsx';

/** Resolves any CSS colour expression (a `var()`/`color-mix()` string) to a concrete colour. */
export type ColorResolver = (cssExpression: string) => string;

interface ResolvedTone {
  stroke: string;
  fill: string;
  text: string;
}

const HUE_RE = /\bhue-([a-z]+)\b/;
const ARBITRARY_VAR_RE = /\[var\((--[\w-]+)\)\]/;

/**
 * Classifies a `tones` entry and resolves it to concrete colours. Every tone
 * string in the app follows one of two conventions — `hue-<name>` (a design
 * token) or `[var(--color-<name>)]` (an arbitrary value naming one directly)
 * — or matches neither, which is the same "no tone declared for this kind"
 * case `FlowTree`'s own `build()` falls back on, given the identical neutral
 * triple.
 */
export function resolveTone(toneClass: string, resolveColor: ColorResolver): ResolvedTone {
  const arb = ARBITRARY_VAR_RE.exec(toneClass);
  if (arb) {
    const varExpr = `var(${arb[1]})`;
    return {
      stroke: resolveColor(varExpr),
      fill: resolveColor(`color-mix(in oklab, ${varExpr} 12%, transparent)`),
      text: resolveColor(varExpr),
    };
  }
  const hue = HUE_RE.exec(toneClass);
  if (hue) {
    const base = `var(--color-hue-${hue[1]})`;
    const ink = `var(--color-hue-${hue[1]}-ink)`;
    return {
      stroke: resolveColor(base),
      fill: resolveColor(`color-mix(in oklab, ${base} 12%, transparent)`),
      text: resolveColor(ink),
    };
  }
  return {
    stroke: resolveColor('var(--color-edge)'),
    fill: resolveColor('var(--color-surface-3)'),
    text: resolveColor('var(--color-ink)'),
  };
}

const BOX_PADDING = 10;
const GUTTER = 16;
const FONT = { label: 12, kind: 9, detail: 10, est: 9 } as const;
const LINE_HEIGHT = 1.35;
/** A monospace character's width as a fraction of its font size — generous enough that wrapping never overflows. */
const CHAR_WIDTH_RATIO = 0.62;

/** Deterministic word-wrap for a monospace line, so no DOM text measurement is needed. */
export function wrapMonospace(text: string, maxWidthPx: number, fontSizePx: number): string[] {
  const maxChars = Math.max(4, Math.floor(maxWidthPx / (fontSizePx * CHAR_WIDTH_RATIO)));
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (word.length > maxChars) {
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface LaidOutNode {
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
  kindLine: string;
  detailLines: string[];
  estLine: string | null;
  tone: ResolvedTone;
  highlighted: boolean;
}

export interface RenderSvgOptions {
  /** Same shape `FlowTreeProps.tones` takes — the DOM tone class per node kind. */
  tones: Record<string, string>;
  kindIcons?: Record<string, string>;
  wide?: boolean;
  compact?: boolean;
  sideEdges?: readonly SideEdge[];
  resolveColor: ColorResolver;
}

/**
 * Renders `root` as a self-contained SVG document string — real `<rect>`,
 * `<text>` and `<path>` elements laid out by the same d3-hierarchy tree
 * `FlowTree` uses on screen. Pure given `resolveColor`; the only side effect
 * a caller sees is whatever that callback itself performs.
 */
export function renderSvg(root: FlowNode, options: RenderSvgOptions): string {
  const { tones, kindIcons = {}, wide = false, compact = false, sideEdges = [], resolveColor } = options;
  const nodeWidth = wide ? 200 : compact ? 104 : 132;
  const rowHeight = compact ? 84 : 96;
  const boxWidth = nodeWidth - GUTTER;
  const contentWidth = boxWidth - 2 * BOX_PADDING;

  const h = hierarchy<FlowNode>(root, (d) => d.children);
  tree<FlowNode>().nodeSize([nodeWidth, rowHeight])(h);

  const descendants = h.descendants();
  const present = new Set(descendants.map((d) => d.data.id));

  const lineH = (px: number) => px * LINE_HEIGHT;

  const byId = new Map<string, LaidOutNode>();
  for (const d of descendants) {
    const node = d.data;
    const labelLines = wrapMonospace(node.label, contentWidth, FONT.label);
    const detailLines = node.detail ? wrapMonospace(node.detail, contentWidth, FONT.detail) : [];
    const icon = kindIcons[node.kind];
    const kindLine = `${icon ? `${icon} ` : ''}${node.kind.toUpperCase()}`;
    const estLine =
      node.estRows === undefined ? null : `~${String(node.estRows)} row${node.estRows === 1 ? '' : 's'}`;

    let height = BOX_PADDING * 2;
    height += labelLines.length * lineH(FONT.label);
    height += lineH(FONT.kind);
    if (detailLines.length > 0) height += detailLines.length * lineH(FONT.detail);
    if (estLine) height += lineH(FONT.est);

    byId.set(node.id, {
      x: d.x ?? 0,
      y: d.y ?? 0,
      width: boxWidth,
      height,
      labelLines,
      kindLine,
      detailLines,
      estLine,
      tone: resolveTone(tones[node.kind] ?? '', resolveColor),
      highlighted: node.highlight === true,
    });
  }

  const boxes = [...byId.values()];
  const margin = 24;
  const minX = Math.min(...boxes.map((n) => n.x)) - margin;
  const maxX = Math.max(...boxes.map((n) => n.x + n.width)) + margin;
  const minY = Math.min(...boxes.map((n) => n.y)) - margin;
  const maxY = Math.max(...boxes.map((n) => n.y + n.height)) + margin;
  const width = maxX - minX;
  const height = maxY - minY;

  const edgeColor = resolveColor('var(--color-flow-edge)');
  const sideColor = resolveColor('var(--color-node-leaf)');
  const bg = resolveColor('var(--color-surface-2)');

  const edgePaths = h.links().map((l) => {
    const a = byId.get(l.source.data.id)!;
    const b = byId.get(l.target.data.id)!;
    const x1 = a.x + a.width / 2;
    const y1 = a.y + a.height;
    const x2 = b.x + b.width / 2;
    const y2 = b.y;
    const midY = (y1 + y2) / 2;
    return `<path d="M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(midY)}, ${String(x2)} ${String(midY)}, ${String(x2)} ${String(y2)}" fill="none" stroke="${edgeColor}" stroke-width="1.5" />`;
  });

  const sidePaths = sideEdges
    .filter((e) => present.has(e.source) && present.has(e.target))
    .map((e) => {
      const a = byId.get(e.source)!;
      const b = byId.get(e.target)!;
      const x1 = a.x + a.width;
      const y1 = a.y + a.height / 2;
      const x2 = b.x;
      const y2 = b.y + b.height / 2;
      const midX = (x1 + x2) / 2;
      return `<path d="M ${String(x1)} ${String(y1)} C ${String(midX)} ${String(y1)}, ${String(midX)} ${String(y2)}, ${String(x2)} ${String(y2)}" fill="none" stroke="${sideColor}" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" />`;
    });

  const nodeEls = boxes.map((n) => {
    const cx = n.x + n.width / 2;
    let cursor = n.y + BOX_PADDING;
    const texts: string[] = [];

    const emit = (line: string, fontSize: number, family: string, opacity: number) => {
      cursor += lineH(fontSize);
      const baseline = cursor - fontSize * (LINE_HEIGHT - 1);
      texts.push(
        `<text x="${String(cx)}" y="${String(baseline)}" font-family="${family}" font-size="${String(fontSize)}" text-anchor="middle" fill="${n.tone.text}"${opacity < 1 ? ` opacity="${String(opacity)}"` : ''}>${escapeXml(line)}</text>`,
      );
    };

    for (const line of n.labelLines) emit(line, FONT.label, 'ui-monospace, Menlo, monospace', 1);
    emit(n.kindLine, FONT.kind, 'ui-sans-serif, system-ui, sans-serif', 0.85);
    for (const line of n.detailLines) emit(line, FONT.detail, 'ui-monospace, Menlo, monospace', 0.85);
    if (n.estLine) emit(n.estLine, FONT.est, 'ui-monospace, Menlo, monospace', 0.7);

    const strokeWidth = n.highlighted ? 2 : 1;
    return [
      `<rect x="${String(n.x)}" y="${String(n.y)}" width="${String(n.width)}" height="${String(n.height)}" rx="8" fill="${n.tone.fill}" stroke="${n.tone.stroke}" stroke-width="${String(strokeWidth)}" />`,
      ...texts,
    ].join('\n');
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${String(minX)} ${String(minY)} ${String(width)} ${String(height)}" width="${String(Math.round(width))}" height="${String(Math.round(height))}">`,
    `<rect x="${String(minX)}" y="${String(minY)}" width="${String(width)}" height="${String(height)}" fill="${bg}" />`,
    ...edgePaths,
    ...sidePaths,
    ...nodeEls,
    '</svg>',
  ].join('\n');
}

/**
 * The real, browser-backed resolver — two steps, not one:
 *
 * 1. A throwaway element's `color` is set to the CSS expression and read back
 *    via `getComputedStyle`. This is the only step that can resolve `var()`
 *    and `color-mix()` at all — they need a real cascade to resolve against,
 *    which a bare colour string does not have.
 * 2. That computed value is then painted onto a 1×1 canvas and read back as
 *    concrete RGBA bytes. Step 1 alone is not enough: this app's tokens are
 *    `oklch()`, and current Chrome's `getComputedStyle` now *preserves* that
 *    — it does not normalise to `rgb()` the way it used to — so without this
 *    step the exported SVG would still be full of `oklch()`/`oklab()`
 *    strings, the exact "imports inconsistently" problem this file exists to
 *    avoid, just via an unsupported colour function instead of an
 *    unsupported element. Canvas's own colour parser rasterises any CSS
 *    Color 4 syntax to plain 8-bit sRGB, which is the one format every
 *    destination — Illustrator, Inkscape, PowerPoint — actually imports.
 */
export function resolveCssColor(cssExpression: string): string {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.color = cssExpression;
  document.body.appendChild(probe);
  const literal = getComputedStyle(probe).color;
  probe.remove();
  if (!literal) return '#888';

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return literal;

  ctx.fillStyle = '#000';
  ctx.fillStyle = literal;
  ctx.fillRect(0, 0, 1, 1);
  // A 1×1 ImageData always has exactly 4 bytes (RGBA) — the `!`s just tell
  // the type system what the canvas API itself guarantees.
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  const [r, g, b, a] = [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]!];
  const alpha = Math.round((a / 255) * 1000) / 1000;
  return alpha < 1 ? `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(alpha)})` : `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}
