import { act, render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAddressBarQuery } from '../addressBar.ts';

function Page({ query, delay }: { query: string; delay?: number | undefined }) {
  useAddressBarQuery(query, delay);
  return null;
}

const page = (query: string, delay?: number) => (
  <BrowserRouter>
    <Page query={query} delay={delay} />
  </BrowserRouter>
);

const addressBar = () => `${location.pathname}${location.search}${location.hash}`;

/**
 * A nav-link click moves the address bar at once, and the page it leaves runs
 * on until the route change commits. The router hears only its own
 * navigations, so a bare `pushState` is that gap held open: the address bar
 * shows `/tools` while this page is still the one rendered.
 */
const leaveForTools = () => { window.history.pushState(null, '', '/tools'); };

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/tools/btree');
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('useAddressBarQuery', () => {
  it('writes the query 250 ms after it last changed, keeping the hash and the entry’s state', () => {
    window.history.replaceState({ usr: 'kept' }, '', '/tools/btree#tree');
    const { rerender } = render(page('keys=1'));
    const state: unknown = history.state;
    act(() => { vi.advanceTimersByTime(200); });
    rerender(page('keys=1,2'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(addressBar()).toBe('/tools/btree#tree');

    act(() => { vi.advanceTimersByTime(50); });
    expect(addressBar()).toBe('/tools/btree?keys=1,2#tree');
    expect(history.state).toEqual(state);
  });

  it('with no delay, writes as the change commits, and an empty query leaves a bare path', () => {
    const { rerender } = render(page('e=0', 0));
    expect(addressBar()).toBe('/tools/btree?e=0');
    rerender(page('', 0));
    expect(addressBar()).toBe('/tools/btree');
  });

  it('drops a write that falls due once the address bar shows another page', () => {
    render(page('keys=1'));
    leaveForTools();
    act(() => { vi.advanceTimersByTime(250); });
    expect(addressBar()).toBe('/tools');
  });

  it('drops one made at a render in that gap', () => {
    const { rerender } = render(page('', 0));
    leaveForTools();
    rerender(page('e=0', 0));
    expect(addressBar()).toBe('/tools');
  });
});

describe('the address bar', () => {
  it('is written by addressBar.ts alone, so every write passes its check', () => {
    const sources = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!**/__tests__/**'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const writers = Object.entries(sources)
      .filter(([, source]) => /history\.(replaceState|pushState)\(/.test(source))
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(writers).toEqual(['../addressBar.ts']);
  });
});
