/**
 * The QueryLens mark — a prism: one ray in, the spectrum out. It stands in for
 * the whole product thesis (a query goes in one side, its internals come out
 * the other) and gives the wordmark something to sit beside so the header is
 * not just text, which every published list of "unchosen" design tells names.
 *
 * Inline SVG, not an asset: it inherits `currentColor` for the prism and uses
 * the accent token for the refracted rays, so it is theme-correct for free and
 * costs no request. Always decorative — the adjacent wordmark is the label.
 */
export function Logo({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* the prism */}
      <path
        d="M15 4.5 27 25a1.6 1.6 0 0 1-1.4 2.4H4.4A1.6 1.6 0 0 1 3 25L15 4.5a1.15 1.15 0 0 1 2 0Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
        opacity="0.9"
      />
      {/* incoming ray */}
      <path d="M1 15.5h7.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      {/* refracted spectrum */}
      <path d="M18 19.5h13" stroke="var(--color-accent-strong)" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M18 23h13" stroke="var(--color-accent)" strokeWidth="1.75" strokeLinecap="round" opacity="0.75" />
      <path d="M18 26.5h13" stroke="var(--color-hue-violet)" strokeWidth="1.75" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}
