import { useEffect, useRef, useState } from 'react';
import type { ReplacementPolicyName, Span, Stage, ViewState } from '../engine/index.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { PipelineTracker } from './PipelineTracker.tsx';
import { PlaybackControls } from './PlaybackControls.tsx';
import { StageDetail } from './panels/StageDetail.tsx';
import { STAGE_META } from './stageMeta.ts';
import type { Playback } from './usePlayback.ts';

export interface PresenterViewProps {
  playback: Playback;
  length: number;
  maxStep: number;
  activeStage: Stage | null;
  state: ViewState;
  policy: ReplacementPolicyName;
  activeSpan?: Span | undefined;
  currentStage: Stage | null;
  visited: ReadonlySet<Stage>;
  /** The one sentence for this step (`stepAnnouncement`). */
  narration: string;
  onExit: () => void;
}

/**
 * plan.md §22.5 / §17.2: the room-facing surface. A full-viewport view of the
 * current stage — big diagram, big narration, big transport — over a plain
 * ground, keyboard-driven (Space, ←/→, Esc). Prediction is suppressed by the
 * caller: a prompt card mid-demo stops the room, not helps it.
 *
 * It is an overlay, not a route, so it shares the Playground's live `playback`
 * and trace rather than re-deriving them; `?present=1` re-opens it on load.
 */
export function PresenterView({
  playback,
  length,
  maxStep,
  activeStage,
  state,
  policy,
  activeSpan,
  currentStage,
  visited,
  narration,
  onExit,
}: PresenterViewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    exitRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
        return;
      }
      // A light focus trap: keep Tab inside the dialog.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onExit]);

  useEffect(() => {
    const sync = () => { setIsFullscreen(document.fullscreenElement !== null); };
    document.addEventListener('fullscreenchange', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); };
  }, []);

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen can be blocked by policy; the overlay already fills the
      // viewport, so this is a nicety, not a requirement.
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Presenter view"
      className="fixed inset-0 z-50 flex flex-col gap-4 bg-surface p-4 sm:p-8"
    >
      <header className="flex flex-wrap items-center gap-3">
        <span className="text-label tracking-[0.12em] text-ink-dim uppercase">Presenter</span>
        <span className="font-mono text-body tabular-nums text-ink-dim">
          step {playback.step} / {length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {document.fullscreenEnabled && (
            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded-full border border-edge bg-surface-2 px-3 py-1 text-label text-ink-dim shadow-e1 transition hover:border-ink-dim/50 hover:text-ink"
            >
              {isFullscreen ? 'Exit full screen' : 'Full screen'}
            </button>
          )}
          <button
            ref={exitRef}
            type="button"
            onClick={onExit}
            className="rounded-full border border-edge bg-surface-2 px-3 py-1 text-label text-ink-dim shadow-e1 transition hover:border-ink-dim/50 hover:text-ink"
          >
            Exit presenter (Esc)
          </button>
        </div>
      </header>

      {/* Read-only here: pinning a stage is an authoring action, not a demo one. */}
      <PipelineTracker current={currentStage} visited={visited} selected={null} onSelect={() => undefined} />

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-edge bg-surface-2 p-4 shadow-e2 sm:p-6">
        {activeStage ? (
          <ErrorBoundary variant="panel" label={STAGE_META[activeStage].title} resetKey={activeStage}>
            <StageDetail stage={activeStage} state={state} policy={policy} activeSpan={activeSpan} />
          </ErrorBoundary>
        ) : (
          <p className="text-body text-ink-dim">Step forward to start the trace.</p>
        )}
      </div>

      <p
        className="text-heading leading-snug text-ink"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="sr-only">Step {playback.step} of {length}. </span>
        {narration}
      </p>

      <div className="rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <PlaybackControls playback={playback} length={length} maxStep={maxStep} />
        <p className="mt-2 text-label text-ink-dim">
          <kbd className="rounded border border-edge px-1">Space</kbd> play/pause ·{' '}
          <kbd className="rounded border border-edge px-1">←</kbd>
          <kbd className="rounded border border-edge px-1">→</kbd> step ·{' '}
          <kbd className="rounded border border-edge px-1">Esc</kbd> exit. Prediction is off here.
        </p>
      </div>
    </div>
  );
}
