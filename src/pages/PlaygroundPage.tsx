import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { PresenterView } from '../ui/PresenterView.tsx';
import { ShortcutHints } from '../ui/ShortcutHints.tsx';
import { recordPrediction, recordStages } from '../ui/progress.ts';
import { stepAnnouncement } from '../ui/stepAnnouncement.ts';
import { btnPrimary, btnSecondary, panelSurface } from '../ui/primitives.ts';
import { useThemeContext } from '../ui/ThemeContext.tsx';
import { RUN_HINT, useIsTouch } from '../ui/platform.ts';
import { readDefaultPolicy, readDefaultPredictOn } from '../ui/preferences.ts';
import { StageDetail } from '../ui/panels/StageDetail.tsx';
import { STAGE_META } from '../ui/stageMeta.ts';
import { usePlayback, usePlaybackShortcuts } from '../ui/usePlayback.ts';
import {
  encodeShareState,
  readShareState,
  skippedAnswersBefore,
  writeShareState,
} from '../ui/urlState.ts';
import { parseTraceFile, serializeTraceFile } from '../ui/traceFile.ts';
import type { TraceState } from '../ui/traceFile.ts';

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

/**
 * plan.md §20.5: an assignment link (`&l=1`) seals the trace at its landing
 * step until the learner commits an answer — the scrubber cannot cross it and
 * the prompt has no "skip". `readShareState` has already forced `predictOn`
 * true when this is set.
 */
const ASSIGNMENT = SHARED.lockReveal === true;

/** plan.md §22.5: `?present=1` opens the room-facing presenter view on load. */
const PRESENT_INITIAL =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('present') === '1';

