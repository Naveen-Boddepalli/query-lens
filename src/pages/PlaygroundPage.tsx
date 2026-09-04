import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createSeedDatabase,
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../engine/index.ts';
import type {
  Database,
  ReplacementPolicyName,
  Row,
  RunResult,
  Span,
  Stage,
} from '../engine/index.ts';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { publishRepro } from '../ui/errorReport.ts';
import { PipelineTracker } from '../ui/PipelineTracker.tsx';
import { PlaybackControls } from '../ui/PlaybackControls.tsx';
import { SqlEditor } from '../ui/SqlEditor.tsx';
import { DataEditor } from '../ui/DataEditor.tsx';
import { PredictionCard } from '../ui/PredictionCard.tsx';
import { ShortcutHints } from '../ui/ShortcutHints.tsx';
import { useThemeContext } from '../ui/ThemeContext.tsx';
import { RUN_HINT, useIsTouch } from '../ui/platform.ts';
import { StageDetail } from '../ui/panels/StageDetail.tsx';
import { STAGE_META } from '../ui/stageMeta.ts';
import { usePlayback, usePlaybackShortcuts } from '../ui/usePlayback.ts';
import {
  encodeShareState,
  readShareState,
  skippedAnswersBefore,
  writeShareState,
} from '../ui/urlState.ts';

const INITIAL_SQL = 'SELECT *\nFROM users\nWHERE id = 5;';

const TABLE = 'users';

function landingStep(result: RunResult, predictOn: boolean): number {
  if (result.events.length === 0) return 0;
  return predictOn && result.events[0]?.predictable !== undefined ? 0 : 1;
}

const SEED = createSeedDatabase();
const SHARED = readShareState(
  typeof location === 'undefined' ? '' : location.search,
  SEED.tables[TABLE]?.columns ?? [],
);

const START = {
  sql: SHARED.sql ?? INITIAL_SQL,
  policy: SHARED.policy ?? DEFAULT_ENGINE_OPTIONS.policy,
  predictOn: SHARED.predictOn ?? true,
  db: ((): Database => {
    const table = SEED.tables[TABLE];
    if (!SHARED.rows || !table) return SEED;
    return { tables: { ...SEED.tables, [TABLE]: { ...table, rows: SHARED.rows } } };
  })(),
};

const INITIAL_RESULT = runQuery(START.sql, START.db, {
  ...DEFAULT_ENGINE_OPTIONS,
  policy: START.policy,
});

