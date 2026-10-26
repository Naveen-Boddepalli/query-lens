import { hierarchy } from 'd3-hierarchy';

/**
 * Where a reader's arrow keys go from one node of a tree diagram (plan.md §H6). A node is a `treeitem` in a `tree`,
 * so its level and place among its siblings are announced, and the keys follow the hierarchy: up to the parent, down
 * to the first child, left and right through its siblings. The sibling links across a B+Tree's leaves are not
 * followed, since arrows follow the hierarchy only.
 */
export interface TreeRelation {
  level: number;
  position: number;
  setSize: number;
  parent?: string;
  firstChild?: string;
  prev?: string;
  next?: string;
}

export function treeRelations<T extends { id: string; children?: T[] }>(root: T): Map<string, TreeRelation> {
  const out = new Map<string, TreeRelation>();
  for (const d of hierarchy<T>(root, (n) => n.children).descendants()) {
    const siblings = d.parent?.children ?? [d];
    const i = siblings.indexOf(d);
    const before = siblings[i - 1];
    const after = siblings[i + 1];
    const firstChild = d.children?.[0];
    out.set(d.data.id, {
      level: d.depth + 1,
      position: i + 1,
      setSize: siblings.length,
      ...(d.parent ? { parent: d.parent.data.id } : {}),
      ...(firstChild ? { firstChild: firstChild.data.id } : {}),
      ...(before ? { prev: before.data.id } : {}),
      ...(after ? { next: after.data.id } : {}),
    });
  }
  return out;
}

export function nextFocus(relation: TreeRelation, key: string): string | undefined {
  switch (key) {
    case 'ArrowUp': return relation.parent;
    case 'ArrowDown': return relation.firstChild;
    case 'ArrowLeft': return relation.prev;
    case 'ArrowRight': return relation.next;
    default: return undefined;
  }
}