const START = {
  sql: SHARED.sql ?? INITIAL_SQL,
  // The URL wins when present; a `/settings` preference (plan.md §21.3) is the
  // fallback for a bare visit, and the engine's own default is the fallback
  // for that. Same precedence order the theme already follows.
  policy: SHARED.policy ?? readDefaultPolicy() ?? DEFAULT_ENGINE_OPTIONS.policy,
  predictOn: SHARED.predictOn ?? readDefaultPredictOn() ?? true,
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
  const [presenting, setPresenting] = useState(PRESENT_INITIAL);
  const [answers, setAnswers] = useState<Record<number, string>>(() =>
    skippedAnswersBefore(INITIAL_RESULT.events, SHARED.step ?? 0),
  );

  // Presenting a demo to a room: a prediction prompt mid-flow stops it rather
  // than helps (plan.md §17.2). Suppress the gate and the card while presenting.
  const askToPredict = predictOn && !presenting;

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
        (e) => askToPredict && e.predictable !== undefined && answers[e.id] === undefined,
      ),
    [result, askToPredict, answers],
  );

  // In assignment mode the playhead cannot pass the first unanswered prompt by
  // any route — the scrubber included. It lifts one gate at a time as answers
  // come in.
  const ceiling = useMemo(() => {
    if (!ASSIGNMENT) return undefined;
    const firstGate = gates.findIndex((g) => g);
    return firstGate === -1 ? result.events.length : firstGate;
  }, [gates, result]);

  const playback = usePlayback(result.events.length, {
    dwells,
    gates,
    ...(ceiling === undefined ? {} : { ceiling }),
    initialStep: SHARED.step ?? landingStep(INITIAL_RESULT, START.predictOn),
  });
  usePlaybackShortcuts(playback, !editingData);

  const state = projector.at(playback.step);

  const upcoming = result.events[playback.step];
  const prompt = askToPredict ? upcoming?.predictable : undefined;

  // plan.md §22.6: what a screen reader hears on this step. The narration `<p>`
  // below is the live region and is kept permanently mounted for it — the
  // prediction card renders alongside rather than in its place, so the region
  // is never re-created with the very text it needed to announce.
  const announcement = stepAnnouncement({
    narration: state.narration,
    error: result.error !== undefined,
    prediction: prompt && upcoming ? { prompt, answer: answers[upcoming.id] } : undefined,
  });

  const visited = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result.events.slice(0, playback.step)) seen.add(e.stage);
    return seen;
  }, [result, playback.step]);

  // plan.md §22.4: feed the `/progress` dashboard. A localStorage convenience,
  // guarded, and a no-op once every stage in `visited` is already recorded.
  useEffect(() => { recordStages(visited); }, [visited]);

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
      const query = encodeShareState(
        {
          sql,
          policy,
          predictOn,
          step: playback.step,
          ...(rowsEdited && table ? { rows: table.rows } : {}),
        },
        table,
      );
      // `present` is a view flag, not part of the shared moment — appended after
      // `encodeShareState` so a copied link still opens the presenter.
      writeShareState(presenting ? `${query}&present=1` : query);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [sql, policy, predictOn, playback.step, rowsEdited, table, presenting]);

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

  // plan.md §22.5: the shareable moment as a file, for a dataset too big for a
  // URL or a bug report that wants the seed data attached. `data:` + `<a
  // download>`, the DownloadPngButton pattern — no `blob:` lifecycle, and the
  // deployed CSP has no `navigate-to`, so a download link is unrestricted.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [traceMsg, setTraceMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function downloadTrace() {
    const json = serializeTraceFile({
      sql,
      policy,
      predictOn,
      step: playback.step,
      rows: rowsEdited && table ? table.rows : null,
    });
    const a = document.createElement('a');
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    a.download = `querylens-trace-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    a.click();
  }

  /** Restore a parsed trace file the same way a shared link's `START` would. */
  function applyTraceState(t: TraceState) {
    const seed = createSeedDatabase();
    const seedTable = seed.tables[TABLE];
    const nextDb: Database =
      t.rows && seedTable
        ? { tables: { ...seed.tables, [TABLE]: { ...seedTable, rows: t.rows } } }
        : seed;
    const nextResult = runQuery(t.sql, nextDb, { ...DEFAULT_ENGINE_OPTIONS, policy: t.policy });
    const step = Math.min(t.step, nextResult.events.length);

    setSql(t.sql);
    setPolicy(t.policy);
    setPredictOn(t.predictOn);
    setDb(nextDb);
    setRowsEdited(t.rows !== null);
    setEditingData(false);
    setPinnedStage(null);
    setResult(nextResult);
    setAnswers(skippedAnswersBefore(nextResult.events, step));
    playback.land(step);
  }

  async function loadTraceFile(file: File) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      setTraceMsg({ kind: 'err', text: 'Could not read that file.' });
      return;
    }
    const parsed = parseTraceFile(text, SEED.tables[TABLE]?.columns ?? []);
    if (!parsed.ok) {
      setTraceMsg({ kind: 'err', text: parsed.error });
      return;
    }
    applyTraceState(parsed.value);
    setTraceMsg({
      kind: 'ok',
      text: `Loaded trace${parsed.value.rows ? ' with edited data' : ''} at step ${String(parsed.value.step)}.`,
    });
    window.setTimeout(() => { setTraceMsg(null); }, 4000);
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
            <button type="button" onClick={() => { run(); }} className={btnPrimary}>
              Run{touch ? '' : ` ${RUN_HINT}`}
            </button>
            <button
              type="button"
              onClick={() => { setEditingData(true); }}
              className={btnSecondary}
            >
              Edit data ({table?.rows.length ?? 0})
            </button>
            <label className="ml-auto flex items-center gap-2 text-label text-ink-dim">
              Eviction
              <select
                className="rounded-lg border border-edge bg-surface-3 px-2 py-1 text-ink shadow-e1 transition hover:border-ink-dim/50"
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
            <span className="ml-auto flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={() => { void copyLink(); }}
                className="underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                {copied ? 'Link copied ✓' : 'Copy link to this step'}
              </button>
              <button
                type="button"
                onClick={downloadTrace}
                className="underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                Download trace
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                Load trace
              </button>
              <button
                type="button"
                onClick={() => { setPresenting(true); }}
                className="underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                Present
              </button>
            </span>
          </div>

          {traceMsg && (
            <p
              role="status"
              className={`text-label ${traceMsg.kind === 'err' ? 'text-evict' : 'text-ink-dim'}`}
            >
              {traceMsg.text}
            </p>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void loadTraceFile(file);
            }}
          />

          {ASSIGNMENT ? (
            <p className="rounded-lg border border-accent/40 bg-accent/[0.07] px-3 py-2 text-label text-ink-dim">
              <span className="font-medium text-ink">Assignment mode.</span> The trace is sealed at
              this step until you answer the question — no skipping, no scrubbing ahead.
            </p>
          ) : (
            <label className="flex items-center gap-2 text-label text-ink-dim">
              <input
                type="checkbox"
                checked={predictOn}
                onChange={(e) => { setPredictOn(e.target.checked); }}
                className="accent-[var(--color-accent)]"
              />
              Ask me to predict before each reveal
            </label>
          )}

        </div>

        {/* Trace panel */}
        <div className="snap-section order-1 flex min-h-0 min-w-0 flex-col gap-3 lg:order-2 lg:overflow-hidden">
          <PipelineTracker
            current={state?.stage ?? null}
            visited={visited}
            selected={pinnedStage}
            onSelect={(s) => { setPinnedStage((prev) => (prev === s ? null : s)); }}
          />

          <div className={`${panelSurface} max-h-[60dvh] min-h-80 min-w-0 flex-1 overflow-hidden p-4 lg:max-h-none`}>
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

          {prompt && upcoming && (
            <PredictionCard
              prompt={prompt}
              answer={answers[upcoming.id]}
              canSkip={!ASSIGNMENT}
              onAnswer={(optionId) => {
                setAnswers((current) => ({ ...current, [upcoming.id]: optionId }));
                recordPrediction(optionId === prompt.correctOptionId);
              }}
              onSkip={() => {
                setAnswers((current) => ({ ...current, [upcoming.id]: '' }));
              }}
            />
          )}

          {/* The narration line doubles as the trace's live region (plan.md
              §22.6), so it stays mounted even while the prediction card is up —
              a screen reader only announces a change to a region that was
              already there. While the card shows, this drops to sr-only and the
              card carries the visuals; `stepAnnouncement` puts the question and
              then the verdict into it. */}
          <div
            className={
              prompt
                ? 'sr-only'
                : 'ql-sheen rounded-xl border border-edge bg-surface-2 p-3 shadow-e1'
            }
          >
            {!prompt && (
              <h2 className="mb-1 text-label font-medium tracking-[0.12em] text-ink-dim uppercase">
                Narration
              </h2>
            )}
            <p className="min-h-10 text-body leading-relaxed" aria-live="polite" aria-atomic="true">
              <span className="sr-only">
                Step {playback.step} of {result.events.length}.{' '}
              </span>
              {announcement}
            </p>
          </div>

          <div className="sticky bottom-0 z-10 -mx-4 space-y-2 border-t border-edge bg-surface/85 px-4 py-2 backdrop-blur-md lg:static lg:mx-0 lg:space-y-3 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none">
            <PlaybackControls
              playback={playback}
              length={result.events.length}
              maxStep={ceiling ?? result.events.length}
            />
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

      {presenting && (
        <PresenterView
          playback={playback}
          length={result.events.length}
          maxStep={ceiling ?? result.events.length}
          activeStage={activeStage}
          state={state}
          policy={policy}
          activeSpan={activeSpan}
          currentStage={state?.stage ?? null}
          visited={visited}
          narration={announcement}
          onExit={() => { setPresenting(false); }}
        />
      )}
    </>
  );
}
