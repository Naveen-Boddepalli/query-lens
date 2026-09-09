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
