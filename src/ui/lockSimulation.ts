/**
 * plan.md §22.2 "enforced concurrency" / §22.3 `/tools/locks`: two
 * transactions placing real lock requests against each other, with its own
 * driver — the SQL pipeline (`src/engine/locks/lockManager.ts`) runs exactly
 * one query at a time on purpose, so nothing there ever waits. This is the
 * standalone half: a lock that cannot be granted immediately genuinely
 * *blocks*, a wait-for graph forms from who is blocked on whom, and a cycle
 * in it is a real deadlock, resolved by aborting a victim.
 *
 * Pure and total, like `externalSort.ts` — every function takes a `SimState`
 * and returns a new one (never mutates its argument), so the tool can step
 * forward and back through a sequence of requests exactly the way the SQL
 * trace steps through `StepEvent`s.
 *
 * The compatibility rule is the standard one: any number of `shared` holders
 * may coexist; `exclusive` conflicts with everything, including another
 * `exclusive`. A request that cannot be granted joins the FIFO waiter queue
 * for that resource; a release (or an abort) tries to promote the queue's
 * front, granting consecutive compatible `shared` waiters together but
 * stopping at the first `exclusive` — the standard fairness/throughput
 * trade-off every real lock manager makes the same way.
 *
 * Victim selection (plan.md §22.2 calls this "the interesting half"): the
 * *youngest* transaction in the cycle — the one that made its first request
 * most recently — is aborted. Older transactions, which have more invested,
 * survive; this is the same "wound-wait" intuition real deadlock detectors
 * use, simplified to a single deterministic rule instead of a timestamp
 * comparison against the real clock.
 */

export type LockMode = 'shared' | 'exclusive';

export interface Holder {
  transaction: string;
  mode: LockMode;
}

export interface Waiter {
  transaction: string;
  mode: LockMode;
  /** The transactions currently holding a conflicting lock, as of the request. */
  waitingOn: string[];
}

export interface SimState {
  /** Locks held right now, per resource. */
  holders: Record<number, Holder[]>;
  /** Requests not yet granted, per resource, oldest first. */
  waiters: Record<number, Waiter[]>;
  /** Transactions a deadlock has aborted. An aborted transaction makes no further requests. */
  aborted: string[];
  /** First-seen order, for "youngest" victim selection. */
  startOrder: Record<string, number>;
  nextOrder: number;
}

export function emptyState(): SimState {
  return { holders: {}, waiters: {}, aborted: [], startOrder: {}, nextOrder: 0 };
}

function clone(state: SimState): SimState {
  return structuredClone(state);
}

/** "a shared lock", "an exclusive lock" — the narration reads it out loud often enough to earn this. */
function article(mode: LockMode): 'a' | 'an' {
  return mode === 'exclusive' ? 'an' : 'a';
}

function compatible(existingOthers: Holder[], mode: LockMode): boolean {
  if (existingOthers.length === 0) return true;
  if (mode === 'exclusive') return false;
  return existingOthers.every((h) => h.mode === 'shared');
}

/** Wait-for edges, rebuilt fresh from the current waiters every time — nothing here goes stale. */
function waitForGraph(state: SimState): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const resourceWaiters of Object.values(state.waiters)) {
    for (const w of resourceWaiters) {
      graph.set(w.transaction, [...(graph.get(w.transaction) ?? []), ...w.waitingOn]);
    }
  }
  return graph;
}

/** The first cycle back to `start` reachable by following wait-for edges, if any. */
function findCycle(state: SimState, start: string): string[] | null {
  const graph = waitForGraph(state);
  const visited = new Set<string>([start]);
  const path: string[] = [start];

  function dfs(node: string): string[] | null {
    for (const next of graph.get(node) ?? []) {
      if (next === start) return [...path, next];
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      const found = dfs(next);
      if (found) return found;
      path.pop();
    }
    return null;
  }

  return dfs(start);
}

/** The transaction in `cycle` with the highest start order — the one that arrived most recently. */
function pickVictim(state: SimState, cycle: string[]): string {
  const unique = [...new Set(cycle)];
  return unique.reduce((youngest, t) =>
    (state.startOrder[t] ?? 0) > (state.startOrder[youngest] ?? 0) ? t : youngest,
  );
}

/**
 * Grants the front of `resource`'s waiter queue as far as compatibility
 * allows: any run of consecutive `shared` waiters together, or a single
 * `exclusive` waiter alone — then stops, the same FIFO-with-batching every
 * real lock manager uses.
 */
function promoteWaiters(state: SimState, resource: number): { state: SimState; narration: string[] } {
  const next = clone(state);
  const narration: string[] = [];
  let queue = next.waiters[resource] ?? [];

  for (;;) {
    const front = queue[0];
    if (!front) break;
    const current = next.holders[resource] ?? [];
    if (!compatible(current, front.mode)) break;

    next.holders[resource] = [...current, { transaction: front.transaction, mode: front.mode }];
    narration.push(`${front.transaction} is promoted from waiting to holding ${article(front.mode)} ${front.mode} lock on page ${String(resource)}.`);
    queue = queue.slice(1);

    if (front.mode === 'exclusive') break; // nothing else can share the page with it
  }

  next.waiters[resource] = queue;
  return { state: next, narration };
}

