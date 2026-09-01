import { useMemo, useState } from 'react';
import {
  createSeedDatabase,
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from './engine/index.ts';
import type { ReplacementPolicyName, RunResult, Stage } from './engine/index.ts';
import { DisclaimerBanner } from './ui/DisclaimerBanner.tsx';
import { PipelineTracker } from './ui/PipelineTracker.tsx';
import { PlaybackControls } from './ui/PlaybackControls.tsx';
import { SqlEditor } from './ui/SqlEditor.tsx';
import { StageDetail } from './ui/panels/StageDetail.tsx';
import { usePlayback, usePlaybackShortcuts } from './ui/usePlayback.ts';

const INITIAL_SQL = 'SELECT *\nFROM users\nWHERE id = 5;';

export default function App() {
  const [sql, setSql] = useState(INITIAL_SQL);
  const [policy, setPolicy] = useState<ReplacementPolicyName>('lru');
  const [pinnedStage, setPinnedStage] = useState<Stage | null>(null);
  const [db] = useState(createSeedDatabase);

  const options = useMemo(() => ({ ...DEFAULT_ENGINE_OPTIONS, policy }), [policy]);
  const [result, setResult] = useState<RunResult | null>(null);

  const projector = useMemo(
    () => (result ? createTraceProjector(result.events, options) : null),
    [result, options],
  );

  const playback = usePlayback(result?.events.length ?? 0);
  usePlaybackShortcuts(playback);

  const state = projector?.at(playback.step) ?? null;

  // Stages the run has reached so far, for the tracker's "visited" styling.
  const visited = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result?.events.slice(0, playback.step) ?? []) seen.add(e.stage);
    return seen;
  }, [result, playback.step]);

  const activeStage = pinnedStage ?? state?.stage ?? null;

  function run() {
    setResult(runQuery(sql, db, options));
    setPinnedStage(null);
    playback.reset();
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <DisclaimerBanner />

      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">QueryLens</h1>
        <p className="text-xs text-ink-dim">see what your SQL actually does</p>
        {result?.synthetic && (
          <span
            className="ml-auto rounded-full border border-miss/60 bg-miss/10 px-2.5 py-0.5 text-[11px] text-miss"
            title="No engine has run. This trace is hand-written scaffolding for the playback UI."
          >
            canned trace · engine not built yet (M0)
          </span>
        )}
      </header>

      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <div className="space-y-3">
          <SqlEditor value={sql} onChange={setSql} onRun={run} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={run}
              className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent/25"
            >
              Run ⌘↵
            </button>
            <label className="ml-auto flex items-center gap-2 text-xs text-ink-dim">
              Eviction
              <select
                className="rounded-md border border-edge bg-surface-3 px-2 py-1 text-ink"
                value={policy}
                onChange={(e) => { setPolicy(e.target.value as ReplacementPolicyName); }}
              >
                <option value="lru">LRU</option>
                <option value="clock">Clock sweep</option>
              </select>
            </label>
          </div>

          <div className="rounded-lg border border-edge bg-surface-2 p-3">
            <h2 className="mb-1 text-xs font-medium text-ink-dim">Narration</h2>
            <p className="min-h-10 text-sm leading-relaxed">
              {state?.narration || 'Press Run, then step through with ← and →.'}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <PipelineTracker
            current={state?.stage ?? null}
            visited={visited}
            selected={pinnedStage}
            onSelect={(s) => { setPinnedStage((prev) => (prev === s ? null : s)); }}
          />

          {/* Fixed height on purpose: if the panel resizes with its content, the
              playback controls below it move out from under the cursor mid-step. */}
          <div className="h-96 overflow-y-auto rounded-lg border border-edge bg-surface-2 p-4">
            {activeStage && state ? (
              <StageDetail stage={activeStage} state={state} policy={policy} />
            ) : (
              <p className="text-sm text-ink-dim">
                Nothing has run yet. Press <kbd className="rounded border border-edge px-1">Run</kbd>{' '}
                to build a trace, then <kbd className="rounded border border-edge px-1">Space</kbd> to
                play it.
              </p>
            )}
          </div>

          <PlaybackControls playback={playback} length={result?.events.length ?? 0} />
        </div>
      </main>
    </div>
  );
}
