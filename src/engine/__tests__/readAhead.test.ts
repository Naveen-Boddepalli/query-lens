import { describe, expect, it } from 'vitest';
import { runBufferTrace } from '../bufferTrace.ts';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { StepEvent } from '../types.ts';

const pages = 10;
const scan = Array.from({ length: pages }, (_, i) => i);

function bufferEvents(refs: readonly number[], readAhead: number | undefined): StepEvent[] {
  const options = {
    ...DEFAULT_ENGINE_OPTIONS,
    policy: 'lru' as const,
    bufferFrames: 8,
    ...(readAhead === undefined ? {} : { readAhead }),
  };
  return runBufferTrace(refs, options).events.filter((e) => e.stage === 'buffer');
}

const count = (events: StepEvent[], action: string) =>
  events.filter((e) => e.stage === 'buffer' && e.action === action).length;

describe('sequential read-ahead (plan.md §25.4 F7, decided 2026-10-05)', () => {
  it('reads each page from disk exactly once, and every request after the first two is a hit', () => {
    const events = bufferEvents(scan, 2);
    // Pages 0 and 1 are demanded cold; from page 1 onward the scan is sequential, so pages 2..9 are read early.
    expect(count(events, 'miss')).toBe(2);
    expect(count(events, 'prefetch')).toBe(8);
    expect(count(events, 'load')).toBe(2);
    expect(count(events, 'hit')).toBe(8);
    expect(count(events, 'load') + count(events, 'prefetch')).toBe(pages);
  });

  it('a prefetched page is a prefetch first, and a hit when the scan asks for it', () => {
    const events = bufferEvents(scan, 2);
    for (let p = 2; p < pages; p++) {
      const prefetchAt = events.findIndex((e) => e.stage === 'buffer' && e.action === 'prefetch' && e.pageId === p);
      const hitAt = events.findIndex((e) => e.stage === 'buffer' && e.action === 'hit' && e.pageId === p);
      expect(prefetchAt).toBeGreaterThanOrEqual(0);
      expect(hitAt).toBeGreaterThan(prefetchAt);
    }
  });

  it('without read-ahead, a scan misses every page, as before', () => {
    const events = bufferEvents(scan, undefined);
    expect(count(events, 'prefetch')).toBe(0);
    expect(count(events, 'miss')).toBe(pages);
    expect(count(events, 'hit')).toBe(0);
  });

  it('a non-sequential access pattern prefetches nothing', () => {
    const events = bufferEvents([5, 1, 7, 3, 9, 0, 4], 2);
    expect(count(events, 'prefetch')).toBe(0);
  });

  it('never reads past the last page', () => {
    const events = bufferEvents(scan, 4);
    const prefetched = events.flatMap((e) => (e.stage === 'buffer' && e.action === 'prefetch' ? [e.pageId] : []));
    expect(Math.max(...prefetched)).toBe(pages - 1);
    expect(new Set(prefetched).size).toBe(prefetched.length);
  });

  it('a query reads ahead inside the heap and no further: it never prefetches an index page', () => {
    const db = createSeedDatabase();
    const heapPages = Math.ceil(db.tables.users!.rows.length / DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    // Under `optimal` too, whose rehearsed future (plan.md §26 Feature 2) is a record of demand reads, not a page space.
    for (const [policy, readAhead] of (['lru', 'optimal'] as const).flatMap((p) => [1, 2, 4].map((n) => [p, n] as const))) {
      const result = runQuery('SELECT * FROM users', db, { ...DEFAULT_ENGINE_OPTIONS, policy, readAhead });
      const touched = result.events.flatMap((e) =>
        e.stage === 'buffer' && (e.action === 'load' || e.action === 'prefetch') ? [e.pageId] : [],
      );
      // Each of the heap's pages is read once, as a request or as a prefetch, and nothing else is.
      expect(touched.sort((a, b) => a - b)).toEqual(Array.from({ length: heapPages }, (_, i) => i));
    }
  });

  it('a query that is not a sequential scan reads nothing ahead, even where its pages come in order', () => {
    // A range through the index visits consecutive heap pages, one request after another: sequential in page numbers,
    // not a scan of the heap, and not something the pool may read ahead through (the pages after the last are the
    // index's).
    for (const [sql, policy] of ['SELECT * FROM users WHERE id = 5', 'SELECT * FROM users WHERE id BETWEEN 3 AND 9'].flatMap((q) => (['lru', 'optimal'] as const).map((p) => [q, p] as const))) {
      const result = runQuery(sql, createSeedDatabase(), { ...DEFAULT_ENGINE_OPTIONS, policy, readAhead: 4 });
      expect(result.error).toBeUndefined();
      expect(result.events.some((e) => e.stage === 'buffer' && e.action === 'prefetch')).toBe(false);
    }
  });

  it('a query that reads ahead reports its prefetches as disk reads, in the result it narrates', () => {
    const result = runQuery('SELECT * FROM users', createSeedDatabase(), {
      ...DEFAULT_ENGINE_OPTIONS,
      readAhead: 2,
    });
    const reads = result.events.filter((e) => e.stage === 'buffer' && (e.action === 'load' || e.action === 'prefetch'));
    const prefetches = reads.filter((e) => e.stage === 'buffer' && e.action === 'prefetch');
    const final = result.events.find((e) => e.stage === 'result');
    expect(prefetches.length).toBeGreaterThan(0);
    // The sentence counts every page the query read, those it asked for and those read ahead of it.
    expect(final?.label).toContain(`from ${String(reads.length)} disk reads`);
  });
});
