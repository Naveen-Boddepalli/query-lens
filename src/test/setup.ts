import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-registers its cleanup when Vitest runs with
// `globals: true`, which this project does not — so without this, the second
// UI test in a file queries a DOM still holding the first one's tree.
afterEach(cleanup);

/**
 * jsdom 30 parses <dialog> but implements none of its methods: `show`,
 * `showModal` and `close` are all undefined. This shim is the smallest thing
 * that mirrors the spec for the parts DataEditor relies on.
 *
 * It deliberately honours `defaultPrevented` on the Escape keydown and fires a
 * cancelable `cancel` first, exactly as the UA's close request does — so a
 * regression that swallows Escape (a global handler, a stray preventDefault)
 * fails the test rather than passing through the shim unnoticed.
 *
 * What it cannot model is the top layer and inertness. Those were checked
 * against real Chrome instead (`:modal` matched, focus landed inside).
 */
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };

  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (!this.open) return;
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new Event('close'));
  };

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
    const topmost = open[open.length - 1];
    if (!topmost) return;
    // `cancel` is cancelable; the dialog closes only if nothing preventDefaults.
    if (topmost.dispatchEvent(new Event('cancel', { cancelable: true }))) topmost.close();
  });
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

