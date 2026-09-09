import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { createSeedDatabase, DEFAULT_ENGINE_OPTIONS, runQuery } from '../engine/index.ts';
import type { RunResult } from '../engine/index.ts';
import { CHALLENGES, challengeById, challengeStats } from './challenges/challenges.tsx';
import { markSolved, readSolved } from '../ui/challengeProgress.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SqlEditor } from '../ui/SqlEditor.tsx';
import { useThemeContext } from '../ui/ThemeContext.tsx';
import { encodeShareState } from '../ui/urlState.ts';
import { btnPrimary, btnSecondary, card, panelSurface } from '../ui/primitives.ts';

const SEED = createSeedDatabase();

/** One `/challenges/:id`. Runs the query on a fixed engine config and checks it. */
export function ChallengePage() {
  const { challengeId } = useParams();
  const challenge = challengeById(challengeId);
  const { theme } = useThemeContext();

  const [sql, setSql] = useState(challenge?.starter ?? '');
  const [run, setRun] = useState<{ sql: string; result: RunResult } | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [solved, setSolved] = useState(() => readSolved().has(challengeId ?? ''));

  function check() {
    if (!challenge) return;
    const result = runQuery(sql, SEED, DEFAULT_ENGINE_OPTIONS);
    setRun({ sql, result });
    if (!result.error && challenge.check(result) && !solved) {
      markSolved(challenge.id);
      setSolved(true);
    }
  }

  if (!challenge) return <Navigate to="/challenges" replace />;

  const index = CHALLENGES.findIndex((c) => c.id === challenge.id);
  const next = CHALLENGES[index + 1];
  const result = run?.result ?? null;
  const passed = result !== null && !result.error && challenge.check(result);
  const stats = result && !result.error ? challengeStats(result) : null;

  const playgroundLink =
    run !== null && !run.result.error
      ? `/playground?${encodeShareState(
          { sql: run.sql, policy: DEFAULT_ENGINE_OPTIONS.policy, predictOn: false, step: run.result.events.length },
          undefined,
        )}`
      : null;

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <p className="text-label text-ink-dim">
        <Link to="/challenges" className="underline underline-offset-2 hover:text-ink">
          Challenges
        </Link>
        {' · '}
        {index + 1} of {CHALLENGES.length}
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
                    ? 'border-hit/50 bg-hit/10 text-hit'
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
              </dl>

              {playgroundLink && (
                <Link to={playgroundLink} className={btnSecondary}>
                  Step through this run in the Playground →
                </Link>
              )}
            </>
          )}
        </div>
      )}

      {solved && (
        <div className={`mt-6 ${card}`}>
          <p className="text-body text-ink">Nice.</p>
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
