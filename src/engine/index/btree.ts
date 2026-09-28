/**
 * A B+Tree. All data lives in the leaves; internal nodes hold only separator
 * keys. Leaves are chained left-to-right so a range scan can walk them.
 *
 * THE SPLIT RULE (plan.md §7.6) — this is where implementations go wrong:
 *
 *   leaf split     → COPY up.  The separator goes to the parent *and stays in
 *                              the leaf*, because leaves must hold every key.
 *   internal split → PUSH up.  The middle key moves to the parent and is
 *                              *removed* from the node.
 *
 * Applying one where the other belongs yields a tree that looks plausible and
 * silently returns wrong rows. The property tests exist for exactly that.
 *
 * Fan-out is deliberately tiny (4 keys). Real fan-out is in the hundreds and
 * would never split on a demo dataset — a case where the simplified model
 * teaches better than the faithful one.
 */

import type { SqlValue } from '../types.ts';
import { compareValues } from '../value.ts';

export interface RowPointer {
  pageId: number;
  /** Index of the row within its page. */
  slot: number;
}

/**
 * What a tree orders by (plan.md §25.4 B3). The sandbox trees (`/tools/btree`,
 * the docs demo) use plain **scalars**. An index over a *table* uses
 * **entries**: the column's value(s) plus the row's own address as a
 * tie-breaker — `(30, page 4, slot 2)` — so the tree never holds two equal
 * keys even when a hundred rows share a value. That is how InnoDB and
 * PostgreSQL make a non-unique index (their "row id" / TID is the last key
 * column), and why splits, merges and the leaf chain need no special case: the
 * tree is *always* unique; only the lookup changes, from "find this key" to
 * "find every entry whose value is this".
 *
 * A **probe** is a bound to search *for*, never stored: `{ values: [30], bound:
 * 'low' }` sorts before every entry with value 30 and `'high'` after every one,
 * so `lowerBound` finds the first duplicate (or the first entry past them all)
 * with no special case either.
 */
export interface EntryKey {
  /** The indexed column's value — or values, for a composite index — in column order. */
  values: readonly SqlValue[];
  page: number;
  slot: number;
  /**
   * A SECONDARY index on a CLUSTERED table (plan.md §25.4 B3e): `page`/`slot` are unused (`-1`) — a clustered leaf
   * can split and move rows between pages, so a physical address would go stale, and this entry carries the row's
   * CLUSTERING KEY instead. Finding the row costs a second, real descent through the clustered index itself.
   */
  clusterKey?: readonly SqlValue[];
}
export interface ProbeKey {
  values: readonly SqlValue[];
  bound: 'low' | 'high';
}
export type IndexKey = SqlValue | EntryKey | ProbeKey;

export const isProbe = (key: IndexKey): key is ProbeKey => typeof key === 'object' && key !== null && 'bound' in key;
export const isEntry = (key: IndexKey): key is EntryKey => typeof key === 'object' && key !== null && 'page' in key;

/** The entry an index over `values` holds for the row at `pointer` — or, on a clustered table's secondary index, for `clusterKey` instead (plan.md §25.4 B3e). */
export function entryKey(values: readonly SqlValue[], pointer: RowPointer, clusterKey?: readonly SqlValue[]): EntryKey {
  return { values, page: pointer.pageId, slot: pointer.slot, ...(clusterKey ? { clusterKey } : {}) };
}

/** The bound just before every entry with these leading values (`'low'`) or just after them all (`'high'`). */
export function probe(values: readonly SqlValue[], bound: 'low' | 'high'): ProbeKey {
  return { values, bound };
}

/** The column values of a key: a scalar is its own one value, an entry or probe carries its list. */
export function valuesOf(key: IndexKey): readonly SqlValue[] {
  return typeof key === 'object' && key !== null ? key.values : [key];
}

interface NodeBase {
  id: string;
  /** Index nodes live on pages too, so traversal costs real buffer reads. */
  pageId: number;
}

export interface LeafNode extends NodeBase {
  kind: 'leaf';
  keys: IndexKey[];
  pointers: RowPointer[];
  /** Right sibling, for range scans. */
  next: string | null;
}

export interface InternalNode extends NodeBase {
  kind: 'internal';
  keys: IndexKey[];
  /** Always `keys.length + 1` entries. */
  children: string[];
}

