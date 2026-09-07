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

export interface RowPointer {
  pageId: number;
  /** Index of the row within its page. */
  slot: number;
}

interface NodeBase {
  id: string;
  /** Index nodes live on pages too, so traversal costs real buffer reads. */
  pageId: number;
}

export interface LeafNode extends NodeBase {
  kind: 'leaf';
  keys: SqlValue[];
  pointers: RowPointer[];
  /** Right sibling, for range scans. */
  next: string | null;
}

export interface InternalNode extends NodeBase {
  kind: 'internal';
  keys: SqlValue[];
  /** Always `keys.length + 1` entries. */
  children: string[];
}

export type BTreeNode = LeafNode | InternalNode;

export interface BPlusTree {
  rootId: string;
  nodes: Record<string, BTreeNode>;
  maxKeys: number;
  nextNodeId: number;
  nextPageId: number;
}

export const DEFAULT_MAX_KEYS = 4;

/** Orders numbers numerically, strings lexicographically. Booleans as 0/1. */
export function compareKeys(a: SqlValue, b: SqlValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = a === null ? '' : typeof a === 'boolean' ? String(Number(a)) : String(a);
  const sb = b === null ? '' : typeof b === 'boolean' ? String(Number(b)) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function node(tree: BPlusTree, id: string): BTreeNode {
  const n = tree.nodes[id];
  if (!n) throw new Error(`B+Tree node ${id} is missing`);
  return n;
}

export function createTree(maxKeys = DEFAULT_MAX_KEYS, firstPageId = 0): BPlusTree {
  const root: LeafNode = {
    kind: 'leaf',
    id: 'n0',
    pageId: firstPageId,
    keys: [],
    pointers: [],
    next: null,
  };
  return {
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

/** Index of the first key >= `key`. */
function lowerBound(keys: SqlValue[], key: SqlValue): number {
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
export function childIndexFor(internal: InternalNode, key: SqlValue): number {
  let i = 0;
  while (i < internal.keys.length && compareKeys(key, internal.keys[i]!) >= 0) i += 1;
  return i;
}

/** Root-to-leaf node ids for `key`. The last entry is always the leaf. */
export function descend(tree: BPlusTree, key: SqlValue): string[] {
  const path: string[] = [tree.rootId];
  let current = node(tree, tree.rootId);

  while (current.kind === 'internal') {
    const childId = current.children[childIndexFor(current, key)]!;
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

export function search(tree: BPlusTree, key: SqlValue): SearchResult {
  const path = descend(tree, key);
  const leaf = node(tree, path[path.length - 1]!) as LeafNode;
  const at = lowerBound(leaf.keys, key);
  const found = at < leaf.keys.length && compareKeys(leaf.keys[at]!, key) === 0;

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

export function insert(tree: BPlusTree, key: SqlValue, pointer: RowPointer): void {
  const path = descend(tree, key);
  const leaf = node(tree, path[path.length - 1]!) as LeafNode;

  const at = lowerBound(leaf.keys, key);
  if (at < leaf.keys.length && compareKeys(leaf.keys[at]!, key) === 0) {
    // Duplicate key: last writer wins. v0 indexes a unique column.
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
  separator: SqlValue,
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

export function deleteKey(tree: BPlusTree, key: SqlValue): DeleteResult {
  const steps: DeleteStep[] = [];
  const path = descend(tree, key);
  const leaf = node(tree, path[path.length - 1]!) as LeafNode;

  const at = lowerBound(leaf.keys, key);
  if (at >= leaf.keys.length || compareKeys(leaf.keys[at]!, key) !== 0) {
    return { found: false, steps };
  }

  leaf.keys.splice(at, 1);
  leaf.pointers.splice(at, 1);
  steps.push({ kind: 'remove', node: leaf.id, detail: String(key) });

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
  oldKey: SqlValue,
  newKey: SqlValue,
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
        detail: `${String(oldKey)} → ${String(newKey)}`,
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

export function allKeys(tree: BPlusTree): SqlValue[] {
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
