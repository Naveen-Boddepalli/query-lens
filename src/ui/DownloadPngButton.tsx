import { useState } from 'react';
import type { RefObject } from 'react';

/**
 * plan.md §20.8: a **Download PNG** action on every diagram panel, with the
 * app's real fonts and colours embedded.
 *
 * `html-to-image` (~10 kB gzip) is `import()`ed on first use, so a route that
 * never exports a panel never pays for it. It serialises the node into an
 * `<svg><foreignObject>` and rasterises through an `<img data:…>` — which
 * `img-src 'self' data:` already permits — then hands back a `data:` PNG that a
 * same-origin `<a download>` saves. `oklch()` fills rasterise correctly in
 * Chrome and Firefox; Safari's `foreignObject`→canvas path has known bugs
 * (§20.3), so the export there may fall back to sRGB.
 */

const LABEL: Record<'idle' | 'working' | 'done' | 'error', string> = {
  idle: 'Download PNG',
  working: 'Rendering…',
  done: 'Saved ✓',
  error: 'Render failed',
};

export function DownloadPngButton({
  target,
  name,
}: {
  target: RefObject<HTMLElement | null>;
  name: string;
}) {
  const [phase, setPhase] = useState<keyof typeof LABEL>('idle');

  async function run() {
    const node = target.current;
    if (!node || phase === 'working') return;
    setPhase('working');
    try {
      const { toPng } = await import('html-to-image');
      const bg =
        getComputedStyle(document.documentElement).getPropertyValue('--color-surface-2').trim() ||
        '#111827';
      const url = await toPng(node, { pixelRatio: 2, backgroundColor: bg, cacheBust: true });

      const a = document.createElement('a');
      a.href = url;
      a.download = `querylens-${name}.png`;
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
      onClick={() => { void run(); }}
      disabled={phase === 'working'}
      className="rounded-full border border-edge bg-surface-2 px-3 py-1 text-label text-ink-dim shadow-e1 transition hover:border-ink-dim/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      title="Download this panel as a PNG, with the app's real fonts and colours"
    >
      {LABEL[phase]}
    </button>
  );
}
