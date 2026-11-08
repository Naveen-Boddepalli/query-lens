import { SPEEDS } from './usePlayback.ts';
import type { Playback } from './usePlayback.ts';

export interface PlaybackControlsProps {
  playback: Playback;
  length: number;
  maxStep?: number;
}

const Svg = ({ d }: { d: string }) => (
  <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
    <path d={d} />
  </svg>
);

const STEP_FWD = 'M4 3.5 10 8 4 12.5zM11 3h2v10H11z';
const STEP_BACK = 'M12 3.5 6 8l6 4.5zM3 3h2v10H3z';
const RESET = 'M2 3h2v10H2zm3 5 8-5v10z';
const PLAY = 'M5 3.5 13 8 5 12.5z';
const PAUSE = 'M3 3h3v10H3zm7 0h3v10h-3z';
const BLOCKED = 'Answer the prediction first';

const btn = 'flex h-8 items-center justify-center rounded-full transition active:scale-95 disabled:cursor-not-allowed';
const iconBtn = `${btn} w-8 text-ink-dim hover:bg-surface-3 hover:text-ink disabled:opacity-40`;
const playBtn = `${btn} min-w-24 gap-1.5 border border-accent/60 bg-accent/20 px-3 text-body font-medium text-ink shadow-e1 hover:bg-accent/30 disabled:opacity-40`;

export function PlaybackControls({ playback, length, maxStep }: PlaybackControlsProps) {
  const { step, playing, speed, atStart, atEnd, blocked } = playback;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="inline-flex items-center gap-0.5 rounded-full border border-edge bg-surface-2 p-1 shadow-e1">
        <button
          type="button"
          className={iconBtn}
          onClick={playback.reset}
          disabled={atStart}
          title="Reset (Home)"
          aria-label="Reset to the start"
        >
          <Svg d={RESET} />
        </button>
        <button
          type="button"
          className={iconBtn}
          onClick={playback.stepBack}
          disabled={atStart}
          title="Step back (Left)"
          aria-label="Step back"
        >
          <Svg d={STEP_BACK} />
        </button>
        <button
          type="button"
          className={playBtn}
          onClick={playback.toggle}
          disabled={length === 0 || blocked || (atEnd && !playing)}
          title={blocked ? BLOCKED : 'Play / pause (Space)'}
        >
          <Svg d={playing ? PAUSE : PLAY} />
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>
        <button
          type="button"
          className={iconBtn}
          onClick={playback.stepForward}
          disabled={atEnd || blocked}
          title={blocked ? BLOCKED : 'Step forward (Right)'}
          aria-label="Step forward"
        >
          <Svg d={STEP_FWD} />
        </button>
      </div>

      <label className="flex items-center gap-1.5 text-label text-ink-dim">
        Speed
        <select
          className="cursor-pointer rounded-lg border border-edge bg-surface-3 px-2 py-1 text-ink shadow-e1 transition hover:border-ink-dim/50"
          value={speed}
          onChange={(e) => playback.setSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
      </label>

      <label className="flex min-w-40 flex-1 items-center gap-2 text-label text-ink-dim">
        <span
          className="rounded border border-edge bg-surface-3 px-2 py-0.5 font-mono text-label tabular-nums text-ink shadow-e1"
          aria-label={`Step ${step} of ${length}`}
        >
          {step} / {length}
        </span>
        <input
          type="range"
          className="scrubber w-full flex-1 accent-[var(--color-accent)] cursor-pointer"
          min={0}
          max={maxStep ?? length}
          value={step}
          onChange={(e) => playback.seek(Number(e.target.value))}
          aria-label="Scrub to step"
        />
      </label>
    </div>
  );
}
