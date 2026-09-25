import type { IndexNode, SqlValue } from '../types.ts';
import { node, valuesOf } from './btree.ts';
import type { BPlusTree, IndexKey } from './btree.ts';

function formatValue(value: SqlValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** A key as the tree draws it: a table index's entry shows its value(s) — the row address it also carries is not drawn. */
function formatKey(key: IndexKey): string {
  const values = valuesOf(key);
  return values.length === 1 ? formatValue(values[0]!) : `(${values.map(formatValue).join(', ')})`;
}

export function keyList(keys: readonly IndexKey[]): string {
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
