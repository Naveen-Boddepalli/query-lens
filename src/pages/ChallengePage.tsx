import { lazy, Suspense, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { DATASETS, DEFAULT_ENGINE_OPTIONS, runQuery } from '../engine/index.ts';
import type { RunResult } from '../engine/index.ts';
import {
  challengeById,
  challengeDatabase,
  challengeDataset,
  challengeOptions,
  challengeStats,
} from './challenges/challenges.tsx';
import { CHALLENGE_ORDER as ORDER } from './challenges/groups.ts';
import { scriptChallengeById } from './challenges/scriptChallenges.tsx';
import { settingsChallengeById } from './challenges/settingsChallenges.tsx';
import { markSolved, readSolved } from '../ui/challengeProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SqlEditor } from '../ui/SqlEditor.tsx';
import { useThemeContext } from '../ui/ThemeContext.tsx';
import { encodeShareState } from '../ui/urlState.ts';
import { btnGhost, btnPrimary, btnSecondary, card } from '../ui/primitives.ts';

const CheckIcon = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3.5 8.5l3 3 6-6" />
  </svg>
);

const CrossIcon = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

const ArrowLeftIcon = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
    <path d="M12.5 8h-9M7 4.5L3.5 8 7 11.5" />
  </svg>
);

const ArrowRightIcon = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
    <path d="M3.5 8h9M9 4.5l3.5 3.5L9 11.5" />
  </svg>
);

// The transaction and durability challenges run a schedule or a log script, not a query; their view carries the
// schedule runner and the log machine, which a query challenge has no use for, so it is loaded only when one is opened.
const ScriptChallengeView = lazy(() =>
  import('./challenges/ScriptChallengeView.tsx').then((m) => ({ default: m.ScriptChallengeView })),
);
// The settings challenges run the storage and execution drivers (the sort, the LSM tree, the vector index …), which
// nothing else on this page needs, so their view is loaded when one is opened as well.
const SettingsChallengeView = lazy(() =>
  import('./challenges/SettingsChallengeView.tsx').then((m) => ({ default: m.SettingsChallengeView })),
);

/** One `/challenges/:id`: a query on a fixed engine config, a script on the schedule and log machines, or settings for a tool. */
export function ChallengePage() {
  const { challengeId } = useParams();
  const settings = settingsChallengeById(challengeId);
  if (settings) {
    const index = ORDER.findIndex((c) => c.id === settings.id);
    return (
      <Suspense fallback={<div className="flex-1" aria-hidden />}>
        <SettingsChallengeView
          key={settings.id}
          challenge={settings}
          index={index}
          total={ORDER.length}
          next={ORDER[index + 1] ?? null}
        />
      </Suspense>
    );
  }
  const script = scriptChallengeById(challengeId);
  if (script) {
    const index = ORDER.findIndex((c) => c.id === script.id);
    return (
      <Suspense fallback={<div className="flex-1" aria-hidden />}>
        <ScriptChallengeView
          key={script.id}
          challenge={script}
          index={index}
          total={ORDER.length}
          next={ORDER[index + 1] ?? null}
        />
      </Suspense>
    );
  }
  return <QueryChallengeView challengeId={challengeId} />;
}

