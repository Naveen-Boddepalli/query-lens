import { useCallback, useMemo, useState } from 'react';
import {
  createSeedDatabase,
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  IMPLEMENTED_STAGES,
  runQuery,
  STAGES,
} from './engine/index.ts';
import type {
  Database,
  ReplacementPolicyName,
  Row,
  RunResult,
  Span,
  Stage,
} from './engine/index.ts';
import { DisclaimerBanner } from './ui/DisclaimerBanner.tsx';
import { PipelineTracker } from './ui/PipelineTracker.tsx';
import { PlaybackControls } from './ui/PlaybackControls.tsx';
import { SqlEditor } from './ui/SqlEditor.tsx';
import { DataEditor } from './ui/DataEditor.tsx';
import { PredictionCard } from './ui/PredictionCard.tsx';
import { ShortcutHints } from './ui/ShortcutHints.tsx';
import { StageDetail } from './ui/panels/StageDetail.tsx';
import { usePlayback, usePlaybackShortcuts } from './ui/usePlayback.ts';

// plan.md §9's first query: the indexed point lookup. Swap the WHERE for
// `age > 30` to watch the same table read by a sequential scan instead.
const INITIAL_SQL = 'SELECT *\nFROM users\nWHERE id = 5;';

const TABLE = 'users';

export default function App() {
  const [sql, setSql] = useState(INITIAL_SQL);
  const [policy, setPolicy] = useState<ReplacementPolicyName>('lru');
  const [pinnedStage, setPinnedStage] = useState<Stage | null>(null);
  const [db, setDb] = useState<Database>(createSeedDatabase);
  const [editingData, setEditingData] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  // Prediction is on by default: RESEARCH.md §1 is that the prompts are what
  // teach. A toggle, not a trap, for anyone who just wants to watch.
  const [predictOn, setPredictOn] = useState(true);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const options = useMemo(() => ({ ...DEFAULT_ENGINE_OPTIONS, policy }), [policy]);
  const table = db.tables[TABLE];

  const projector = useMemo(
    () => (result ? createTraceProjector(result.events, options) : null),
    [result, options],
  );

  // Disk reads dwell longer than buffer hits during playback.
  const dwells = useMemo(() => result?.events.map((e) => e.dwell ?? 1) ?? [], [result]);

  // `gates[i]`: applying event i would reveal an answer nobody has committed to.
  const gates = useMemo(
    () =>
      result?.events.map(
        (e) => predictOn && e.predictable !== undefined && answers[e.id] === undefined,
      ) ?? [],
    [result, predictOn, answers],
  );

  const playback = usePlayback(result?.events.length ?? 0, { dwells, gates });
  usePlaybackShortcuts(playback);

  const state = projector?.at(playback.step) ?? null;

  // The prompt for the step about to run — asked before it is revealed.
  const upcoming = result?.events[playback.step];
  const prompt = predictOn ? upcoming?.predictable : undefined;

  const visited = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result?.events.slice(0, playback.step) ?? []) seen.add(e.stage);
    return seen;
  }, [result, playback.step]);

  const activeStage = pinnedStage ?? state?.stage ?? null;

  const activeSpan: Span | undefined =
    state?.lastEvent?.stage === 'parse' ? state.lastEvent.span : undefined;

  const run = useCallback(
    (database: Database = db) => {
      setResult(runQuery(sql, database, options));
      setPinnedStage(null);
      setAnswers({});
      playback.reset();
    },
    [sql, db, options, playback],
  );

  function applyRows(rows: Row[]) {
    if (!table) return;
    const next: Database = { tables: { ...db.tables, [TABLE]: { ...table, rows } } };
    setDb(next);
    setEditingData(false);
    run(next);
  }

  function resetData() {
    const fresh = createSeedDatabase();
    setDb(fresh);
    setEditingData(false);
    run(fresh);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <DisclaimerBanner />

      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">QueryLens</h1>
        <p className="text-xs text-ink-dim">see what your SQL actually does</p>
        <span
          className="ml-auto rounded-full border border-edge bg-surface-2 px-2.5 py-0.5 text-[11px] text-ink-dim"
          title={`Built: ${IMPLEMENTED_STAGES.join(', ')}.`}
        >
          {IMPLEMENTED_STAGES.length}/{STAGES.length} stages built
        </span>
      </header>

      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(300px,400px)_1fr]">
        <div className="space-y-3">
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={run}
            error={result?.error}
            activeSpan={activeSpan}
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { run(); }}
              className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent/25"
            >
              Run ⌘↵
            </button>
            <button
              type="button"
              onClick={() => { setEditingData(true); }}
              className="rounded-md border border-edge px-3 py-1.5 text-sm text-ink-dim transition-colors hover:border-accent/70 hover:text-ink"
            >
              Edit data ({table?.rows.length ?? 0})
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

          <label className="flex items-center gap-2 text-xs text-ink-dim">
            <input
              type="checkbox"
              checked={predictOn}
              onChange={(e) => { setPredictOn(e.target.checked); }}
              className="accent-[var(--color-accent)]"
            />
            Ask me to predict before each reveal
          </label>

          {prompt && upcoming ? (
            <PredictionCard
              prompt={prompt}
              answer={answers[upcoming.id]}
              onAnswer={(optionId) => {
                setAnswers((current) => ({ ...current, [upcoming.id]: optionId }));
              }}
              onSkip={() => {
                setAnswers((current) => ({ ...current, [upcoming.id]: '' }));
              }}
            />
          ) : (
            <div className="rounded-lg border border-edge bg-surface-2 p-3">
              <h2 className="mb-1 text-xs font-medium text-ink-dim">Narration</h2>
              {/* Announced as it changes: stepping is the primary interaction,
                  and a screen reader user needs to hear what each step did. */}
              <p className="min-h-10 text-sm leading-relaxed" aria-live="polite">
                {state?.narration || 'Press Run, then step through with ← and →.'}
              </p>
            </div>
          )}
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
          <ShortcutHints />
        </div>
      </main>

      {editingData && table && (
        <DataEditor
          table={table}
          onApply={applyRows}
          onReset={resetData}
          onClose={() => { setEditingData(false); }}
        />
      )}
    </div>
  );
}
