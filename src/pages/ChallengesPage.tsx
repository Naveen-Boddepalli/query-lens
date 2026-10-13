import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CHALLENGES } from './challenges/challenges.tsx';
import { SCRIPT_CHALLENGES } from './challenges/scriptChallenges.tsx';
import { SETTINGS_CHALLENGES } from './challenges/settingsChallenges.tsx';
import { clearSolved, readSolved } from '../ui/challengeProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, cardInteractive } from '../ui/primitives.ts';

interface Entry {
  id: string;
  title: string;
  brief: ReactNode;
}

const GROUPS: { id: string; title: string; about: string; entries: readonly Entry[] }[] = [
  {
    id: 'queries',
    title: 'Queries',
    about: 'Write a query that makes the engine do — or not do — something specific.',
    entries: CHALLENGES,
  },
  {
    id: 'transactions',
    title: 'Transactions and durability',
    about: 'Write a schedule of two sessions, or a script for the write-ahead log, and make the engine do it.',
    entries: SCRIPT_CHALLENGES,
  },
  {
    id: 'storage',
    title: 'Storage and execution',
    about: 'Set the knobs of a sort, a join, a page, an index or a tree, and make the numbers say what you claim.',
    entries: SETTINGS_CHALLENGES,
  },
];

/**
 * plan.md §22.4: goal-shaped puzzles. Each opens a small editor whose Run
 * result is checked against a pure predicate — no backend. Solved marks are a
 * `localStorage` convenience (`challengeProgress.ts`).
 */
export function ChallengesPage() {
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => readSolved());
  const all = GROUPS.flatMap((g) => g.entries);
  const done = all.filter((c) => solved.has(c.id)).length;

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader title="Challenges">
        Short, goal-shaped puzzles. Write a query — or a schedule or a log script, or set the knobs of a tool — run it,
        and the check tells you whether you hit the goal. The trace shows you why. Progress is kept in this browser
        only.
      </PageHeader>

      <div className="mt-6 flex items-center justify-between text-label text-ink-dim">
        <span className="tabular-nums">
          {done} of {all.length} solved
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

      {GROUPS.map((group) => {
        const first = all.indexOf(group.entries[0]!);
        return (
          <section key={group.id} aria-labelledby={`challenges-${group.id}`} className="mt-8">
            <h2 id={`challenges-${group.id}`} className="text-heading font-semibold text-ink">
              {group.title}
            </h2>
            <p className="mt-1 text-label text-ink-dim">{group.about}</p>
            <ol className="mt-4 space-y-3">
              {group.entries.map((c, i) => (
                <li key={c.id}>
                  <Link to={`/challenges/${c.id}`} className={cardInteractive}>
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-label text-ink-dim tabular-nums">{first + i + 1}</span>
                      <h3 className="flex-1 text-body font-semibold text-ink">{c.title}</h3>
                      {solved.has(c.id) && <span className="shrink-0 text-label text-hit">solved ✓</span>}
                    </div>
                    <p className="mt-1 pl-7 text-label text-ink-dim">{c.brief}</p>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
