/**
 * An enforced lock table (plan.md §25.4 D2): transactions place `shared` and `exclusive` requests against named
 * resources, a request that cannot be granted genuinely *waits* in a FIFO queue, the wait-for graph is rebuilt from
 * those queues on every request, and a cycle in it is a real deadlock, resolved by aborting a victim.
 *
 * This is `ui/lockSimulation.ts` graduated into the engine: the same rules, generic over what a resource is. A
 * resource is just a string key and the caller supplies the words for it (`label`), so the locks sandbox can say
 * "page 3" and a schedule can say "row 2 of accounts" from one implementation.
 *
 * Pure and total — every function takes a state and returns a new one, never mutating its argument — so a caller can
 * step forward and back through a sequence of requests, and a schedule is a value.
 *
 * Compatibility is the standard rule: any number of `shared` holders may coexist; `exclusive` conflicts with everything,
 * including another `exclusive`. A request that cannot be granted joins the FIFO waiter queue for that resource; a
 * release (or an abort) promotes the queue's front, granting consecutive compatible `shared` waiters together but
 * stopping at the first `exclusive` — the fairness/throughput trade-off every real lock manager makes the same way.
 *
 * Victim selection: the *youngest* transaction in the cycle — the one that made its first request most recently — is
 * aborted. Older transactions have more invested and survive; one deterministic rule instead of a timestamp comparison.
 */

export type LockMode = 'shared' | 'exclusive';

export interface Holder {
  transaction: string;
  mode: LockMode;
}

export interface Waiter {
  transaction: string;
  mode: LockMode;
  /** The transactions holding a conflicting lock, as of the request. */
  waitingOn: string[];
}

export interface LockTableState {
  /** Locks held right now, per resource. */
  holders: Record<string, Holder[]>;
  /** Requests not yet granted, per resource, oldest first. */
  waiters: Record<string, Waiter[]>;
  /** Transactions a deadlock has aborted. An aborted transaction makes no further requests. */
  aborted: string[];
  /** First-seen order, for "youngest" victim selection. */
  startOrder: Record<string, number>;
  nextOrder: number;
}

/** The words for a resource, so the narration reads "page 3" or "row 2 of accounts" rather than a bare key. */
export type Label = (resource: string) => string;

export function emptyTable(): LockTableState {
  return { holders: {}, waiters: {}, aborted: [], startOrder: {}, nextOrder: 0 };
}

function clone(state: LockTableState): LockTableState {
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
function waitForGraph(state: LockTableState): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const resourceWaiters of Object.values(state.waiters)) {
    for (const w of resourceWaiters) {
      graph.set(w.transaction, [...(graph.get(w.transaction) ?? []), ...w.waitingOn]);
    }
  }
  return graph;
}

