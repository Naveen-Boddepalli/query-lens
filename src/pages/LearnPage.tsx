import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LESSONS, type LessonCategory } from './learn/lessons.tsx';
import { clearCompleted, readCompleted } from '../ui/learnProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, cardInteractive, eyebrow } from '../ui/primitives.ts';

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

const CATEGORIES: ('All' | LessonCategory)[] = [
  'All',
  'Foundations',
  'Storage',
  'Optimizer',
  'Workflows',
];

export function LearnPage() {
  const [done, setDone] = useState<ReadonlySet<string>>(() => readCompleted());
  const [selectedCategory, setSelectedCategory] = useState<'All' | LessonCategory>('All');

  const completeCount = useMemo(() => LESSONS.filter((l) => done.has(l.id)).length, [done]);
  const totalMinutes = useMemo(() => LESSONS.reduce((acc, l) => acc + l.minutes, 0), []);
  const remainingMinutes = useMemo(
    () => LESSONS.filter((l) => !done.has(l.id)).reduce((acc, l) => acc + l.minutes, 0),
    [done],
  );

  const percentComplete = Math.round((completeCount / LESSONS.length) * 100);

  const filteredLessons = useMemo(
    () =>
      selectedCategory === 'All'
        ? LESSONS
        : LESSONS.filter((l) => l.category === selectedCategory),
    [selectedCategory],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <p className={eyebrow}>Curriculum Track</p>
      <PageHeader title="Database Internals Track" className="mt-1">
        A structured, hands-on path through the query execution engine. Each lesson pairs
        system conceptual prose with live engine visualizers, prediction checkpoints, and deep
        Playground links.
      </PageHeader>

      {/* Telemetry & Roadmap Overview Card */}
      <section
        aria-label="Track Progress"
        className="ql-sheen mt-8 rounded-2xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-heading font-semibold text-ink tabular-nums">
                {completeCount} / {LESSONS.length}
              </span>
              <span className="text-label text-ink-dim font-medium">lessons completed</span>
              <span className="rounded-full border border-edge bg-surface-3 px-2 py-0.5 font-mono text-micro text-ink tabular-nums">
                {percentComplete}%
              </span>
            </div>
            <p className="font-mono text-micro text-ink-dim">
              ~{totalMinutes} min total track · {remainingMinutes} min remaining
            </p>
          </div>

          {completeCount > 0 && (
            <button
              type="button"
              className={`${btnGhost} text-label text-ink-dim hover:text-evict hover:border-evict/30`}
              onClick={() => {
                clearCompleted();
                setDone(new Set());
              }}
            >
              Reset progress
            </button>
          )}
        </div>

        {/* Tactile Sunken Progress Bar */}
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full border border-edge/60 bg-surface/80 p-0.5 shadow-neu-track">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
            style={{ width: `${percentComplete}%` }}
          />
        </div>

        {/* Filter Chips */}
        <div className="mt-5 flex flex-wrap items-center gap-1.5 border-t border-edge/60 pt-4">
          <span className="mr-2 font-mono text-micro uppercase tracking-wider text-ink-dim">
            Filter:
          </span>
          {CATEGORIES.map((cat) => {
            const active = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                aria-pressed={active}
                className={`rounded-lg border px-2.5 py-1 text-label font-medium transition duration-150 select-none ${
                  active
                    ? 'border-accent/60 bg-accent/15 text-ink shadow-neu-pressed'
                    : 'border-edge bg-surface-2/60 text-ink-dim hover:border-ink-dim/40 hover:text-ink hover:bg-surface-3 shadow-neu-rest'
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </section>

      {/* Curriculum Roadmap List */}
      <div className="relative mt-8">
        <div
          aria-hidden="true"
          className="absolute top-6 bottom-6 left-5 hidden w-px bg-edge sm:block"
        />

        <ol className="space-y-3.5">
          {filteredLessons.map((lesson) => {
            const originalIndex = LESSONS.findIndex((l) => l.id === lesson.id);
            const isComplete = done.has(lesson.id);

            return (
              <li key={lesson.id} className="relative sm:pl-12">
                {/* Roadmap Milestone Marker */}
                <div
                  aria-hidden="true"
                  className={`absolute top-4 left-2.5 hidden h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border text-micro font-mono sm:flex ${
                    isComplete
                      ? 'border-hit/60 bg-hit/15 text-hit'
                      : 'border-edge bg-surface-3 text-ink-dim'
                  }`}
                >
                  {isComplete ? <CheckIcon className="h-3 w-3" /> : originalIndex + 1}
                </div>

                <Link
                  to={`/learn/${lesson.id}`}
                  className={`${cardInteractive} flex flex-col gap-2.5 group`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-surface-3 font-mono text-micro text-ink-dim sm:hidden">
                        {originalIndex + 1}
                      </span>
                      <span
                        className={`rounded border px-2 py-0.5 font-mono text-micro uppercase tracking-wider ${
                          lesson.difficulty === 'Beginner'
                            ? 'border-edge bg-surface-3/80 text-ink-dim'
                            : lesson.difficulty === 'Intermediate'
                              ? 'border-accent/40 bg-accent/10 text-accent'
                              : 'border-hue-violet-ink/30 bg-hue-violet-soft text-ink'
                        }`}
                      >
                        {lesson.difficulty}
                      </span>
                      <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-micro text-ink-dim">
                        {lesson.category}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 font-mono text-micro text-ink-dim">
                      <span>~{lesson.minutes} min</span>
                      {isComplete && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-hit/40 bg-hit/10 px-2 py-0.5 font-medium text-hit">
                          <CheckIcon className="h-3 w-3" />
                          Complete
                        </span>
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-body font-semibold text-ink group-hover:text-accent transition-colors">
                      {lesson.title}
                    </h3>
                    <p className="mt-1 text-label leading-relaxed text-ink-dim">
                      {lesson.summary}
                    </p>
                  </div>

                  <div className="flex items-center justify-between border-t border-edge/40 pt-2 text-micro text-ink-dim">
                    <span className="font-mono">{lesson.steps.length} interactive steps</span>
                    <span className="inline-flex items-center gap-1 font-medium text-ink group-hover:text-accent transition-colors">
                      {isComplete ? 'Review lesson' : 'Start lesson'}
                      <ArrowRightIcon className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
