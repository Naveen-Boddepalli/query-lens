import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { STAGES, type Stage } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';
import { btnPrimary, btnSecondary, btnGhost } from './primitives.ts';

const STAGE_ICONS: Record<Stage, string> = {
  parse: 'M3 5l3-3 3 3M6 2v8M13 11l-3 3-3-3M10 14V6',
  plan: 'M2 3h4v4H2zM10 3h4v4h-4zM6 10h4v4H6zM4 7v2h8V7',
  optimize: 'M9 1L3 8h5l-1 7 6-8H8l1-7z',
  execute: 'M8 2a6 6 0 100 12A6 6 0 008 2zM7 6l3 2-3 2V6z',
  buffer: 'M2 2h12v12H2zM2 6h12M2 10h12M6 2v12M10 2v12',
  index: 'M8 3v3M8 6L4 12M8 6l4 6M4 12h8',
  lock: 'M4 7h8v7H4zM6 7V5a2 2 0 114 0v2',
  result: 'M3 8.5l3.5 3.5L13 4',
};

export function Icon({ d, className = 'h-3.5 w-3.5' }: { d: string; className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function StageIcon({ stage, className }: { stage: Stage; className?: string | undefined }) {
  return <Icon d={STAGE_ICONS[stage]} className={className} />;
}

export function Hero() {
  const [idx, setIdx] = useState(0);
  const [play, setPlay] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (!play) return;
    const t = window.setInterval(() => setIdx((p) => (p + 1) % STAGES.length), 3600);
    return () => window.clearInterval(t);
  }, [play]);

  const stage: Stage = STAGES[idx] ?? 'parse';
  const meta = STAGE_META[stage];

  const stepStage = (d: number) => {
    setPlay(false);
    setIdx((p) => (p + d + STAGES.length) % STAGES.length);
  };

  const ctrlBtn = (onClick: () => void, aria: string, d: string) => (
    <button type="button" onClick={onClick} className="rounded p-1 text-ink-dim hover:text-ink" aria-label={aria}>
      <Icon d={d} />
    </button>
  );

  return (
    <section className="relative isolate overflow-hidden px-4 pt-12 pb-16 sm:px-8 lg:pt-20 lg:pb-24">
      <div aria-hidden className="ql-hero-backdrop" />

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-start">
        <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface-2/80 px-3 py-1 shadow-neu-rest">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="font-mono text-micro text-ink-dim uppercase tracking-wider">
            Database Internals
          </span>
        </div>

        <p className="mt-5 text-hero font-semibold text-balance text-ink tracking-tight">
          Watch a SQL query become a B+Tree traversal.
        </p>

        <p className="mt-4 max-w-2xl text-body text-ink-dim leading-relaxed">
          A toy relational engine you can watch think: parse, plan, optimize, execute.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link to="/playground" className={btnPrimary}>
            <span>Open the playground</span>
            <Icon d="M6 4l4 4-4 4" className="h-4 w-4" />
          </Link>
          <Link to="/docs" className={btnSecondary}>
            <span>Read the docs</span>
          </Link>
          <Link to="/stages" className={btnGhost}>
            <span>Explore all 8 stages</span>
            <Icon d="M6 4l4 4-4 4" />
          </Link>
        </div>

        {/* Live Visual Database Pipeline Stepper */}
        <div
          role="region"
          aria-label="Live database query pipeline stepper"
          className="ql-glass-panel ql-sheen mt-10 w-full overflow-hidden p-4 sm:p-6 shadow-neu-rest backdrop-blur-md"
        >
          <div className="flex flex-col gap-3 border-b border-edge pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wider text-accent">
                Query
              </span>
              <code className="font-mono text-code text-ink font-semibold">
                SELECT * FROM users WHERE id = 5;
              </code>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-micro text-ink-dim tabular-nums">
                Stage {idx + 1} of {STAGES.length}
              </span>

              <div className="flex items-center gap-1 rounded-lg border border-edge bg-surface/80 p-0.5 shadow-neu-track">
                {ctrlBtn(() => stepStage(-1), 'Previous stage', 'M10 12L6 8l4-4')}
                {ctrlBtn(
                  () => setPlay(!play),
                  play ? 'Pause' : 'Play',
                  play ? 'M5 3h2v10H5zm4 0h2v10H9z' : 'M5 3.5v9l8-4.5z',
                )}
                {ctrlBtn(() => stepStage(1), 'Next stage', 'M6 4l4 4-4 4')}
              </div>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Pipeline stages"
            className="my-4 flex items-center gap-1.5 overflow-x-auto pb-1"
          >
            {STAGES.map((st, i) => (
              <button
                key={st}
                type="button"
                onClick={() => {
                  setPlay(false);
                  setIdx(i);
                }}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-label font-medium transition select-none ${
                  i === idx
                    ? 'border-accent/60 bg-accent/20 text-ink'
                    : 'border-edge bg-surface-2/60 text-ink-dim hover:text-ink'
                }`}
              >
                <Icon d={STAGE_ICONS[st]} />
                <span>{STAGE_META[st].title}</span>
              </button>
            ))}
          </div>

          <div className="ql-code-plate rounded-xl border border-edge bg-surface/90 p-4 sm:p-5 shadow-neu-track">
            <span className="font-mono text-micro font-semibold uppercase tracking-wider text-accent">
              {meta.title} / {meta.blurb}
            </span>

            <p className="mt-2 text-label text-ink-dim leading-relaxed">{meta.help}</p>

            <div className="mt-3 flex items-center justify-between border-t border-edge/60 pt-3 text-label">
              <span className="font-mono text-micro text-ink-dim tabular-nums">Step {idx + 1} of 8</span>
              <Link
                to={meta.doc}
                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
              >
                Read {meta.title}
                <Icon d="M6 4l4 4-4 4" className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
