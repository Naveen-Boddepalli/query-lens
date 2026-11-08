import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { btnPrimary, btnSecondary } from './primitives.ts';
import { useReducedMotion } from './useReducedMotion.ts';

/**
 * plan.md §19.2 P1 — the 60-second tour. Five sequential highlights over the
 * real Playground (not a video, not a modal carousel): a dim ground with a
 * spotlight on one region at a time and a caption pinned to the viewport edge.
 * Skippable at any point (Skip, Esc), never auto-started — it opens only from
 * the first-visit hint, the "Tour" link, or `?tour=1`.
 *
 * `prefers-reduced-motion` degrades it to a static numbered overlay: one panel,
 * the five captions as an ordered list, no stepping and no moving spotlight
 * (§19.2's required fallback).
 *
 * Targets are found by `data-tour="<key>"` on the Playground's own elements, so
 * this component holds no reference to that page's React tree.
 */

interface TourStep {
  target: string;
  title: string;
  body: string;
}

const STEPS: readonly TourStep[] = [
  {
    target: 'editor',
    title: 'Your query',
    body: 'SQL goes here — a point lookup is already loaded and has already run, so there is something to watch straight away. The chips above swap in other queries.',
  },
  {
    target: 'pipeline',
    title: 'The pipeline',
    body: 'Eight stages, parser to result. Each lights up as the trace reaches it; click any stage to hold the panel there while the rest runs on.',
  },
  {
    target: 'panel',
    title: 'The stage in detail',
    body: 'The current stage in full — the syntax tree here, the buffer pool or the B+Tree descent elsewhere. The ? by the title explains what you are looking at.',
  },
  {
    target: 'narration',
    title: 'Predict, then reveal',
    body: 'Every step is narrated here. At marked steps the run stops and asks what happens next — committing to a guess, right or wrong, is the part that teaches.',
  },
  {
    target: 'playback',
    title: 'Move through it',
    body: 'Arrows step, Space plays, the scrubber jumps anywhere. Copy the link and it reopens on exactly the step you are on.',
  },
];

interface Spot {
  top: number;
  left: number;
  width: number;
  height: number;
  /** Animate to this rect (a step change) rather than snap to it (a page scroll). */
  glide: boolean;
}

function findTarget(key: string): Element | null {
  return document.querySelector(`[data-tour="${key}"]`);
}

const tourCard = 'rounded-xl border border-edge bg-surface-2 shadow-e2 ql-sheen outline-none';

export function PlaygroundTour({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion();
  return reduced ? <StaticTour onClose={onClose} /> : <SpotlightTour onClose={onClose} />;
}

function SpotlightTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Spot | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const last = i === STEPS.length - 1;
  const step = STEPS[i]!;

  useLayoutEffect(() => {
    const measure = (glide: boolean) => {
      const r = findTarget(step.target)?.getBoundingClientRect();
      if (!r) { setRect(null); return; }
      // Unchanged geometry keeps the old object, so the scroll event that our
      // own `scrollIntoView` below fires does not re-render or cut a glide short.
      setRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height, glide },
      );
    };

    // Only scroll when the target is not already wholly on screen. Centring it
    // regardless drags the window down into the footer for regions that were
    // in view all along (the shell is exactly one viewport tall on desktop).
    //
    // `behavior: 'instant'` is load-bearing: index.css sets `scroll-behavior:
    // smooth` on <html>, which `scrollIntoView` honours by default. The scroll
    // is then still in flight when the rect is read below, so the spotlight
    // lands where the target *was* and the page scrolls out from under it.
    const first = findTarget(step.target);
    if (first) {
      const r = first.getBoundingClientRect();
      const onScreen =
        r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
      if (!onScreen) first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
    measure(true);

    // The overlay is `fixed`, so anything that moves the target afterwards — a
    // resize, the page (or the Playground's own scrolling panel) being scrolled
    // behind the dim, a layout shift — has to move the spotlight with it, and
    // without lagging a 180ms glide behind the content. `scroll` does not
    // bubble, so it is caught in the capture phase.
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { measure(false); });
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    const observer = new ResizeObserver(remeasure);
    if (first) observer.observe(first);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
      observer.disconnect();
    };
  }, [step.target]);

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => { restoreFocus.current?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setI((n) => Math.min(n + 1, STEPS.length - 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setI((n) => Math.max(n - 1, 0)); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  // Keep the caption clear of the highlighted region: sit at the top when the
  // target is in the lower half of the viewport, at the bottom otherwise.
  const cardAtTop = rect ? rect.top + rect.height / 2 > window.innerHeight / 2 : false;

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="Playground tour"
    >
      {rect && (
        <div
          aria-hidden
          data-tour-spotlight={step.target}
          className={`pointer-events-none fixed rounded-xl ring-2 ring-accent ${
            rect.glide ? 'transition-[top,left,width,height] duration-[var(--dur-base)]' : ''
          }`}
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: '0 0 0 100vmax rgba(2,6,12,0.64)',
          }}
        />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        className={`fixed left-1/2 w-[min(23rem,calc(100vw-2rem))] -translate-x-1/2 p-4 ${tourCard} ${
          cardAtTop ? 'top-6' : 'bottom-6'
        }`}
      >
        <p className="text-label text-ink-dim tabular-nums">
          Step {i + 1} of {STEPS.length}
        </p>
        <h2 className="mt-1 text-body font-semibold text-ink">{step.title}</h2>
        <p className="mt-1 text-label leading-relaxed text-ink-dim">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-label text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            Skip tour
          </button>
          <div className="flex gap-2">
            {i > 0 && (
              <button type="button" onClick={() => setI((n) => n - 1)} className={btnSecondary}>
                Back
              </button>
            )}
            <button
              type="button"
              onClick={last ? onClose : () => setI((n) => n + 1)}
              className={btnPrimary}
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StaticTour({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,12,0.64)] p-4 backdrop-blur-sm">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Playground tour"
        className={`w-full max-w-md p-5 ${tourCard}`}
      >
        <h2 className="text-heading font-semibold text-ink">A 60-second tour</h2>
        <p className="mt-1 text-label text-ink-dim">Five parts of the Playground, in order.</p>
        <ol className="mt-4 space-y-3">
          {STEPS.map((s, n) => (
            <li key={s.target} className="flex gap-3">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-edge text-label tabular-nums text-ink-dim">
                {n + 1}
              </span>
              <p className="text-label leading-relaxed text-ink-dim">
                <span className="font-medium text-ink">{s.title}.</span> {s.body}
              </p>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className={btnPrimary}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