/** The first cycle back to `start` reachable by following wait-for edges, if any. */
function findCycle(state: LockTableState, start: string): string[] | null {
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
function pickVictim(state: LockTableState, cycle: string[]): string {
  const unique = [...new Set(cycle)];
  return unique.reduce((youngest, t) =>
    (state.startOrder[t] ?? 0) > (state.startOrder[youngest] ?? 0) ? t : youngest,
  );
}

/**
 * Grants the front of `resource`'s waiter queue as far as compatibility allows: any run of consecutive `shared`
 * waiters together, or a single `exclusive` waiter alone — then stops, the same FIFO-with-batching every real lock
 * manager uses.
 */
function promoteWaiters(
  state: LockTableState,
  resource: string,
  label: Label,
): { state: LockTableState; narration: string[]; promoted: string[] } {
  const next = clone(state);
  const narration: string[] = [];
  const promoted: string[] = [];
  let queue = next.waiters[resource] ?? [];

  for (;;) {
    const front = queue[0];
    if (!front) break;
    // A waiter that already holds a shared lock is upgrading: its own lock is not a conflict, and the exclusive one it
    // is promoted to replaces it rather than sitting beside it.
    const others = (next.holders[resource] ?? []).filter((h) => h.transaction !== front.transaction);
    if (!compatible(others, front.mode)) break;

    next.holders[resource] = [...others, { transaction: front.transaction, mode: front.mode }];
    narration.push(
      `${front.transaction} is promoted from waiting to holding ${article(front.mode)} ${front.mode} lock on ${label(resource)}.`,
    );
    promoted.push(front.transaction);
    queue = queue.slice(1);

    if (front.mode === 'exclusive') break; // nothing else can share the resource with it
  }

  next.waiters[resource] = queue;
  return { state: next, narration, promoted };
}

export interface ReleaseAllOutcome {
  state: LockTableState;
  narration: string[];
  /** Every transaction a release promoted from waiting to holding, in the order it happened. */
  promoted: string[];
}

/**
 * Releases every lock `transaction` holds and removes it from every waiter queue. A commit or rollback ends a
 * transaction this way; a deadlock victim's abort does too, with `abort` set so it is recorded as aborted and makes
 * no further requests.
 */
export function releaseAll(
  state: LockTableState,
  transaction: string,
  label: Label,
  abort = false,
): ReleaseAllOutcome {
  let next = clone(state);
  const narration: string[] = [];
  const promoted: string[] = [];
  if (abort) next.aborted = [...next.aborted, transaction];

  for (const key of Object.keys(next.waiters)) {
    next.waiters[key] = (next.waiters[key] ?? []).filter((w) => w.transaction !== transaction);
  }

  for (const key of Object.keys(next.holders)) {
    const held = next.holders[key] ?? [];
    if (!held.some((h) => h.transaction === transaction)) continue;
    next.holders[key] = held.filter((h) => h.transaction !== transaction);
    narration.push(`${transaction}'s lock on ${label(key)} is released.`);
    const result = promoteWaiters(next, key, label);
    next = result.state;
    narration.push(...result.narration);
    promoted.push(...result.promoted);
  }

  return { state: next, narration, promoted };
}

export interface RequestOutcome {
  kind: 'already-held' | 'granted' | 'blocked' | 'deadlock' | 'transaction-aborted';
  state: LockTableState;
  narration: string[];
  /** Set for 'blocked' and 'deadlock': who the request is waiting on. */
  waitingOn?: string[];
  /** Set for 'deadlock': the wait-for cycle, transaction names, first and last the same. */
  cycle?: string[];
  /** Set for 'deadlock': which transaction in the cycle was aborted. */
  victim?: string;
  /** Set for 'deadlock': every transaction the victim's abort promoted from waiting to holding. */
  promoted?: string[];
}

/** Places one lock request. Never mutates `state`. */
export function request(
  state: LockTableState,
  transaction: string,
  resource: string,
  mode: LockMode,
  label: Label,
): RequestOutcome {
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
      narration: [
        `${transaction} already holds ${article(ownHold.mode)} ${ownHold.mode} lock on ${label(resource)} — no change.`,
      ],
    };
  }

  const othersHolding = existing.filter((h) => h.transaction !== transaction);
  if (compatible(othersHolding, mode)) {
    next.holders[resource] = [...existing.filter((h) => h.transaction !== transaction), { transaction, mode }];
    return {
      kind: 'granted',
      state: next,
      narration: [`${transaction} is granted ${article(mode)} ${mode} lock on ${label(resource)}.`],
    };
  }

  const waitingOn = [...new Set(othersHolding.map((h) => h.transaction))];
  const alreadyWaiting = (next.waiters[resource] ?? []).some((w) => w.transaction === transaction);
  if (!alreadyWaiting) {
    next.waiters[resource] = [...(next.waiters[resource] ?? []), { transaction, mode, waitingOn }];
  }

  const narration = [
    `${transaction} requests ${article(mode)} ${mode} lock on ${label(resource)}, held by ${waitingOn.join(', ')} — it must wait.`,
  ];

  const cycle = findCycle(next, transaction);
  if (!cycle) {
    return { kind: 'blocked', state: next, narration, waitingOn };
  }

  const victim = pickVictim(next, cycle);
  narration.push(
    `Deadlock: ${cycle.join(' → ')} — a cycle in the wait-for graph. ${victim} arrived most recently, so it is the victim and is aborted.`,
  );
  const resolved = releaseAll(next, victim, label, true);
  next = resolved.state;
  narration.push(...resolved.narration);

  return { kind: 'deadlock', state: next, narration, waitingOn, cycle, victim, promoted: resolved.promoted };
}

/** Releases one lock `transaction` holds, promoting waiters where the release makes room. */
export function release(
  state: LockTableState,
  transaction: string,
  resource: string,
  mode: LockMode,
  label: Label,
): { state: LockTableState; narration: string[]; promoted: string[] } {
  const held = state.holders[resource] ?? [];
  if (!held.some((h) => h.transaction === transaction && h.mode === mode)) {
    return {
      state,
      narration: [`${transaction} does not hold ${article(mode)} ${mode} lock on ${label(resource)}.`],
      promoted: [],
    };
  }

  let next = clone(state);
  next.holders[resource] = held.filter((h) => !(h.transaction === transaction && h.mode === mode));
  const narration = [`${transaction} releases its ${mode} lock on ${label(resource)}.`];

  const result = promoteWaiters(next, resource, label);
  next = result.state;
  narration.push(...result.narration);

  return { state: next, narration, promoted: result.promoted };
}

/**
 * Forgets that `transaction` was aborted or ever requested anything, so the same session can begin a new one. A
 * deadlock victim's name is not reusable in the sandbox (it simply stops); a schedule's *session* is not a
 * transaction, and goes on to run its next statement as a fresh, and therefore youngest, transaction.
 */
export function forget(state: LockTableState, transaction: string): LockTableState {
  const next = clone(state);
  next.aborted = next.aborted.filter((t) => t !== transaction);
  delete next.startOrder[transaction];
  return next;
}

/** Every lock `transaction` currently holds, across every resource. */
export function heldBy(state: LockTableState, transaction: string): { resource: string; mode: LockMode }[] {
  const out: { resource: string; mode: LockMode }[] = [];
  for (const [resource, holders] of Object.entries(state.holders)) {
    for (const h of holders) if (h.transaction === transaction) out.push({ resource, mode: h.mode });
  }
  return out;
}

/** Every request `transaction` is currently blocked on, across every resource. */
export function waitingBy(state: LockTableState, transaction: string): { resource: string; mode: LockMode }[] {
  const out: { resource: string; mode: LockMode }[] = [];
  for (const [resource, waiters] of Object.entries(state.waiters)) {
    for (const w of waiters) if (w.transaction === transaction) out.push({ resource, mode: w.mode });
  }
  return out;
}

/** Does `transaction` hold a lock on `resource` at least as strong as `mode`? */
export function holds(state: LockTableState, transaction: string, resource: string, mode: LockMode): boolean {
  const own = (state.holders[resource] ?? []).find((h) => h.transaction === transaction);
  return own !== undefined && (own.mode === 'exclusive' || own.mode === mode);
}
