/**
 * plan.md §16.2 item 5 — the motion scale, reachable from JavaScript.
 *
 * The durations are defined once, in `src/index.css`, as `--dur-fast`,
 * `--dur-base` and `--dur-slow`. CSS transitions read them directly; flowinger
 * viewport animations cannot, because they take a number of milliseconds as a
 * function argument. That is exactly how a literal `duration: 400` ends up in a
 * component and stops matching anything — which is what `FlowTree` had.
 *
 * So the number is read back out of the stylesheet rather than duplicated here.
 * The token stays the single source of truth, and the reduced-motion override
 * comes free: `@media (prefers-reduced-motion: reduce)` sets the tokens to 0ms,
 * so a caller that asks for `--dur-slow` is handed 0 without having to know why.
 */

/** The three named steps. Anything animating picks one of these, not a number. */
export type Duration = '--dur-fast' | '--dur-base' | '--dur-slow';

/**
 * Fallbacks for when there is no stylesheet to read: jsdom under Vitest, and
 * the first call of a server-rendered pass. They match index.css by hand, which
 * is a duplication — but a silent 0ms in a test is a worse one, because it
 * would make an assertion about animation pass for the wrong reason.
 */
const FALLBACK: Record<Duration, number> = {
  '--dur-fast': 120,
  '--dur-base': 180,
  '--dur-slow': 320,
};

/** Parses the two forms a CSS time can take. `320ms` and `.32s` are the same. */
function parseMs(value: string): number | null {
  const text = value.trim();
  if (text.endsWith('ms')) {
    const ms = Number.parseFloat(text);
    return Number.isFinite(ms) ? ms : null;
  }
  if (text.endsWith('s')) {
    const s = Number.parseFloat(text);
    return Number.isFinite(s) ? s * 1000 : null;
  }
  return null;
}

/**
 * The named duration, in milliseconds, as the stylesheet currently defines it.
 *
 * Read on every call rather than cached: the value legitimately changes when
 * the viewer turns reduced motion on, and a cache would hold the old one until
 * a reload. The read is a `getComputedStyle` on `:root` for a single custom
 * property, which is cheap and happens at most a few times per interaction.
 */
export function durationMs(name: Duration): number {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return FALLBACK[name];
  }
  const declared = getComputedStyle(document.documentElement).getPropertyValue(name);
  const parsed = declared ? parseMs(declared) : null;
  // An empty string means the stylesheet has not loaded; 0 is a real value the
  // reduced-motion block sets deliberately, so it must survive the `??`.
  return parsed ?? FALLBACK[name];
}
