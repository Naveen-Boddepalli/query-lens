import { allKeys, createTree, descend, height, insert, validate } from '../engine/index.ts';
import type { BPlusTree, BTreeNode } from '../engine/index.ts';

/**
 * plan.md §25.4 F5 `/tools/latch-crabbing`: how concurrent threads can safely descend a B+Tree while inserting.
 * Latches are short physical locks on index pages, held only while a page is being read or changed. They are not
 * the transaction-level locks in `src/engine/locks/`, which hold for a whole transaction.
 *
 * **Three protocols, same workload, same tree:**
 *   - **naive**: every insert takes an exclusive latch on each page along its root-to-leaf path, top-down, and
 *     holds them all until the leaf is written. Correct — every page is locked before it is touched — but every
 *     thread funnels through the root, so the root is held for the whole of every insert.
 *   - **crabbing** (lock coupling, Bayer & Schkolnick): the same top-down latching, but as soon as the child
 *     just latched is *safe* for an insert, every ancestor above it is released. A node is safe when it has
 *     room for one more key, so a split from below cannot reach it and the ancestors above it can never need
 *     to change. A thread's footprint shrinks to the one or two pages it is actually modifying.
 *   - **optimistic** (optimistic lock coupling, Leis et al.): the descent takes no latch at all. A thread *reads*
 *     each page on its way down, remembering the page's version, and after reading a child it checks that its
 *     parent has not changed — the same hand-over-hand as crabbing, with a version check where crabbing has a
 *     latch. Only then does it latch the pages it will change — the leaf, and the ancestors a split would reach,
 *     which are the same pages crabbing ends up holding — and check each is as it read it. If a check fails,
 *     another thread wrote that page in between, and the insert **restarts** from the root. It trades the latches
 *     the other two hold on the way down for the work of a restart when two inserts really do meet. A read of a
 *     page another thread has latched waits, as a spin does.
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

export type LatchProtocol = 'naive' | 'crabbing' | 'optimistic';

export interface LatchAction {
  tick: number;
  thread: number;
  /**
   * `read` and `restart` are the optimistic protocol's: a read takes no latch, and a restart gives back what the
   * insert held and begins again at the root, naming the page whose version had moved or that it found held.
   */
  kind: 'acquire' | 'release' | 'write' | 'blocked' | 'read' | 'restart';
  /** For a `restart`: why — a parent changed under the descent, the page changed since it was read, or it was held. */
  reason?: 'parent-changed' | 'page-changed' | 'page-held';
  nodeId?: string | undefined;
  key: number;
}

export interface ThreadSummary {
  thread: number;
  peakLatches: number;
  blockedTicks: number;
  /** How many times an insert had to begin again. Always 0 for naive latching and for crabbing. */
  restarts: number;
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
  totalRestarts: number;
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

/** The tree every demo workload starts from: twenty keys, ten apart. */
export const DEMO_INITIAL_KEYS: readonly number[] = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);

/**
 * The scripted workload the tool and its lesson share: each thread gets its own run of keys, drawn from a seeded
 * generator over values not already in the starting tree, so inserts land in different leaves. The same seed always
 * gives the same keys.
 */
export function demoScripts(threads: number, ops: number, seed: number): number[][] {
  const taken = new Set(DEMO_INITIAL_KEYS);
  let s = seed + 1;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  return Array.from({ length: threads }, () => {
    const keys: number[] = [];
    while (keys.length < ops) {
      const k = (next() % 990) + 1;
      if (taken.has(k)) continue;
      taken.add(k);
      keys.push(k);
    }
    return keys;
  });
}

/** A safe node for an insert: one more key still fits, so a split from below cannot propagate into it. */
function isSafeForInsert(tree: BPlusTree, nodeId: string): boolean {
  const n: BTreeNode = tree.nodes[nodeId]!;
  return n.keys.length < tree.maxKeys;
}

interface Action {
  kind: 'acquire' | 'release' | 'write' | 'read';
  nodeId?: string;
  /** For a `read`: the page read just before this one, which must not have changed by the time this is read. */
  parent?: string;
  /** For a `write`: the pages it changes, whose versions move when it lands. */
  modified?: string[];
}

/**
 * The pages an insert changes: the leaf, and each ancestor a split would reach — up to the lowest page with room,
 * which absorbs it, or to the root if there is none. It is what crabbing is left holding when it writes.
 */
function modifiedPages(tree: BPlusTree, path: readonly string[]): string[] {
  let from = path.length - 1;
  while (from > 0 && !isSafeForInsert(tree, path[from]!)) from -= 1;
  return path.slice(from);
}

