import { allKeys, createTree, descend, height, insert, validate } from '../engine/index.ts';
import type { BPlusTree, BTreeNode } from '../engine/index.ts';

/**
 * plan.md §25.4 F5 `/tools/latch-crabbing`: how concurrent threads can safely descend a B+Tree while inserting.
 * Latches are short physical locks on index pages, held only while a page is being read or changed. They are not
 * the transaction-level locks in `src/engine/locks/`, which hold for a whole transaction.
 *
 * **Two protocols, same workload, same tree:**
 *   - **naive**: every insert takes an exclusive latch on each page along its root-to-leaf path, top-down, and
 *     holds them all until the leaf is written. Correct — every page is locked before it is touched — but every
 *     thread funnels through the root, so the root is held for the whole of every insert.
 *   - **crabbing** (lock coupling, Bayer & Schkolnick): the same top-down latching, but as soon as the child
 *     just latched is *safe* for an insert, every ancestor above it is released. A node is safe when it has
 *     room for one more key, so a split from below cannot reach it and the ancestors above it can never need
 *     to change. A thread's footprint shrinks to the one or two pages it is actually modifying.
 *
 * **The scheduler is scripted and deterministic.** Threads take turns, one latch action per tick, in a fixed
 * order. An acquire on a page another thread holds stalls that thread for the tick and is counted as blocked.
 * Nothing runs in parallel, so the timeline is reproducible and the numbers are exact for this schedule.
 *
 * **The tree is real.** Each insert's path is read from the engine's own `descend`, and the final tree is the same
 * engine B+Tree `/tools/btree` drives, checked by its own `validate`. Path choices use the tree as it stands after
 * the ops that come before them in the schedule, so the paths are those of one serial order. A true concurrent
 * interleaving could route an insert differently, and this does not model that.
 */

export type LatchProtocol = 'naive' | 'crabbing';

export interface LatchAction {
  tick: number;
  thread: number;
  kind: 'acquire' | 'release' | 'write' | 'blocked';
  nodeId?: string | undefined;
  key: number;
}

export interface ThreadSummary {
  thread: number;
  peakLatches: number;
  blockedTicks: number;
  operations: number;
}

export interface LatchPlan {
  protocol: LatchProtocol;
  maxKeys: number;
  timeline: LatchAction[];
  threads: ThreadSummary[];
  /** The most latches held across every thread at any single tick. */
  maxConcurrentLatches: number;
  totalBlockedTicks: number;
  ticks: number;
  finalHeight: number;
  finalKeyCount: number;
  treeProblems: string[];
}

export interface LatchLimits {
  minFanout: number;
  maxFanout: number;
  minThreads: number;
  maxThreads: number;
  minOpsPerThread: number;
  maxOpsPerThread: number;
}

export const LATCH_LIMITS: LatchLimits = {
  minFanout: 3,
  maxFanout: 6,
  minThreads: 2,
  maxThreads: 4,
  minOpsPerThread: 1,
  maxOpsPerThread: 6,
};

/** A safe node for an insert: one more key still fits, so a split from below cannot propagate into it. */
function isSafeForInsert(tree: BPlusTree, nodeId: string): boolean {
  const n: BTreeNode = tree.nodes[nodeId]!;
  return n.keys.length < tree.maxKeys;
}

interface Action {
  kind: 'acquire' | 'release' | 'write';
  nodeId?: string;
}

/** The latch actions one insert takes, given its root-to-leaf path and the protocol. */
function actionsFor(tree: BPlusTree, path: readonly string[], protocol: LatchProtocol): Action[] {
  const out: Action[] = [];
  if (protocol === 'naive') {
    for (const id of path) out.push({ kind: 'acquire', nodeId: id });
    out.push({ kind: 'write' });
    for (const id of path) out.push({ kind: 'release', nodeId: id });
    return out;
  }

  // Crabbing: each child is latched before its parent is released, and the parent is released only once the
  // child is safe — so an unsafe chain is held end-to-end, exactly as the naive protocol would hold it.
  const held: string[] = [];
  for (const id of path) {
    out.push({ kind: 'acquire', nodeId: id });
    held.push(id);
    if (isSafeForInsert(tree, id)) {
      for (const ancestor of held.slice(0, -1)) out.push({ kind: 'release', nodeId: ancestor });
      held.splice(0, held.length - 1);
    }
  }
  out.push({ kind: 'write' });
  for (const id of held) out.push({ kind: 'release', nodeId: id });
  return out;
}

