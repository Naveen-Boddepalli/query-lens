import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CHALLENGES, type ChallengeCategory } from './challenges/challenges.tsx';
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

const CATEGORIES: ('All' | ChallengeCategory)[] = [
  'All',
  'Indexing',
  'Buffer Pool',
  'Query Planning',
  'Storage & Execution',
];

export function ChallengesPage() {
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => readSolved());
  const [selectedCategory, setSelectedCategory] = useState<'All' | ChallengeCategory>('All');

  const doneCount = useMemo(
    () => CHALLENGES.filter((c) => solved.has(c.id)).length,
    [solved],
  );

  const percentDone = Math.round((doneCount / CHALLENGES.length) * 100);

  const filteredChallenges = useMemo(
    () =>
      selectedCategory === 'All'
        ? CHALLENGES
        : CHALLENGES.filter((c) => c.category === selectedCategory),
    [selectedCategory],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <p className={eyebrow}>Challenge Directory</p>
      <PageHeader title="Database Engine Challenges" className="mt-1">
        Goal-shaped SQL puzzles evaluated on real engine internals. Write queries to satisfy
        specific optimizer rewrites, buffer pool eviction limits, external sort spills, and join
        mechanics. Progress is saved in this browser.
      </PageHeader>

      {/* Overview Telemetry Card */}
      <section
        aria-label="Challenge Progress"
        className="ql-sheen mt-8 rounded-2xl border border-edge bg-surface-2/80 p-5 shadow-neu-rest backdrop-blur-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-heading font-semibold text-ink tabular-nums">
                {doneCount} / {CHALLENGES.length}
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

      {/* Challenges List */}
      <ol className="mt-8 space-y-3.5">
        {filteredChallenges.map((c) => {
          const originalIndex = CHALLENGES.findIndex((item) => item.id === c.id);
          const isSolved = solved.has(c.id);
          const datasetName = c.database ? 'authors / posts' : (c.dataset ?? 'users');

          return (
            <li key={c.id}>
              <Link
                to={`/challenges/${c.id}`}
                className={`${cardInteractive} flex flex-col gap-2.5 group`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-surface-3 font-mono text-micro text-ink-dim">
                      {originalIndex + 1}
                    </span>
                    <span
                      className={`rounded border px-2 py-0.5 font-mono text-micro uppercase tracking-wider ${
                        c.difficulty === 'Warm-up'
                          ? 'border-edge bg-surface-3/80 text-ink-dim'
                          : c.difficulty === 'Intermediate'
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-hue-violet-ink/30 bg-hue-violet-soft text-ink'
                      }`}
                    >
                      {c.difficulty}
                    </span>
                    <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-micro text-ink-dim">
                      {c.category}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-micro text-ink-dim">
                    <span>table: {datasetName}</span>
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
                  <span className="font-mono">
                    {c.requirements ? `${c.requirements.length} requirements` : 'Objective predicate'}
                  </span>
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
    </div>
  );
}
