import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CHALLENGES } from './challenges/challenges.tsx';
import { clearSolved, readSolved } from '../ui/challengeProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, cardInteractive } from '../ui/primitives.ts';

/**
 * plan.md §22.4: goal-shaped puzzles. Each opens a small editor whose Run
 * result is checked against a pure predicate — no backend. Solved marks are a
 * `localStorage` convenience (`challengeProgress.ts`).
 */
export function ChallengesPage() {
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => readSolved());
  const done = CHALLENGES.filter((c) => solved.has(c.id)).length;

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader title="Challenges">
        Short, goal-shaped puzzles. Write a query, run it, and the check tells you whether you hit
        the goal — the trace shows you why. Progress is kept in this browser only.
      </PageHeader>

      <div className="mt-6 flex items-center justify-between text-label text-ink-dim">
        <span className="tabular-nums">
          {done} of {CHALLENGES.length} solved
        </span>
        {solved.size > 0 && (
          <button
            type="button"
            className={btnGhost}
            onClick={() => { clearSolved(); setSolved(new Set()); }}
          >
            Reset progress
          </button>
        )}
      </div>

      <ol className="mt-4 space-y-3">
        {CHALLENGES.map((c, i) => (
          <li key={c.id}>
            <Link to={`/challenges/${c.id}`} className={cardInteractive}>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-label text-ink-dim tabular-nums">{i + 1}</span>
                <h3 className="flex-1 text-body font-semibold text-ink">{c.title}</h3>
                {solved.has(c.id) && <span className="shrink-0 text-label text-hit">solved ✓</span>}
              </div>
              <p className="mt-1 pl-7 text-label text-ink-dim">{c.brief}</p>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