/** A key's own route, read off the engine's real tree as it stands when the insert is scheduled. */
interface ScheduledOp {
  thread: number;
  key: number;
  actions: Action[];
}

function buildSchedule(
  initialKeys: readonly number[],
  scripts: readonly (readonly number[])[],
  maxKeys: number,
  protocol: LatchProtocol,
): { ops: ScheduledOp[]; tree: BPlusTree } {
  const tree = createTree(maxKeys, 0);
  for (const k of initialKeys) insert(tree, k, { pageId: k, slot: 0 });

  // Issue order: round-robin across threads, one op each per round — the same order the scheduler walks.
  const cursors = scripts.map(() => 0);
  const ops: ScheduledOp[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    scripts.forEach((script, thread) => {
      const key = script[cursors[thread]!];
      if (key === undefined) return;
      cursors[thread]! += 1;
      progressed = true;
      const path = descend(tree, key);
      ops.push({ thread, key, actions: actionsFor(tree, path, protocol) });
      insert(tree, key, { pageId: key, slot: 0 });
    });
  }
  return { ops, tree };
}

export function planLatchCrabbing(
  rawInitialKeys: readonly number[],
  scripts: readonly (readonly number[])[],
  rawMaxKeys: number,
  protocol: LatchProtocol,
): LatchPlan {
  const maxKeys = Math.max(LATCH_LIMITS.minFanout, Math.min(LATCH_LIMITS.maxFanout, Math.round(rawMaxKeys)));
  const initialKeys = [...new Set(rawInitialKeys)];

  const { ops, tree } = buildSchedule(initialKeys, scripts, maxKeys, protocol);

  // Each thread's own queue of actions, flattened in the order it issues its ops.
  const queues: { actions: Action[]; key: number }[][] = scripts.map(() => []);
  for (const op of ops) queues[op.thread]!.push({ actions: op.actions, key: op.key });

  const pending: { action: Action; key: number }[][] = queues.map((q) =>
    q.flatMap((o) => o.actions.map((a) => ({ action: a, key: o.key }))),
  );
  const cursor = pending.map(() => 0);

  const owner = new Map<string, number>();
  const held: number[] = scripts.map(() => 0);
  const threads: ThreadSummary[] = scripts.map((s, thread) => ({
    thread,
    peakLatches: 0,
    blockedTicks: 0,
    operations: s.length,
  }));
  const timeline: LatchAction[] = [];
  let maxConcurrent = 0;
  let tick = 0;
  const cap = 100_000; // a guard, not an expected limit: top-down latching cannot deadlock

  while (cursor.some((c, t) => c < pending[t]!.length) && tick < cap) {
    tick += 1;
    for (let t = 0; t < pending.length; t++) {
      const queue = pending[t]!;
      if (cursor[t]! >= queue.length) continue;
      const { action, key } = queue[cursor[t]!]!;

      if (action.kind === 'acquire') {
        const holder = owner.get(action.nodeId!);
        if (holder !== undefined && holder !== t) {
          timeline.push({ tick, thread: t, kind: 'blocked', nodeId: action.nodeId, key });
          threads[t]!.blockedTicks += 1;
          continue;
        }
        owner.set(action.nodeId!, t);
        held[t]! += 1;
        threads[t]!.peakLatches = Math.max(threads[t]!.peakLatches, held[t]!);
        timeline.push({ tick, thread: t, kind: 'acquire', nodeId: action.nodeId, key });
      } else if (action.kind === 'release') {
        owner.delete(action.nodeId!);
        held[t]! -= 1;
        timeline.push({ tick, thread: t, kind: 'release', nodeId: action.nodeId, key });
      } else {
        timeline.push({ tick, thread: t, kind: 'write', key });
      }
      cursor[t]! += 1;
    }
    maxConcurrent = Math.max(maxConcurrent, held.reduce((a, b) => a + b, 0));
  }

  return {
    protocol,
    maxKeys,
    timeline,
    threads,
    maxConcurrentLatches: maxConcurrent,
    totalBlockedTicks: threads.reduce((n, t) => n + t.blockedTicks, 0),
    ticks: tick,
    finalHeight: height(tree),
    finalKeyCount: allKeys(tree).length,
    treeProblems: validate(tree),
  };
}
