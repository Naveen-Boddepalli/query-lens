/**
 * Structural invariants of a B+Tree. plan.md §7.6 requires these to be tested
 * before anything is drawn: a tree with the split rules subtly wrong still
 * *looks* plausible, and silently returns wrong rows.
 *
 * Returns a list of violations — empty means the tree is sound.
 */

import { compareKeys, leafChain, node } from './btree.ts';
import type { BPlusTree, IndexKey, LeafNode } from './btree.ts';

export function validate(tree: BPlusTree): string[] {
  const problems: string[] = [];
  const root = node(tree, tree.rootId);
  const minLeafKeys = Math.ceil(tree.maxKeys / 2);
  const minInternalChildren = Math.ceil((tree.maxKeys + 1) / 2);

  const depths: number[] = [];
  const visited = new Set<string>();

  function walk(id: string, depth: number, low: IndexKey | null, high: IndexKey | null): void {
    if (visited.has(id)) {
      problems.push(`node ${id} is reachable by more than one path`);
      return;
    }
    visited.add(id);
    const n = node(tree, id);
    const isRoot = id === tree.rootId;

    // Keys within a node are strictly ascending.
    for (let i = 1; i < n.keys.length; i++) {
      if (compareKeys(n.keys[i - 1]!, n.keys[i]!) >= 0) {
        problems.push(`node ${id} keys are not strictly ascending`);
        break;
      }
    }

    // Every key must fall inside the range its ancestors promised.
    for (const key of n.keys) {
      if (low !== null && compareKeys(key, low) < 0) {
        problems.push(`node ${id} holds key below its separator bound`);
        break;
      }
      if (high !== null && compareKeys(key, high) >= 0) {
        problems.push(`node ${id} holds key at or above its separator bound`);
        break;
      }
    }

    if (n.kind === 'leaf') {
      depths.push(depth);
      if (n.keys.length !== n.pointers.length) {
        problems.push(`leaf ${id} has ${n.keys.length} keys but ${n.pointers.length} pointers`);
      }
      // (d) every node except the root is at least half full
      if (!isRoot && n.keys.length < minLeafKeys) {
        problems.push(`leaf ${id} is under half full (${n.keys.length} < ${minLeafKeys})`);
      }
      if (n.keys.length > tree.maxKeys) {
        problems.push(`leaf ${id} overflows (${n.keys.length} > ${tree.maxKeys})`);
      }
      return;
    }

    if (n.children.length !== n.keys.length + 1) {
      problems.push(
        `internal ${id} has ${n.keys.length} keys but ${n.children.length} children`,
      );
      return;
    }
    if (n.keys.length > tree.maxKeys) {
      problems.push(`internal ${id} overflows (${n.keys.length} > ${tree.maxKeys})`);
    }
    if (!isRoot && n.children.length < minInternalChildren) {
      problems.push(
        `internal ${id} is under half full (${n.children.length} < ${minInternalChildren})`,
      );
    }
    if (isRoot && n.children.length < 2) {
      problems.push(`root ${id} has fewer than two children`);
    }

    n.children.forEach((childId, i) => {
      walk(
        childId,
        depth + 1,
        i === 0 ? low : n.keys[i - 1]!,
        i === n.keys.length ? high : n.keys[i]!,
      );
    });
  }

  walk(root.id, 0, null, null);

  // (c) all leaves at equal depth
  if (new Set(depths).size > 1) {
    problems.push(`leaves sit at differing depths: ${[...new Set(depths)].sort().join(', ')}`);
  }

  // (b) the sibling chain is sorted and reaches every leaf
  const chain = leafChain(tree);
  const chainKeys = chain.flatMap((id) => (node(tree, id) as LeafNode).keys);
  for (let i = 1; i < chainKeys.length; i++) {
    if (compareKeys(chainKeys[i - 1]!, chainKeys[i]!) >= 0) {
      problems.push('the leaf sibling chain is not in ascending key order');
      break;
    }
  }

  const leavesInTree = [...visited].filter((id) => node(tree, id).kind === 'leaf');
  if (chain.length !== leavesInTree.length) {
    problems.push(
      `the sibling chain reaches ${chain.length} leaves but the tree has ${leavesInTree.length}`,
    );
  }

  // Every separator in an internal node must actually exist as a leaf key
  // (the copy-up rule) — a pushed-up leaf separator would break lookups.
  const leafKeySet = new Set(chainKeys.map((k) => JSON.stringify(k)));
  for (const id of visited) {
    const n = node(tree, id);
    if (n.kind !== 'internal') continue;
    for (const key of n.keys) {
      if (!leafKeySet.has(JSON.stringify(key))) {
        problems.push(`separator ${JSON.stringify(key)} in ${id} is not present in any leaf`);
      }
    }
  }

  return problems;
}
