import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePlayback, usePlaybackShortcuts } from '../usePlayback.ts';

/** Fires a key at the window, the way a real keypress reaches the listener. */
function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

describe('usePlayback gating', () => {
  // plan.md §14.2 named this first: predict-then-reveal is the highest-leverage
  // feature in the product, and it is enforced entirely by this array.
  it('blocks advancement while a prompt at the current step is unanswered', () => {
    const gates = [false, false, true, false, false];
    const { result } = renderHook(() => usePlayback(5, { gates }));

    act(() => { result.current.stepForward(); });
    act(() => { result.current.stepForward(); });
    expect(result.current.step).toBe(2);
    expect(result.current.blocked).toBe(true);

    act(() => { result.current.stepForward(); });
    expect(result.current.step).toBe(2);
  });

  it('unblocks when the gate clears', () => {
    const gates = [false, false, true, false, false];
    const { result, rerender } = renderHook(({ g }) => usePlayback(5, { gates: g }), {
      initialProps: { g: gates },
    });

    act(() => { result.current.seek(2); });
    expect(result.current.blocked).toBe(true);

    // Answering the prompt is what flips the entry — App rebuilds the array.
    rerender({ g: [false, false, false, false, false] });
    expect(result.current.blocked).toBe(false);

    act(() => { result.current.stepForward(); });
    expect(result.current.step).toBe(3);
  });

  it('never re-locks on the way back', () => {
    // Once answered, a gate stays clear: walking backwards through a prompt the
    // user has already committed to must not trap them behind it again.
    const { result, rerender } = renderHook(({ g }) => usePlayback(5, { gates: g }), {
      initialProps: { g: [false, false, true, false, false] },
    });

    act(() => { result.current.seek(4); });
    rerender({ g: [false, false, false, false, false] });

    for (const expected of [3, 2, 1, 0]) {
      act(() => { result.current.stepBack(); });
      expect(result.current.step).toBe(expected);
      expect(result.current.blocked).toBe(false);
    }
  });

  it('lets a gated user scrub away rather than trapping them', () => {
    const { result } = renderHook(() => usePlayback(5, { gates: [false, false, true, false, false] }));
    act(() => { result.current.seek(2); });
    expect(result.current.blocked).toBe(true);

    act(() => { result.current.seek(4); });
    expect(result.current.step).toBe(4);
  });

  it('will not play while blocked', () => {
    const { result } = renderHook(() => usePlayback(5, { gates: [true, false, false, false, false] }));
    act(() => { result.current.play(); });
    expect(result.current.playing).toBe(false);
  });
});

describe('usePlayback bounds', () => {
  it('clamps a step left over from a longer trace', () => {
    // A re-run producing a shorter trace must not leave playback past the end.
    const { result, rerender } = renderHook(({ n }) => usePlayback(n), { initialProps: { n: 30 } });
    act(() => { result.current.seek(28); });
    rerender({ n: 5 });
    expect(result.current.step).toBe(5);
    expect(result.current.atEnd).toBe(true);
  });

  it('land() survives a trace that arrives in the same commit', () => {
    // `seek` clamps against the length it can see — still 0 right after a parse
    // error — so landing on step 1 has to skip that clamp. See usePlayback.ts.
    const { result, rerender } = renderHook(({ n }) => usePlayback(n), { initialProps: { n: 0 } });
    act(() => { result.current.land(1); });
    expect(result.current.step).toBe(0);

    rerender({ n: 33 });
    expect(result.current.step).toBe(1);
  });

  it('honours initialStep', () => {
    const { result } = renderHook(() => usePlayback(33, { initialStep: 13 }));
    expect(result.current.step).toBe(13);
  });
});

describe('usePlayback ceiling (assignment mode)', () => {
  it('stops the scrubber at the ceiling — the gate a `gates` entry cannot', () => {
    const { result } = renderHook(() =>
      usePlayback(20, { ceiling: 5, gates: [false, false, false, false, false, true] }),
    );
    // `gates` alone lets a scrub jump anywhere; the ceiling does not.
    act(() => { result.current.seek(18); });
    expect(result.current.step).toBe(5);
    expect(result.current.atEnd).toBe(false); // stuck at the gate, not the end
  });

  it('lifts as the ceiling is raised, one gate at a time', () => {
    const { result, rerender } = renderHook(({ c }) => usePlayback(20, { ceiling: c }), {
      initialProps: { c: 5 },
    });
    act(() => { result.current.seek(20); });
    expect(result.current.step).toBe(5);

    rerender({ c: 12 });
    act(() => { result.current.seek(20); });
    expect(result.current.step).toBe(12);
  });

  it('never exceeds the trace length even with a larger ceiling', () => {
    const { result } = renderHook(() => usePlayback(8, { ceiling: 999 }));
    act(() => { result.current.seek(50); });
    expect(result.current.step).toBe(8);
  });
});

describe('usePlaybackShortcuts', () => {
  function setup(enabled = true) {
    return renderHook(() => {
      const playback = usePlayback(10);
      usePlaybackShortcuts(playback, enabled);
      return playback;
    });
  }

  it('steps with the arrow keys and resets with Home', () => {
    const { result } = setup();
    press('ArrowRight');
    press('ArrowRight');
    expect(result.current.step).toBe(2);

    press('ArrowLeft');
    expect(result.current.step).toBe(1);

    press('Home');
    expect(result.current.step).toBe(0);
  });

  it('toggles play with the space bar', () => {
    const { result } = setup();
    press(' ', { code: 'Space' });
    expect(result.current.playing).toBe(true);
    press(' ', { code: 'Space' });
    expect(result.current.playing).toBe(false);
  });

  it('matches the space bar on `code`, for layouts that report Spacebar', () => {
    const { result } = setup();
    press('Spacebar', { code: 'Space' });
    expect(result.current.playing).toBe(true);
  });

  it('keeps out of the way of the modifier the editor binds Run to', () => {
    const { result } = setup();
    press('ArrowRight', { metaKey: true });
    press('ArrowRight', { ctrlKey: true });
    expect(result.current.step).toBe(0);
  });

  it('does nothing while disabled, so the data editor keeps its keys', () => {
    const { result } = setup(false);
    press('ArrowRight');
    expect(result.current.step).toBe(0);
  });
});
