import { useEffect, useState } from 'react';

/**
 * plan.md §15.1 item 5. The binding was always right — CodeMirror's `Mod-`
 * prefix resolves to Cmd on Apple hardware and Ctrl everywhere else — but the
 * label said ⌘ to every user on every machine. Same test CodeMirror itself
 * uses, so the hint cannot disagree with the keymap.
 */
const APPLE = /Mac|iP(hone|[oa]d)/;

export const IS_APPLE =
  typeof navigator !== 'undefined' &&
  // `platform` is deprecated but is still the field that distinguishes Apple
  // hardware most reliably; userAgent is the documented fallback.
  APPLE.test(navigator.platform || navigator.userAgent);

/** '⌘' or 'Ctrl' — whichever key the user actually has to press. */
export const MOD_KEY = IS_APPLE ? '⌘' : 'Ctrl';

/** Enter's glyph is universal; its label is not. */
export const ENTER_KEY = '↵';

/** The label for the Run shortcut, e.g. "⌘↵" or "Ctrl+↵". */
export const RUN_HINT = IS_APPLE ? `${MOD_KEY}${ENTER_KEY}` : `${MOD_KEY}+${ENTER_KEY}`;

// Coarse pointer without hover is the pair that means "no mouse and no
// keyboard attached". Either alone gives false positives: a touchscreen laptop
// reports coarse, and some styluses report no hover.
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * plan.md §15.1 item 6. A phone is currently told about Space, ←, →, Home and
 * ⌘↵ — five keys it does not have. Watched rather than read once, because a
 * tablet gains a keyboard the moment its case is folded open.
 */
export function useIsTouch(): boolean {
  const [touch, setTouch] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(TOUCH_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(TOUCH_QUERY);
    const onChange = (e: MediaQueryListEvent) => { setTouch(e.matches); };
    mq.addEventListener('change', onChange);
    return () => { mq.removeEventListener('change', onChange); };
  }, []);

  return touch;
}
