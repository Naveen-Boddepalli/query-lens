import { useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { LESSONS, lessonById, stepLink } from './learn/lessons.tsx';
import { readCompleted, setCompleted } from '../ui/learnProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary } from '../ui/primitives.ts';

/** One lesson from the `/learn` track (plan.md §21.3 `/learn/:lessonId`). */
export function LessonPage() {
  const { lessonId } = useParams();
  const lesson = lessonById(lessonId);

  const [complete, setComplete] = useState(() => readCompleted().has(lessonId ?? ''));
  const links = useMemo(
    () => (lesson ? lesson.steps.map((s) => (s.open ? stepLink(s.open) : null)) : []),
    [lesson],
  );

  if (!lesson) return <Navigate to="/learn" replace />;

  const index = LESSONS.findIndex((l) => l.id === lesson.id);
  const next = LESSONS[index + 1];

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <p className="text-label text-ink-dim">
        <Link to="/learn" className="underline underline-offset-2 hover:text-ink">
          Learn
        </Link>
        {' · '}Lesson {index + 1} of {LESSONS.length}
      </p>
      <PageHeader title={lesson.title} className="mt-2">
        {lesson.summary}
      </PageHeader>

      <ol className="mt-8 space-y-8">
        {lesson.steps.map((step, i) => {
          const link = links[i];
          return (
          <li key={step.heading} className="border-l-2 border-edge pl-4">
            <h2 className="text-heading font-semibold text-ink">
              <span className="mr-2 font-mono text-label text-ink-dim">{i + 1}</span>
              {step.heading}
            </h2>
            <div className="mt-2 text-body leading-relaxed text-ink-dim">{step.body}</div>
            {link && (
              <Link to={link.href} className={`${btnSecondary} mt-3`}>
                {link.label} →
              </Link>
            )}
            {step.tryThis && (
              <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-label text-ink">
                <span className="font-medium">Try this. </span>
                {step.tryThis}
              </div>
            )}
          </li>
          );
        })}
      </ol>

      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-edge pt-6">
        <button
          type="button"
          className={complete ? btnSecondary : btnPrimary}
          onClick={() => {
            const nextState = !complete;
            setCompleted(lesson.id, nextState);
            setComplete(nextState);
          }}
        >
          {complete ? 'Completed ✓ — undo' : 'Mark this lesson complete'}
        </button>
        {next ? (
          <Link
            to={`/learn/${next.id}`}
            className="text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
          >
            Next: {next.title} →
          </Link>
        ) : (
          <Link
            to="/learn"
            className="text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
          >
            Back to all lessons
          </Link>
        )}
      </div>
    </div>
  );
}
