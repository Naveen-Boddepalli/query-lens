import { useCallback, useEffect, useRef, useState } from 'react';

export interface Playback {
  /** Number of events consumed. 0 = before the first step. */
  step: number;
  playing: boolean;
  speed: number;
  atStart: boolean;
  atEnd: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stepForward: () => void;
  stepBack: () => void;
  reset: () => void;
  seek: (step: number) => void;
  setSpeed: (speed: number) => void;
}

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
const BASE_STEP_MS = 900;

export interface PlaybackOptions {
  /**
   * Called with the step just reached. Returning true stops playback there —
   * the seam for predict-then-reveal, which must halt before revealing.
   */
  onHalt?: (step: number) => boolean;
}

/** Playback is an index into an array we already own — nothing more. */
export function usePlayback(length: number, options?: PlaybackOptions): Playback {
  const [rawStep, setRawStep] = useState(0);
  const [wantsToPlay, setWantsToPlay] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Derived, not stored: a re-run producing a shorter trace must not leave us
  // parked past the end, and playing must stop at the end on its own.
  const step = Math.min(rawStep, length);
  const atStart = step === 0;
  const atEnd = step >= length;
  const playing = wantsToPlay && !atEnd;

  const onHaltRef = useRef(options?.onHalt);
  useEffect(() => {
    onHaltRef.current = options?.onHalt;
  });

  const advance = useCallback(() => {
    if (step >= length) return;
    const next = step + 1;
    setRawStep(next);
    if (onHaltRef.current?.(next)) setWantsToPlay(false);
  }, [step, length]);

  const play = useCallback(() => { setWantsToPlay(true); }, []);
  const pause = useCallback(() => { setWantsToPlay(false); }, []);
  const toggle = useCallback(() => { setWantsToPlay(!playing); }, [playing]);
  const stepBack = useCallback(() => {
    setWantsToPlay(false);
    setRawStep(Math.max(0, step - 1));
  }, [step]);
  const stepForward = useCallback(() => {
    setWantsToPlay(false);
    if (step < length) setRawStep(step + 1);
  }, [step, length]);
  const reset = useCallback(() => { setWantsToPlay(false); setRawStep(0); }, []);
  const seek = useCallback(
    (target: number) => {
      setWantsToPlay(false);
      setRawStep(Math.max(0, Math.min(target, length)));
    },
    [length],
  );

  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(advance, BASE_STEP_MS / speed);
    return () => { window.clearTimeout(id); };
  }, [playing, speed, advance]);

  return {
    step, playing, speed, atStart, atEnd,
    play, pause, toggle, stepForward, stepBack, reset, seek, setSpeed,
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
      switch (e.key) {
        case ' ': e.preventDefault(); playback.toggle(); break;
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
