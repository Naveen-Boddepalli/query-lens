/**
 * Cross-component channel for opening the Spotlight search dialog.
 *
 * Matching the pattern used in Tessera: an explicit custom event decoupling
 * the header button and other triggers from the modal's state.
 */

export const OPEN_SPOTLIGHT_EVENT = 'querylens:open-spotlight';

export function openSpotlight(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_SPOTLIGHT_EVENT));
}
