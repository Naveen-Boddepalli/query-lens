/**
 * A buffer pool trace driven by a bare page-reference string, with no SQL, no
 * table and no index — the seam plan.md §20.2 #2 calls for and §21.4's tools
 * catalogue needs.
 *
 * `createBufferPool` (storage/bufferPool.ts) already has no dependency on a
 * heap or an index: it manages frames and takes page ids. `runQuery` is one
 * caller of it; this is another, so the OS-course buffer-pool tool (§20.4) and
 * the LRU/clock comparison view (§13, §21.3) render through the exact same
 * `BufferPoolPanel` and the exact same event-folding (`createTraceProjector`)
 * as the full pipeline — nothing about the panel or the fold is SQL-specific.
 */

import { createTracer } from './trace.ts';
import { createBufferPool } from './storage/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { EngineOptions, StepEvent } from './types.ts';

export interface BufferTraceResult {
  events: StepEvent[];
  /**
   * `accessBoundaries[i]` is the event count immediately after the i-th page
   * reference finishes (a hit is one event; a miss can be several — a load,
   * or an eviction plus, under clock sweep, one `sweep` event per frame the
   * hand passes). Driving playback by *reference index* rather than raw event
   * index is what lets two policies — which emit different numbers of events
   * for the same reference string — be scrubbed by one shared step control
   * (§21.3's comparison view).
   */
  accessBoundaries: number[];
}

/** Same cap the URL layers use elsewhere: a hostile or pasted string should
 *  not be able to hang the tab. Not a security boundary — there is nothing to
 *  inject — just a size limit on user-typed input. */
export const MAX_REFERENCES = 500;

/**
 * Runs a page-reference string through a buffer pool and returns the full
 * event trace. Pure and synchronous, same as `runQuery` (plan.md §5).
 */
export function runBufferTrace(
  referenceString: readonly number[],
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): BufferTraceResult {
  const refs = referenceString.slice(0, MAX_REFERENCES);
  const { emit, drain } = createTracer();
  const pageCount = refs.length === 0 ? 1 : Math.max(...refs) + 1;
  // The whole string is the lookahead the `optimal` policy needs; the other
  // policies are handed it and ignore it.
  const pool = createBufferPool(pageCount, options, emit, refs);

  const accessBoundaries: number[] = [];
  for (const pageId of refs) {
    // `fetch` pins the frame it resolves to, the same as a live operator
    // holding a page while it reads it (locks.test.ts covers that half). A
    // bare reference string has no operator to release it, so the access is
    // modelled as instantaneous: unpin immediately, or every frame is "in use"
    // forever and the second distinct page onward can never find a victim.
    const result = pool.fetch(pageId);
    if (result) pool.unpin(result.frameId);
    accessBoundaries.push(drain().length);
  }

  return { events: drain(), accessBoundaries };
}

/**
 * Parses free-typed input ("1 2 3, 4  5") into page ids, dropping anything
 * that is not a non-negative integer rather than throwing — this is typed
 * input from the one person using the tool, but the parse still has to be
 * total, the same discipline `urlState.ts` applies to a stranger's link.
 */
export function parseReferenceString(input: string): number[] {
  return input
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, MAX_REFERENCES);
}

/** A reference string with real locality — repeats and revisits — rather than
 *  uniform noise, so a generated example actually produces hits, not just misses. */
export function randomReferenceString(length: number, distinctPages: number): number[] {
  const hot = Math.max(1, Math.round(distinctPages * 0.4));
  return Array.from({ length }, () =>
    Math.random() < 0.7
      ? Math.floor(Math.random() * hot)
      : Math.floor(Math.random() * distinctPages),
  );
}
