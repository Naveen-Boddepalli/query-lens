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
  /** Clock-sweep counter, capped at USAGE_COUNT_CAP. Also the reference bit
   *  second-chance reads (any non-zero value means "used since loaded"). */
  usageCount: number;
  /** Postgres's `refcount`: a pinned page must not be evicted. */
  pinCount: number;
  /** Logical time of last access, for LRU. */
  lastUsedAt: number;
  /** Logical time the frame last received a page, for FIFO and second-chance.
   *  Stamped by `createBufferPool` on load; -1 while the frame is empty. */
  loadedAt: number;
}

export interface BufferState {
  frames: Frame[];
  /** Monotonic logical clock for LRU ordering (and FIFO load ordering). */
  now: number;
  /** Clock-sweep hand position. */
  hand: number;
  /**
   * The whole reference string, for the `optimal` (Bélády) policy — it decides
   * purely from what comes next. Set by `runBufferTrace`; absent on the SQL
   * path, where `optimal` then behaves as FIFO. `readonly number[]` stays
   * structurally cloneable, so `BufferState` remains worker-ready (types.ts).
   */
  lookahead?: readonly number[];
  /** Index into `lookahead` of the access currently being resolved. */
  lookaheadCursor: number;
  /**
   * LRU-K's reference history, keyed by page: the last K logical times each page was touched. Keyed by page rather
   * than frame, because LRU-K remembers a page's history across the times it is evicted and read back in. Created on
   * first use, so pools that never run LRU-K carry nothing extra.
   */
  history?: Record<number, number[]>;
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
   * Record that a page was just *loaded* into a frame (a miss, not a hit).
   * Defaults to `onAccess`, which is right for every policy but midpoint-LRU:
   * InnoDB inserts a freshly read page at the head of the *old* sublist, not
   * the young one, so a one-pass scan cannot flush the hot set.
   */
  onLoad?: (state: BufferState, frameId: number) => void;
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

/* -------------------------------------------------------------------------- */

/**
 * FIFO: evict whichever page has been resident longest, no matter how heavily
 * it has been used since. The textbook baseline clock sweep improves on — and
 * the one that shows Bélády's anomaly, where *adding* frames can add misses.
 */
const fifo: ReplacementPolicy = {
  name: 'fifo',
  onAccess() {
    // A page's age under FIFO is when it was loaded, not when it was touched.
  },
  selectVictim(state) {
    let victim: Frame | undefined;
    for (const f of state.frames) {
      if (f.pinCount > 0) continue;
      if (!victim || f.loadedAt < victim.loadedAt) victim = f;
    }
    return victim ? { frameId: victim.frameId } : null;
  },
};

/**
 * Second-chance: FIFO with a reference bit. Walk the queue oldest-first; a
 * frame whose bit is set is forgiven once — the bit clears and it goes to the
 * back — so the first frame reached with a clear bit is the victim. This is
 * clock sweep's ancestor: the same idea before the circular hand and the
 * multi-bit counter. The forgiveness passes emit `sweep` events, the same kind
 * clock uses, so the panel animates them identically.
 */
const secondChance: ReplacementPolicy = {
  name: 'second-chance',
  onAccess(state, frameId) {
    const f = frame(state, frameId);
    if (!f) return;
    state.now += 1;
    f.lastUsedAt = state.now;
    f.usageCount = Math.min(f.usageCount + 1, USAGE_COUNT_CAP);
  },
  selectVictim(state, emit) {
    if (state.frames.every((f) => f.pinCount > 0)) return null;

    // Every forgiveness clears one bit and cannot recur for that frame in the
    // same call, so a clear bit is reached within one pass over the unpinned
    // frames. The bound doubles that for headroom, matching `clock` above.
    const unpinned = state.frames.filter((f) => f.pinCount === 0).length;
    const maxSteps = unpinned * 2 + 1;

    for (let step = 0; step < maxSteps; step++) {
      let oldest: Frame | undefined;
      for (const f of state.frames) {
        if (f.pinCount > 0) continue;
        if (!oldest || f.loadedAt < oldest.loadedAt) oldest = f;
      }
      if (!oldest) return null;
      if (oldest.usageCount === 0) return { frameId: oldest.frameId };

      oldest.usageCount = 0;
      state.now += 1;
      oldest.loadedAt = state.now; // to the back of the queue
      emit(
        `Second chance: frame ${oldest.frameId} was used since it loaded, so it survives this pass — its reference bit clears and it moves to the back of the queue.`,
        {
          stage: 'buffer',
          action: 'sweep',
          frameId: oldest.frameId,
          usageCountAfter: 0,
          clockHand: state.hand,
        },
      );
    }
    return null;
  },
};

/**
 * Bélády's MIN / OPT: evict the resident page whose next use is farthest in
 * the future (a page never used again wins outright). It cannot be implemented
 * for real — nothing knows the future — but it is the optimal bound every
 * other policy is measured against, and seeing it makes "how good is LRU here?"
 * concrete. With no `lookahead` on the state it degrades to FIFO.
 */
function nextUseDistance(
  future: readonly number[] | undefined,
  cursor: number,
  pageId: number,
): number {
  if (!future) return Number.POSITIVE_INFINITY;
  for (let k = cursor + 1; k < future.length; k++) {
    if (future[k] === pageId) return k;
  }
  return Number.POSITIVE_INFINITY;
}

const optimal: ReplacementPolicy = {
  name: 'optimal',
  onAccess() {
    // MIN needs no per-access bookkeeping — the whole decision is the future.
  },
  selectVictim(state) {
    let victim: Frame | undefined;
    let victimNextUse = -1;
    for (const f of state.frames) {
      if (f.pinCount > 0 || f.pageId === null) continue;
      const nextUse = nextUseDistance(state.lookahead, state.lookaheadCursor, f.pageId);
      // Farthest next use wins; on a tie (typically two pages never used
      // again) evict the one loaded earliest, which makes the no-lookahead
      // fallback exactly FIFO.
      if (
        nextUse > victimNextUse ||
        (nextUse === victimNextUse && victim !== undefined && f.loadedAt < victim.loadedAt)
      ) {
        victim = f;
        victimNextUse = nextUse;
      }
    }
    return victim ? { frameId: victim.frameId } : null;
  },
};

/**
 * InnoDB's midpoint-insertion LRU. The buffer pool's LRU list is split into a
 * *young* (hot) sublist and an *old* sublist; a page read from disk lands at
 * the head of the *old* sublist, and only reaches the young sublist if it is
 * touched again. A sequential scan touches each page once, so its pages ride
 * through the old sublist and evict one another without ever displacing the
 * hot set — the flaw in plain LRU that this exists to fix (plan.md §7.5).
 *
 * Modelled without InnoDB's `innodb_old_blocks_time` delay: `usageCount` is a
 * 1-bit "which sublist" flag — 0 = old, 1 = young — and one re-access promotes.
 * Eviction takes the least-recently-used frame in the old sublist, falling
 * back to the overall LRU frame only when every unpinned frame is young.
 */
const midpoint: ReplacementPolicy = {
  onLoad(state, frameId) {
    const f = frame(state, frameId);
    if (!f) return;
    state.now += 1;
    f.lastUsedAt = state.now; // recency, but it stays in the old sublist
  },
  name: 'midpoint',
  onAccess(state, frameId) {
    const f = frame(state, frameId);
    if (!f) return;
    state.now += 1;
    f.lastUsedAt = state.now;
    f.usageCount = 1; // a re-access promotes it to the young sublist
  },
  selectVictim(state) {
    let old: Frame | undefined;
    let overall: Frame | undefined;
    for (const f of state.frames) {
      if (f.pinCount > 0) continue;
      if (!overall || f.lastUsedAt < overall.lastUsedAt) overall = f;
      if (f.usageCount === 0 && (!old || f.lastUsedAt < old.lastUsedAt)) old = f;
    }
    const victim = old ?? overall;
    return victim ? { frameId: victim.frameId } : null;
  },
};

/**
 * LRU-K with K = 2 (O'Neil, O'Neil and Weikum, 1993). Plain LRU evicts whatever was touched least recently, so a
 * single sequential scan can push out the pages that were genuinely hot. LRU-K evicts by the time of a page's K-th
 * most recent reference instead. A page referenced only once has no K-th reference at all, so it is the first to go,
 * and a page that has been touched twice survives a one-pass scan. That is the scan resistance this policy exists for.
 */
const LRU_K = 2;

const lruK: ReplacementPolicy = {
  name: 'lru-k',
  onAccess(state, frameId) {
    const f = frame(state, frameId);
    if (!f) return;
    state.now += 1;
    f.lastUsedAt = state.now;
    f.usageCount = Math.min(f.usageCount + 1, USAGE_COUNT_CAP);
    if (f.pageId === null) return;
    const history = (state.history ??= {});
    const times = [...(history[f.pageId] ?? []), state.now].slice(-LRU_K);
    history[f.pageId] = times;
  },
  selectVictim(state) {
    let victim: Frame | undefined;
    let victimKth = Number.POSITIVE_INFINITY;
    for (const f of state.frames) {
      if (f.pinCount > 0) continue;
      const times = f.pageId === null ? [] : (state.history?.[f.pageId] ?? []);
      // A page with fewer than K references has no K-th reference: treat it as older than anything, so it goes first.
      const kth = times.length >= LRU_K ? times[0]! : Number.NEGATIVE_INFINITY;
      if (
        !victim ||
        kth < victimKth ||
        (kth === victimKth && f.lastUsedAt < victim.lastUsedAt)
      ) {
        victim = f;
        victimKth = kth;
      }
    }
    return victim ? { frameId: victim.frameId } : null;
  },
};

const POLICIES: Record<ReplacementPolicyName, ReplacementPolicy> = {
  lru,
  clock,
  fifo,
  'second-chance': secondChance,
  optimal,
  midpoint,
  'lru-k': lruK,
};

export function policyFor(name: ReplacementPolicyName): ReplacementPolicy {
  return POLICIES[name];
}

/** Display order for policy pickers. */
export const REPLACEMENT_POLICY_NAMES = [
  'lru',
  'clock',
  'fifo',
  'second-chance',
  'optimal',
  'midpoint',
  'lru-k',
] as const satisfies readonly ReplacementPolicyName[];

/** Short label for each policy, for `<select>`s and column headers. */
export const REPLACEMENT_POLICY_LABELS: Record<ReplacementPolicyName, string> = {
  lru: 'LRU',
  clock: 'Clock sweep',
  fifo: 'FIFO',
  'second-chance': 'Second-chance',
  optimal: 'Optimal (Bélády)',
  midpoint: 'Midpoint LRU (InnoDB)',
  'lru-k': 'LRU-2 (scan-resistant)',
};
