import { useCallback, useEffect, useState } from 'react';

/**
 * Light/dark, as a user choice that can also be "whatever the system says"
 * (plan.md §15.3).
 *
 * The attribute this drives is already set before first paint by
 * `public/theme.js` — that file is the anti-flash half, this one is the
 * interactive half. They agree on one storage key and one attribute, and
 * neither reads the other's state.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'querylens:theme';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

function systemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

/**
 * Absence of a stored value *is* "system" — storing the string would make a
 * later change of system preference silently stop being followed.
 */
function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // Private mode, or site data blocked. Following the system is the right
    // fallback: it is what the user gets everywhere else.
    return 'system';
  }
}

function persist(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // The theme still applies for this session; only the memory is lost.
  }
}

/**
 * Flips the palette with transitions suppressed for the swap.
 *
 * Measured: without this, a live theme change leaves every `transition-colors`
 * element — the Run button, the tracker chips, this toggle — painting its
 * *old* text colour indefinitely. Chrome starts a `color` transition when the
 * custom property behind it changes, but keeps interpolating toward the
 * endpoint the property had when the transition began, so the element settles
 * on the previous theme's value. A fresh load of either theme is always
 * correct; only the switch is affected, which is why nothing caught it until
 * the contrast sweep was run twice in one page.
 *
 * Two frames: one for the palette change to be committed, one before letting
 * transitions animate again. The timeout is a floor, because this file already
 * knows `requestAnimationFrame` does not fire in a tab that is not painting —
 * and a theme stuck without transitions is far better than one stuck in the
 * wrong colours.
 */
function apply(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;

  // Order matters, and was arrived at by measuring rather than by reasoning.
  // Suppressing transitions *before* the swap is not enough on its own — Chrome
  // still latches the colour endpoint. What actually re-resolves the stuck
  // elements is a style flush taken while `transition: none` is in force, so
  // both attributes go on together and the flush comes after them.
  root.dataset.themeSwapping = '';
  root.dataset.theme = theme;
  void root.offsetHeight;

  const restore = () => { delete root.dataset.themeSwapping; };
  requestAnimationFrame(() => { requestAnimationFrame(restore); });
  window.setTimeout(restore, 250);
}

export interface ThemeState {
  /** What the user picked, including "follow the system". */
  choice: ThemeChoice;
  /** What that resolves to right now — the value CSS actually sees. */
  theme: Theme;
  setChoice: (choice: ThemeChoice) => void;
}

export function useTheme(): ThemeState {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // Watched, not read once: "system" has to mean *now*, so a laptop switching
  // at sunset moves the app with it.
  useEffect(() => {
    const mq = window.matchMedia(LIGHT_QUERY);
    const onChange = (e: MediaQueryListEvent) => { setSystem(e.matches ? 'light' : 'dark'); };
    mq.addEventListener('change', onChange);
    return () => { mq.removeEventListener('change', onChange); };
  }, []);

  const theme: Theme = choice === 'system' ? system : choice;

  useEffect(() => { apply(theme); }, [theme]);

  const setChoice = useCallback((next: ThemeChoice) => {
    persist(next);
    setChoiceState(next);
  }, []);

  return { choice, theme, setChoice };
}