export function PlaygroundPage() {
  const [sql, setSql] = useState(START.sql);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(START.policy);
  const [pinnedStage, setPinnedStage] = useState<Stage | null>(null);
  const [db, setDb] = useState<Database>(START.db);
  const [editingData, setEditingData] = useState(false);
  const [rowsEdited, setRowsEdited] = useState(SHARED.rows !== undefined);
  const [result, setResult] = useState<RunResult>(INITIAL_RESULT);

  const [predictOn, setPredictOn] = useState(START.predictOn);
  const [answers, setAnswers] = useState<Record<number, string>>(() =>
    skippedAnswersBefore(INITIAL_RESULT.events, SHARED.step ?? 0),
  );

  const options = useMemo(() => ({ ...DEFAULT_ENGINE_OPTIONS, policy }), [policy]);
  const table = db.tables[TABLE];
  const touch = useIsTouch();
  const { theme } = useThemeContext();

  const projector = useMemo(
    () => createTraceProjector(result.events, options),
    [result, options],
  );

  const dwells = useMemo(() => result.events.map((e) => e.dwell ?? 1), [result]);

  const gates = useMemo(
    () =>
      result.events.map(
        (e) => predictOn && e.predictable !== undefined && answers[e.id] === undefined,
      ),
    [result, predictOn, answers],
  );

  const playback = usePlayback(result.events.length, {
    dwells,
    gates,
    initialStep: SHARED.step ?? landingStep(INITIAL_RESULT, START.predictOn),
  });
  usePlaybackShortcuts(playback, !editingData);

  const state = projector.at(playback.step);

  const upcoming = result.events[playback.step];
  const prompt = predictOn ? upcoming?.predictable : undefined;

  const visited = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result.events.slice(0, playback.step)) seen.add(e.stage);
    return seen;
  }, [result, playback.step]);

  const activeStage = pinnedStage ?? (prompt ? upcoming?.stage : undefined) ?? state.stage ?? null;

  const activeSpan: Span | undefined =
    state?.lastEvent?.stage === 'parse' ? state.lastEvent.span : undefined;

  publishRepro({
    sql,
    policy,
    step: playback.step,
    predictOn,
    rows: table?.rows ?? [],
    rowsEdited,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeShareState(
        encodeShareState(
          {
            sql,
            policy,
            predictOn,
            step: playback.step,
            ...(rowsEdited && table ? { rows: table.rows } : {}),
          },
          table,
        ),
      );
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [sql, policy, predictOn, playback.step, rowsEdited, table]);

  const [copied, setCopied] = useState(false);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    } catch {
      setCopied(false);
    }
  }

  const run = useCallback(
    (database: Database = db) => {
      const next = runQuery(sql, database, options);
      setResult(next);
      setPinnedStage(null);
      setAnswers({});
      playback.land(landingStep(next, predictOn));
    },
    [sql, db, options, playback, predictOn],
  );

  function applyRows(rows: Row[]) {
    if (!table) return;
    const next: Database = { tables: { ...db.tables, [TABLE]: { ...table, rows } } };
    setDb(next);
    setRowsEdited(true);
    setEditingData(false);
    run(next);
  }

  function resetData() {
    const fresh = createSeedDatabase();
    setDb(fresh);
    setRowsEdited(false);
    setEditingData(false);
    run(fresh);
  }

  return (
    <>
      <main className="grid flex-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[minmax(300px,400px)_1fr]">
        {/* Authoring panel */}
        <div className="snap-section order-2 flex min-w-0 flex-col gap-3 lg:order-1 lg:min-h-0 lg:overflow-y-auto">
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={run}
            error={result.error}
            activeSpan={activeSpan}
            theme={theme}
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { run(); }}
              className="rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-accent/25 active:bg-accent/40"
            >
              Run{touch ? '' : ` ${RUN_HINT}`}
            </button>
            <button
              type="button"
              onClick={() => { setEditingData(true); }}
              className="rounded-md border border-edge px-3 py-1.5 text-body text-ink-dim transition-colors hover:border-accent/70 hover:text-ink active:bg-surface-3"
            >
              Edit data ({table?.rows.length ?? 0})
            </button>
            <label className="ml-auto flex items-center gap-2 text-label text-ink-dim">
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

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-label text-ink-dim">
            <p>
              {result.error ? (
                <span className="text-evict">The query did not run — see the error by the editor.</span>
              ) : (
                <>
                  {result.events.length} steps in this trace · showing step{' '}
                  <span className="tabular-nums text-ink">{playback.step}</span>
                </>
              )}
            </p>
            <button
              type="button"
              onClick={() => { void copyLink(); }}
              className="ml-auto underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {copied ? 'Link copied ✓' : 'Copy link to this step'}
            </button>
          </div>

          <label className="flex items-center gap-2 text-label text-ink-dim">
            <input
              type="checkbox"
              checked={predictOn}
              onChange={(e) => { setPredictOn(e.target.checked); }}
              className="accent-[var(--color-accent)]"
            />
            Ask me to predict before each reveal
          </label>

        </div>

        {/* Trace panel */}
        <div className="snap-section order-1 flex min-h-0 min-w-0 flex-col gap-4 lg:order-2 lg:overflow-hidden">
          <PipelineTracker
            current={state?.stage ?? null}
            visited={visited}
            selected={pinnedStage}
            onSelect={(s) => { setPinnedStage((prev) => (prev === s ? null : s)); }}
          />

          <div className="max-h-[60dvh] min-h-80 min-w-0 flex-1 overflow-hidden rounded-lg border border-edge bg-surface-2 p-4 lg:max-h-none">
            {activeStage ? (
              <ErrorBoundary
                variant="panel"
                label={STAGE_META[activeStage].title}
                resetKey={activeStage}
              >
                <StageDetail
                  stage={activeStage}
                  state={state}
                  policy={policy}
                  activeSpan={activeSpan}
                  pinned={pinnedStage !== null && pinnedStage !== state.stage}
                  onFollow={() => { setPinnedStage(null); }}
                />
              </ErrorBoundary>
            ) : (
              <p className="text-body text-ink-dim">
                {result.error
                  ? 'Fix the query and run it again to build a trace.'
                  : 'Answer the question below to reveal the first step.'}
              </p>
            )}
          </div>

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
              <h2 className="mb-1 text-label font-medium text-ink-dim">Narration</h2>
              <p className="min-h-10 text-body leading-relaxed" aria-live="polite">
                {state.narration || 'Step forward to start the trace.'}
              </p>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-4 space-y-2 border-t border-edge bg-surface px-4 py-2 lg:static lg:mx-0 lg:space-y-4 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0">
            <PlaybackControls playback={playback} length={result.events.length} />
            <ShortcutHints />
          </div>
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
    </>
  );
}
