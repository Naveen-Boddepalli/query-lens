import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  createTraceProjector,
  DATASET_IDS,
  DATASETS,
  DEFAULT_ENGINE_OPTIONS,
  REPLACEMENT_POLICY_LABELS,
  REPLACEMENT_POLICY_NAMES,
  runQuery,
} from '../engine/index.ts';
import type {
  Database,
  DatasetId,
  ReplacementPolicyName,
  Row,
  RunResult,
  Span,
  Stage,
} from '../engine/index.ts';
import { DATASET_CATALOGUE } from '../ui/datasetCatalogue.ts';
import { CUSTOM_STARTER_SQL } from '../ui/customDatabase.ts';
import { loadWorkingCopy, saveWorkingCopy } from '../ui/workingCopy.ts';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { publishRepro } from '../ui/errorReport.ts';
import { ReportStepLink } from '../ui/ReportStepLink.tsx';
import type { Moment } from '../ui/stepReport.ts';
import { PipelineTracker } from '../ui/PipelineTracker.tsx';
import { appendStep, carryOn, openLog, recordWrite } from '../ui/durableLog.ts';
import type { DurableLog } from '../ui/durableLog.ts';
import { PlaybackControls } from '../ui/PlaybackControls.tsx';
import { SqlEditor } from '../ui/SqlEditor.tsx';
import { DataEditor } from '../ui/DataEditor.tsx';
import { SchemaEditor } from '../ui/SchemaEditor.tsx';
import { PredictionCard } from '../ui/PredictionCard.tsx';
import { PresenterView } from '../ui/PresenterView.tsx';
import { PlaygroundTour } from '../ui/PlaygroundTour.tsx';
import { TraceWorksheet } from '../ui/TraceWorksheet.tsx';
import { useDocumentTitle } from '../ui/documentTitle.ts';
import { hasPendingTour, listenForTour } from '../ui/firstVisit.ts';
import { ShortcutHints } from '../ui/ShortcutHints.tsx';
import { WhyNotNote } from '../ui/WhyNotNote.tsx';
import { recordPrediction, recordStages } from '../ui/progress.ts';
import { stepAnnouncement } from '../ui/stepAnnouncement.ts';
import { btnPrimary, btnSecondary, panelSurface } from '../ui/primitives.ts';
import { useThemeContext } from '../ui/ThemeContext.tsx';
import { RUN_HINT, useIsTouch } from '../ui/platform.ts';
import { readDefaultPolicy, readDefaultPredictOn } from '../ui/preferences.ts';
import { StageDetail } from '../ui/panels/StageDetail.tsx';
import { TraceDiffNote } from '../ui/panels/TraceDiffNote.tsx';
import { diffRuns, readLastRuns, summarize, writeLastRun } from '../ui/traceDiff.ts';
import type { TraceDiff } from '../ui/traceDiff.ts';
import { STAGE_META } from '../ui/stageMeta.ts';
import { usePlayback, usePlaybackShortcuts } from '../ui/usePlayback.ts';
import {
  encodeShareState,
  readDatasetParam,
  readShareState,
  skippedAnswersBefore,
} from '../ui/urlState.ts';
import { useAddressBarQuery } from '../ui/addressBar.ts';
import { parseTraceFile, serializeTraceFile } from '../ui/traceFile.ts';
import type { TraceState } from '../ui/traceFile.ts';

function landingStep(result: RunResult, predictOn: boolean): number {
  if (result.events.length === 0) return 0;
  return predictOn && result.events[0]?.predictable !== undefined ? 0 : 1;
}

const SEARCH = typeof location === 'undefined' ? '' : location.search;

/**
 * plan.md §22.7: the link may name a preset dataset (`?t=orders`). It is read
 * first, on its own, because the dataset decides the table name every `FROM`
 * must use and the columns the shared `d` rows are validated against.
 */
const DATASET_ID = readDatasetParam(SEARCH);
const DATASET = DATASETS[DATASET_ID];
const CATALOGUE = DATASET_CATALOGUE[DATASET_ID];

const SEED = DATASET.make();
const SHARED = readShareState(SEARCH, SEED.tables[DATASET.table]?.columns ?? []);

