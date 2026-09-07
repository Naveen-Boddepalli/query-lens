import { useCallback, useEffect, useState } from 'react';

export interface Playback {
  /** Number of events consumed. 0 = before the first step. */
  step: number;
  playing: boolean;
  speed: number;
  atStart: boolean;
  atEnd: boolean;
  /** True while an unanswered prompt is holding playback. */
  blocked: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stepForward: () => void;
  stepBack: () => void;
  reset: () => void;
  seek: (step: number) => void;
  /** Land on a step in a trace arriving in this same commit. See below. */
  land: (step: number) => void;
  setSpeed: (speed: number) => void;
}

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
const BASE_STEP_MS = 900;

export interface PlaybackOptions {
  /**
   * `gates[i]` true means "do not advance past step i yet". Predict-then-reveal
   * sets it while a prompt is unanswered: the question must be asked *before*
   * the event that answers it is applied.
   *
   * An array rather than a predicate on the current step, because the caller
   * would need the step to compute one — and the step comes from this hook.
   */
  gates?: readonly boolean[];
  /**
   * Per-event pacing weights, indexed like the event array. A disk read dwells
   * longer than a buffer hit. Passed as an array rather than a callback so the
   * hook stays free of caller-owned refs.
   */
  dwells?: readonly number[];
  /**
   * Where to sit before anything is pressed. plan.md §15.1 item 1 opens the app
   * on a real trace, and step 0 means "no event applied yet" — which renders
   * the empty state that item exists to delete.
   */
  initialStep?: number;
  /**
   * A hard upper bound the playhead cannot cross by *any* route — including the
   * scrubber, which `gates` deliberately does not stop. Assignment mode
   * (plan.md §20.5) sets this to the first unanswered prediction, so the reveal
   * stays sealed until the learner commits. Defaults to `length`.
   */
  ceiling?: number;
}

/** Playback is an index into an array we already own — nothing more. */
export function usePlayback(length: number, options?: PlaybackOptions): Playback {
  const [rawStep, setRawStep] = useState(options?.initialStep ?? 0);
  const [wantsToPlay, setWantsToPlay] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Derived, not stored: a re-run producing a shorter trace must not leave us
  // parked past the end, and playing must stop at the end on its own.
  const hardCeiling = options?.ceiling; // undefined unless a caller sets one
  const ceiling = Math.min(hardCeiling ?? length, length);
  const step = Math.min(rawStep, ceiling);
  const blocked = options?.gates?.[Math.min(rawStep, ceiling)] ?? false;
  const atStart = step === 0;
  const atEnd = step >= length;
  const playing = wantsToPlay && !atEnd && !blocked;

  const advance = useCallback(() => {
    if (step >= length || blocked) return;
    setRawStep(step + 1);
  }, [step, length, blocked]);

  const play = useCallback(() => { setWantsToPlay(true); }, []);
  const pause = useCallback(() => { setWantsToPlay(false); }, []);
  const toggle = useCallback(() => { setWantsToPlay(!playing); }, [playing]);
  const stepBack = useCallback(() => {
    setWantsToPlay(false);
    setRawStep(Math.max(0, step - 1));
  }, [step]);
  const stepForward = useCallback(() => {
    setWantsToPlay(false);
    if (step < length && !blocked) setRawStep(step + 1);
  }, [step, length, blocked]);
  const reset = useCallback(() => { setWantsToPlay(false); setRawStep(0); }, []);
  // Scrubbing is deliberately *not* stopped by a `gate` — a prompt should not
  // trap someone who wants to look elsewhere in the trace — but it *is* stopped
  // by `ceiling`, which assignment mode uses to seal the reveal.
  const seek = useCallback(
    (target: number) => {
      setWantsToPlay(false);
      setRawStep(Math.max(0, Math.min(target, ceiling)));
    },
    [ceiling],
  );
  /**
   * `seek` clamps against the length it can see, which during a Run is still
   * the *previous* trace's — so seeking to step 1 straight after a run that
   * follows a parse error (length 0) would clamp to 0. This skips the upper
   * clamp because `step` re-derives it from the new length on render anyway.
   */
  const land = useCallback((target: number) => {
    setWantsToPlay(false);
    // Skip the length clamp — it's the previous trace's during a Run — but
    // still honour an explicit ceiling if one is set.
    setRawStep(hardCeiling === undefined ? Math.max(0, target) : Math.max(0, Math.min(target, hardCeiling)));
  }, [hardCeiling]);

  // The weight of the event currently on screen: we linger on what just
  // happened before moving to the next thing.
  const dwell = options?.dwells?.[step - 1] ?? 1;

  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(advance, (BASE_STEP_MS * dwell) / speed);
    return () => { window.clearTimeout(id); };
  }, [playing, speed, dwell, advance]);

  return {
    step, playing, speed, atStart, atEnd, blocked,
    play, pause, toggle, stepForward, stepBack, reset, seek, land, setSpeed,
  };
}

/** True when the keystroke belongs to a text field and we should keep out of it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('.cm-editor') !== null
  );
}

/**
 * Space = play/pause, ←/→ = step, Home = reset. Learners in training settings
 * lean on these heavily (plan.md §8).
 */
export function usePlaybackShortcuts(playback: Playback, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Match on `code` for the space bar: `key` is ' ' on most layouts but
      // 'Spacebar' on older ones, and matching the physical key is layout-proof.
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        playback.toggle();
        return;
      }

      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); playback.stepForward(); break;
        case 'ArrowLeft': e.preventDefault(); playback.stepBack(); break;
        case 'Home': e.preventDefault(); playback.reset(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [playback, enabled]);
}
