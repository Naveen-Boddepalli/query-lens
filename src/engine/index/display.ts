import type { IndexNode, SqlValue } from '../types.ts';
import { node } from './btree.ts';
import type { BPlusTree } from './btree.ts';

function formatKey(key: SqlValue): string {
  if (key === null) return 'NULL';
  return typeof key === 'string' ? `'${key}'` : String(key);
}

export function keyList(keys: SqlValue[]): string {
  return keys.length === 0 ? '·' : keys.map(formatKey).join(' ');
}

/** The whole tree, as the UI draws it. */
export function toIndexDisplay(tree: BPlusTree, id: string = tree.rootId): IndexNode {
  const n = node(tree, id);

  if (n.kind === 'leaf') {
    return {
      id: n.id,
      kind: 'leaf',
      label: keyList(n.keys),
      pageId: n.pageId,
      ...(n.next === null ? {} : { next: n.next }),
    };
  }

  return {
    id: n.id,
    kind: 'internal',
    label: keyList(n.keys),
    pageId: n.pageId,
    children: n.children.map((childId) => toIndexDisplay(tree, childId)),
  };
}