export type BTreeNode = LeafNode | InternalNode;

export interface BPlusTree {
  /** True for an index over a table: its keys are `EntryKey`s, displayed by their values only. */
  tiebreak?: boolean;
  /** A `UNIQUE` index: a lookup of a whole key can stop at the first entry it finds (plan.md §25.4 B3c). */
  unique?: boolean;
  /**
   * A SECONDARY index on a CLUSTERED table (plan.md §25.4 B3e): its entries carry a `clusterKey`, not an address,
   * named here as this tree's row in `ExecContext.trees` — the clustered index a lookup must descend a second time
   * to reach the row. Unset for the clustering key's own tree, and for every index of an unclustered table.
   */
  clusteredVia?: string;
  rootId: string;
  nodes: Record<string, BTreeNode>;
  maxKeys: number;
  nextNodeId: number;
  nextPageId: number;
}

export const DEFAULT_MAX_KEYS = 4;

// NULL sorts before everything and equals only NULL. A NULL never reaches a plain index's leading column (it is
// not indexed), but a composite index's *later* columns can hold one — and `(0, NULL)` must not read as `(0, '')`.
// The shared order every index-shaped structure in this engine uses (`value.ts`'s own doc comment names the rest).
const compareScalar = compareValues;

/**
 * Orders numbers numerically, strings lexicographically, booleans as 0/1 — and,
 * for a table's index, entries by their values (column by column) and then by
 * the row's address. A probe sorts before (`'low'`) or after (`'high'`) every
 * entry that shares its leading values; a shorter list of values is a prefix.
 */
export function compareKeys(a: IndexKey, b: IndexKey): number {
  const aObj = typeof a === 'object' && a !== null;
  const bObj = typeof b === 'object' && b !== null;
  if (!aObj && !bObj) return compareScalar(a, b);

  const av = valuesOf(a);
  const bv = valuesOf(b);
  const shared = Math.min(av.length, bv.length);
  for (let i = 0; i < shared; i++) {
    const c = compareScalar(av[i]!, bv[i]!);
    if (c !== 0) return c;
  }

  // Equal on every shared value: a probe decides by its bound, otherwise the shorter list is smaller.
  const rank = (key: IndexKey): number => (isProbe(key) ? (key.bound === 'low' ? -1 : 1) : 0);
  if (isProbe(a) || isProbe(b)) {
    if (isProbe(a) && isProbe(b)) return rank(a) - rank(b);
    return isProbe(a) ? rank(a) : -rank(b);
  }
  if (av.length !== bv.length) return av.length - bv.length;
  const ea = a as EntryKey;
  const eb = b as EntryKey;
  // A clustered table's secondary entry has no address to break the tie with (plan.md §25.4 B3e) — its clustering
  // key does the job instead, exactly the way the row address does everywhere else: it is unique per row.
  if (ea.clusterKey || eb.clusterKey) {
    const ak = ea.clusterKey ?? [];
    const bk = eb.clusterKey ?? [];
    const shared2 = Math.min(ak.length, bk.length);
    for (let i = 0; i < shared2; i++) {
      const c = compareScalar(ak[i]!, bk[i]!);
      if (c !== 0) return c;
    }
    return ak.length - bk.length;
  }
  return ea.page - eb.page || ea.slot - eb.slot;
}

/** A key as text for a step's detail: the value for a scalar, `value @page.slot` for an entry — or, on a clustered
 *  table's secondary index, `value → clustering key` (plan.md §25.4 B3e), since it holds no address at all. */
function describeKey(key: IndexKey): string {
  if (isEntry(key)) {
    return key.clusterKey
      ? `${key.values.map(String).join(', ')} → (${key.clusterKey.map(String).join(', ')})`
      : `${key.values.map(String).join(', ')} @${String(key.page)}.${String(key.slot)}`;
  }
  if (isProbe(key)) return key.values.map(String).join(', ');
  return String(key);
}

export function node(tree: BPlusTree, id: string): BTreeNode {
  const n = tree.nodes[id];
  if (!n) throw new Error(`B+Tree node ${id} is missing`);
  return n;
}

