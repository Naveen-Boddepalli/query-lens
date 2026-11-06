import { useState } from 'react';
import { Link } from 'react-router-dom';
// From `types.ts` itself, not the engine barrel: a constant is all this page needs, and the barrel brings `runQuery`.
import { STAGES } from '../engine/types.ts';
import { LESSON_INDEX } from './learn/lessonIndex.ts';
import { clearCompleted, readCompleted } from '../ui/learnProgress.ts';
import { clearSolved, readSolved } from '../ui/challengeProgress.ts';
import { CONFIDENCE_LABELS, CONFIDENCE_LEVELS, clearProgress, readProgress } from '../ui/progress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { STAGE_META } from '../ui/stageMeta.ts';
import { btnGhost, card } from '../ui/primitives.ts';

const TOTAL_CHALLENGES = 41;

/**
 * plan.md §22.4: the returning visitor's page (§21.2). Three numbers, all read
 * from `localStorage` and all degrading to zero — lessons marked complete,
 * pipeline stages seen in a trace, and the prediction record. Footer-only nav
 * (§21.2): not the first fifteen seconds a cold visitor sees.
 */
export function ProgressPage() {
  const [lessons, setLessons] = useState(() => readCompleted());
  const [solved, setSolved] = useState(() => readSolved());
  const [progress, setProgress] = useState(() => readProgress());

  const seen = new Set(progress.stages);
  const nothing =
    lessons.size === 0 && solved.size === 0 && seen.size === 0 && progress.asked === 0;

  const hitRate =
    progress.asked === 0 ? '—' : `${Math.round((progress.right / progress.asked) * 100)}%`;
  const rated = CONFIDENCE_LEVELS.reduce((n, level) => n + progress.byConfidence[level].asked, 0);

  function reset() {
    clearCompleted();
    clearSolved();
    clearProgress();
    setLessons(new Set());
    setSolved(new Set());
    setProgress(readProgress());
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader title="Progress">
        A little of what you have done here, kept in this browser only — clearing it below, or
        clearing site data, resets it. Want questions the engine answers itself?{' '}
        <Link to="/practice" className="underline underline-offset-2 hover:text-ink">
          Practise
        </Link>
        .
      </PageHeader>

      {nothing ? (
        <p className="mt-8 text-body text-ink-dim">
          Nothing tracked yet. Run a query in the{' '}
          <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
            Playground
          </Link>{' '}
          or start the{' '}
          <Link to="/learn" className="underline underline-offset-2 hover:text-ink">
            guided path
          </Link>
          .
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          <div className={card}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold text-ink">Lessons complete</h2>
              <span className="font-mono tabular-nums text-ink-dim">
                {lessons.size} / {LESSON_INDEX.length}
              </span>
            </div>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {LESSON_INDEX.map((l) => (
                <li
                  key={l.id}
                  className={`rounded-full border px-2 py-0.5 text-label ${
                    lessons.has(l.id)
                      ? 'border-hit/50 text-hit'
                      : 'border-edge text-ink-dim'
                  }`}
                >
                  {lessons.has(l.id) ? '✓ ' : ''}
                  {l.title}
                </li>
              ))}
            </ul>
          </div>

          <div className={card}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold text-ink">Challenges solved</h2>
              <span className="font-mono tabular-nums text-ink-dim">
                {solved.size} / {TOTAL_CHALLENGES}
              </span>
            </div>
            <p className="mt-2 text-label text-ink-dim">
              {solved.size === 0 ? (
                <>
                  No challenges solved yet.{' '}
                  <Link to="/challenges" className="underline hover:text-ink">
                    Try one
                  </Link>
                  .
                </>
              ) : (
                <>
                  <span className="tabular-nums text-ink font-semibold">{solved.size}</span> solved across all categories.
                </>
              )}
            </p>
          </div>

          <div className={card}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold text-ink">Pipeline stages seen</h2>
              <span className="font-mono tabular-nums text-ink-dim">
                {seen.size} / {STAGES.length}
              </span>
            </div>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {STAGES.map((s) => (
                <li
                  key={s}
                  className={`rounded-full border px-2 py-0.5 text-label ${
                    seen.has(s) ? 'border-edge bg-surface-3 text-ink' : 'border-dashed border-edge text-ink-dim'
                  }`}
                >
                  {seen.has(s) ? '● ' : '○ '}
                  {STAGE_META[s].title}
                </li>
              ))}
            </ul>
          </div>

          <div className={card}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold text-ink">Predictions</h2>
              <span className="font-mono tabular-nums text-ink-dim">{hitRate} hit rate</span>
            </div>
            <p className="mt-2 text-label text-ink-dim">
              {progress.asked === 0 ? (
                <>None yet. Leave “Ask me to predict” on in the Playground.</>
              ) : (
                <>
                  <span className="tabular-nums text-ink font-medium">{progress.right}</span> right of{' '}
                  <span className="tabular-nums text-ink font-medium">{progress.asked}</span> committed. A wrong
                  guess you committed to is the one that teaches (RESEARCH.md §1).
                </>
              )}
            </p>
          </div>

          {rated > 0 && (
            <div className={card}>
              <div className="flex items-baseline justify-between">
                <h2 className="text-body font-semibold text-ink">Calibration</h2>
                <span className="font-mono tabular-nums text-ink-dim">{rated} rated</span>
              </div>
              <p className="mt-2 text-label text-ink-dim">
                How often a prediction came true, by how sure you said you were before committing. A bar from two or
                three predictions is noise, not a trend.
              </p>
              <ul className="mt-3 space-y-2">
                {CONFIDENCE_LEVELS.map((level) => {
                  const t = progress.byConfidence[level];
                  return (
                    <li key={level}>
                      <div className="flex items-baseline justify-between text-label">
                        <span className="text-ink">{CONFIDENCE_LABELS[level]}</span>
                        <span className="font-mono tabular-nums text-ink-dim">
                          {t.asked === 0 ? 'none yet' : `${String(t.right)} of ${String(t.asked)} right`}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-surface-3" aria-hidden>
                        <div
                          className="h-1.5 rounded-full bg-accent"
                          style={{ width: `${String(t.asked === 0 ? 0 : Math.round((t.right / t.asked) * 100))}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <button type="button" onClick={reset} className={`${btnGhost} mt-2`}>
            Clear progress
          </button>
        </div>
      )}
    </div>
  );
}
