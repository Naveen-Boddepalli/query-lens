/**
 * plan.md §22.2 "enforced concurrency" / §22.3 `/tools/locks`: two transactions placing real lock requests against
 * each other. The lock rules themselves — FIFO waiters, a wait-for graph, deadlock detection, the youngest as victim —
 * graduated into the engine (`engine/locks/lockTable.ts`, plan.md §25.4 D2) so a schedule can enforce them on real
 * statements. What is left here is the sandbox's own vocabulary: its resources are numbered *pages*, and its narration
 * says "page 3".
 */

import {
  emptyTable,
  heldBy as tableHeldBy,
  release as tableRelease,
  request as tableRequest,
  waitingBy as tableWaitingBy,
} from '../engine/locks/lockTable.ts';
import type { Holder, LockMode, LockTableState, RequestOutcome, Waiter } from '../engine/locks/lockTable.ts';

export type { Holder, LockMode, RequestOutcome, Waiter };
export type SimState = LockTableState;

const pageLabel = (resource: string): string => `page ${resource}`;

export function emptyState(): SimState {
  return emptyTable();
}

/** Places one lock request on a numbered page. Never mutates `state`. */
export function request(state: SimState, transaction: string, resource: number, mode: LockMode): RequestOutcome {
  return tableRequest(state, transaction, String(resource), mode, pageLabel);
}

/** Releases one lock `transaction` holds, promoting waiters where the release makes room. */
export function release(
  state: SimState,
  transaction: string,
  resource: number,
  mode: LockMode,
): { state: SimState; narration: string[] } {
  const { state: next, narration } = tableRelease(state, transaction, String(resource), mode, pageLabel);
  return { state: next, narration };
}

/** Every lock `transaction` currently holds, across every page. */
export function heldBy(state: SimState, transaction: string): { resource: number; mode: LockMode }[] {
  return tableHeldBy(state, transaction).map(({ resource, mode }) => ({ resource: Number(resource), mode }));
}

/** Every request `transaction` is currently blocked on, across every page. */
export function waitingBy(state: SimState, transaction: string): { resource: number; mode: LockMode }[] {
  return tableWaitingBy(state, transaction).map(({ resource, mode }) => ({ resource: Number(resource), mode }));
}
