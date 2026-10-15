import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { STAGES } from '../engine/index.ts';
import { LESSONS } from './learn/lessons.tsx';
import { clearCompleted, readCompleted } from '../ui/learnProgress.ts';
import { clearSolved, readSolved } from '../ui/challengeProgress.ts';
import { clearProgress, readProgress } from '../ui/progress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { STAGE_META } from '../ui/stageMeta.ts';
import { btnGhost, btnPrimary, btnSecondary, card, eyebrow } from '../ui/primitives.ts';

const CheckIcon = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3.5 8.5l3 3 6-6" />
  </svg>
);

const ArrowRightIcon = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
    <path d="M3.5 8h9M9 4.5l3.5 3.5L9 11.5" />
  </svg>
);

const TOTAL_CHALLENGES = 12;

/**
 * plan.md §22.4 / §21.2: Returning visitor's progress telemetry dashboard.
 * Tracks completed lessons, solved challenges, pipeline stages seen in traces,
 * and prediction calibration accuracy — stored purely in this browser.
 */
export function ProgressPage() {
  const [lessons, setLessons] = useState(() => readCompleted());
  const [solved, setSolved] = useState(() => readSolved());
  const [progress, setProgress] = useState(() => readProgress());
  const [confirmClear, setConfirmClear] = useState(false);

  const seen = useMemo(() => new Set(progress.stages), [progress.stages]);
  const isEmpty = lessons.size === 0 && solved.size === 0 && seen.size === 0 && progress.asked === 0;

  const hitRate = progress.asked === 0 ? '—' : `${Math.round((progress.right / progress.asked) * 100)}%`;
  const lessonPercent = Math.round((lessons.size / LESSONS.length) * 100);
  const challengePercent = Math.round((solved.size / TOTAL_CHALLENGES) * 100);
  const stagePercent = Math.round((seen.size / STAGES.length) * 100);
  const predScore = progress.asked > 0 ? (progress.right / progress.asked) * 100 : 0;
  const compositeScore = Math.round(
    lessonPercent * 0.35 + challengePercent * 0.35 + stagePercent * 0.2 + predScore * 0.1,
  );

  function resetAll() {
    clearCompleted();
    clearSolved();
    clearProgress();
    setLessons(new Set());
    setSolved(new Set());
    setProgress(readProgress());
    setConfirmClear(false);
  }

  const statCards = [
    { label: 'Lessons', value: `${lessons.size} / ${LESSONS.length}`, percent: lessonPercent, color: 'bg-accent' },
    { label: 'Challenges', value: `${solved.size} / ${TOTAL_CHALLENGES}`, percent: challengePercent, color: 'bg-hit' },
    { label: 'Stages Seen', value: `${seen.size} / ${STAGES.length}`, percent: stagePercent, color: 'bg-ink' },
    { label: 'Predictions', value: hitRate, percent: predScore, color: 'bg-hue-violet-ink' },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <p className={eyebrow}>Learning Metrics &amp; Telemetry</p>
      <PageHeader title="Your Progress Dashboard" className="mt-1">
        Local browser telemetry tracking your curriculum completion, challenge mastery,
        pipeline stage coverage, and active prediction hit rate.
      </PageHeader>

      {isEmpty ? (
        <div className="ql-sheen mt-8 rounded-2xl border border-edge bg-surface-2/80 p-8 text-center shadow-neu-rest backdrop-blur-md">
          <h3 className="text-heading font-semibold text-ink">No telemetry recorded yet</h3>
          <p className="mx-auto mt-2 max-w-md text-label leading-relaxed text-ink-dim">
            Begin the guided curriculum track or jump directly into interactive database challenges to
            build your mastery telemetry.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link to="/learn" className={btnPrimary}>
              <span>Start Curriculum Track</span>
              <ArrowRightIcon className="h-3.5 w-3.5" />
            </Link>
            <Link to="/challenges" className={btnSecondary}>
              <span>Browse Challenges</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {/* Master Telemetry Scorecard */}
          <section
            aria-label="Mastery Overview"
            className="ql-sheen rounded-2xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
          >
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-edge/60 pb-4">
              <div className="space-y-1">
                <span className="font-mono text-micro uppercase tracking-wider text-accent font-semibold">
                  Internals Mastery Composite
                </span>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-title font-bold text-ink tabular-nums">
                    {compositeScore}%
                  </span>
                  <span className="text-label text-ink-dim">overall track progress</span>
                </div>
              </div>

              {!confirmClear ? (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className={`${btnGhost} text-label text-ink-dim hover:text-evict hover:border-evict/30`}
                >
                  Reset all progress
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-micro text-evict">Confirm reset?</span>
                  <button
                    type="button"
                    onClick={resetAll}
                    className="rounded-lg border border-evict/60 bg-evict/15 px-2.5 py-1 text-label font-medium text-evict shadow-neu-pressed"
                  >
                    Yes, reset
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className={`${btnGhost} px-2 py-1 text-label text-ink-dim`}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* 4 Core Metric Cards Grid */}
            <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
              {statCards.map((sc) => (
                <div key={sc.label} className="rounded-xl border border-edge/70 bg-surface-3/50 p-3.5 shadow-neu-rest">
                  <span className="font-mono text-micro uppercase tracking-wider text-ink-dim">
                    {sc.label}
                  </span>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="font-mono text-heading font-semibold text-ink tabular-nums">
                      {sc.value}
                    </span>
                    <span className="font-mono text-micro text-ink-dim tabular-nums">
                      {Math.round(sc.percent)}%
                    </span>
                  </div>
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface shadow-neu-track">
                    <div
                      className={`h-full rounded-full ${sc.color} transition-all duration-500`}
                      style={{ width: `${Math.min(100, sc.percent)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Curriculum Lessons Progress */}
          <section
            aria-label="Lessons Progress"
            className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
          >
            <div className="flex items-center justify-between border-b border-edge/60 pb-3">
              <h3 className="text-body font-semibold text-ink">Curriculum Lessons</h3>
              <Link to="/learn" className="text-label text-ink hover:text-accent font-medium">
                Open Track →
              </Link>
            </div>
            <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {LESSONS.map((l) => {
                const isComplete = lessons.has(l.id);
                return (
                  <li key={l.id}>
                    <Link
                      to={`/learn/${l.id}`}
                      className={`flex items-center justify-between rounded-lg border p-2 text-label transition shadow-neu-rest ${
                        isComplete
                          ? 'border-hit/40 bg-hit/10 text-hit hover:border-hit/60'
                          : 'border-edge bg-surface-3/50 text-ink-dim hover:text-ink'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-mono text-micro shrink-0">
                          {isComplete ? <CheckIcon className="h-3 w-3 text-hit" /> : '○'}
                        </span>
                        <span className="truncate">{l.title}</span>
                      </div>
                      <span className="ml-2 font-mono text-micro shrink-0 opacity-70">
                        {l.minutes}m
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Challenges Status */}
          <section
            aria-label="Challenges Progress"
            className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
          >
            <div className="flex items-center justify-between border-b border-edge/60 pb-3">
              <h3 className="text-body font-semibold text-ink">Database Challenges</h3>
              <Link to="/challenges" className="text-label text-ink hover:text-accent font-medium">
                Open Challenges →
              </Link>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-edge bg-surface-3/40 p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-hit/40 bg-hit/10 text-hit font-mono text-body font-bold">
                  {solved.size}
                </span>
                <div>
                  <p className="text-body font-semibold text-ink">
                    {solved.size} of {TOTAL_CHALLENGES} challenges completed ({challengePercent}%)
                  </p>
                  <p className="text-label text-ink-dim">
                    {solved.size === TOTAL_CHALLENGES
                      ? 'All challenges solved!'
                      : `${TOTAL_CHALLENGES - solved.size} remaining to complete full mastery.`}
                  </p>
                </div>
              </div>
              <Link to="/challenges" className={btnSecondary}>
                <span>Explore Challenges</span>
              </Link>
            </div>
          </section>

          {/* Pipeline Stages Coverage */}
          <section
            aria-label="Pipeline Stages"
            className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
          >
            <div className="flex items-center justify-between border-b border-edge/60 pb-3">
              <h3 className="text-body font-semibold text-ink">Pipeline Stages Discovered</h3>
              <Link to="/stages" className="text-label text-ink hover:text-accent font-medium">
                Stage Reference →
              </Link>
            </div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              {STAGES.map((s) => {
                const isSeen = seen.has(s);
                return (
                  <div
                    key={s}
                    className={`rounded-lg border p-2.5 text-center transition ${
                      isSeen
                        ? 'border-edge bg-surface-3/90 text-ink shadow-neu-rest'
                        : 'border-dashed border-edge/70 bg-surface/40 text-ink-dim/50'
                    }`}
                  >
                    <span className="font-mono text-micro text-ink-dim block">
                      {isSeen ? 'DISCOVERED' : 'UNSEEN'}
                    </span>
                    <span className="mt-0.5 block font-mono text-label uppercase font-semibold">
                      {s}
                    </span>
                    <span className="block text-micro text-ink-dim truncate">
                      {STAGE_META[s].title}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Prediction Calibration Insight Card */}
          <section aria-label="Active Predictions" className={`ql-sheen p-5 ${card}`}>
            <h3 className="text-body font-semibold text-ink">Cognitive Calibration</h3>
            <p className="mt-2 text-label leading-relaxed text-ink-dim">
              {progress.asked === 0 ? (
                <>
                  No active predictions recorded yet. Turn on{' '}
                  <strong className="text-ink">Ask me to predict</strong> in the Playground or
                  complete prediction checkpoints in lessons to test your intuition.
                </>
              ) : (
                <>
                  You have committed to{' '}
                  <span className="font-mono text-ink font-semibold tabular-nums">
                    {progress.asked}
                  </span>{' '}
                  active predictions with{' '}
                  <span className="font-mono text-hit font-semibold tabular-nums">
                    {progress.right}
                  </span>{' '}
                  correct ({hitRate} accuracy). A wrong guess committed to beforehand is the
                  single most powerful learning mechanism in interactive systems.
                </>
              )}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