/** One query challenge. Runs the query on a fixed engine config and checks it. */
function QueryChallengeView({ challengeId }: { challengeId: string | undefined }) {
  const challenge = challengeById(challengeId);
  const { theme } = useThemeContext();
  const dataset = challenge ? challengeDataset(challenge) : 'users';
  // A multi-table preset (plan.md §27.5 S2) is named by its tables, not as one table.
  const tableNames = Object.keys(DATASETS[dataset].make().tables);

  const [sql, setSql] = useState(challenge?.starter ?? '');
  const [run, setRun] = useState<{ sql: string; result: RunResult } | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [solved, setSolved] = useState(() => readSolved().has(challengeId ?? ''));

  function check() {
    if (!challenge) return;
    const result = runQuery(sql, challengeDatabase(challenge), challengeOptions(challenge));
    setRun({ sql, result });
    if (!result.error && challenge.check(result, sql) && !solved) {
      markSolved(challenge.id);
      setSolved(true);
    }
  }

  function handleResetStarter() {
    if (!challenge) return;
    setSql(challenge.starter);
    setRun(null);
  }

  if (!challenge) return <Navigate to="/challenges" replace />;

  const index = ORDER.findIndex((c) => c.id === challenge.id);
  const next = ORDER[index + 1];
  const prev = ORDER[index - 1];
  const result = run?.result ?? null;
  const passed = run !== null && !run.result.error && challenge.check(run.result, run.sql);
  const stats = result && !result.error ? challengeStats(result) : null;
  const requirements = challenge.requirements ?? ['Query passes challenge objective predicate'];

  const playgroundLink =
    run !== null && !run.result.error && !challenge.database
      ? `/playground?${encodeShareState(
          {
            sql: run.sql,
            policy: DEFAULT_ENGINE_OPTIONS.policy,
            predictOn: false,
            step: run.result.events.length,
            dataset,
          },
          undefined,
        )}`
      : null;

  // A tool that shows what the challenge is about, opened on the query that was just run — also after an error, which
  // the Parser can show better than the message can.
  const toolLink = run !== null ? (challenge.tool?.href(run.sql) ?? null) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-label text-ink-dim">
        <Link
          to="/challenges"
          className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-ink font-medium hover:underline"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          <span>Challenges Directory</span>
        </Link>
        <span className="font-mono text-label text-ink-dim">
          Puzzle {index + 1} of {ORDER.length}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-label uppercase tracking-wider text-ink-dim">
          {challenge.difficulty}
        </span>
        <span className="rounded border border-edge bg-surface-3/80 px-2 py-0.5 font-mono text-label text-ink-dim">
          {challenge.category}
        </span>
        <span className="rounded border border-edge bg-surface px-2 py-0.5 font-mono text-label text-ink-dim">
          dataset: {challenge.database ? 'authors / posts' : dataset}
        </span>
        {solved && (
          <span className="inline-flex items-center gap-1 rounded-full border border-hit/40 bg-hit/10 px-2 py-0.5 font-mono text-label font-medium text-hit">
            <CheckIcon className="h-3 w-3" />
            Solved
          </span>
        )}
      </div>

      <PageHeader title={challenge.title} className="mt-2">
        {challenge.brief}
      </PageHeader>

      <div className="mt-2">
        {challenge.database ? (
          <p className="text-label text-ink-dim">
            This one runs against its own <code className="font-mono text-ink">authors</code> /{' '}
            <code className="font-mono text-ink">posts</code> pair, not the usual seed table.
          </p>
        ) : (
          dataset !== 'users' && (
            <p className="text-label text-ink-dim">
              {tableNames.length > 1 ? (
                <>
                  This one runs against the <code className="font-mono text-ink">{dataset}</code> preset&rsquo;s tables:{' '}
                  {tableNames.map((name, i) => (
                    <span key={name}>
                      {i > 0 ? (i === tableNames.length - 1 ? ' and ' : ', ') : ''}
                      <code className="font-mono text-ink">{name}</code>
                    </span>
                  ))}
                  .
                </>
              ) : (
                <>
                  This one runs against the <code className="font-mono text-ink">{dataset}</code> table.
                </>
              )}
            </p>
          )
        )}
      </div>

      {/* Hint Accordion */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowHint((v) => !v)}
          aria-expanded={showHint}
          className={`${btnGhost} text-label text-ink-dim hover:text-ink`}
        >
          <span>{showHint ? 'Hide hint' : 'Show hint'}</span>
        </button>
        {showHint && (
          <div className="mt-2 rounded-xl border border-edge bg-surface-2/80 p-3.5 text-label text-ink-dim shadow-neu-rest backdrop-blur-sm">
            <span className="font-semibold text-ink">Hint: </span>
            {challenge.hint}
          </div>
        )}
      </div>

      {/* Editor & Controls */}
      <div className="mt-6 space-y-3">
        <div className="flex items-center justify-between text-label font-mono text-ink-dim">
          <span>SQL Query Editor</span>
          <button
            type="button"
            onClick={handleResetStarter}
            className="hover:text-ink flex items-center gap-1 transition-colors"
          >
            Reset to starter
          </button>
        </div>

        <SqlEditor value={sql} onChange={setSql} onRun={check} theme={theme} />

        <div className="flex items-center gap-3">
          <button type="button" onClick={check} className={btnPrimary}>
            <span>Run &amp; check</span>
          </button>
          <span className="text-label text-ink-dim font-mono hidden sm:inline">
            Press Cmd+Enter or Ctrl+Enter to execute
          </span>
        </div>
      </div>

      {/* Verification Feedback & Requirements Checklist */}
      <div className="mt-8 space-y-5">
        <section
          aria-label="Requirements Checklist"
          className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md"
        >
          <div className="flex items-center justify-between border-b border-edge/60 pb-2.5">
            <h3 className="font-mono text-label uppercase tracking-wider text-ink font-semibold">
              Verification Requirements Checklist
            </h3>
            <span className="font-mono text-label text-ink-dim">
              {run
                ? `${run.result.error ? 0 : passed ? requirements.length : 1} / ${requirements.length} satisfied`
                : 'Awaiting run'}
            </span>
          </div>

          <ul className="mt-3 space-y-2">
            {requirements.map((req, i) => {
              const hasRun = run !== null;
              const isSatisfied = hasRun && !run.result.error && (passed || i === 0);

              return (
                <li
                  key={i}
                  className={`flex items-center justify-between rounded-lg border p-2.5 text-label transition shadow-neu-rest ${
                    !hasRun
                      ? 'border-edge/50 bg-surface-3/40 text-ink-dim'
                      : isSatisfied
                        ? 'border-hit/40 bg-hit/10 text-hit font-medium'
                        : 'border-evict/30 bg-evict/10 text-ink-dim'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full border text-label ${
                        !hasRun
                          ? 'border-edge text-ink-dim'
                          : isSatisfied
                            ? 'border-hit bg-hit/20 text-hit'
                            : 'border-evict bg-evict/20 text-evict'
                      }`}
                    >
                      {!hasRun ? '○' : isSatisfied ? <CheckIcon className="h-3 w-3" /> : <CrossIcon className="h-3 w-3" />}
                    </span>
                    <span className={isSatisfied ? 'text-hit' : 'text-ink'}>{req}</span>
                  </div>
                  <span className="font-mono text-label">
                    {!hasRun ? 'pending' : isSatisfied ? 'pass' : 'fail'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Calm Success Banner or Attempt Feedback */}
        {result && (
          <div className="space-y-4">
            {result.error ? (
              <div className="rounded-xl border border-evict/50 bg-evict/10 p-4 text-evict shadow-neu-rest backdrop-blur-md">
                <p className="font-mono text-label uppercase tracking-wider font-semibold">
                  Execution Error
                </p>
                <p className="mt-1 font-mono text-label">{result.error.message}</p>
              </div>
            ) : passed ? (
              /* Calm Success Banner */
              <div className="ql-sheen rounded-2xl border border-hit/50 bg-hit/10 p-5 text-hit shadow-neu-rest backdrop-blur-md">
                <div className="space-y-2">
                  <h3 className="text-body font-semibold text-hit flex items-center gap-2">
                    <CheckIcon className="h-4 w-4" />
                    <span>✓ Solved.</span>
                  </h3>
                  <p className="text-label leading-relaxed text-ink-dim">
                    Your query satisfied all verification requirements and verified cleanly against
                    the engine trace.
                  </p>
                  {challenge.misconception && (
                    <p className="text-label leading-relaxed text-ink-dim">
                      <span className="text-ink font-medium">The belief this checks:</span> {challenge.misconception}
                    </p>
                  )}
                  <div className="pt-2 flex flex-wrap items-center gap-3">
                    {next ? (
                      <Link to={`/challenges/${next.id}`} className={`${btnPrimary} gap-1.5`}>
                        <span>Next: {next.title}</span>
                        <ArrowRightIcon className="h-3.5 w-3.5" />
                      </Link>
                    ) : (
                      <Link to="/challenges" className={`${btnPrimary} gap-1.5`}>
                        <span>Return to Challenges Directory</span>
                        <ArrowRightIcon className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-edge bg-surface-2/90 p-4 text-ink-dim shadow-neu-rest backdrop-blur-md">
                <p className="font-medium text-ink">Not there yet.</p>
                <p className="mt-1 text-label text-ink-dim">
                  Inspect the verification checklist above and the engine execution stats below
                  to adjust your query.
                </p>
              </div>
            )}

            {/* Compact Stats Grid */}
            {!result.error && stats && (
              <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-edge bg-surface-2/80 p-3.5 text-label shadow-neu-rest backdrop-blur-md">
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">rows</dt>
                  <dd className="font-mono tabular-nums text-ink font-semibold">{stats.rows}</dd>
                </div>
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">disk reads</dt>
                  <dd className="font-mono tabular-nums text-miss font-semibold">{stats.diskReads}</dd>
                </div>
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">evictions</dt>
                  <dd className="font-mono tabular-nums text-evict font-semibold">{stats.evictions}</dd>
                </div>
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">index used</dt>
                  <dd className="font-mono text-ink font-semibold">{stats.usesIndex ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">range scan</dt>
                  <dd className="font-mono text-ink font-semibold">{stats.usesRangeScan ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">sort writes</dt>
                  <dd className="font-mono tabular-nums text-hue-violet-ink font-semibold">{stats.writes}</dd>
                </div>
                <div>
                  <dt className="text-label font-mono uppercase text-ink-dim">dirty evicts</dt>
                  <dd className="font-mono tabular-nums text-evict font-semibold">{stats.dirtyEvictions}</dd>
                </div>
              </dl>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3">
              {toolLink && (
                <Link to={toolLink} className={btnSecondary}>
                  {challenge.tool?.label ?? 'Open related tool'}
                </Link>
              )}
              {playgroundLink && (
                <Link to={playgroundLink} className={`${btnSecondary} gap-1.5`}>
                  <span>Step through this run in the Playground →</span>
                </Link>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Navigation Footer */}
      <div className={`mt-8 ${card} flex flex-wrap items-center justify-between gap-4`}>
        {prev ? (
          <Link
            to={`/challenges/${prev.id}`}
            className="text-label text-ink-dim hover:text-ink font-medium inline-flex items-center gap-1.5"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            <span>Prev: {prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            to={`/challenges/${next.id}`}
            className="text-label text-ink font-semibold hover:text-accent inline-flex items-center gap-1.5"
          >
            <span>Next: {next.title}</span>
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <Link
            to="/challenges"
            className="text-label text-ink font-semibold hover:text-accent inline-flex items-center gap-1.5"
          >
            <span>All Challenges</span>
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}
