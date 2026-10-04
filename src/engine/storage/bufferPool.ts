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
  /**
   * Claims a frame for a page this caller is producing, not reading off disk
   * — a `Sort` operator's spill (plan.md §22.2). Competes for the same frames
   * as every heap/index read, evicting under the same policy when the pool is
   * full. Returns `null` only when every frame is pinned.
   */
  write: (pageId: number) => FetchResult | null;
  /**
   * Marks a resident page as modified — a `DELETE` that removed a row from it
   * (plan.md §22.2, the write path's other half). A clean page's eviction is
   * free: the disk already holds the same bytes. A dirty page's is not — it
   * has to be written back first, which `claimFrame` charges for and narrates
   * the moment the page is actually evicted, not when it was marked.
   */
  markDirty: (pageId: number) => void;
  unpin: (frameId: number) => void;
  readonly state: BufferState;
  readonly stats: { hits: number; misses: number; evictions: number; writes: number };
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
    case 'midpoint':
      return 'Midpoint LRU picked the least-recently-used page in the old sublist — a page read once and never touched again, which is exactly what it is built to evict first.';
    case 'lru-k':
      return 'LRU-2 picked it because its second-most-recent reference is the oldest — a page touched only once has no second reference at all, so it goes first.';
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
  const stats = { hits: 0, misses: 0, evictions: 0, writes: 0 };
  // Which access `fetch` is resolving, so `optimal` can look past it. Advances
  // once per successful `fetch`, staying aligned with the reference index.
  let accessIndex = -1;
  // Only the first eviction asks. After that the learner has the rule, and a
  // prompt on every one of them would be nagging rather than teaching.
  let evictionAsked = false;
  // Pages a DELETE (or a future write) has modified since they were read —
  // resident or not, since a page can be marked dirty and evicted later in
  // the same query. Cleared once the writeback happens.
  const dirty = new Set<number>();

  const resident = (pageId: number): Frame | undefined =>
    state.frames.find((f) => f.pageId === pageId);

  /**
   * A free frame, or the policy's eviction victim — shared between a disk
   * read's miss and a fresh write, since both need "a frame for this page"
   * and both may have to evict for it under the same policy. `incoming` is
   * narration only: what the emitted `evict` event says is displacing the
   * victim.
   */
  function claimFrame(incoming: number, forWrite: boolean): Frame | null {
    const free = state.frames.find((f) => f.pageId === null);
    if (free) return free;

    const choice = policy.selectVictim(state, emit);
    if (choice === null) return null; // every frame pinned
    const victimId = choice.frameId;
    const victim = state.frames.find((f) => f.frameId === victimId)!;
    const evicted = victim.pageId!;

    stats.evictions += 1;

    // A clean page's eviction is free — the disk already holds the same
    // bytes. A dirty one costs a write first, charged and narrated here,
    // at the moment it is actually paid, not when the page was marked.
    const writtenBack = dirty.delete(evicted);
    if (writtenBack) stats.writes += 1;

    // The eviction question is asked once regardless of which path triggers
    // it — a write can just as easily be the first eviction a trace shows.
    const prompt = evictionAsked ? null : evictionPrompt(state.frames, victimId, incoming, options.policy);
    evictionAsked = true;

    emit(
      `The pool is full, so page ${evicted} is evicted from frame ${victimId} to make room ${
        forWrite ? 'for a freshly written page' : ''
      }. ${
        writtenBack
          ? `Page ${evicted} is dirty — a row was deleted from it — so evicting it costs a write back to disk first. `
          : ''
      }${evictionReason(options.policy)}`,
      {
        stage: 'buffer',
        action: 'evict',
        frameId: victimId,
        victimPageId: evicted,
        pageId: incoming,
        ...(choice.clockHand === undefined ? {} : { clockHand: choice.clockHand }),
        ...(writtenBack ? { writtenBack } : {}),
      },
      prompt ? { predictable: prompt } : undefined,
    );

    victim.pageId = null;
    victim.usageCount = 0;
    victim.loadedAt = -1;
    return victim;
  }

  function markDirty(pageId: number): void {
    if (Number.isInteger(pageId) && pageId >= 0 && pageId < pageCount) dirty.add(pageId);
  }

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

    const target = claimFrame(pageId, false);
    if (!target) return null;

    // Bump the clock on every load, not only in `onAccess` — FIFO and
    // second-chance order frames by `loadedAt`, and FIFO's `onAccess` is a
    // no-op, so nothing else would advance it.
    state.now += 1;
    target.pageId = pageId;
    target.usageCount = 0;
    target.loadedAt = state.now;
    target.pinCount += 1;
    // A load is a miss, not a hit: `onLoad` (default `onAccess`) lets a policy
    // treat the two differently — midpoint-LRU inserts at the old sublist.
    (policy.onLoad ?? policy.onAccess)(state, target.frameId);

    emit(
      `Read page ${pageId} from disk into frame ${target.frameId}. This is the expensive part — everything else is memory.`,
      { stage: 'buffer', action: 'load', pageId, frameId: target.frameId },
      { dwell: DISK_READ_DWELL },
    );

    return { frameId: target.frameId, hit: false };
  }

  /**
   * A page a caller is *producing* — a `Sort` run or merge-pass output — not
   * reading off disk. Always a fresh page id (a `Sort` operator never reuses
   * one within a run), so unlike `fetch` there is no hit path: it either
   * takes a free frame or evicts, exactly the way a disk read does, and the
   * two kinds of page genuinely compete for the same pool.
   */
  function write(pageId: number): FetchResult | null {
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= pageCount) return null;

    stats.writes += 1;
    const target = claimFrame(pageId, true);
    if (!target) return null;

    state.now += 1;
    target.pageId = pageId;
    target.usageCount = 0;
    target.loadedAt = state.now;
    target.pinCount += 1;
    (policy.onLoad ?? policy.onAccess)(state, target.frameId);

    emit(`Write page ${pageId} into frame ${target.frameId} — a fresh page, not a disk read.`, {
      stage: 'buffer',
      action: 'write',
      pageId,
      frameId: target.frameId,
    });

    return { frameId: target.frameId, hit: false };
  }

  function unpin(frameId: number): void {
    const f = state.frames.find((x) => x.frameId === frameId);
    if (f && f.pinCount > 0) f.pinCount -= 1;
  }

  return { fetch, write, markDirty, unpin, state, stats };
}
