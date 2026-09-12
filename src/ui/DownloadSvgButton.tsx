import { useState } from 'react';
import { renderSvg, resolveCssColor } from './renderSvg.ts';
import type { FlowNode, SideEdge } from './panels/FlowTree.tsx';

/**
 * plan.md §20.3: a real vector export, alongside `DownloadPngButton` — a
 * `data:image/svg+xml` link built from `renderSvg`, the same `data:` +
 * `<a download>` pattern `downloadTrace` already uses (no `blob:` lifecycle
 * to manage, and `img-src`/no CSP concern applies here since nothing is
 * rendered from it before the click).
 */

const LABEL: Record<'idle' | 'done' | 'error', string> = {
  idle: 'Download SVG',
  done: 'Saved ✓',
  error: 'Render failed',
};

export interface DownloadSvgButtonProps {
  root: FlowNode;
  tones: Record<string, string>;
  kindIcons?: Record<string, string>;
  wide?: boolean;
  compact?: boolean;
  sideEdges?: readonly SideEdge[];
  name: string;
}

export function DownloadSvgButton({
  root,
  tones,
  kindIcons,
  wide,
  compact,
  sideEdges,
  name,
}: DownloadSvgButtonProps) {
  const [phase, setPhase] = useState<keyof typeof LABEL>('idle');

  function run() {
    try {
      const svg = renderSvg(root, {
        tones,
        ...(kindIcons ? { kindIcons } : {}),
        ...(wide === undefined ? {} : { wide }),
        ...(compact === undefined ? {} : { compact }),
        ...(sideEdges ? { sideEdges } : {}),
        resolveColor: resolveCssColor,
      });

      const a = document.createElement('a');
      a.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      a.download = `querylens-${name}.svg`;
      a.click();

      setPhase('done');
      window.setTimeout(() => { setPhase('idle'); }, 2000);
    } catch {
      setPhase('error');
      window.setTimeout(() => { setPhase('idle'); }, 3000);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      className="rounded-full border border-edge bg-surface-2 px-3 py-1 text-label text-ink-dim shadow-e1 transition hover:border-ink-dim/50 hover:text-ink"
      title="Download this tree as a real vector SVG — rect/text/path, not a screenshot — for a paper or a slide deck"
    >
      {LABEL[phase]}
    </button>
  );
}
