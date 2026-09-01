import { useMemo, useState } from 'react';
import {
  createSeedDatabase,
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  IMPLEMENTED_STAGES,
  runQuery,
  STAGES,
} from './engine/index.ts';
import type { ReplacementPolicyName, RunResult, Span, Stage } from './engine/index.ts';
import { DisclaimerBanner } from './ui/DisclaimerBanner.tsx';
import { PipelineTracker } from './ui/PipelineTracker.tsx';
import { PlaybackControls } from './ui/PlaybackControls.tsx';
import { SqlEditor } from './ui/SqlEditor.tsx';
import { StageDetail } from './ui/panels/StageDetail.tsx';
import { usePlayback, usePlaybackShortcuts } from './ui/usePlayback.ts';

// The scan, not the point lookup, until M4 builds the B+Tree: this is the
// query that exercises the newest layer (12 pages through 8 frames).
const INITIAL_SQL = 'SELECT name, age\nFROM users\nWHERE age > 30;';

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

  // Disk reads dwell longer than buffer hits during playback.
  const dwells = useMemo(() => result?.events.map((e) => e.dwell ?? 1) ?? [], [result]);
  const playback = usePlayback(result?.events.length ?? 0, { dwells });
  usePlaybackShortcuts(playback);

  const state = projector?.at(playback.step) ?? null;

  const visited = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result?.events.slice(0, playback.step) ?? []) seen.add(e.stage);
    return seen;
  }, [result, playback.step]);

  const activeStage = pinnedStage ?? state?.stage ?? null;

  // The source range the current step is consuming, mirrored into the editor.
  const activeSpan: Span | undefined =
    state?.lastEvent?.stage === 'parse' ? state.lastEvent.span : undefined;

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
        <span
          className="ml-auto rounded-full border border-edge bg-surface-2 px-2.5 py-0.5 text-[11px] text-ink-dim"
          title={`Built: ${IMPLEMENTED_STAGES.join(', ')}. The rest of the pipeline is not implemented yet.`}
        >
          under construction · {IMPLEMENTED_STAGES.length}/{STAGES.length} stages built
        </span>
      </header>

      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <div className="space-y-3">
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={run}
            error={result?.error}
            activeSpan={activeSpan}
          />
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
          <div className="h-[27rem] overflow-hidden rounded-lg border border-edge bg-surface-2 p-4">
            {activeStage && state ? (
              <StageDetail
                stage={activeStage}
                state={state}
                policy={policy}
                activeSpan={activeSpan}
              />
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
