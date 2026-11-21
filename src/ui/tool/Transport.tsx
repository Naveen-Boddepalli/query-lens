import { PlaybackControls } from '../PlaybackControls.tsx';
import { usePlaybackShortcuts, type Playback } from '../usePlayback.ts';

export interface Phase {
  label: string;
  /** The step the phase starts at. */
  step: number;
}

export interface TransportProps {
  playback: Playback;
  length: number;
  maxStep?: number;
  /** Named stretches of the trace (recovery's analysis, redo, undo): chips that jump to their start. */
  phases?: readonly Phase[];
  /** Space, arrows, Home and End drive the playback. Off where another control on the page owns those keys. */
  shortcuts?: boolean;
}

/**
 * The one way to move through a trace (§4.1): `PlaybackControls` in a bar that sticks to the bottom of the stage
 * column, or of the screen on a phone, so stepping never means scrolling back down to find the buttons. Every
 * step-based tool uses this instead of its own back and forward buttons.
 */
export function Transport({ playback, length, maxStep, phases, shortcuts = true }: TransportProps) {
  usePlaybackShortcuts(playback, shortcuts);
  // The phase the current step is in: the last one that has started.
  const current = phases ? phases.reduce((at, p, i) => (p.step <= playback.step ? i : at), -1) : -1;

  return (
    <div
      role="group"
      aria-label="Playback"
      className="sticky bottom-2 z-10 flex min-w-0 flex-col gap-2 rounded-xl border border-edge bg-surface-2/90 px-3 py-2 shadow-e2 backdrop-blur-md"
    >
      <PlaybackControls playback={playback} length={length} {...(maxStep !== undefined ? { maxStep } : {})} />
      {phases && phases.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Phases">
          {phases.map((p, i) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={i === current}
              onClick={() => { playback.seek(p.step); }}
              className={`rounded-full border px-2.5 py-0.5 text-label transition duration-150 ease-out ${
                i === current ? 'ql-stage-chip-current text-ink' : 'border-edge text-ink-dim hover:text-ink'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
