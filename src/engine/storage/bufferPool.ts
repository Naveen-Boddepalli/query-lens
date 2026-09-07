/**
 * The buffer pool: a fixed set of frames standing between the executor and
 * "disk". Every page the engine reads goes through `fetch`, which is the only
 * place a disk read can happen — so the hit/miss numbers in the UI are exactly
 * the ones the engine experienced.
 */

import type { Emit } from '../trace.ts';
import type { EngineOptions, ReplacementPolicyName } from '../types.ts';
import { policyFor } from './policy.ts';
import { evictionPrompt } from '../predict.ts';
import type { BufferState, Frame, ReplacementPolicy } from './policy.ts';

/** Playback pacing weight — a disk read should *feel* slower than a hit. */
export const DISK_READ_DWELL = 2.5;

export interface FetchResult {
  frameId: number;
  hit: boolean;
}

export interface BufferPool {
  fetch: (pageId: number) => FetchResult | null;
  unpin: (frameId: number) => void;
  readonly state: BufferState;
  readonly stats: { hits: number; misses: number; evictions: number };
}

function emptyState(frameCount: number): BufferState {
  return {
    frames: Array.from({ length: frameCount }, (_, frameId) => ({
      frameId,
      pageId: null,
      usageCount: 0,
      pinCount: 0,
      lastUsedAt: -1,
      loadedAt: -1,
    })),
    now: 0,
    hand: 0,
    lookaheadCursor: 0,
  };
}

/** How the `evict` event narrates the choice, per policy. */
function evictionReason(policy: ReplacementPolicyName): string {
  switch (policy) {
    case 'lru':
      return 'LRU picked it because it was used least recently.';
    case 'clock':
      return 'Clock sweep picked it because the hand reached it with a usage count of zero.';
    case 'fifo':
      return 'FIFO picked it because it has been resident longest — first in, first out, however much it was used.';
    case 'second-chance':
      return 'Second-chance picked it: the oldest frame whose reference bit was already clear.';
    case 'optimal':
      return "The optimal policy picked it because its next use is farthest away — the choice no real policy can make, since it needs the future.";
  }
}

/**
 * `pageCount` covers every page in the database — heap pages first, then index
 * pages. The pool manages frames, not contents: what a page *holds* is the
 * caller's business, which is why heap and index pages can share one pool and
 * compete for the same frames.
 */
export function createBufferPool(
  pageCount: number,
  options: EngineOptions,
  emit: Emit,
  /**
   * The full page-reference string, when the caller has one (`runBufferTrace`
   * does; `runQuery` does not — its page accesses emerge from execution). Only
   * the `optimal` policy reads it; every other policy ignores it.
   */
  lookahead?: readonly number[],
): BufferPool {
  const state = emptyState(options.bufferFrames);
  if (lookahead !== undefined) state.lookahead = lookahead;
  const policy: ReplacementPolicy = policyFor(options.policy);
  const stats = { hits: 0, misses: 0, evictions: 0 };
  // Which access `fetch` is resolving, so `optimal` can look past it. Advances
  // once per successful `fetch`, staying aligned with the reference index.
  let accessIndex = -1;
  // Only the first eviction asks. After that the learner has the rule, and a
  // prompt on every one of them would be nagging rather than teaching.
  let evictionAsked = false;

  const resident = (pageId: number): Frame | undefined =>
    state.frames.find((f) => f.pageId === pageId);

  function fetch(pageId: number): FetchResult | null {
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= pageCount) return null;

    accessIndex += 1;
    state.lookaheadCursor = accessIndex;

    const hitFrame = resident(pageId);
    if (hitFrame) {
      stats.hits += 1;
      hitFrame.pinCount += 1;
      policy.onAccess(state, hitFrame.frameId);
      emit(
        `Page ${pageId} is already in frame ${hitFrame.frameId} — a buffer hit. No disk read.`,
        { stage: 'buffer', action: 'hit', pageId, frameId: hitFrame.frameId },
      );
      return { frameId: hitFrame.frameId, hit: true };
    }

    stats.misses += 1;
    emit(`Page ${pageId} is not in the pool — a buffer miss.`, {
      stage: 'buffer',
      action: 'miss',
      pageId,
    });

    let target = state.frames.find((f) => f.pageId === null);

    if (!target) {
      const choice = policy.selectVictim(state, emit);
      if (choice === null) return null; // every frame pinned
      const victimId = choice.frameId;
      const victim = state.frames.find((f) => f.frameId === victimId)!;
      const evicted = victim.pageId!;

      stats.evictions += 1;

      const prompt = evictionAsked
        ? null
        : evictionPrompt(state.frames, victimId, pageId, options.policy);
      evictionAsked = true;

      emit(
        `The pool is full, so page ${evicted} is evicted from frame ${victimId} to make room. ${evictionReason(
          options.policy,
        )}`,
        {
          stage: 'buffer',
          action: 'evict',
          frameId: victimId,
          victimPageId: evicted,
          pageId,
          ...(choice.clockHand === undefined ? {} : { clockHand: choice.clockHand }),
        },
        prompt ? { predictable: prompt } : undefined,
      );

      victim.pageId = null;
      victim.usageCount = 0;
      victim.loadedAt = -1;
      target = victim;
    }

    // Bump the clock on every load, not only in `onAccess` — FIFO and
    // second-chance order frames by `loadedAt`, and FIFO's `onAccess` is a
    // no-op, so nothing else would advance it.
    state.now += 1;
    target.pageId = pageId;
    target.usageCount = 0;
    target.loadedAt = state.now;
    target.pinCount += 1;
    policy.onAccess(state, target.frameId);

    emit(
      `Read page ${pageId} from disk into frame ${target.frameId}. This is the expensive part — everything else is memory.`,
      { stage: 'buffer', action: 'load', pageId, frameId: target.frameId },
      { dwell: DISK_READ_DWELL },
    );

    return { frameId: target.frameId, hit: false };
  }

  function unpin(frameId: number): void {
    const f = state.frames.find((x) => x.frameId === frameId);
    if (f && f.pinCount > 0) f.pinCount -= 1;
  }

  return { fetch, unpin, state, stats };
}
