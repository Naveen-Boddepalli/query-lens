import { useEffect, useState } from 'react';
import { hasSeenHint, markHintSeen, requestTour } from './firstVisit.ts';
import { useIsTouch } from './platform.ts';

/**
 * plan.md §19.2 P1: one line under the header, shown once to a visitor who
 * arrives at the app's own front door — `/playground` with nothing in the URL.
 * A shared-moment link carries its own context and its recipient is not
 * "exploring cold", so `Layout` only mounts this for the bare route.
 *
 * It retires itself on mount, so a reload never brings it back (§19.4's
 * "appears once"), and the Dismiss button removes it mid-session as well.
 * "Take the 60-second tour" hands off to `PlaygroundTour` (via `requestTour`,
 * since that component lives in a different subtree) and dismisses the line.
 *
 * Rendered by `Layout` rather than `PlaygroundPage` so it sits genuinely under
 * the header and paints before the Playground chunk resolves. §19.4 item 1's
 * "no banner on first paint" is about marketing chrome standing in front of the
 * product; §19.2 mandates this strip by name, it is one quiet line, and the
 * completed trace stays fully visible below it.
 */
export function FirstVisitHint() {
  const [shown, setShown] = useState(() => !hasSeenHint());
  const touch = useIsTouch();

  useEffect(() => {
    if (shown) markHintSeen();
  }, [shown]);

  if (!shown) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-edge bg-accent-soft px-4 py-1.5 text-center text-label text-ink-dim">
      <p>
        <span className="font-medium text-ink">New here?</span>{' '}
        {touch ? (
          'Use the playback controls below to walk through the trace one event at a time.'
        ) : (
          <>
            Press{' '}
            <kbd className="rounded-md border border-edge border-b-2 bg-surface-3 px-1.5 py-0.5 font-mono text-ink shadow-e1">
              Space
            </kbd>{' '}
            to play the trace, or the arrow keys to step through it.
          </>
        )}{' '}
        <button
          type="button"
          onClick={() => { markHintSeen(); setShown(false); requestTour(); }}
          className="font-medium text-ink underline underline-offset-2 transition hover:no-underline"
        >
          Take the 60-second tour
        </button>
      </p>
      <button
        type="button"
        onClick={() => { markHintSeen(); setShown(false); }}
        className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-label text-ink-dim transition hover:border-ink-dim/50 hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}
