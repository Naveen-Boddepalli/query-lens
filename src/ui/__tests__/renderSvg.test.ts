import { describe, expect, it } from 'vitest';
import { renderSvg, resolveCssColor, resolveTone, wrapMonospace } from '../renderSvg.ts';
import type { ColorResolver } from '../renderSvg.ts';
import type { FlowNode } from '../panels/FlowTree.tsx';

describe('wrapMonospace', () => {
  it('does not wrap text that already fits', () => {
    expect(wrapMonospace('SeqScan users', 200, 12)).toEqual(['SeqScan users']);
  });

  it('wraps on word boundaries when the line is too long', () => {
    const lines = wrapMonospace('age > 30 AND status = blocked', 60, 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('age > 30 AND status = blocked');
  });

  it('hard-breaks a single word longer than the whole line', () => {
    const lines = wrapMonospace('a'.repeat(40), 30, 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('a'.repeat(40));
  });

  it('an empty string still yields one (empty) line, never zero', () => {
    expect(wrapMonospace('', 100, 12)).toEqual(['']);
  });
});

describe('resolveTone', () => {
  const echo: ColorResolver = (expr) => expr;

  it('classifies a hue-token tone (AstTree/PlanTree convention)', () => {
    const tone = resolveTone('border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky', echo);
    expect(tone.stroke).toBe('var(--color-hue-sky)');
    expect(tone.text).toBe('var(--color-hue-sky-ink)');
    expect(tone.fill).toBe('color-mix(in oklab, var(--color-hue-sky) 12%, transparent)');
  });

  it('classifies an arbitrary-value tone (BTreePanel convention)', () => {
    const tone = resolveTone(
      'border-[var(--color-node-internal)]/70 bg-[var(--color-node-internal)]/10 text-[var(--color-node-internal)]',
      echo,
    );
    expect(tone.stroke).toBe('var(--color-node-internal)');
    expect(tone.text).toBe('var(--color-node-internal)');
  });

  it('falls back to the neutral triple for an unmapped or plain tone', () => {
    const tone = resolveTone('border-edge bg-surface-3 text-ink', echo);
    expect(tone).toEqual({
      stroke: 'var(--color-edge)',
      fill: 'var(--color-surface-3)',
      text: 'var(--color-ink)',
    });
  });

  it('falls back to neutral for an empty string — an unmapped kind', () => {
    expect(resolveTone('', echo).stroke).toBe('var(--color-edge)');
  });

  // Anti-drift: every real tone string in the app must classify as either the
  // hue or arbitrary-var convention, or be one of the handful *deliberately*
  // neutral entries (Literal/Star share FlowTree's own unmapped-kind
  // fallback on purpose) — never something resolveTone silently mis-parses.
  const DELIBERATELY_NEUTRAL = new Set(['Literal', 'Star']);

  it('classifies every real tone string the app actually uses', async () => {
    const [{ TONES: astTones }, { TONES: planTones }, { TONES: btreeTones }] = await Promise.all([
      import('../panels/astTreeTones.ts'),
      import('../panels/planTreeTones.ts'),
      import('../panels/btreeTones.ts'),
    ]);
    const neutral = { stroke: 'var(--color-edge)', fill: 'var(--color-surface-3)', text: 'var(--color-ink)' };
    for (const [kind, tone] of [
      ...Object.entries(astTones),
      ...Object.entries(planTones),
      ...Object.entries(btreeTones),
    ]) {
      const resolved = resolveTone(tone, echo);
      if (DELIBERATELY_NEUTRAL.has(kind)) {
        expect(resolved, `tone for ${kind}`).toEqual(neutral);
      } else {
        expect(resolved, `tone for ${kind}`).not.toEqual(neutral);
      }
    }
  });
});

describe('resolveCssColor', () => {
  // jsdom has no real canvas backend, so this only exercises the DOM-resolve
  // half and the graceful fallback when `getContext('2d')` is unavailable —
  // the rasterisation-to-rgb() half is verified against a real browser, not
  // reproducible headlessly (plan.md §22.5's PNG export has the same split).
  it('never throws, and resolves a plain colour token to something non-empty', () => {
    expect(() => resolveCssColor('red')).not.toThrow();
    expect(resolveCssColor('red')).not.toBe('');
  });
});

const TONES = { Root: 'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink' };
const echo: ColorResolver = (expr) => expr;

describe('renderSvg', () => {
  const tree: FlowNode = {
    id: 'a',
    kind: 'Root',
    label: 'SELECT *',
    detail: 'FROM users',
    children: [
      { id: 'b', kind: 'Root', label: 'child one' },
      { id: 'c', kind: 'Root', label: 'child two', highlight: true },
    ],
  };

  it('produces a well-formed SVG document with one rect per node plus the background', () => {
    const svg = renderSvg(tree, { tones: TONES, resolveColor: echo });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    // 3 nodes + 1 background rect.
    expect(svg.match(/<rect /g)).toHaveLength(4);
  });

  it('draws one edge path per parent-child link', () => {
    const svg = renderSvg(tree, { tones: TONES, resolveColor: echo });
    expect(svg.match(/<path /g)).toHaveLength(2);
  });

  it('includes a side edge only when both endpoints are present', () => {
    const withSide = renderSvg(tree, {
      tones: TONES,
      resolveColor: echo,
      sideEdges: [{ source: 'b', target: 'c' }, { source: 'b', target: 'nonexistent' }],
    });
    // 2 hierarchy edges + exactly 1 side edge (the other references a missing node).
    expect(withSide.match(/<path /g)).toHaveLength(3);
  });

  it('escapes XML-sensitive characters in labels', () => {
    const svg = renderSvg(
      { id: 'x', kind: 'Root', label: '<a>&"q"' },
      { tones: TONES, resolveColor: echo },
    );
    expect(svg).not.toContain('<a>&"q"');
    expect(svg).toContain('&lt;a&gt;&amp;&quot;q&quot;');
  });

  it('gives a highlighted node a thicker stroke', () => {
    const svg = renderSvg(tree, { tones: TONES, resolveColor: echo });
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('stroke-width="1"');
  });

  it('is deterministic for the same input', () => {
    const a = renderSvg(tree, { tones: TONES, resolveColor: echo });
    const b = renderSvg(tree, { tones: TONES, resolveColor: echo });
    expect(a).toEqual(b);
  });

  it('a wide tree lays out wider boxes than a normal one', () => {
    const normal = renderSvg(tree, { tones: TONES, resolveColor: echo });
    const wide = renderSvg(tree, { tones: TONES, resolveColor: echo, wide: true });
    const widthOf = (svg: string) => Number(/<rect x="[\d.-]+" y="[\d.-]+" width="([\d.]+)"/.exec(svg)![1]);
    expect(widthOf(wide)).toBeGreaterThan(widthOf(normal));
  });

  it('calls resolveColor with every colour it needs, and nothing crashes if it throws-free for any expression', () => {
    const seen: string[] = [];
    const spy: ColorResolver = (expr) => { seen.push(expr); return '#000'; };
    renderSvg(tree, { tones: TONES, resolveColor: spy });
    expect(seen).toContain('var(--color-flow-edge)');
    expect(seen).toContain('var(--color-surface-2)');
    expect(seen.some((e) => e.includes('--color-hue-sky'))).toBe(true);
  });
});
