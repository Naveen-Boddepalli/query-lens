/**
 * The buffer pool: a fixed set of frames standing between the executor and
 * "disk". Every page the engine reads goes through `fetch`, which is the only
 * place a disk read can happen — so the hit/miss numbers in the UI are exactly
 * the ones the engine experienced.
 */

import type { Emit } from '../trace.ts';
import type { EngineOptions } from '../types.ts';
import type { Heap, Page } from './page.ts';
import { pageById } from './page.ts';
import { policyFor } from './policy.ts';
import type { BufferState, Frame, ReplacementPolicy } from './policy.ts';

/** Playback pacing weight — a disk read should *feel* slower than a hit. */
export const DISK_READ_DWELL = 2.5;

export interface FetchResult {
  frameId: number;
  page: Page;
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
    })),
    now: 0,
    hand: 0,
  };
}

export function createBufferPool(
  heap: Heap,
  options: EngineOptions,
  emit: Emit,
): BufferPool {
  const state = emptyState(options.bufferFrames);
  const policy: ReplacementPolicy = policyFor(options.policy);
  const stats = { hits: 0, misses: 0, evictions: 0 };

  const resident = (pageId: number): Frame | undefined =>
    state.frames.find((f) => f.pageId === pageId);

  function fetch(pageId: number): FetchResult | null {
    const page = pageById(heap, pageId);
    if (!page) return null;

    const hitFrame = resident(pageId);
    if (hitFrame) {
      stats.hits += 1;
      hitFrame.pinCount += 1;
      policy.onAccess(state, hitFrame.frameId);
      emit(
        `Page ${pageId} is already in frame ${hitFrame.frameId} — a buffer hit. No disk read.`,
        { stage: 'buffer', action: 'hit', pageId, frameId: hitFrame.frameId },
      );
      return { frameId: hitFrame.frameId, page, hit: true };
    }

    stats.misses += 1;
    emit(`Page ${pageId} is not in the pool — a buffer miss.`, {
      stage: 'buffer',
      action: 'miss',
      pageId,
      frameId: -1,
    });

    let target = state.frames.find((f) => f.pageId === null);

    if (!target) {
      const choice = policy.selectVictim(state, emit);
      if (choice === null) return null; // every frame pinned
      const victimId = choice.frameId;
      const victim = state.frames.find((f) => f.frameId === victimId)!;
      const evicted = victim.pageId!;

      stats.evictions += 1;
      emit(
        `The pool is full, so page ${evicted} is evicted from frame ${victimId} to make room. ${
          options.policy === 'lru'
            ? 'LRU picked it because it was used least recently.'
            : 'Clock sweep picked it because the hand reached it with a usage count of zero.'
        }`,
        {
          stage: 'buffer',
          action: 'evict',
          frameId: victimId,
          victimPageId: evicted,
          pageId,
          ...(choice.clockHand === undefined ? {} : { clockHand: choice.clockHand }),
        },
      );

      victim.pageId = null;
      victim.usageCount = 0;
      target = victim;
    }

    target.pageId = pageId;
    target.usageCount = 0;
    target.pinCount += 1;
    policy.onAccess(state, target.frameId);

    emit(
      `Read page ${pageId} from disk into frame ${target.frameId}. This is the expensive part — everything else is memory.`,
      { stage: 'buffer', action: 'load', pageId, frameId: target.frameId },
      { dwell: DISK_READ_DWELL },
    );

    return { frameId: target.frameId, page, hit: false };
  }

  function unpin(frameId: number): void {
    const f = state.frames.find((x) => x.frameId === frameId);
    if (f && f.pinCount > 0) f.pinCount -= 1;
  }

  return { fetch, unpin, state, stats };
}
