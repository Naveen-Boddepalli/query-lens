import { useCallback, useSyncExternalStore } from 'react';

/** The workbench's one breakpoint: the inspector is a side rail from here up, a collapsible bar below. */
export const WIDE = '(min-width: 1024px)';

/**
 * Whether a media query matches, read synchronously on the first render so a
 * wide screen never paints the narrow layout first, then kept current.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => { mq.removeEventListener('change', onChange); };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
