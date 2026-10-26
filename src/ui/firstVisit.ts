/**
 * Whether this browser has already seen the Playground's first-visit hint
 * (plan.md §19.2). Same convenience-not-state discipline as
 * `challengeProgress.ts`: a blocked or private store degrades to "treat it as a
 * first visit", and the hint's own on-mount write then simply does not stick —
 * a returning visitor in a locked-down browser sees the one line again, which
 * is a far smaller failure than throwing on load.
 */

const KEY = 'querylens:seen-hint';

export function hasSeenHint(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markHintSeen(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Private window or blocked site data: the hint shows again next time,
    // which is acceptable. Nothing else depends on this.
  }
}

/**
 * The first-visit hint (in `Layout`) and the tour (in `PlaygroundPage`) sit in
 * different parts of the tree, so "take the tour" is a signal, not a prop. The
 * window event covers the common case — the Playground chunk is already
 * mounted and listening; the one-shot `sessionStorage` flag covers the cold
 * one, where the hint rendered before the Playground and the event had no
 * listener yet. `listenForTour` is the one place either is answered.
 */
const START_TOUR_EVENT = 'querylens:start-tour';
const PENDING_TOUR_KEY = 'querylens:pending-tour';

export function requestTour(): void {
  try {
    sessionStorage.setItem(PENDING_TOUR_KEY, '1');
  } catch {
    // The live event below still fires; only the cold-start path is lost.
  }
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

/** Whether a request is waiting, without answering it — safe to call during a render, which may be thrown away. */
export function hasPendingTour(): boolean {
  try {
    return sessionStorage.getItem(PENDING_TOUR_KEY) === '1';
  } catch {
    return false;
  }
}

function takePendingTour(): boolean {
  try {
    const pending = sessionStorage.getItem(PENDING_TOUR_KEY) === '1';
    if (pending) sessionStorage.removeItem(PENDING_TOUR_KEY);
    return pending;
  } catch {
    return false;
  }
}

/**
 * Calls `open` for every "take the tour" request from now on, and once now if one was made before anything was
 * listening. Returns the function that stops listening.
 *
 * The order is the point. The Playground used to take the flag while it *rendered* and attach the listener in an
 * effect, after the commit; a click in between found no listener, and the flag it set had already been read — the
 * tour never opened, and the flag was left to open it by surprise on a later visit. Listening first and taking the
 * flag second leaves no moment a click can reach neither. A request answered live takes its own flag too, so it is
 * answered exactly once.
 */
export function listenForTour(open: () => void): () => void {
  const onRequest = () => {
    takePendingTour();
    open();
  };
  window.addEventListener(START_TOUR_EVENT, onRequest);
  if (takePendingTour()) open();
  return () => {
    window.removeEventListener(START_TOUR_EVENT, onRequest);
  };
}
