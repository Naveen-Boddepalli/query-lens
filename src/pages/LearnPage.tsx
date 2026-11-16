import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LESSON_GROUPS, LESSON_INDEX, type LessonGroupId } from './learn/lessonIndex.ts';
import type { CSSProperties } from 'react';

/** Each track borrows a stage colour (the Prism spectrum), the same mapping the
 *  Tools index uses, so "storage" is the buffer pool's coral everywhere. */
const GROUP_STAGE: Record<LessonGroupId, string> = {
  pipeline: 'optimize',
  storage: 'buffer',
  transactions: 'lock',
  distributed: 'parse',
};
const groupStyle = (id: LessonGroupId): CSSProperties =>
  ({ '--stage': `var(--color-stage-${GROUP_STAGE[id]})` }) as CSSProperties;
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

const TRACK_FILTERS: { id: 'All' | LessonGroupId; label: string }[] = [
  { id: 'All', label: 'All Tracks' },
  { id: 'pipeline', label: 'Query Pipeline' },
  { id: 'storage', label: 'Storage Engine' },
  { id: 'transactions', label: 'Transactions & WAL' },
];

export function LearnPage() {
  const [done, setDone] = useState<ReadonlySet<string>>(() => readCompleted());
  const [selectedGroup, setSelectedGroup] = useState<'All' | LessonGroupId>('All');

  const completeCount = useMemo(() => LESSON_INDEX.filter((l) => done.has(l.id)).length, [done]);
  const totalMinutes = useMemo(() => LESSON_INDEX.reduce((acc, l) => acc + l.minutes, 0), []);
  const remainingMinutes = useMemo(
    () => LESSON_INDEX.filter((l) => !done.has(l.id)).reduce((acc, l) => acc + l.minutes, 0),
    [done],
  );

  const percentComplete = Math.round((completeCount / LESSON_INDEX.length) * 100);

  const visibleGroups = useMemo(
    () =>
      selectedGroup === 'All'
        ? LESSON_GROUPS
        : LESSON_GROUPS.filter((g) => g.id === selectedGroup),
    [selectedGroup],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <p className={eyebrow}>Curriculum Track</p>
      <PageHeader title="Database Internals Track" className="mt-1">
        A short, ordered path through the engine. Each lesson pairs system conceptual prose with live
        engine visualizers, prediction checkpoints, and deep Playground links.
      </PageHeader>

      {/* Track Progress Overview Card */}
      <section
        aria-label="Track Progress"
        className="ql-sheen mt-8 rounded-2xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-heading font-semibold text-ink tabular-nums">
                {completeCount} of {LESSON_INDEX.length} complete
              </span>
              <span className="rounded-full border border-edge bg-surface-3 px-2 py-0.5 font-mono text-label text-ink tabular-nums">
                {percentComplete}%
              </span>
            </div>
            <p className="font-mono text-label text-ink-dim">
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
            className="h-full rounded-full bg-[image:var(--gradient-spectrum)] transition-all duration-500 ease-out"
            style={{ width: `${percentComplete}%` }}
          />
        </div>

        {/* Filter Chips */}
        <div className="mt-5 flex flex-wrap items-center gap-1.5 border-t border-edge/60 pt-4">
          <span className="mr-2 font-mono text-label uppercase tracking-wider text-ink-dim">
            Track:
          </span>
          {TRACK_FILTERS.map((filter) => {
            const active = selectedGroup === filter.id;
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => setSelectedGroup(filter.id)}
                aria-pressed={active}
                className={`rounded-lg border px-2.5 py-1 text-label font-medium transition duration-150 select-none ${
                  active
                    ? 'border-accent/60 bg-accent/15 text-ink shadow-neu-pressed'
                    : 'border-edge bg-surface-2/60 text-ink-dim hover:border-ink-dim/40 hover:text-ink hover:bg-surface-3 shadow-neu-rest'
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Curriculum Groups */}
      <div className="mt-10 space-y-12">
        {visibleGroups.map((group) => {
          const lessons = group.lessons;
          const first = LESSON_INDEX.findIndex((l) => l.id === lessons[0]!.id);

          return (
            <section key={group.id} aria-labelledby={`track-${group.id}`} className="relative" style={groupStyle(group.id)}>
              <div className="mb-4">
                <h2 id={`track-${group.id}`} className="flex items-center gap-2.5 text-heading font-semibold text-ink">
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--stage)] shadow-[0_0_10px_var(--stage)]" />
                  {group.title}
                </h2>
                <p className="mt-1 text-label text-ink-dim leading-relaxed">{group.about}</p>
              </div>

              {/* Roadmap line */}
              <div className="relative mt-6">
                <div
                  aria-hidden="true"
                  className="absolute top-6 bottom-6 left-5 hidden w-px bg-gradient-to-b from-[var(--stage)] to-edge sm:block"
                />

                <ol className="space-y-3.5">
                  {lessons.map((lesson, i) => {
                    const lessonIndex = first + i;
                    const isComplete = done.has(lesson.id);

                    return (
                      <li key={lesson.id} className="relative sm:pl-12">
                        {/* Roadmap Milestone Marker */}
                        <div
                          aria-hidden="true"
                          className={`absolute top-4 left-2.5 hidden h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border text-label font-mono sm:flex ${
                            isComplete
                              ? 'border-hit/60 bg-hit/15 text-hit'
                              : 'border-edge bg-surface-3 text-ink-dim'
                          }`}
                        >
                          {isComplete ? <CheckIcon className="h-3 w-3" /> : lessonIndex + 1}
                        </div>

                        <Link
                          to={`/learn/${lesson.id}`}
                          className={`${cardInteractive} flex flex-col gap-2.5 group`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-surface-3 font-mono text-label text-ink-dim sm:hidden">
                                {lessonIndex + 1}
                              </span>
                              <span className="inline-flex items-center gap-1.5 rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-label text-ink-dim">
                                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--stage)]" />
                                {group.title}
                              </span>
                            </div>

                            <div className="flex items-center gap-2 font-mono text-label text-ink-dim">
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

                          <div className="flex items-center justify-between border-t border-edge/40 pt-2 text-label text-ink-dim">
                            <span className="font-mono">Interactive guided track</span>
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
