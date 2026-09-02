import { SPEEDS } from './usePlayback.ts';
import type { Playback } from './usePlayback.ts';

export interface PlaybackControlsProps {
  playback: Playback;
  length: number;
}

const btn =
  'rounded-md border border-edge bg-surface-3 px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent/70 disabled:cursor-not-allowed disabled:opacity-40';

export function PlaybackControls({ playback, length }: PlaybackControlsProps) {
  const { step, playing, speed, atStart, atEnd, blocked } = playback;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={btn} onClick={playback.reset} disabled={atStart}
        title="Reset (Home)">
        ↺
      </button>
      <button type="button" className={btn} onClick={playback.stepBack} disabled={atStart}
        title="Step back (←)">
        ◀
      </button>
      <button
        type="button"
        className={`${btn} min-w-24 font-medium`}
        onClick={playback.toggle}
        disabled={length === 0 || blocked || (atEnd && !playing)}
        title={blocked ? 'Answer the prediction first' : 'Play / pause (Space)'}
      >
        {playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <button
        type="button"
        className={btn}
        onClick={playback.stepForward}
        disabled={atEnd || blocked}
        title={blocked ? 'Answer the prediction first' : 'Step forward (→)'}
      >
        ▶│
      </button>

      <label className="ml-2 flex items-center gap-2 text-xs text-ink-dim">
        Speed
        <select
          className="rounded-md border border-edge bg-surface-3 px-2 py-1 text-ink"
          value={speed}
          onChange={(e) => { playback.setSpeed(Number(e.target.value)); }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
      </label>

      <label className="flex flex-1 items-center gap-2 text-xs text-ink-dim">
        <span className="tabular-nums">
          {step} / {length}
        </span>
        <input
          type="range"
          className="w-full accent-[var(--color-accent)]"
          min={0}
          max={length}
          value={step}
          onChange={(e) => { playback.seek(Number(e.target.value)); }}
          aria-label="Scrub to step"
        />
      </label>
    </div>
  );
}