export function createTree(maxKeys = DEFAULT_MAX_KEYS, firstPageId = 0, tiebreak = false): BPlusTree {
  const root: LeafNode = {
    kind: 'leaf',
    id: 'n0',
    pageId: firstPageId,
    keys: [],
    pointers: [],
    next: null,
  };
  return {
    ...(tiebreak ? { tiebreak } : {}),
    rootId: root.id,
    nodes: { [root.id]: root },
    maxKeys,
    nextNodeId: 1,
    nextPageId: firstPageId + 1,
  };
}

function allocate<T extends BTreeNode>(tree: BPlusTree, make: (id: string, pageId: number) => T): T {
  const created = make(`n${tree.nextNodeId}`, tree.nextPageId);
  tree.nextNodeId += 1;
  tree.nextPageId += 1;
  tree.nodes[created.id] = created;
  return created;
}

/** Index of the first key >= `key`. Exported for `index/rangeLookup.ts` — a range scan's own starting position within its first leaf. */
export function lowerBound(keys: readonly IndexKey[], key: IndexKey): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareKeys(keys[mid]!, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Which child of an internal node covers `key`. */
export function childIndexFor(internal: InternalNode, key: IndexKey): number {
  let i = 0;
  while (i < internal.keys.length && compareKeys(key, internal.keys[i]!) >= 0) i += 1;
  return i;
}

/** Root-to-leaf node ids for `key`. The last entry is always the leaf. */
export function descend(tree: BPlusTree, key: IndexKey): string[] {
  const path: string[] = [tree.rootId];
  let current = node(tree, tree.rootId);

  while (current.kind === 'internal') {
    const childId = current.children[childIndexFor(current, key)]!;
    path.push(childId);
    current = node(tree, childId);
  }

  return path;
}

/** How many values an entry of this tree holds: one for a plain index, more for a composite one. */
export function entryWidth(tree: BPlusTree): number {
  const first = node(tree, leftmostPath(tree).at(-1)!) as LeafNode;
  const key = first.keys[0];
  return key === undefined ? 1 : valuesOf(key).length;
}

/**
 * The lowest key of the leaf to the right of `leaf` — what its parent's separator says, and what a real engine keeps on the
 * page itself as its "high key" (PostgreSQL does) so a scan can tell the run of equal values has ended *without reading the
 * next page*. `null` for the rightmost leaf, and for an empty one. Pure bookkeeping: it touches no buffer-pool page.
 */
export function highKey(tree: BPlusTree, leaf: LeafNode): IndexKey | null {
  const first = leaf.keys[0];
  if (first === undefined) return null;
  let bound: IndexKey | null = null;
  let current = node(tree, tree.rootId);
  while (current.kind === 'internal') {
    const at = childIndexFor(current, first);
    if (at < current.keys.length) bound = current.keys[at]!;
    current = node(tree, current.children[at]!);
  }
  return bound;
}

/**
 * Root-to-leaf node ids along the tree's leftmost edge — always child 0 at
 * every internal node. The starting point for a range scan with no lower
 * bound (`age < 30`, with nothing to descend *toward*), mirroring `descend`'s
 * shape exactly so `index/rangeLookup.ts` can narrate either the same way.
 */
export function leftmostPath(tree: BPlusTree): string[] {
  const path: string[] = [tree.rootId];
  let current = node(tree, tree.rootId);

  while (current.kind === 'internal') {
    const childId = current.children[0]!;
    path.push(childId);
    current = node(tree, childId);
  }

  return path;
}

export interface SearchResult {
  path: string[];
  leafId: string;
  /** Position within the leaf, or -1 when the key is absent. */
  slotInLeaf: number;
  pointer: RowPointer | null;
}

/**
 * Finds `key`. Given a plain value on a table's index — which holds entries, not bare values — it finds the *first*
 * entry for that value (the one lowest in row-address order); `emitIndexLookup` is the narrated version that also
 * returns the rest of the run.
 */
export function search(tree: BPlusTree, key: IndexKey): SearchResult {
  const target = tree.tiebreak && !isEntry(key) && !isProbe(key) ? probe([key], 'low') : key;
  const path = descend(tree, target);
  let leaf = node(tree, path[path.length - 1]!) as LeafNode;
  let at = lowerBound(leaf.keys, target);
  // The first entry for a value can start the *next* leaf (the probe routed left of a separator that equals it).
  if (at >= leaf.keys.length && leaf.next !== null && tree.tiebreak) {
    leaf = node(tree, leaf.next) as LeafNode;
    at = 0;
  }
  const matches = (candidate: IndexKey): boolean =>
    target === key ? compareKeys(candidate, key) === 0 : compareKeys(valuesOf(candidate)[0]!, key) === 0;
  const found = at < leaf.keys.length && matches(leaf.keys[at]!);

  return {
    path,
    leafId: leaf.id,
    slotInLeaf: found ? at : -1,
    pointer: found ? leaf.pointers[at]! : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Insert                                                                      */
/* -------------------------------------------------------------------------- */

export function insert(tree: BPlusTree, key: IndexKey, pointer: RowPointer): void {
  const path = descend(tree, key);
  const leaf = node(tree, path[path.length - 1]!) as LeafNode;

  const at = lowerBound(leaf.keys, key);
  if (at < leaf.keys.length && compareKeys(leaf.keys[at]!, key) === 0) {
    // The same key again — for a table's index that is the same *row* (the address is part of the key), so
    // there is nothing new to hold; for a scalar sandbox tree, last writer wins.
    leaf.pointers[at] = pointer;
    return;
  }

  leaf.keys.splice(at, 0, key);
  leaf.pointers.splice(at, 0, pointer);

  if (leaf.keys.length <= tree.maxKeys) return;
  splitLeaf(tree, path, leaf);
}

function splitLeaf(tree: BPlusTree, path: string[], leaf: LeafNode): void {
  const mid = Math.ceil(leaf.keys.length / 2);

  const right = allocate<LeafNode>(tree, (id, pageId) => ({
    kind: 'leaf',
    id,
    pageId,
    keys: leaf.keys.slice(mid),
    pointers: leaf.pointers.slice(mid),
    next: leaf.next,
  }));

  leaf.keys = leaf.keys.slice(0, mid);
  leaf.pointers = leaf.pointers.slice(0, mid);
  leaf.next = right.id;

  // COPY up: the separator also remains as the right leaf's first key.
  const separator = right.keys[0]!;
  insertIntoParent(tree, path.slice(0, -1), leaf.id, separator, right.id);
}

function insertIntoParent(
  tree: BPlusTree,
  ancestors: string[],
  leftId: string,
  separator: IndexKey,
  rightId: string,
): void {
  if (ancestors.length === 0) {
    const root = allocate<InternalNode>(tree, (id, pageId) => ({
      kind: 'internal',
      id,
      pageId,
      keys: [separator],
      children: [leftId, rightId],
    }));
    tree.rootId = root.id;
    return;
  }

  const parent = node(tree, ancestors[ancestors.length - 1]!) as InternalNode;
  const at = parent.children.indexOf(leftId);
  parent.keys.splice(at, 0, separator);
  parent.children.splice(at + 1, 0, rightId);

  if (parent.keys.length <= tree.maxKeys) return;

  const mid = Math.floor(parent.keys.length / 2);
  // PUSH up: the middle key leaves this node entirely.
  const pushed = parent.keys[mid]!;

  const right = allocate<InternalNode>(tree, (id, pageId) => ({
    kind: 'internal',
    id,
    pageId,
    keys: parent.keys.slice(mid + 1),
    children: parent.children.slice(mid + 1),
  }));

  parent.keys = parent.keys.slice(0, mid);
  parent.children = parent.children.slice(0, mid + 1);

  insertIntoParent(tree, ancestors.slice(0, -1), parent.id, pushed, right.id);
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * THE DELETE RULE (plan.md §7.6) — the mirror of the split rule, and just as
 * easy to get subtly wrong:
 *
 *   leaf underflow     → borrow a key from a sibling, or MERGE with one. The
 *                        separator between the two in the parent is *rewritten*
 *                        to the new boundary (borrow) or *removed* (merge).
 *   internal underflow → borrow, or merge — and the parent's separator is
 *                        *pulled down* into the merged node, because internal
 *                        nodes hold no data and must not duplicate a key.
 *   deleted key was a separator → the copy in every ancestor that routes into
 *                        this leaf's subtree is replaced with the leaf's new
 *                        minimum, so `validate`'s "every separator exists as a
 *                        leaf key" invariant still holds after any delete.
 *
 * "Under half full" is `ceil(maxKeys / 2)` keys for a leaf and
 * `ceil((maxKeys + 1) / 2)` children for an internal node — the same floors
 * `validate` enforces. The root is exempt: it may hold as little as one key
 * (leaf) or two children (internal), and collapses into its only child when it
 * drops below that.
 */

const minLeafKeys = (tree: BPlusTree): number => Math.ceil(tree.maxKeys / 2);
const minInternalChildren = (tree: BPlusTree): number =>
  Math.ceil((tree.maxKeys + 1) / 2);

export type DeleteStepKind =
  | 'remove'
  | 'update-separator'
  | 'borrow-left'
  | 'borrow-right'
  | 'merge'
  | 'root-collapse';

export interface DeleteStep {
  kind: DeleteStepKind;
  /** The node this step acts on (or, for a collapse, the new root). */
  node: string;
  detail?: string;
}

export interface DeleteResult {
  /** False when the key was not in the tree — nothing changed. */
  found: boolean;
  /** What the delete did, in order. Empty beyond the `remove` step means the
   *  key came out of a leaf that stayed at least half full. */
  steps: DeleteStep[];
}

export function deleteKey(tree: BPlusTree, key: IndexKey): DeleteResult {
  const steps: DeleteStep[] = [];
  const path = descend(tree, key);
  const leaf = node(tree, path[path.length - 1]!) as LeafNode;

  const at = lowerBound(leaf.keys, key);
  if (at >= leaf.keys.length || compareKeys(leaf.keys[at]!, key) !== 0) {
    return { found: false, steps };
  }

  leaf.keys.splice(at, 1);
  leaf.pointers.splice(at, 1);
  steps.push({ kind: 'remove', node: leaf.id, detail: describeKey(key) });

  // The deleted key can only be a separator if it was this leaf's minimum.
  // Rewrite it wherever an ancestor routes right into this leaf's subtree.
  if (at === 0 && leaf.keys.length > 0) {
    updateSeparators(tree, path, key, leaf.keys[0]!, steps);
  }

  // The root leaf is allowed to sit below the floor, empty included.
  if (path.length === 1 || leaf.keys.length >= minLeafKeys(tree)) {
    return { found: true, steps };
  }

  rebalanceLeaf(tree, path, steps);
  return { found: true, steps };
}

function updateSeparators(
  tree: BPlusTree,
  path: string[],
  oldKey: IndexKey,
  newKey: IndexKey,
  steps: DeleteStep[],
): void {
  for (let i = 0; i < path.length - 1; i++) {
    const parent = node(tree, path[i]!) as InternalNode;
    const childIndex = parent.children.indexOf(path[i + 1]!);
    if (childIndex > 0 && compareKeys(parent.keys[childIndex - 1]!, oldKey) === 0) {
      parent.keys[childIndex - 1] = newKey;
      steps.push({
        kind: 'update-separator',
        node: parent.id,
        detail: `${describeKey(oldKey)} → ${describeKey(newKey)}`,
      });
    }
  }
}

function rebalanceLeaf(tree: BPlusTree, path: string[], steps: DeleteStep[]): void {
  const leaf = node(tree, path[path.length - 1]!) as LeafNode;
  const parent = node(tree, path[path.length - 2]!) as InternalNode;
  const idx = parent.children.indexOf(leaf.id);
  const floor = minLeafKeys(tree);

  const left = idx > 0 ? (node(tree, parent.children[idx - 1]!) as LeafNode) : null;
  const right =
    idx < parent.children.length - 1
      ? (node(tree, parent.children[idx + 1]!) as LeafNode)
      : null;

  if (left && left.keys.length > floor) {
    leaf.keys.unshift(left.keys.pop()!);
    leaf.pointers.unshift(left.pointers.pop()!);
    parent.keys[idx - 1] = leaf.keys[0]!;
    steps.push({ kind: 'borrow-left', node: leaf.id, detail: `from ${left.id}` });
    return;
  }
  if (right && right.keys.length > floor) {
    leaf.keys.push(right.keys.shift()!);
    leaf.pointers.push(right.pointers.shift()!);
    parent.keys[idx] = right.keys[0]!;
    steps.push({ kind: 'borrow-right', node: leaf.id, detail: `from ${right.id}` });
    return;
  }

  // No sibling has a key to spare — merge, and drop the separator between them.
  if (left) {
    left.keys.push(...leaf.keys);
    left.pointers.push(...leaf.pointers);
    left.next = leaf.next;
    delete tree.nodes[leaf.id];
    parent.keys.splice(idx - 1, 1);
    parent.children.splice(idx, 1);
    steps.push({ kind: 'merge', node: left.id, detail: `absorbed ${leaf.id}` });
  } else if (right) {
    leaf.keys.push(...right.keys);
    leaf.pointers.push(...right.pointers);
    leaf.next = right.next;
    delete tree.nodes[right.id];
    parent.keys.splice(idx, 1);
    parent.children.splice(idx + 1, 1);
    steps.push({ kind: 'merge', node: leaf.id, detail: `absorbed ${right.id}` });
  }

  rebalanceInternal(tree, path.slice(0, -1), steps);
}

function rebalanceInternal(tree: BPlusTree, path: string[], steps: DeleteStep[]): void {
  const target = node(tree, path[path.length - 1]!) as InternalNode;

  if (path.length === 1) {
    // The root may thin all the way to a single child; then it *is* that child.
    if (target.children.length === 1) {
      tree.rootId = target.children[0]!;
      delete tree.nodes[target.id];
      steps.push({ kind: 'root-collapse', node: tree.rootId, detail: `dropped ${target.id}` });
    }
    return;
  }

  if (target.children.length >= minInternalChildren(tree)) return;

  const parent = node(tree, path[path.length - 2]!) as InternalNode;
  const idx = parent.children.indexOf(target.id);
  const left = idx > 0 ? (node(tree, parent.children[idx - 1]!) as InternalNode) : null;
  const right =
    idx < parent.children.length - 1
      ? (node(tree, parent.children[idx + 1]!) as InternalNode)
      : null;
  const floor = minInternalChildren(tree);

  // Borrow: rotate a child across, threading it through the parent separator.
  if (left && left.children.length > floor) {
    target.children.unshift(left.children.pop()!);
    target.keys.unshift(parent.keys[idx - 1]!);
    parent.keys[idx - 1] = left.keys.pop()!;
    steps.push({ kind: 'borrow-left', node: target.id, detail: `from ${left.id}` });
    return;
  }
  if (right && right.children.length > floor) {
    target.children.push(right.children.shift()!);
    target.keys.push(parent.keys[idx]!);
    parent.keys[idx] = right.keys.shift()!;
    steps.push({ kind: 'borrow-right', node: target.id, detail: `from ${right.id}` });
    return;
  }

  // Merge: the parent separator comes down between the two nodes' children.
  if (left) {
    left.keys.push(parent.keys[idx - 1]!, ...target.keys);
    left.children.push(...target.children);
    delete tree.nodes[target.id];
    parent.keys.splice(idx - 1, 1);
    parent.children.splice(idx, 1);
    steps.push({ kind: 'merge', node: left.id, detail: `absorbed ${target.id}` });
  } else if (right) {
    target.keys.push(parent.keys[idx]!, ...right.keys);
    target.children.push(...right.children);
    delete tree.nodes[right.id];
    parent.keys.splice(idx, 1);
    parent.children.splice(idx + 1, 1);
    steps.push({ kind: 'merge', node: target.id, detail: `absorbed ${right.id}` });
  }

  rebalanceInternal(tree, path.slice(0, -1), steps);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Leaf ids left to right, following the sibling chain from the leftmost leaf. */
export function leafChain(tree: BPlusTree): string[] {
  let current = node(tree, tree.rootId);
  while (current.kind === 'internal') current = node(tree, current.children[0]!);

  const ids: string[] = [];
  let cursor: LeafNode | null = current;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    ids.push(cursor.id);
    cursor = cursor.next ? (node(tree, cursor.next) as LeafNode) : null;
  }
  return ids;
}

export function allKeys(tree: BPlusTree): IndexKey[] {
  return leafChain(tree).flatMap((id) => (node(tree, id) as LeafNode).keys);
}

export function height(tree: BPlusTree): number {
  let h = 1;
  let current = node(tree, tree.rootId);
  while (current.kind === 'internal') {
    current = node(tree, current.children[0]!);
    h += 1;
  }
  return h;
}
