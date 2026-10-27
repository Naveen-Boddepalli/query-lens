import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CHALLENGE_GROUPS, type ChallengeGroup } from './challenges/groups.ts';
import { clearSolved, readSolved } from '../ui/challengeProgress.ts';
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

const GROUP_FILTERS: { id: 'All' | ChallengeGroup['id']; label: string }[] = [
  { id: 'All', label: 'All Challenges' },
  { id: 'queries', label: 'SQL Queries' },
  { id: 'transactions', label: 'Transactions & Durability' },
  { id: 'storage', label: 'Storage & Execution' },
];

export function ChallengesPage() {
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => readSolved());
  const [selectedGroup, setSelectedGroup] = useState<'All' | ChallengeGroup['id']>('All');

  const allChallenges = useMemo(() => CHALLENGE_GROUPS.flatMap((g) => g.entries), []);
  const doneCount = useMemo(() => allChallenges.filter((c) => solved.has(c.id)).length, [allChallenges, solved]);
  const percentDone = Math.round((doneCount / allChallenges.length) * 100);

  const visibleGroups = useMemo(
    () =>
      selectedGroup === 'All'
        ? CHALLENGE_GROUPS
        : CHALLENGE_GROUPS.filter((g) => g.id === selectedGroup),
    [selectedGroup],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <p className={eyebrow}>Puzzles &amp; Quests</p>
      <PageHeader title="Database Internals Challenges" className="mt-1">
        Short, goal-shaped puzzles. Write a query — or a schedule, script, or engine configuration —
        run it, and the check validates whether you satisfied the goal. The trace reveals exactly why.
      </PageHeader>

      {/* Telemetry & Roadmap Overview Card */}
      <section
        aria-label="Challenges Progress"
        className="ql-sheen mt-8 rounded-2xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-heading font-semibold text-ink tabular-nums">
                {doneCount} / {allChallenges.length}
              </span>
              <span className="text-label text-ink-dim font-medium">challenges solved</span>
              <span className="rounded-full border border-edge bg-surface-3 px-2 py-0.5 font-mono text-micro text-ink tabular-nums">
                {percentDone}%
              </span>
            </div>
            <p className="font-mono text-micro text-ink-dim">
              Pure client-side verification · Instant AST &amp; buffer telemetry feedback
            </p>
          </div>

          {solved.size > 0 && (
            <button
              type="button"
              className={`${btnGhost} text-label text-ink-dim hover:text-evict hover:border-evict/30`}
              onClick={() => {
                clearSolved();
                setSolved(new Set());
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
            style={{ width: `${percentDone}%` }}
          />
        </div>

        {/* Category Filters */}
        <div className="mt-5 flex flex-wrap items-center gap-1.5 border-t border-edge/60 pt-4">
          <span className="mr-2 font-mono text-micro uppercase tracking-wider text-ink-dim">
            Category:
          </span>
          {GROUP_FILTERS.map((f) => {
            const active = selectedGroup === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedGroup(f.id)}
                aria-pressed={active}
                className={`rounded-lg border px-2.5 py-1 text-label font-medium transition duration-150 select-none ${
                  active
                    ? 'border-accent/60 bg-accent/15 text-ink shadow-neu-pressed'
                    : 'border-edge bg-surface-2/60 text-ink-dim hover:border-ink-dim/40 hover:text-ink hover:bg-surface-3 shadow-neu-rest'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Challenge Groups */}
      <div className="mt-10 space-y-12">
        {visibleGroups.map((group) => {
          const first = allChallenges.findIndex((c) => c.id === group.entries[0]?.id);

          return (
            <section key={group.id} aria-labelledby={`challenges-${group.id}`}>
              <div className="mb-4">
                <h2 id={`challenges-${group.id}`} className="text-heading font-semibold text-ink">
                  {group.title}
                </h2>
                <p className="mt-1 text-label text-ink-dim leading-relaxed">{group.about}</p>
              </div>

              <ol className="mt-4 space-y-3.5">
                {group.entries.map((c, i) => {
                  const challengeNum = first >= 0 ? first + i + 1 : i + 1;
                  const isSolved = solved.has(c.id);

                  return (
                    <li key={c.id}>
                      <Link
                        to={`/challenges/${c.id}`}
                        className={`${cardInteractive} flex flex-col gap-2.5 group`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-surface-3 font-mono text-micro text-ink-dim">
                              {challengeNum}
                            </span>
                            <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-micro text-ink-dim">
                              {group.title}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 font-mono text-micro text-ink-dim">
                            {isSolved && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-hit/40 bg-hit/10 px-2 py-0.5 font-medium text-hit">
                                <CheckIcon className="h-3 w-3" />
                                Solved
                              </span>
                            )}
                          </div>
                        </div>

                        <div>
                          <h3 className="text-body font-semibold text-ink group-hover:text-accent transition-colors">
                            {c.title}
                          </h3>
                          <div className="mt-1 text-label leading-relaxed text-ink-dim">{c.brief}</div>
                        </div>

                        <div className="flex items-center justify-between border-t border-edge/40 pt-2 text-micro text-ink-dim">
                          <span className="font-mono">Interactive objective</span>
                          <span className="inline-flex items-center gap-1 font-medium text-ink group-hover:text-accent transition-colors">
                            {isSolved ? 'Review challenge' : 'Solve challenge'}
                            <ArrowRightIcon className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}
