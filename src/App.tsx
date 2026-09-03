import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import { Footer } from './ui/Footer.tsx';
import { publishRepro } from './ui/errorReport.ts';
import { PipelineTracker } from './ui/PipelineTracker.tsx';
import { PlaybackControls } from './ui/PlaybackControls.tsx';
import { SqlEditor } from './ui/SqlEditor.tsx';
import { DataEditor } from './ui/DataEditor.tsx';
import { PredictionCard } from './ui/PredictionCard.tsx';
import { ShortcutHints } from './ui/ShortcutHints.tsx';
import { ThemeToggle } from './ui/ThemeToggle.tsx';
import { useTheme } from './ui/theme.ts';
import { RUN_HINT, useIsTouch } from './ui/platform.ts';
import { StageDetail } from './ui/panels/StageDetail.tsx';
import { STAGE_META } from './ui/stageMeta.ts';
import { usePlayback, usePlaybackShortcuts } from './ui/usePlayback.ts';
import {
  encodeShareState,
  readShareState,
  skippedAnswersBefore,
  writeShareState,
} from './ui/urlState.ts';

// plan.md §9's first query: the indexed point lookup. Swap the WHERE for
// `age > 30` to watch the same table read by a sequential scan instead.
const INITIAL_SQL = 'SELECT *\nFROM users\nWHERE id = 5;';

const TABLE = 'users';

/**
 * plan.md §15.1 item 2. Step 0 means "no event applied yet", which renders the
 * same empty panel the user was already looking at — the documented result
 * being that they press Run again. Landing on step 1 puts the first parse
 * event into the panel, the narration and the pipeline tracker at once.
 *
 * Unless step 0 asks a question: predict-then-reveal must ask before it
 * reveals, and that outranks the feedback.
 */
function landingStep(result: RunResult, predictOn: boolean): number {
  if (result.events.length === 0) return 0;
  return predictOn && result.events[0]?.predictable !== undefined ? 0 : 1;
}

/**
 * The moment this tab opened on (plan.md §8, §15.2), read once at module load.
 *
 * Everything below is derived from it rather than from constants, so a shared
 * link and a cold start take exactly the same path through the app — there is
 * no second "restore" code path that can drift from the first.
 */
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

// plan.md §15.1 item 1. Everything the first trace needs is deterministic and
// already here, so the app can open on it rather than on an empty box that is
// 53% of a phone viewport and teaches nothing.
const INITIAL_RESULT = runQuery(START.sql, START.db, {
  ...DEFAULT_ENGINE_OPTIONS,
  policy: START.policy,
});

