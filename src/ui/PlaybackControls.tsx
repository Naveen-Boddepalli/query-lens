import { SPEEDS } from './usePlayback.ts';
import type { Playback } from './usePlayback.ts';

export interface PlaybackControlsProps {
  playback: Playback;
  length: number;
  /**
   * Upper bound for the scrubber track — assignment mode (plan.md §20.5) sets
   * it below `length` so the thumb cannot be dragged past a sealed step.
   * Defaults to `length`.
   */
  maxStep?: number;
}

/** A round icon button inside the segmented transport group. */
const iconBtn =
  'flex h-8 w-8 items-center justify-center rounded-full text-body text-ink-dim transition ' +
  'hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent';

export function PlaybackControls({ playback, length, maxStep }: PlaybackControlsProps) {
  const { step, playing, speed, atStart, atEnd, blocked } = playback;
  const scrubMax = maxStep ?? length;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="inline-flex items-center gap-0.5 rounded-full border border-edge bg-surface-2 p-0.5 shadow-e1">
        <button
          type="button"
          className={iconBtn}
          onClick={playback.reset}
          disabled={atStart}
          title="Reset (Home)"
          aria-label="Reset to the start"
        >
          <span aria-hidden>↺</span>
        </button>
        <button
          type="button"
          className={iconBtn}
          onClick={playback.stepBack}
          disabled={atStart}
          title="Step back (←)"
          aria-label="Step back"
        >
          <span aria-hidden>◀</span>
        </button>
        <button
          type="button"
          className={[
            'flex h-8 min-w-24 items-center justify-center gap-1.5 rounded-full border border-accent/60',
            'bg-accent/20 px-3 text-body font-medium text-ink transition',
            'hover:bg-accent/30 hover:shadow-glow',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent/20 disabled:hover:shadow-none',
          ].join(' ')}
          onClick={playback.toggle}
          disabled={length === 0 || blocked || (atEnd && !playing)}
          title={blocked ? 'Answer the prediction first' : 'Play / pause (Space)'}
        >
          <span aria-hidden>{playing ? '❚❚' : '▶'}</span> {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className={iconBtn}
          onClick={playback.stepForward}
          disabled={atEnd || blocked}
          title={blocked ? 'Answer the prediction first' : 'Step forward (→)'}
          aria-label="Step forward"
        >
          <span aria-hidden>▶│</span>
        </button>
      </div>

      <label className="flex items-center gap-2 text-label text-ink-dim">
        Speed
        <select
          className="rounded-lg border border-edge bg-surface-3 px-2 py-1 text-ink shadow-e1 transition hover:border-ink-dim/50"
          value={speed}
          onChange={(e) => { playback.setSpeed(Number(e.target.value)); }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
      </label>

      <label className="flex min-w-40 flex-1 items-center gap-2 text-label text-ink-dim">
        <span
          className="tabular-nums text-ink"
          aria-label={`Step ${String(step)} of ${String(length)}`}
        >
          {step} / {length}
        </span>
        <input
          type="range"
          className="scrubber w-full accent-[var(--color-accent)]"
          min={0}
          max={scrubMax}
          value={step}
          onChange={(e) => { playback.seek(Number(e.target.value)); }}
          aria-label="Scrub to step"
        />
      </label>
    </div>
  );
}
