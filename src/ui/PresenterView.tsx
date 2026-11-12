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

const presBtn =
  'rounded-full border px-2.5 py-0.5 text-label font-medium select-none transition-all border-edge text-ink-dim hover:border-ink-dim/50 hover:text-ink active:scale-95';

const kbdCls =
  'rounded border border-edge bg-surface-3 px-1.5 py-0.5 font-mono text-micro text-ink shadow-e1';

const card = 'rounded-xl border border-edge bg-surface-2 shadow-e2';

const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className={kbdCls}>{children}</kbd>;

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
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button, input, select');
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
      // Ignored if fullscreen blocked
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Presenter view"
      className="fixed inset-0 z-50 flex flex-col gap-4 bg-surface/95 p-4 backdrop-blur-xl sm:p-6"
    >
      <header className={`flex flex-wrap items-center gap-3 p-3 ${card}`}>
        <span className="text-micro font-semibold tracking-[0.14em] text-accent uppercase">Presenter</span>
        <span className="font-mono text-body tabular-nums text-ink-dim">
          step {playback.step} / {length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {document.fullscreenEnabled && (
            <button type="button" onClick={toggleFullscreen} className={presBtn}>
              {isFullscreen ? 'Exit full screen' : 'Full screen'}
            </button>
          )}
          <button ref={exitRef} type="button" onClick={onExit} className={presBtn}>
            Exit presenter (Esc)
          </button>
        </div>
      </header>

      {/* Read-only here: pinning a stage is an authoring action, not a demo one. */}
      <PipelineTracker current={currentStage} visited={visited} selected={null} onSelect={() => {}} />

      <div className={`min-h-0 flex-1 overflow-hidden p-4 sm:p-6 ${card}`}>
        {activeStage ? (
          <ErrorBoundary variant="panel" label={STAGE_META[activeStage].title} resetKey={activeStage}>
            <StageDetail stage={activeStage} state={state} policy={policy} activeSpan={activeSpan} />
          </ErrorBoundary>
        ) : (
          <p className="text-body text-ink-dim">Step forward to start the trace.</p>
        )}
      </div>

      <p
        className={`ql-sheen p-3.5 text-heading font-medium leading-snug text-ink ${card}`}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="sr-only">Step {playback.step} of {length}. </span>
        {narration}
      </p>

      <div className={`p-3 ${card}`}>
        <PlaybackControls playback={playback} length={length} maxStep={maxStep} />
        <p className="mt-2 text-label text-ink-dim/80">
          <Kbd>Space</Kbd> play/pause · <Kbd>Left</Kbd> <Kbd>Right</Kbd> step · <Kbd>Esc</Kbd> exit
        </p>
      </div>
    </div>
  );
}
