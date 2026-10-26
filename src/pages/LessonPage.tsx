import { useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
  type ReplacementPolicyName,
  type StepEvent,
} from '../engine/index.ts';
import { LESSONS, lessonById, stepLink } from './learn/lessons.tsx';
import { readCompleted, setCompleted } from '../ui/learnProgress.ts';
import { recordPrediction } from '../ui/progress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, card, eyebrow } from '../ui/primitives.ts';

function CheckIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3.5 8.5l3 3 6-6" />
    </svg>
  );
}

function CrossIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function ArrowLeftIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
      <path d="M12.5 8h-9M7 4.5L3.5 8 7 11.5" />
    </svg>
  );
}

function ArrowRightIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
      <path d="M3.5 8h9M9 4.5l3.5 3.5L9 11.5" />
    </svg>
  );
}

const SEED_DB = createSeedDatabase();

/** Embedded live mini visualizer projecting query engine state at target step */
function EmbeddedLiveVisualizer({
  sql,
  policy = 'lru',
  targetStepFinder,
  deepLinkHref,
  deepLinkLabel,
}: {
  sql: string;
  policy?: ReplacementPolicyName | undefined;
  targetStepFinder?: ((events: readonly StepEvent[]) => number) | undefined;
  deepLinkHref?: string | undefined;
  deepLinkLabel?: string | undefined;
}) {
  const result = useMemo(() => {
    return runQuery(sql, SEED_DB, { ...DEFAULT_ENGINE_OPTIONS, policy });
  }, [sql, policy]);

  const targetEventIndex = useMemo(() => {
    if (!targetStepFinder || result.events.length === 0) return 0;
    const stepNumber = targetStepFinder(result.events);
    return Math.max(0, Math.min(result.events.length - 1, stepNumber - 1));
  }, [result.events, targetStepFinder]);

  const event = result.events[targetEventIndex];
  const activeStage = event?.stage ?? 'parse';

  return (
    <div className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge/60 pb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro uppercase tracking-wider text-accent font-semibold">
            Live Engine Visualizer
          </span>
          <span className="rounded border border-edge bg-surface-3 px-1.5 py-0.5 font-mono text-micro text-ink-dim uppercase">
            {policy}
          </span>
        </div>
        <span className="font-mono text-micro text-ink-dim">
          Target Step {targetEventIndex + 1} of {result.events.length}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-edge bg-surface/90 px-3 py-2 font-mono text-micro text-ink shadow-neu-track">
        <span className="text-ink-dim select-none">$ </span>
        {sql.replace(/\n/g, ' ')}
      </div>

      <div className="mt-3 rounded-lg border border-edge/60 bg-surface-3/70 p-3 text-label">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-micro uppercase tracking-wider text-ink-dim">
            Engine State
          </span>
          <span className="rounded border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-micro text-accent font-semibold uppercase">
            {activeStage}
          </span>
        </div>
        <p className="mt-1.5 font-mono text-label text-ink leading-relaxed">
          {event?.label || 'Ready.'}
        </p>
      </div>

      {deepLinkHref && (
        <div className="mt-3 flex justify-end">
          <Link to={deepLinkHref} className={`${btnPrimary} gap-1.5 text-label`}>
            <span>{deepLinkLabel ?? 'Open in Playground'}</span>
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

/** Checkpoint prediction component that updates local progress telemetry */
function CheckpointCard({
  prediction,
}: {
  prediction: {
    question: string;
    options: { id: string; label: string }[];
    correctOptionId: string;
    explanation: string;
  };
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);

  function handleSelect(id: string) {
    if (answered) return;
    setSelected(id);
    setAnswered(true);
    const isCorrect = id === prediction.correctOptionId;
    recordPrediction(isCorrect);
  }

  const isCorrect = selected === prediction.correctOptionId;

  return (
    <div className="ql-sheen mt-4 rounded-xl border border-edge bg-surface-2/90 p-4 shadow-neu-rest backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 border-b border-edge/60 pb-2.5">
        <span className="flex items-center gap-1.5 font-mono text-micro uppercase tracking-wider text-accent font-semibold">
          <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
          Active Checkpoint Prediction
        </span>
        <span className="font-mono text-micro text-ink-dim">Test your intuition</span>
      </div>

      <p className="mt-3 font-medium text-body text-ink leading-relaxed">
        {prediction.question}
      </p>

      <div className="mt-3 space-y-2">
        {prediction.options.map((opt) => {
          const isChosen = selected === opt.id;
          const isThisCorrect = opt.id === prediction.correctOptionId;

          let btnClass = 'border-edge bg-surface-3/60 text-ink-dim hover:border-ink-dim/40 hover:text-ink hover:bg-surface-3';
          if (answered) {
            if (isThisCorrect) {
              btnClass = 'border-hit/60 bg-hit/15 text-hit font-medium';
            } else if (isChosen) {
              btnClass = 'border-evict/60 bg-evict/15 text-evict font-medium';
            } else {
              btnClass = 'border-edge/40 bg-surface-3/30 text-ink-dim/40 opacity-60';
            }
          }

          return (
            <button
              key={opt.id}
              type="button"
              disabled={answered}
              onClick={() => handleSelect(opt.id)}
              className={`w-full text-left rounded-lg border p-2.5 text-label transition flex items-center justify-between gap-3 shadow-neu-rest ${btnClass}`}
            >
              <span>{opt.label}</span>
              {answered && isThisCorrect && <CheckIcon className="h-4 w-4 text-hit shrink-0" />}
              {answered && isChosen && !isThisCorrect && (
                <CrossIcon className="h-4 w-4 text-evict shrink-0" />
              )}
            </button>
          );
        })}
      </div>

      {answered && (
        <div
          className={`mt-3 rounded-lg border p-3 text-label leading-relaxed ${
            isCorrect
              ? 'border-hit/40 bg-hit/10 text-hit'
              : 'border-evict/40 bg-evict/10 text-ink'
          }`}
        >
          <div className="flex items-center gap-1.5 font-semibold">
            {isCorrect ? <CheckIcon className="h-3.5 w-3.5 text-hit" /> : <CrossIcon className="h-3.5 w-3.5 text-evict" />}
            <span>{isCorrect ? 'Correct intuition.' : 'Not quite.'}</span>
          </div>
          <p className="mt-1 text-ink-dim text-label">{prediction.explanation}</p>
        </div>
      )}
    </div>
  );
}

/** One lesson from the `/learn` track (plan.md §21.3 `/learn/:lessonId`). */
export function LessonPage() {
  const { lessonId } = useParams();
  const lesson = lessonById(lessonId);

  const [complete, setComplete] = useState(() => readCompleted().has(lessonId ?? ''));
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  const links = useMemo(
    () => (lesson ? lesson.steps.map((s) => (s.open ? stepLink(s.open) : null)) : []),
    [lesson],
  );

  if (!lesson) return <Navigate to="/learn" replace />;

  const index = LESSONS.findIndex((l) => l.id === lesson.id);
  const next = LESSONS[index + 1];
  const prev = LESSONS[index - 1];

  const currentStep = lesson.steps[activeStepIndex] ?? lesson.steps[0]!;
  const currentLink = links[activeStepIndex];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Breadcrumb Navigation Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-label text-ink-dim">
        <Link
          to="/learn"
          className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-ink font-medium hover:underline"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          <span>Curriculum Track</span>
        </Link>
        <span className="font-mono text-micro text-ink-dim">
          Lesson {index + 1} of {LESSONS.length}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-micro uppercase tracking-wider text-ink-dim">
          {lesson.difficulty}
        </span>
        <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-micro text-ink-dim">
          {lesson.category}
        </span>
        <span className="font-mono text-micro text-ink-dim">~{lesson.minutes} min read</span>
      </div>

      <PageHeader title={lesson.title} className="mt-2">
        {lesson.summary}
      </PageHeader>

      {/* Interactive Step Navigator / Stepper */}
      <div className="mt-8 border-b border-edge pb-4">
        <p className={eyebrow}>Lesson Steps</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {lesson.steps.map((step, i) => {
            const isActive = i === activeStepIndex;
            return (
              <button
                key={step.heading}
                type="button"
                onClick={() => setActiveStepIndex(i)}
                aria-pressed={isActive}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-label font-medium transition duration-150 select-none ${
                  isActive
                    ? 'border-accent bg-accent/20 text-ink shadow-neu-pressed font-semibold'
                    : 'border-edge bg-surface-2/70 text-ink-dim hover:border-ink-dim/40 hover:text-ink hover:bg-surface-3 shadow-neu-rest'
                }`}
              >
                <span className="font-mono text-micro text-ink-dim tabular-nums">{i + 1}.</span>
                <span>{step.heading}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step Content Card */}
      <div className="mt-6 space-y-6">
        <div className="space-y-3">
          <h2 className="text-heading font-semibold text-ink flex items-center gap-2">
            <span className="font-mono text-label text-accent tabular-nums">
              Step {activeStepIndex + 1} of {lesson.steps.length}:
            </span>
            <span>{currentStep.heading}</span>
          </h2>
          <div className="text-body leading-relaxed text-ink-dim">{currentStep.body}</div>

          {currentStep.tryThis && (
            <div className="rounded-lg border border-accent/40 bg-accent-soft/80 p-3 text-label text-ink shadow-neu-rest">
              <span className="font-semibold text-ink">Try this: </span>
              {currentStep.tryThis}
            </div>
          )}

          {currentStep.link && (
            <div className="pt-2">
              <Link to={currentStep.link.href} className={`${btnSecondary} gap-1.5`}>
                <span>{currentStep.link.label}</span>
                <ArrowRightIcon className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>

        {/* Embedded Live Engine Visualizer for steps with `open` spec */}
        {currentStep.open && (
          <EmbeddedLiveVisualizer
            key={`${currentStep.open.sql}-${activeStepIndex}`}
            sql={currentStep.open.sql}
            policy={currentStep.open.policy}
            targetStepFinder={currentStep.open.find}
            deepLinkHref={currentLink?.href}
            deepLinkLabel={currentLink?.label}
          />
        )}

        {/* Checkpoint Prediction Widget */}
        {currentStep.checkpointPrediction && (
          <CheckpointCard prediction={currentStep.checkpointPrediction} />
        )}
      </div>

      {/* Step Navigation Controls (Prev / Next Step) */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-edge/60 pt-6">
        <button
          type="button"
          disabled={activeStepIndex <= 0}
          onClick={() => setActiveStepIndex((i) => Math.max(0, i - 1))}
          className={`${btnSecondary} gap-1.5`}
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          <span>Previous step</span>
        </button>

        <span className="font-mono text-micro text-ink-dim tabular-nums">
          Step {activeStepIndex + 1} of {lesson.steps.length}
        </span>

        <button
          type="button"
          disabled={activeStepIndex >= lesson.steps.length - 1}
          onClick={() => setActiveStepIndex((i) => Math.min(lesson.steps.length - 1, i + 1))}
          className={`${btnSecondary} gap-1.5`}
        >
          <span>Next step</span>
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Lesson Complete & Track Navigation Footer */}
      <div className={`mt-8 ${card} flex flex-wrap items-center justify-between gap-4`}>
        <button
          type="button"
          className={`${complete ? btnSecondary : btnPrimary} gap-1.5`}
          onClick={() => {
            const nextState = !complete;
            setCompleted(lesson.id, nextState);
            setComplete(nextState);
          }}
        >
          <CheckIcon className={`h-4 w-4 ${complete ? 'text-hit' : 'text-ink'}`} />
          <span>{complete ? 'Completed — click to undo' : 'Mark lesson as complete'}</span>
        </button>

        <div className="flex items-center gap-4">
          {prev && (
            <Link
              to={`/learn/${prev.id}`}
              className="text-label text-ink-dim hover:text-ink font-medium"
            >
              ← Prev: {prev.title}
            </Link>
          )}
          {next ? (
            <Link
              to={`/learn/${next.id}`}
              className="text-label text-ink font-semibold hover:text-accent flex items-center gap-1"
            >
              <span>Next: {next.title}</span>
              <ArrowRightIcon className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <Link
              to="/learn"
              className="text-label text-ink font-semibold hover:text-accent flex items-center gap-1"
            >
              <span>Return to Curriculum Track</span>
              <ArrowRightIcon className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