/** Releases every lock `transaction` holds and removes it from every waiter queue — a deadlock victim's fate. */
function abortTransaction(state: SimState, transaction: string): { state: SimState; narration: string[] } {
  let next = clone(state);
  const narration: string[] = [];
  next.aborted = [...next.aborted, transaction];

  for (const key of Object.keys(next.waiters)) {
    const resource = Number(key);
    next.waiters[resource] = (next.waiters[resource] ?? []).filter((w) => w.transaction !== transaction);
  }

  for (const key of Object.keys(next.holders)) {
    const resource = Number(key);
    const held = next.holders[resource] ?? [];
    if (!held.some((h) => h.transaction === transaction)) continue;
    next.holders[resource] = held.filter((h) => h.transaction !== transaction);
    narration.push(`${transaction}'s lock on page ${String(resource)} is released.`);
    const promoted = promoteWaiters(next, resource);
    next = promoted.state;
    narration.push(...promoted.narration);
  }

  return { state: next, narration };
}

export interface RequestOutcome {
  kind: 'already-held' | 'granted' | 'blocked' | 'deadlock' | 'transaction-aborted';
  state: SimState;
  narration: string[];
  /** Set for 'blocked' and 'deadlock': who the request is waiting on. */
  waitingOn?: string[];
  /** Set for 'deadlock': the wait-for cycle, transaction names, first and last the same. */
  cycle?: string[];
  /** Set for 'deadlock': which transaction in the cycle was aborted. */
  victim?: string;
}

/** Places one lock request. Never mutates `state`. */
export function request(state: SimState, transaction: string, resource: number, mode: LockMode): RequestOutcome {
  if (state.aborted.includes(transaction)) {
    return {
      kind: 'transaction-aborted',
      state,
      narration: [`${transaction} was aborted by an earlier deadlock and makes no further requests.`],
    };
  }

  let next = clone(state);
  if (!(transaction in next.startOrder)) {
    next.startOrder[transaction] = next.nextOrder;
    next.nextOrder += 1;
  }

  const existing = next.holders[resource] ?? [];
  const ownHold = existing.find((h) => h.transaction === transaction);
  if (ownHold && (ownHold.mode === mode || ownHold.mode === 'exclusive')) {
    return {
      kind: 'already-held',
      state: next,
      narration: [`${transaction} already holds ${article(ownHold.mode)} ${ownHold.mode} lock on page ${String(resource)} — no change.`],
    };
  }

  const othersHolding = existing.filter((h) => h.transaction !== transaction);
  if (compatible(othersHolding, mode)) {
    next.holders[resource] = [...existing.filter((h) => h.transaction !== transaction), { transaction, mode }];
    return {
      kind: 'granted',
      state: next,
      narration: [`${transaction} is granted ${article(mode)} ${mode} lock on page ${String(resource)}.`],
    };
  }

  const waitingOn = [...new Set(othersHolding.map((h) => h.transaction))];
  const alreadyWaiting = (next.waiters[resource] ?? []).some((w) => w.transaction === transaction);
  if (!alreadyWaiting) {
    next.waiters[resource] = [...(next.waiters[resource] ?? []), { transaction, mode, waitingOn }];
  }

  const narration = [
    `${transaction} requests ${article(mode)} ${mode} lock on page ${String(resource)}, held by ${waitingOn.join(', ')} — it must wait.`,
  ];

  const cycle = findCycle(next, transaction);
  if (!cycle) {
    return { kind: 'blocked', state: next, narration, waitingOn };
  }

  const victim = pickVictim(next, cycle);
  narration.push(
    `Deadlock: ${cycle.join(' → ')} — a cycle in the wait-for graph. ${victim} arrived most recently, so it is the victim and is aborted.`,
  );
  const resolved = abortTransaction(next, victim);
  next = resolved.state;
  narration.push(...resolved.narration);

  return { kind: 'deadlock', state: next, narration, waitingOn, cycle, victim };
}

/** Releases one lock `transaction` holds, promoting waiters where the release makes room. */
export function release(
  state: SimState,
  transaction: string,
  resource: number,
  mode: LockMode,
): { state: SimState; narration: string[] } {
  const held = state.holders[resource] ?? [];
  if (!held.some((h) => h.transaction === transaction && h.mode === mode)) {
    return { state, narration: [`${transaction} does not hold ${article(mode)} ${mode} lock on page ${String(resource)}.`] };
  }

  let next = clone(state);
  next.holders[resource] = held.filter((h) => !(h.transaction === transaction && h.mode === mode));
  const narration = [`${transaction} releases its ${mode} lock on page ${String(resource)}.`];

  const promoted = promoteWaiters(next, resource);
  next = promoted.state;
  narration.push(...promoted.narration);

  return { state: next, narration };
}

/** Every lock `transaction` currently holds, across every resource. */
export function heldBy(state: SimState, transaction: string): { resource: number; mode: LockMode }[] {
  const out: { resource: number; mode: LockMode }[] = [];
  for (const [key, holders] of Object.entries(state.holders)) {
    for (const h of holders) if (h.transaction === transaction) out.push({ resource: Number(key), mode: h.mode });
  }
  return out;
}

/** Every request `transaction` is currently blocked on, across every resource. */
export function waitingBy(state: SimState, transaction: string): { resource: number; mode: LockMode }[] {
  const out: { resource: number; mode: LockMode }[] = [];
  for (const [key, waiters] of Object.entries(state.waiters)) {
    for (const w of waiters) if (w.transaction === transaction) out.push({ resource: Number(key), mode: w.mode });
  }
  return out;
}
