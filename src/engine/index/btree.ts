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
