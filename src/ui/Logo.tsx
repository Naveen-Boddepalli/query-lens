/**
 * The QueryLens mark — a geometric database cylinder stack intersected by an
 * optical lens ray: data in storage illuminated and inspected step-by-step.
 *
 * Inline SVG, not an asset: it inherits `currentColor` for the database tiers
 * and uses the accent token for the refracted lens ray, so it is theme-correct
 * for free and costs zero network requests. Always decorative — the adjacent
 * wordmark is the accessible label.
 */

export const VERSION_TAG = 'v0.9.4-dev';

export function Logo({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* Top database cylinder platter */}
      <ellipse
        cx="16"
        cy="7.5"
        rx="11"
        ry="3.75"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.95"
      />
      {/* Middle platter tier */}
      <path
        d="M5 7.5v6c0 2.07 4.92 3.75 11 3.75s11-1.68 11-3.75v-6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.85"
      />
      {/* Lower platter tier */}
      <path
        d="M5 13.5v6c0 2.07 4.92 3.75 11 3.75s11-1.68 11-3.75v-6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.7"
      />
      {/* Base platter tier */}
      <path
        d="M5 19.5v5c0 2.07 4.92 3.75 11 3.75s11-1.68 11-3.75v-5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.55"
      />
      {/* Optical query ray lens: precision ray entering and refracting through storage */}
      <path
        d="M1 16.5h5.5"
        stroke="var(--color-accent-strong)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 11.5l8 10"
        stroke="var(--color-accent)"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M25.5 16.5H31"
        stroke="var(--color-accent-strong)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      {/* Internal focal point */}
      <circle cx="16" cy="16.5" r="1.5" fill="var(--color-accent)" />
    </svg>
  );
}

export function VersionBadge({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center rounded border border-edge bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-ink-dim uppercase select-none ${className}`}
    >
      {VERSION_TAG}
    </span>
  );
}