/** The latch actions one insert takes, given its root-to-leaf path and the protocol. */
function actionsFor(tree: BPlusTree, path: readonly string[], protocol: LatchProtocol): Action[] {
  const out: Action[] = [];
  if (protocol === 'naive') {
    for (const id of path) out.push({ kind: 'acquire', nodeId: id });
    out.push({ kind: 'write', modified: modifiedPages(tree, path) });
    for (const id of path) out.push({ kind: 'release', nodeId: id });
    return out;
  }

  if (protocol === 'optimistic') {
    // Read the whole path with no latch, then latch top-down only what will change; the write, then the releases.
    const changed = modifiedPages(tree, path);
    path.forEach((id, i) => {
      const parent = path[i - 1];
      out.push({ kind: 'read', nodeId: id, ...(parent === undefined ? {} : { parent }) });
    });
    for (const id of changed) out.push({ kind: 'acquire', nodeId: id });
    out.push({ kind: 'write', modified: changed });
    for (const id of changed) out.push({ kind: 'release', nodeId: id });
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
  out.push({ kind: 'write', modified: [...held] });
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

  // Each thread's flattened actions, each remembering where its insert began: a restart goes back there.
  interface Pending {
    action: Action;
    key: number;
    opStart: number;
  }
  const pending: Pending[][] = queues.map((q) => {
    const flat: Pending[] = [];
    for (const o of q) {
      const opStart = flat.length;
      for (const a of o.actions) flat.push({ action: a, key: o.key, opStart });
    }
    return flat;
  });
  const cursor = pending.map(() => 0);

  const owner = new Map<string, number>();
  const heldNodes: string[][] = scripts.map(() => []);
  /** How many writes have landed on each page — what an optimistic read remembers and a latch then checks. */
  const version = new Map<string, number>();
  /**
   * The version each thread last read of each page. An insert always reads a page before it checks or latches it, in
   * the attempt it is making, so what an earlier insert or an abandoned attempt left here is overwritten, never used.
   */
  const seen: Map<string, number>[] = scripts.map(() => new Map<string, number>());
  const threads: ThreadSummary[] = scripts.map((s, thread) => ({
    thread,
    peakLatches: 0,
    blockedTicks: 0,
    restarts: 0,
    operations: s.length,
  }));
  const timeline: LatchAction[] = [];
  let maxConcurrent = 0;
  let tick = 0;
  // A guard, not an expected limit: top-down latching cannot deadlock, and an insert restarts only because another
  // thread wrote a page it read, of which there are finitely many.
  const cap = 100_000;

  while (cursor.some((c, t) => c < pending[t]!.length) && tick < cap) {
    tick += 1;
    for (let t = 0; t < pending.length; t++) {
      const queue = pending[t]!;
      if (cursor[t]! >= queue.length) continue;
      const { action, key, opStart } = queue[cursor[t]!]!;

      if (action.kind === 'read') {
        // No latch is taken, but a page another thread has latched is being changed: wait for it, as a spin does.
        const holder = owner.get(action.nodeId!);
        if (holder !== undefined && holder !== t) {
          timeline.push({ tick, thread: t, kind: 'blocked', nodeId: action.nodeId, key });
          threads[t]!.blockedTicks += 1;
          continue;
        }
        // Hand-over-hand: with the child read, the parent it was reached through must be as it was read.
        if (action.parent !== undefined && (version.get(action.parent) ?? 0) !== seen[t]!.get(action.parent)) {
          timeline.push({ tick, thread: t, kind: 'restart', nodeId: action.parent, key, reason: 'parent-changed' });
          threads[t]!.restarts += 1;
          cursor[t] = opStart;
          continue;
        }
        seen[t]!.set(action.nodeId!, version.get(action.nodeId!) ?? 0);
        timeline.push({ tick, thread: t, kind: 'read', nodeId: action.nodeId, key });
      } else if (action.kind === 'acquire') {
        const holder = owner.get(action.nodeId!);
        if (holder !== undefined && holder !== t) {
          if (seen[t]!.has(action.nodeId!)) {
            // An optimistic latch is a compare-and-swap on the version it read, which a held page fails: the insert
            // does not wait for the page, it restarts, and its read of the page waits for the holder instead.
            timeline.push({ tick, thread: t, kind: 'restart', nodeId: action.nodeId, key, reason: 'page-held' });
            threads[t]!.restarts += 1;
            for (const id of heldNodes[t]!) owner.delete(id);
            heldNodes[t] = [];
            cursor[t] = opStart;
            continue;
          }
          timeline.push({ tick, thread: t, kind: 'blocked', nodeId: action.nodeId, key });
          threads[t]!.blockedTicks += 1;
          continue;
        }
        // Having latched it, check that it is as it was read. Only an optimistic insert has read anything, so for
        // the other two this finds nothing to compare.
        const read = seen[t]!.get(action.nodeId!);
        if (read !== undefined && (version.get(action.nodeId!) ?? 0) !== read) {
          timeline.push({ tick, thread: t, kind: 'restart', nodeId: action.nodeId, key, reason: 'page-changed' });
          threads[t]!.restarts += 1;
          for (const id of heldNodes[t]!) owner.delete(id);
          heldNodes[t] = [];
          cursor[t] = opStart;
          continue;
        }
        owner.set(action.nodeId!, t);
        heldNodes[t]!.push(action.nodeId!);
        threads[t]!.peakLatches = Math.max(threads[t]!.peakLatches, heldNodes[t]!.length);
        timeline.push({ tick, thread: t, kind: 'acquire', nodeId: action.nodeId, key });
      } else if (action.kind === 'release') {
        owner.delete(action.nodeId!);
        heldNodes[t] = heldNodes[t]!.filter((id) => id !== action.nodeId);
        timeline.push({ tick, thread: t, kind: 'release', nodeId: action.nodeId, key });
      } else {
        for (const id of action.modified ?? []) version.set(id, (version.get(id) ?? 0) + 1);
        timeline.push({ tick, thread: t, kind: 'write', key });
      }
      cursor[t]! += 1;
    }
    maxConcurrent = Math.max(maxConcurrent, heldNodes.reduce((a, h) => a + h.length, 0));
  }

  return {
    protocol,
    maxKeys,
    timeline,
    threads,
    maxConcurrentLatches: maxConcurrent,
    totalBlockedTicks: threads.reduce((n, t) => n + t.blockedTicks, 0),
    totalRestarts: threads.reduce((n, t) => n + t.restarts, 0),
    ticks: tick,
    finalHeight: height(tree),
    finalKeyCount: allKeys(tree).length,
    treeProblems: validate(tree),
  };
}
