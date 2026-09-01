/**
 * Drives page access for the chosen scan, so the buffer pool can be watched
 * doing its job before the executor exists.
 *
 * M5 replaces this with real Volcano iterators that also emit `execute` and
 * `result` events. Until then this emits *only* buffer events: it reports the
 * pages the scan reads, and claims nothing about rows.
 */

import type { Emit } from '../trace.ts';
import type { EngineOptions } from '../types.ts';
import type { Plan } from '../planner/index.ts';
import { createBufferPool } from './bufferPool.ts';
import type { BufferPool } from './bufferPool.ts';
import type { Heap } from './page.ts';

/** The access-method node at the base of a plan. */
export function findScan(plan: Plan): Plan | undefined {
  if (plan.op === 'SeqScan' || plan.op === 'IndexScan') return plan;
  if (plan.op === 'Filter' || plan.op === 'Project') return findScan(plan.child);
  return undefined;
}

export interface ScanOutcome {
  pool: BufferPool;
  /** False when the plan's access method is not built yet. */
  ran: boolean;
}

export function emitScanEvents(
  emit: Emit,
  plan: Plan,
  heap: Heap,
  options: EngineOptions,
): ScanOutcome {
  const pool = createBufferPool(heap, options, emit);
  const scan = findScan(plan);

  // An IndexScan needs the B+Tree, which arrives in M4. Reading every page
  // here and calling it an index scan would be a lie the whole product exists
  // to avoid.
  if (!scan || scan.op !== 'SeqScan') return { pool, ran: false };

  for (const page of heap.pages) {
    const fetched = pool.fetch(page.pageId);
    if (!fetched) break;
    // The page is pinned while its rows are read, then released. Only an
    // unpinned frame can be evicted — that is the `refcount == 0` half of the
    // clock-sweep rule.
    pool.unpin(fetched.frameId);
  }

  return { pool, ran: true };
}