export default function App() {
  const [sql, setSql] = useState(START.sql);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(START.policy);
  const [pinnedStage, setPinnedStage] = useState<Stage | null>(null);
  const [db, setDb] = useState<Database>(START.db);
  const [editingData, setEditingData] = useState(false);
  // Only so a crash report can say whether the rows are worth including.
  const [rowsEdited, setRowsEdited] = useState(SHARED.rows !== undefined);
  const [result, setResult] = useState<RunResult>(INITIAL_RESULT);

  // Prediction is on by default: RESEARCH.md §1 is that the prompts are what
  // teach. A toggle, not a trap, for anyone who just wants to watch.
  const [predictOn, setPredictOn] = useState(START.predictOn);
  const [answers, setAnswers] = useState<Record<number, string>>(() =>
    skippedAnswersBefore(INITIAL_RESULT.events, SHARED.step ?? 0),
  );

  const options = useMemo(() => ({ ...DEFAULT_ENGINE_OPTIONS, policy }), [policy]);
  const table = db.tables[TABLE];
  // A phone has no ⌘ and no ↵ to press (plan.md §15.1 item 6).
  const touch = useIsTouch();
  // Everything else follows the CSS tokens; only CodeMirror needs telling,
  // because a HighlightStyle bakes its colours in at definition time.
  const { choice, theme, setChoice } = useTheme();

  const projector = useMemo(
    () => createTraceProjector(result.events, options),
    [result, options],
  );

  // Disk reads dwell longer than buffer hits during playback.
  const dwells = useMemo(() => result.events.map((e) => e.dwell ?? 1), [result]);

  // `gates[i]`: applying event i would reveal an answer nobody has committed to.
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
    // A link names its own step; a cold start lands on 1 (plan.md §15.1 item 2).
    initialStep: SHARED.step ?? landingStep(INITIAL_RESULT, START.predictOn),
  });
  // The data editor is a modal: its own Escape and Tab handling should not be
  // competing with ←/→/Space stepping a trace nobody can see behind it.
  usePlaybackShortcuts(playback, !editingData);

  const state = projector.at(playback.step);

  // The prompt for the step about to run — asked before it is revealed.
  const upcoming = result.events[playback.step];
  const prompt = predictOn ? upcoming?.predictable : undefined;

  const visited = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result.events.slice(0, playback.step)) seen.add(e.stage);
    return seen;
  }, [result, playback.step]);

  // A pinned stage always wins; otherwise the panel follows the question when
  // one is pending, and the last applied event when one is not. The cheap half
  // of plan.md §15.2's spatial-contiguity fix: a prompt about an eviction is
  // useless while the parser is on screen.
  const activeStage = pinnedStage ?? (prompt ? upcoming?.stage : undefined) ?? state.stage ?? null;

  const activeSpan: Span | undefined =
    state?.lastEvent?.stage === 'parse' ? state.lastEvent.span : undefined;

  // plan.md §14.1 item 4. Written during render, not from an effect: the state
  // worth reporting is the state of the render that throws, and an effect only
  // sees renders that already succeeded. Idempotent, so StrictMode is fine.
  publishRepro({
    sql,
    policy,
    step: playback.step,
    predictOn,
    rows: table?.rows ?? [],
    rowsEdited,
  });

  /**
   * Keep the address bar pointing at the moment on screen (plan.md §15.2).
   *
   * Debounced, because this also runs on every SQL keystroke and browsers rate-
   * limit history writes. `replaceState` rather than `pushState`, so stepping a
   * 33-event trace does not bury the previous page under 33 history entries.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeShareState(
        encodeShareState(
          {
            sql,
            policy,
            predictOn,
            step: playback.step,
            // The seed set is reproducible from the code; only a customised
            // table earns 2 kB of URL.
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
      // Clipboard permission can be refused. The URL is the source of truth
      // either way, so say where it is rather than failing silently.
      setCopied(false);
    }
  }

  const run = useCallback(
    (database: Database = db) => {
      const next = runQuery(sql, database, options);
      setResult(next);
      setPinnedStage(null);
      setAnswers({});
      // `land`, not `reset`: pressing Run has to change something the user is
      // already looking at (plan.md §15.1 item 2). Answers were just cleared,
      // so the gate check uses `predictOn` alone.
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
    /* On a wide screen the app is a fixed-height shell and the panels scroll
       inside it; on a phone the page scrolls normally and the panel is capped
       instead. Without the `lg:h-dvh`, the grid row is auto-sized, so a 43-row
       result grows the row, the panel's `flex-1` never gets a definite height
       to divide, and the whole page gets taller than the viewport. */
    /* `snap-sections` is a no-op above `lg`, where this shell is fixed-height
       and the panels scroll inside it rather than the page scrolling at all
       (plan.md §16.2 item 10). */
    <div className="snap-sections flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <DisclaimerBanner />

      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
        <h1 className="text-display font-semibold tracking-tight">QueryLens</h1>
        {/* plan.md §19.1, job 1: say what this is in one line, in the visitor's
            words, with concrete nouns. The previous line — "see what your SQL
            actually does" — is the failure mode that section names: true, and
            it says nothing the title tag did not. A visitor who reads only this
            sentence should be able to describe the product; "B+Tree traversal"
            is the noun that makes that possible, and it is also the promise the
            first paint keeps, because the trace has already run. */}
        <p className="text-label text-ink-dim">
          Watch a SQL query become a B+Tree traversal.
        </p>
        <span
          className="ml-auto rounded-full border border-edge bg-surface-2 px-2.5 py-0.5 text-micro text-ink-dim"
          title={`Built: ${IMPLEMENTED_STAGES.join(', ')}.`}
        >
          {IMPLEMENTED_STAGES.length}/{STAGES.length} stages built
        </span>
        <ThemeToggle choice={choice} setChoice={setChoice} />
      </header>

      <main className="grid flex-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[minmax(300px,400px)_1fr]">
        {/* Authoring. Deliberately after the trace in phone reading order. */}
        {/* min-w-0: a grid item defaults to `min-width: auto`, so it refuses to
            shrink below its content and a long line pushes the page sideways
            instead of scrolling inside. */}
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
            {/* plan.md §16.2 item 6 — acknowledge Run.
                A trace takes roughly 50 ms and `runQuery` is synchronous, so a
                spinner could not paint before the work finished even if one
                existed: it would appear only to be torn down, which is the
                jank the item warns about. Under that threshold the item's own
                answer is a press state, and this is it — `active:` deepens the
                fill for exactly as long as the button is held, with no state,
                no timer and nothing to get out of sync with the engine.
                §19.1 job 3 is the other half: this is the one element on the
                first screen that reads as the primary action, and everything
                beside it is deliberately quieter. */}
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

          {/* plan.md §15.1 item 2: the trace length belongs next to the button
              that built it. The counter in the playback row is on the other
              side of the screen, and 12px of it moving is not feedback. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-micro text-ink-dim">
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
            {/* The address bar already holds the moment, but nobody looks there
                — and on a phone it is usually hidden entirely. */}
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

        {/* The trace. First on a phone: people open links on one, and nobody
            writes SQL there (plan.md §15.2, "mobile as read-first"). */}
        <div className="snap-section order-1 flex min-h-0 min-w-0 flex-col gap-4 lg:order-2 lg:overflow-hidden">
          <PipelineTracker
            current={state?.stage ?? null}
            visited={visited}
            selected={pinnedStage}
            onSelect={(s) => { setPinnedStage((prev) => (prev === s ? null : s)); }}
          />

          {/* plan.md §15.2. The old fixed `h-[27rem]` was right that the controls
              must not move mid-step and wrong that freezing the panel is how:
              it letterboxed a 1440×900 monitor and ate half a phone. Filling the
              column instead is stable for the same reason — the height comes
              from the viewport, not from what the current step happens to
              render — while actually using the screen it is given. */}
          <div className="max-h-[60dvh] min-h-80 min-w-0 flex-1 overflow-hidden rounded-lg border border-edge bg-surface-2 p-4 lg:max-h-none">
            {activeStage ? (
              /* A panel-scoped boundary, so one broken renderer costs the user
                 that stage rather than the trace they were part-way through.
                 Keyed by stage: leaving a stage that threw clears the error. */
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
                  // Only "pinned" once the trace has moved on: holding the
                  // panel on the stage it would show anyway is not a state
                  // worth announcing.
                  pinned={pinnedStage !== null && pinnedStage !== state.stage}
                  onFollow={() => { setPinnedStage(null); }}
                />
              </ErrorBoundary>
            ) : (
              /* Only reachable when step 0 itself asks a question, or when the
                 SQL failed to parse — the trace otherwise runs on load. */
              <p className="text-body text-ink-dim">
                {result.error
                  ? 'Fix the query and run it again to build a trace.'
                  : 'Answer the question below to reveal the first step.'}
              </p>
            )}
          </div>

          {/* Directly under the panel it is about (plan.md §8, §15.2): the
              spatial-contiguity effect is g = 0.63 over 58 comparisons, the
              same order as the effect that justified building prediction at
              all, and asking "which child pointer?" with the buffer pool on
              screen hands it straight back. */}
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
              {/* Announced as it changes: stepping is the primary interaction,
                  and a screen reader user needs to hear what each step did. */}
              <p className="min-h-10 text-body leading-relaxed" aria-live="polite">
                {state.narration || 'Step forward to start the trace.'}
              </p>
            </div>
          )}

          {/* Sticky on a phone, so the control you press every few seconds stays
              in thumb reach while the trace scrolls under it.

              Was `bg-surface/95 backdrop-blur`. plan.md §16.1 constraint 3
              rejects `backdrop-blur` by name — it is a SaaS-surface effect, and
              the reference class here is an instrument, where separation comes
              from a border. The blur was also barely doing anything behind a
              95%-opaque background: an opaque surface plus the border that was
              already there is the same separation, sharper, and one composited
              layer cheaper on the phone where this bar actually appears. */}
          <div className="sticky bottom-0 z-10 -mx-4 space-y-2 border-t border-edge bg-surface px-4 py-2 lg:static lg:mx-0 lg:space-y-4 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0">
            <PlaybackControls playback={playback} length={result.events.length} />
            <ShortcutHints />
          </div>
        </div>
      </main>

      {/* plan.md §16.2 item 9 and §19.1 job 5: the quiet way deeper, below the
          fold. Outside <main> because it is not part of the trace, and after it
          in the DOM so it is the last thing a screen reader reaches. */}
      <Footer />

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
