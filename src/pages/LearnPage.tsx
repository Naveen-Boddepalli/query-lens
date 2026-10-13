import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LESSON_GROUPS, LESSON_INDEX } from './learn/lessonIndex.ts';
import { clearCompleted, readCompleted } from '../ui/learnProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, cardInteractive } from '../ui/primitives.ts';

/**
 * plan.md §21.3 `/learn`: the §17.2 manual tasks as an ordered track. The docs
 * (`/docs`) are the reference; this is the guided version — each lesson drives
 * the Playground to the step it describes and keeps a completion mark in
 * `localStorage` (a convenience only; see `learnProgress.ts`).
 *
 * It lists lessons from `learn/lessonIndex.ts` and imports none of their steps, so this route carries a few kB of
 * titles rather than every lesson's prose and the engine.
 */
export function LearnPage() {
  const [done, setDone] = useState<ReadonlySet<string>>(() => readCompleted());
  const completeCount = LESSON_INDEX.filter((l) => done.has(l.id)).length;

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader title="Learn">
        A short, ordered path through the engine. Each lesson opens the Playground or a tool at the
        exact moment it describes, and most end with one thing to change and re-run. Progress is
        kept in this browser only.
      </PageHeader>

      <div className="mt-6 flex items-center justify-between text-label text-ink-dim">
        <span className="tabular-nums">
          {completeCount} of {LESSON_INDEX.length} complete
        </span>
        {completeCount > 0 && (
          <button
            type="button"
            className={btnGhost}
            onClick={() => { clearCompleted(); setDone(new Set()); }}
          >
            Reset progress
          </button>
        )}
      </div>

      {LESSON_GROUPS.map((group) => {
        const lessons = group.lessons;
        const first = LESSON_INDEX.findIndex((l) => l.id === lessons[0]!.id);
        return (
          <section key={group.title} aria-labelledby={`track-${group.id}`} className="mt-8">
            <h2 id={`track-${group.id}`} className="text-heading font-semibold text-ink">
              {group.title}
            </h2>
            <p className="mt-1 text-label text-ink-dim">{group.about}</p>
            <ol className="mt-4 space-y-3">
              {lessons.map((lesson, i) => {
                const complete = done.has(lesson.id);
                return (
                  <li key={lesson.id}>
                    <Link to={`/learn/${lesson.id}`} className={cardInteractive}>
                      <div className="flex items-baseline gap-3">
                        <span className="font-mono text-label text-ink-dim tabular-nums">{first + i + 1}</span>
                        <h3 className="flex-1 text-body font-semibold text-ink">{lesson.title}</h3>
                        {complete ? (
                          <span className="shrink-0 text-label text-hit">done ✓</span>
                        ) : (
                          <span className="shrink-0 text-label text-ink-dim">{lesson.minutes} min</span>
                        )}
                      </div>
                      <p className="mt-1 pl-7 text-label text-ink-dim">{lesson.summary}</p>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}

      <p className="mt-8 text-label text-ink-dim">
        Prefer to read rather than be walked through it? The same ground, as reference, is in the{' '}
        <Link to="/docs" className="underline underline-offset-2 hover:text-ink">
          docs
        </Link>
        .
      </p>
    </div>
  );
}
