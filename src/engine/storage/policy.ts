/**
 * Buffer replacement, behind one interface, with two implementations.
 *
 * This exists because **textbook LRU is not what real databases do**, and
 * plan.md §2 makes honesty about ground truth a top-line goal. Postgres avoids
 * an LRU list precisely because maintaining one needs a lock on every page
 * access; it uses clock sweep instead. InnoDB uses LRU but inserts at a
 * midpoint so a big scan cannot flush the hot set. Teaching "eviction = LRU"
 * would plant exactly the misconception §12 warns about.
 */

import type { Emit } from '../trace.ts';
import type { ReplacementPolicyName } from '../types.ts';

export interface Frame {
  frameId: number;
  pageId: number | null;
  /** Clock-sweep counter, capped at USAGE_COUNT_CAP. */
  usageCount: number;
  /** Postgres's `refcount`: a pinned page must not be evicted. */
  pinCount: number;
  /** Logical time of last access, for LRU. */
  lastUsedAt: number;
}

export interface BufferState {
  frames: Frame[];
  /** Monotonic logical clock for LRU ordering. */
  now: number;
  /** Clock-sweep hand position. */
  hand: number;
}

/** Postgres caps `usage_count` at 5. Same here. */
export const USAGE_COUNT_CAP = 5;

export interface Victim {
  frameId: number;
  /**
   * Hand position after the search. Reported rather than inferred: the hand
   * also advances past pinned frames and past the victim itself, and those
   * moves emit no event of their own, so the UI could not reconstruct it.
   */
  clockHand?: number;
}

export interface ReplacementPolicy {
  name: ReplacementPolicyName;
  /** Record that a resident frame was just used. */
  onAccess: (state: BufferState, frameId: number) => void;
  /**
   * Choose a frame to evict. May emit its own reasoning steps — the clock
   * sweep's decrement walk is the interesting part, so it is not hidden.
   * Returns null when every frame is pinned.
   */
  selectVictim: (state: BufferState, emit: Emit) => Victim | null;
}

function frame(state: BufferState, frameId: number): Frame | undefined {
  return state.frames.find((f) => f.frameId === frameId);
}

/* -------------------------------------------------------------------------- */

const lru: ReplacementPolicy = {
  name: 'lru',
  onAccess(state, frameId) {
    const f = frame(state, frameId);
    if (!f) return;
    state.now += 1;
    f.lastUsedAt = state.now;
    f.usageCount = Math.min(f.usageCount + 1, USAGE_COUNT_CAP);
  },
  selectVictim(state) {
    let victim: Frame | undefined;
    for (const f of state.frames) {
      if (f.pinCount > 0) continue;
      if (!victim || f.lastUsedAt < victim.lastUsedAt) victim = f;
    }
    return victim ? { frameId: victim.frameId } : null;
  },
};

/**
 * Postgres's clock sweep. The hand walks the frames in a circle; each pass
 * decrements `usage_count`, and the first frame found with
 * `refcount == 0 && usage_count == 0` is the victim. Frequently used pages
 * survive several passes without any list to maintain — which is the whole
 * point, since maintaining one would need a lock on every access.
 */
const clock: ReplacementPolicy = {
  name: 'clock',
  onAccess(state, frameId) {
    const f = frame(state, frameId);
    if (!f) return;
    state.now += 1;
    f.lastUsedAt = state.now;
    f.usageCount = Math.min(f.usageCount + 1, USAGE_COUNT_CAP);
  },
  selectVictim(state, emit) {
    const n = state.frames.length;
    if (n === 0) return null;
    if (state.frames.every((f) => f.pinCount > 0)) return null;

    // Bounded by construction: every full pass strictly decreases the total
    // usage count of unpinned frames, and at least one is unpinned.
    const maxSteps = n * (USAGE_COUNT_CAP + 1) + n;

    for (let step = 0; step < maxSteps; step++) {
      const f = state.frames[state.hand]!;
      const at = state.hand;
      state.hand = (state.hand + 1) % n;

      if (f.pinCount > 0) continue;

      if (f.usageCount === 0) return { frameId: f.frameId, clockHand: state.hand };

      f.usageCount -= 1;
      emit(
        `Clock sweep: frame ${at} was used recently, so it gets a second chance — usage count drops to ${f.usageCount} and the hand moves on.`,
        { stage: 'buffer', action: 'sweep', frameId: at, usageCountAfter: f.usageCount, clockHand: state.hand },
      );
    }

    return null;
  },
};

const POLICIES: Record<ReplacementPolicyName, ReplacementPolicy> = { lru, clock };

export function policyFor(name: ReplacementPolicyName): ReplacementPolicy {
  return POLICIES[name];
}