/**
 * plan.md §20.5: an assignment link (`&l=1`) seals the trace at its landing
 * step until the learner commits an answer — the scrubber cannot cross it and
 * the prompt has no "skip". `readShareState` has already forced `predictOn`
 * true when this is set.
 */
const ASSIGNMENT = SHARED.lockReveal === true;

/** plan.md §22.5: `?present=1` opens the room-facing presenter view on load. */
const PRESENT_INITIAL = new URLSearchParams(SEARCH).get('present') === '1';

/** plan.md §19.2: `?tour=1` opens the 60-second tour on load — for a course
 *  link or a doc, and the path the first-visit hint takes when its chunk
 *  rendered before the Playground's. */
const TOUR_INITIAL = new URLSearchParams(SEARCH).get('tour') === '1';

const START = {
  sql: SHARED.sql ?? CATALOGUE.starterSql,
  // The URL wins when present; a `/settings` preference (plan.md §21.3) is the
  // fallback for a bare visit, and the engine's own default is the fallback
  // for that. Same precedence order the theme already follows.
  policy: SHARED.policy ?? readDefaultPolicy() ?? DEFAULT_ENGINE_OPTIONS.policy,
  predictOn: SHARED.predictOn ?? readDefaultPredictOn() ?? true,
  db: ((): Database => {
    const table = SEED.tables[DATASET.table];
    if (!SHARED.rows || !table) return SEED;
    return { tables: { ...SEED.tables, [DATASET.table]: { ...table, rows: SHARED.rows } } };
  })(),
};

const INITIAL_RESULT = runQuery(START.sql, START.db, {
  ...DEFAULT_ENGINE_OPTIONS,
  policy: START.policy,
});

const CHIP_BASE = 'rounded-full border px-2.5 py-0.5 text-label font-medium select-none transition-all';
const CHIP_ACTIVE = `${CHIP_BASE} border-accent bg-accent-soft text-ink shadow-glow`;
const CHIP_INACTIVE = `${CHIP_BASE} border-edge text-ink-dim hover:border-ink-dim/50 hover:text-ink active:scale-95`;
const CHIP_ROW = 'flex flex-wrap items-center gap-1.5';
const CHIP_LABEL = 'mr-1 text-label font-medium text-ink-dim';
const PANEL_COL = 'snap-section flex min-w-0 flex-col gap-3';
const LINK_ACTION = 'text-label text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50';
const GLASS_CARD = 'rounded-xl border border-edge bg-surface-2/80 shadow-neu-rest backdrop-blur-md';
const NARRATION_BOX = `ql-sheen p-3 ${GLASS_CARD}`;
const CUSTOM_BLURB = 'Your own tables, kept in this browser';

const WorkspaceDialog = lazy(() =>
  import('../ui/WorkspaceDialog.tsx').then((m) => ({ default: m.WorkspaceDialog })),
);

// plan.md §25.4 E4: the write-ahead log, crash and recovery, loaded when a visitor opens it.
const DurabilityDialog = lazy(() =>
  import('../ui/DurabilityDialog.tsx').then((m) => ({ default: m.DurabilityDialog })),
);

