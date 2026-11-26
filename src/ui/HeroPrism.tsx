import { STAGES } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';

/**
 * The hero's illustration: the logo's prism, drawn large, doing what the
 * product does. A query comes in as one white ray, hits the prism, and leaves
 * as the eight pipeline stages — each ray in that stage's colour and labelled
 * with its name. It is the thesis of the app in one picture, and it uses the
 * same stage tokens as the tracker, so the colours a visitor meets here are
 * the colours they will see in the Playground.
 *
 * Decorative (the text beside it says the same thing), so `aria-hidden`.
 * The rays draw themselves once on load (`.ql-draw`); reduced motion collapses
 * that to the final frame via the global animation-duration override.
 */

const W = 560;
const H = 360;
const ENTRY = { x: 214, y: 186 };
const EXIT = { x: 300, y: 186 };
const RAY_END_X = 418;
const TOP = 46;
const STEP = 38;

export function HeroPrism() {
  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      className="h-auto w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="ql-prism-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-surface-4)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--color-surface-2)" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="ql-prism-edge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-stage-parse)" />
          <stop offset="0.5" stopColor="var(--color-stage-optimize)" />
          <stop offset="1" stopColor="var(--color-stage-index)" />
        </linearGradient>
      </defs>

      {/* the query, as one ray of light */}
      <text
        x="8"
        y={ENTRY.y - 14}
        className="fill-ink-dim font-mono"
        style={{ fontSize: 12 }}
      >
        SELECT * FROM users
      </text>
      <path
        d={`M8 ${String(ENTRY.y)} H${String(ENTRY.x)}`}
        pathLength={1}
        className="ql-draw stroke-ink"
        strokeWidth="2.5"
        strokeLinecap="round"
        style={{ animationDelay: '0ms' }}
      />

      {/* the spectrum fanning out */}
      <g className="ql-ray-glow">
        {STAGES.map((stage, i) => {
          const y = TOP + i * STEP;
          const color = `var(--color-stage-${stage})`;
          return (
            <g key={stage}>
              <path
                d={`M${String(EXIT.x)} ${String(EXIT.y)} L${String(RAY_END_X)} ${String(y)}`}
                pathLength={1}
                className="ql-draw"
                stroke={color}
                strokeWidth="2.25"
                strokeLinecap="round"
                style={{ animationDelay: `${String(380 + i * 70)}ms` }}
              />
              <circle
                cx={RAY_END_X}
                cy={y}
                r="3.5"
                fill={color}
                className="ql-fade"
                style={{ animationDelay: `${String(620 + i * 70)}ms` }}
              />
              <text
                x={RAY_END_X + 14}
                y={y + 4}
                fill={color}
                className="ql-fade font-mono"
                style={{ fontSize: 13, animationDelay: `${String(620 + i * 70)}ms` }}
              >
                {STAGE_META[stage].title.toLowerCase()}
              </text>
            </g>
          );
        })}
      </g>

      {/* the prism itself, drawn over the ray ends so the light seems to pass through */}
      <path
        d="M257 64 L338 300 Q340 308 332 308 L182 308 Q174 308 176 300 Z"
        fill="url(#ql-prism-face)"
        stroke="url(#ql-prism-edge)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d={`M${String(ENTRY.x)} ${String(ENTRY.y)} L${String(EXIT.x)} ${String(EXIT.y)}`}
        className="stroke-ink"
        strokeWidth="1.5"
        strokeOpacity="0.35"
        strokeDasharray="3 5"
      />
    </svg>
  );
}
