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
import { btnPrimary, btnSecondary, card, panelSurface } from '../ui/primitives.ts';

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

  if (!challenge) return <Navigate to="/challenges" replace />;

  const index = ORDER.findIndex((c) => c.id === challenge.id);
  const next = ORDER[index + 1];
  const result = run?.result ?? null;
  const passed = run !== null && !run.result.error && challenge.check(run.result, run.sql);
  const stats = result && !result.error ? challengeStats(result) : null;

  const playgroundLink =
    // A challenge with its own `database` (the authors/posts JOIN demo) has
    // no `DatasetId` the Playground's own URL scheme could name — skip the
    // link rather than reproduce the wrong table.
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
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <p className="text-label text-ink-dim">
        <Link to="/challenges" className="underline underline-offset-2 hover:text-ink">
          Challenges
        </Link>
        {' · '}
        {index + 1} of {ORDER.length}
      </p>
      <PageHeader title={challenge.title} className="mt-2">
        {challenge.brief}
      </PageHeader>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => { setShowHint((v) => !v); }}
          aria-expanded={showHint}
          className="text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
        >
          {showHint ? 'Hide hint' : 'Show hint'}
        </button>
        {showHint && (
          <p className="mt-1 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim">
            {challenge.hint}
          </p>
        )}
      </div>

      <div className="mt-4 space-y-3">
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
        <SqlEditor value={sql} onChange={setSql} onRun={check} theme={theme} />
        <button type="button" onClick={check} className={btnPrimary}>
          Run &amp; check
        </button>
      </div>

      {result && (
        <div className="mt-4 space-y-3">
          {result.error ? (
            <p className="rounded-lg border border-evict/40 bg-evict/10 px-3 py-2 text-label text-evict">
              {result.error.message}
            </p>
          ) : (
            <>
              <div
                className={`rounded-xl border px-4 py-3 ${
                  passed
                    ? 'border-hit/50 bg-hit/10 text-ink'
                    : 'border-edge bg-surface-2 text-ink-dim'
                }`}
              >
                {passed ? '✓ Solved.' : 'Not there yet — check the numbers and the trace.'}
              </div>

              <dl className={`flex flex-wrap gap-x-5 gap-y-1 ${panelSurface} p-3 text-label`}>
                <div>
                  <dt className="text-ink-dim">rows</dt>
                  <dd className="font-mono tabular-nums text-ink">{stats?.rows}</dd>
                </div>
                <div>
                  <dt className="text-ink-dim">disk reads</dt>
                  <dd className="font-mono tabular-nums text-miss">{stats?.diskReads}</dd>
                </div>
                <div>
                  <dt className="text-ink-dim">evictions</dt>
                  <dd className="font-mono tabular-nums text-evict">{stats?.evictions}</dd>
                </div>
                <div>
                  <dt className="text-ink-dim">index used</dt>
                  <dd className="font-mono text-ink">{stats?.usesIndex ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt className="text-ink-dim">range scan</dt>
                  <dd className="font-mono text-ink">{stats?.usesRangeScan ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt className="text-ink-dim">sort writes</dt>
                  <dd className="font-mono tabular-nums text-hue-violet-ink">{stats?.writes}</dd>
                </div>
                <div>
                  <dt className="text-ink-dim">dirty evictions</dt>
                  <dd className="font-mono tabular-nums text-evict">{stats?.dirtyEvictions}</dd>
                </div>
              </dl>

              {playgroundLink && (
                <Link to={playgroundLink} className={btnSecondary}>
                  Step through this run in the Playground →
                </Link>
              )}
            </>
          )}
          {toolLink && (
            <Link to={toolLink} className={btnSecondary}>
              {challenge.tool?.label}
            </Link>
          )}
        </div>
      )}

      {solved && (
        <div className={`mt-6 ${card}`}>
          <p className="text-body text-ink">Nice.</p>
          {challenge.misconception && (
            <p className="mt-2 text-label leading-relaxed text-ink-dim">
              <span className="text-ink">The belief this checks:</span> {challenge.misconception}
            </p>
          )}
          {next ? (
            <Link
              to={`/challenges/${next.id}`}
              className="mt-1 inline-block text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
            >
              Next: {next.title} →
            </Link>
          ) : (
            <Link
              to="/challenges"
              className="mt-1 inline-block text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
            >
              That is all of them — back to the list
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