export function PlaygroundPage() {
  useDocumentTitle('Playground');
  const [sql, setSql] = useState(START.sql);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(START.policy);
  const [pinnedStage, setPinnedStage] = useState<Stage | null>(null);
  const [datasetId, setDatasetId] = useState<DatasetId>(DATASET_ID);
  const [db, setDb] = useState<Database>(START.db);
  // plan.md §22.7: a user-authored, multi-table database — local only (not
  // part of `datasetId`/the URL scheme, which assume one of the three fixed
  // presets), so JOIN can finally run from the Playground itself instead of
  // staying `/tools/planner` + `/compare`-only.
  const [isCustom, setIsCustom] = useState(false);
  // Counts every dataset change, so a custom database that finishes loading after the user has moved on is dropped.
  const datasetChange = useRef(0);
  const [schemaEditorOpen, setSchemaEditorOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [durabilityOpen, setDurabilityOpen] = useState(false);
  const [editingData, setEditingData] = useState(false);
  const [rowsEdited, setRowsEdited] = useState(SHARED.rows !== undefined);
  const [result, setResult] = useState<RunResult>(INITIAL_RESULT);
  const [traceDiff, setTraceDiff] = useState<{ sql: string; diff: TraceDiff | null } | null>(null);

  const [predictOn, setPredictOn] = useState(START.predictOn);
  const [presenting, setPresenting] = useState(PRESENT_INITIAL);
  // A request already waiting opens the tour on the first render (only *looked at* here — a render may be thrown
  // away); `listenForTour` below is what answers it.
  const [tourOpen, setTourOpen] = useState(() => TOUR_INITIAL || hasPendingTour());
  const [answers, setAnswers] = useState<Record<number, string>>(() =>
    skippedAnswersBefore(INITIAL_RESULT.events, SHARED.step ?? 0),
  );

  // Presenting a demo to a room: a prediction prompt mid-flow stops it rather
  // than helps (plan.md §17.2). Suppress the gate and the card while presenting.
  const askToPredict = predictOn && !presenting;

  const options = useMemo(() => ({ ...DEFAULT_ENGINE_OPTIONS, policy }), [policy]);
  // The write statements run here, as log steps (plan.md §25.4 E4). Kept as plain data; the machine runs only when
  // the Durability dialog is opened.
  const [durable, setDurable] = useState<DurableLog>(() => openLog(START.db, DEFAULT_ENGINE_OPTIONS.rowsPerPage));
  const tableName = DATASETS[datasetId].table;
  const table = db.tables[tableName];
  const presets = DATASET_CATALOGUE[datasetId].presets;
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
  // The tour binds ←/→ to Next/Back and Esc to leave, so the trace must not
  // also step underneath it — same reason `editingData` suspends them.
  usePlaybackShortcuts(playback, !editingData && !tourOpen);

  // "Take the tour" in the first-visit hint (mounted by `Layout`, a different
  // subtree): a request made before this ran, or any time after (`firstVisit.ts`).
  useEffect(() => listenForTour(() => { setTourOpen(true); }), []);

  // The print worksheet (plan.md §22.6) is mounted *only* while printing —
  // keeping its copy of the whole trace out of the DOM the rest of the time.
  // `flushSync` so the render lands before the browser snapshots the page.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const on = () => { flushSync(() => { setPrinting(true); }); };
    const off = () => { setPrinting(false); };
    window.addEventListener('beforeprint', on);
    window.addEventListener('afterprint', off);
    const mq = window.matchMedia('print');
    const onMq = (e: MediaQueryListEvent) => { if (e.matches) on(); else off(); };
    mq.addEventListener('change', onMq);
    return () => {
      window.removeEventListener('beforeprint', on);
      window.removeEventListener('afterprint', off);
      mq.removeEventListener('change', onMq);
    };
  }, []);

  const state = projector.at(playback.step);

  const upcoming = result.events[playback.step];
  const prompt = askToPredict ? upcoming?.predictable : undefined;

  // plan.md §22.6: what a screen reader hears on this step. The narration `<p>`
  // below is the live region and is kept permanently mounted for it — the
  // prediction card renders alongside rather than in its place, so the region
  // is never re-created with the very text it needed to announce.
  const announcement = stepAnnouncement({
    narration: state.narration,
    // A statement rejected part-way (a UNIQUE key already taken) has a trace to read; only one that never ran has none.
    error: result.error !== undefined && result.events.length === 0,
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

  // The "Why not?" panel (plan.md §25.4 C5, fourth slice): set on whichever step actually chose by cost —
  // index-vs-scan and join-algorithm land on an `optimize` event, join order on a `plan` event.
  const whyNot =
    state?.lastEvent?.stage === 'optimize'
      ? state.lastEvent.whyNot
      : state?.lastEvent?.stage === 'plan'
        ? state.lastEvent.whyNot
        : undefined;

  publishRepro({
    sql,
    policy,
    step: playback.step,
    predictOn,
    rows: table?.rows ?? [],
    rowsEdited,
  });

  // The moment as a query string. One derivation feeds both the address bar
  // (below) and "Report a confusing step", so the link a report carries is
  // always exactly the one Copy link would give.
  const shareQuery = useMemo(
    () =>
      encodeShareState(
        {
          sql,
          policy,
          predictOn,
          step: playback.step,
          // A custom database has no `DatasetId` of its own (plan.md §22.7) —
          // omitted rather than the stale preset id underneath it, so a
          // copied link never claims to be a preset it isn't.
          ...(isCustom ? {} : { dataset: datasetId }),
          ...(rowsEdited && table ? { rows: table.rows } : {}),
        },
        table,
      ),
    [sql, policy, predictOn, playback.step, datasetId, isCustom, rowsEdited, table],
  );

  // `present` is a view flag, not part of the shared moment — appended after
  // `encodeShareState` so a copied link still opens the presenter.
  useAddressBarQuery(presenting ? `${shareQuery}&present=1` : shareQuery);

  // plan.md §25.4 A3 — everything a "confusing step" report needs, from state
  // the page already holds. Read at render, not from `location`, which trails
  // the playhead by the address bar's 250 ms debounce.
  const moment: Moment = {
    sql,
    policy,
    predictOn,
    step: playback.step,
    stepCount: result.events.length,
    stage: state.stage ?? null,
    narration: state.narration ?? '',
    dataset: isCustom ? 'a custom database' : datasetId,
    rowsEdited,
    shareUrl: `${location.origin}${location.pathname}${shareQuery ? `?${shareQuery}` : ''}`,
  };

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
      if (next.error) {
        setTraceDiff({ sql, diff: null });
      } else {
        const after = summarize(next);
        const before = readLastRuns()[sql];
        writeLastRun(sql, after);
        setTraceDiff({ sql, diff: before ? diffRuns(before, after) : null });
      }
      setPinnedStage(null);
      setAnswers({});
      playback.land(landingStep(next, predictOn));

      // A DELETE has nowhere else to leave its effect (plan.md §22.2): the
      // engine holds no state between calls, so persisting the new row set
      // is this session's whole memory of the write — the same mechanism
      // the seed editor's `applyRows` already uses.
      if (next.write) {
        const target = database.tables[next.write.table];
        if (target) {
          setDb({
            tables: { ...database.tables, [next.write.table]: { ...target, rows: next.write.rows } },
          });
          setRowsEdited(true);
          const write = next.write;
          setDurable((log) =>
            recordWrite(log, database, sql, { table: write.table, kind: write.kind, rows: write.rows }),
          );
        }
      }

      // ANALYZE (plan.md §25.4 C1) is the same story for statistics: the engine never holds state between calls,
      // so persisting them here is what lets the *next* query actually read them instead of scanning the live
      // rows. Unlike a write, the rows themselves have not changed — no `rowsEdited`.
      if (next.analyze) {
        const target = database.tables[next.analyze.table];
        if (target) {
          setDb({
            tables: { ...database.tables, [next.analyze.table]: { ...target, stats: next.analyze.stats } },
          });
        }
      }
    },
    [sql, db, options, playback, predictOn],
  );

  function applyRows(rows: Row[]) {
    if (!table) return;
    const next: Database = { tables: { ...db.tables, [tableName]: { ...table, rows } } };
    setDb(next);
    setRowsEdited(true);
    setEditingData(false);
    run(next);
  }

  function resetData() {
    const fresh = DATASETS[datasetId].make();
    setDb(fresh);
    setRowsEdited(false);
    setEditingData(false);
    run(fresh);
  }

  /** A preset chip: load the query and run it in one click (plan.md §19.2). */
  function loadPreset(presetSql: string) {
    setSql(presetSql);
    const next = runQuery(presetSql, db, options);
    setResult(next);
    setPinnedStage(null);
    setAnswers({});
    playback.land(landingStep(next, askToPredict));
  }

  /**
   * Switch to another preset dataset (plan.md §22.7): swap the table, drop any
   * row edits, and open on that dataset's starter query, run. Same shape as
   * `loadPreset` — it computes `runQuery` explicitly rather than leaning on
   * `run`, whose `useCallback` still closes over the old `sql`/`db`.
   */
  function switchDataset(id: DatasetId) {
    if (!isCustom && id === datasetId) return;
    datasetChange.current += 1;
    const nextDb = DATASETS[id].make();
    const nextSql = DATASET_CATALOGUE[id].starterSql;
    setDatasetId(id);
    setIsCustom(false);
    setDb(nextDb);
    setRowsEdited(false);
    setEditingData(false);
    setSql(nextSql);
    const next = runQuery(nextSql, nextDb, options);
    setResult(next);
    setPinnedStage(null);
    setAnswers({});
    playback.land(landingStep(next, askToPredict));
  }

  /** Switches to the user's own multi-table database — same shape as `switchDataset`, loading the working copy from IndexedDB instead of a fixed preset (plan.md §22.7). */
  function switchToCustom() {
    if (isCustom) return;
    const change = ++datasetChange.current;
    void loadWorkingCopy().then((nextDb) => {
      if (change !== datasetChange.current) return;
      setIsCustom(true);
      setDb(nextDb);
      setRowsEdited(false);
      setEditingData(false);
      setSql(CUSTOM_STARTER_SQL);
      const next = runQuery(CUSTOM_STARTER_SQL, nextDb, options);
      setResult(next);
      setPinnedStage(null);
      setAnswers({});
      playback.land(landingStep(next, askToPredict));
    });
  }

  function openDatabase(next: Database) {
    setWorkspacesOpen(false);
    setDb(next);
    setRowsEdited(true);
    run(next);
  }

  function applySchema(next: Database) {
    setDb(next);
    setRowsEdited(true);
    setSchemaEditorOpen(false);
    run(next);
  }

  // Every discrete change to a custom database is saved as it happens — no
  // debounce, unlike the URL-share effect below: `db` here only changes on
  // whole actions (an applied schema edit, a write statement's persisted
  // result), never per keystroke, so there is no thrash to guard against, and
  // a debounce would risk losing an edit made just before switching away.
  useEffect(() => {
    if (isCustom) {
      void saveWorkingCopy(db).catch(() => {
        // Not persisted this session; the database itself is still in memory, and nothing depends on the autosave.
      });
    }
  }, [isCustom, db]);

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
      dataset: datasetId,
      rows: rowsEdited && table ? table.rows : null,
    });
    const a = document.createElement('a');
    a.href = `data:application/json,${encodeURIComponent(json)}`;
    a.download = `querylens-trace-${Date.now()}.json`;
    a.click();
  }

  /** Restore a parsed trace file the same way a shared link's `START` would. */
  function applyTraceState(t: TraceState) {
    const spec = DATASETS[t.dataset];
    const seed = spec.make();
    const seedTable = seed.tables[spec.table];
    const nextDb: Database =
      t.rows && seedTable
        ? { tables: { ...seed.tables, [spec.table]: { ...seedTable, rows: t.rows } } }
        : seed;
    const nextResult = runQuery(t.sql, nextDb, { ...DEFAULT_ENGINE_OPTIONS, policy: t.policy });
    const step = Math.min(t.step, nextResult.events.length);

    setSql(t.sql);
    setPolicy(t.policy);
    setPredictOn(t.predictOn);
    setDatasetId(t.dataset);
    datasetChange.current += 1;
    setIsCustom(false); // a trace file always names one of the fixed presets
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
    const parsed = parseTraceFile(text);
    if (!parsed.ok) {
      setTraceMsg({ kind: 'err', text: parsed.error });
      return;
    }
    applyTraceState(parsed.value);
    setTraceMsg({
      kind: 'ok',
      text: `Loaded trace at step ${parsed.value.step}.`,
    });
    window.setTimeout(() => { setTraceMsg(null); }, 4000);
  }

  return (
    <>
      <main className="grid flex-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* Authoring panel */}
        <div className={`${PANEL_COL} order-2 lg:order-1 lg:min-h-0 lg:overflow-y-auto`}>
          <div data-tour="editor" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className={CHIP_ROW}>
                <span className={CHIP_LABEL}>Data:</span>
                {DATASET_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { switchDataset(id); }}
                    title={DATASET_CATALOGUE[id].blurb}
                    className={!isCustom && datasetId === id ? CHIP_ACTIVE : CHIP_INACTIVE}
                  >
                    {DATASET_CATALOGUE[id].label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={switchToCustom}
                  title={CUSTOM_BLURB}
                  className={isCustom ? CHIP_ACTIVE : CHIP_INACTIVE}
                >
                  Custom
                </button>
              </div>
              <p className="text-label text-ink-dim/80">
                {isCustom
                  ? CUSTOM_BLURB
                  : DATASET_CATALOGUE[datasetId].blurb}
              </p>
            </div>

            {!isCustom && (
              <div className={CHIP_ROW}>
                <span className={CHIP_LABEL}>Try:</span>
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { loadPreset(p.sql); }}
                    className={sql === p.sql ? CHIP_ACTIVE : CHIP_INACTIVE}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <SqlEditor
              value={sql}
              onChange={setSql}
              onRun={run}
              error={result.error}
              activeSpan={activeSpan}
              theme={theme}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { run(); }} className={btnPrimary}>
              Run{touch ? '' : ` ${RUN_HINT}`}
            </button>
            {isCustom ? (
              <>
                <button
                  type="button"
                  onClick={() => { setSchemaEditorOpen(true); }}
                  className={btnSecondary}
                >
                  Manage tables ({Object.keys(db.tables).length})
                </button>
                <button type="button" onClick={() => { setWorkspacesOpen(true); }} className={btnSecondary}>
                  Workspaces
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => { setEditingData(true); }}
                className={btnSecondary}
              >
                Edit data ({table?.rows.length ?? 0})
              </button>
            )}
            <button type="button" onClick={() => { setDurabilityOpen(true); }} className={btnSecondary}>
              Durability{durable.statements.length > 0 ? ` (${String(durable.statements.length)})` : ''}
            </button>
            <label className="ml-auto flex items-center gap-2 text-label text-ink-dim">
              Eviction
              <select
                className="cursor-pointer rounded-lg border border-edge bg-surface-3 px-2 py-1 text-ink shadow-neu-rest transition hover:border-ink-dim/50"
                value={policy}
                onChange={(e) => { setPolicy(e.target.value as ReplacementPolicyName); }}
              >
                {REPLACEMENT_POLICY_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {REPLACEMENT_POLICY_LABELS[name]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-label text-ink-dim">
            <p>
              {result.error && result.events.length === 0 ? (
                <span className="text-evict">The query did not run — see the error by the editor.</span>
              ) : result.error ? (
                // A statement the engine started and then rejected (a UNIQUE key already taken): the trace shows how far it got.
                <span className="text-evict">
                  Rejected after {result.events.length} steps — the trace shows how far it got; the error is by the editor.
                </span>
              ) : (
                <>
                  {result.events.length} steps in this trace · showing step{' '}
                  <span className="tabular-nums font-semibold text-ink">{playback.step}</span>
                </>
              )}
            </p>
            <span className="ml-auto flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <button type="button" onClick={() => { void copyLink(); }} className={LINK_ACTION}>
                {copied ? 'Link copied' : 'Copy link to this step'}
              </button>
              <button type="button" onClick={downloadTrace} disabled={isCustom} title={isCustom ? 'Not available for custom tables' : undefined} className={LINK_ACTION}>
                Download trace
              </button>
              <button type="button" onClick={() => { fileInputRef.current?.click(); }} className={LINK_ACTION}>
                Load trace
              </button>
              <button type="button" onClick={() => { setPresenting(true); }} className={LINK_ACTION}>
                Present
              </button>
              <button type="button" onClick={() => { setTourOpen(true); }} className={LINK_ACTION}>
                Tour
              </button>
              <button type="button" onClick={() => { print(); }} className={LINK_ACTION}>
                Print
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
            <p className={`p-3 text-label text-ink-dim ${GLASS_CARD}`}>
              <span className="font-semibold text-ink">Assignment mode.</span> The trace is sealed until answered.
            </p>
          ) : (
            <label className="flex items-center gap-2 text-label text-ink-dim select-none">
              <input
                type="checkbox"
                checked={predictOn}
                onChange={(e) => { setPredictOn(e.target.checked); }}
                className="accent-[var(--color-accent)] cursor-pointer"
              />
              Ask me to predict before each reveal
            </label>
          )}

        </div>

        {/* Trace panel */}
        <div className={`${PANEL_COL} order-1 lg:order-2 lg:overflow-hidden`}>
          <div data-tour="pipeline">
            <PipelineTracker
              current={state?.stage ?? null}
              visited={visited}
              selected={pinnedStage}
              onSelect={(s) => { setPinnedStage((prev) => (prev === s ? null : s)); }}
            />
          </div>

          <div
            data-tour="panel"
            className={`${panelSurface} max-h-[60dvh] min-h-80 min-w-0 flex-1 overflow-hidden p-4 lg:max-h-none`}
          >
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
                  withHelp
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
              key={upcoming.id}
              prompt={prompt}
              answer={answers[upcoming.id]}
              canSkip={!ASSIGNMENT}
              onAnswer={(optionId, confidence) => {
                setAnswers((current) => ({ ...current, [upcoming.id]: optionId }));
                recordPrediction(optionId === prompt.correctOptionId, confidence);
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
            data-tour="narration"
            className={prompt ? 'sr-only' : NARRATION_BOX}
          >
            {!prompt && (
              <div className="mb-1 flex items-center justify-between gap-2">
                <h2 className="text-micro font-semibold tracking-[0.14em] text-ink-dim uppercase">
                  Narration
                </h2>
                <ReportStepLink moment={moment} />
              </div>
            )}
            <p className="min-h-10 text-body leading-relaxed text-ink" aria-live="polite" aria-atomic="true">
              <span className="sr-only">
                Step {playback.step} of {result.events.length}.{' '}
              </span>
              {announcement}
            </p>
          </div>

          {!prompt && whyNot && <WhyNotNote whyNot={whyNot} />}
          {!prompt && traceDiff?.sql === sql && traceDiff.diff && <TraceDiffNote diff={traceDiff.diff} />}

          <div
            data-tour="playback"
            className="sticky bottom-0 z-10 -mx-4 space-y-2 border-t border-edge bg-surface/80 px-4 py-2 backdrop-blur-md lg:static lg:mx-0 lg:space-y-3 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
          >
            <PlaybackControls
              playback={playback}
              length={result.events.length}
              maxStep={ceiling ?? result.events.length}
            />
            <ShortcutHints />
          </div>
        </div>
      </main>

      {/* plan.md §22.6: mounted only while printing (see the `beforeprint`
          effect), so its copy of the trace never sits in the on-screen DOM. */}
      {printing && (
        <TraceWorksheet
          sql={sql}
          policy={policy}
          predictOn={predictOn}
          dataset={isCustom ? 'a custom database' : datasetId}
          events={result.events}
          rowCount={result.rows.length}
        />
      )}

      {editingData && table && (
        <DataEditor
          table={table}
          onApply={applyRows}
          onReset={resetData}
          onClose={() => { setEditingData(false); }}
        />
      )}

      {workspacesOpen && (
        <Suspense fallback={null}>
          <WorkspaceDialog
            db={db}
            sql={sql}
            onOpen={openDatabase}
            onLoadQuery={(text) => { setSql(text); }}
            onClose={() => { setWorkspacesOpen(false); }}
          />
        </Suspense>
      )}

      {durabilityOpen && (
        <Suspense fallback={null}>
          <DurabilityDialog
            db={db}
            log={durable}
            onAppend={(step) => { setDurable((log) => appendStep(log, step)); }}
            onRestart={() => { setDurable(openLog(db, options.rowsPerPage)); }}
            onUse={(recovered, heap) => {
              setDb(recovered);
              setRowsEdited(true);
              setDurable((log) => carryOn(log, recovered, heap));
              setDurabilityOpen(false);
              // A read can show the recovered rows at once; a write must not be run a second time.
              const again = runQuery(sql, recovered, options);
              if (!again.write) {
                setResult(again);
                setPinnedStage(null);
                setAnswers({});
                playback.land(landingStep(again, predictOn));
              }
            }}
            onClose={() => { setDurabilityOpen(false); }}
          />
        </Suspense>
      )}

      {schemaEditorOpen && (
        <SchemaEditor
          db={db}
          onApply={applySchema}
          onClose={() => { setSchemaEditorOpen(false); }}
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

      {tourOpen && !presenting && (
        <PlaygroundTour onClose={() => { setTourOpen(false); }} />
      )}
    </>
  );
}
