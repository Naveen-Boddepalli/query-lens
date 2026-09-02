import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * plan.md §8: honour reduced motion by snapping between states instead of
 * tweening. The CSS media query in index.css covers CSS transitions, but the
 * viewport animations are driven from JavaScript and need this.
 *
 * This does *not* replace the Play/Pause controls — WCAG 2.2.2 requires both.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => { setReduced(e.matches); };
    mq.addEventListener('change', onChange);
    return () => { mq.removeEventListener('change', onChange); };
  }, []);

  return reduced;
}
