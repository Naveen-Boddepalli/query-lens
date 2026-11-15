import { searchJoinShapes } from '../engine/planner/joinShapes.ts';
import type { JoinOrderEdge, JoinOrderNode, JoinTree } from '../engine/index.ts';

/**
 * plan.md §27.5 T4: four tables joined by foreign keys in a shape you choose, for the join-order page to search both
 * ways — and every graph its menus can make, searched at once, to say where a bushy plan wins and by how much.
 *
 * Each predicate is a foreign key from the bigger table to the smaller, every one of whose rows is referenced, so its
 * column has as many distinct values as the smaller table has rows on both sides, and the join keeps one row in that
 * many: a join of a 600-row table with a 5-row one it references has 600 rows.
 */

export type GraphShape = 'chain' | 'star';
export const GRAPH_SHAPES: readonly GraphShape[] = ['chain', 'star'];
export const SHAPE_LABELS: Record<GraphShape, string> = { chain: 'Chain A–B–C–D', star: 'Star around A' };
const SHAPE_EDGES: Record<GraphShape, readonly (readonly [number, number])[]> = {
  chain: [[0, 1], [1, 2], [2, 3]],
  star: [[0, 1], [0, 2], [0, 3]],
};
export const EXPLORER_TABLES = ['A', 'B', 'C', 'D'] as const;
export const EXPLORER_SIZES = [5, 20, 60, 200, 600, 2000] as const;

/** The join graph for `shape` with these four table sizes. */
export function fkGraph(shape: GraphShape, sizes: readonly number[], rowsPerPage: number): { nodes: JoinOrderNode[]; edges: JoinOrderEdge[] } {
  const nodes = EXPLORER_TABLES.map((name, i) => {
    const rows = sizes[i] ?? 1;
    return { name, rows, pages: Math.max(1, Math.ceil(rows / rowsPerPage)) };
  });
  const edges = SHAPE_EDGES[shape].map(([x, y]) => {
    const distinct = Math.min(nodes[x]!.rows, nodes[y]!.rows);
    return { a: nodes[x]!.name, aColumn: 'fk', aNdistinct: distinct, b: nodes[y]!.name, bColumn: 'fk', bNdistinct: distinct };
  });
  return { nodes, edges };
}

export interface SweepResult {
  graphs: number;
  /** Graphs where the cheapest plan of any shape is cheaper than the cheapest left-deep one. */
  bushyCheaper: number;
  byShape: Record<GraphShape, { graphs: number; bushyCheaper: number }>;
  /** The graph where bushy wins by the most: how much (left-deep pages over bushy pages), and its plan. */
  best: { shape: GraphShape; sizes: number[]; ratio: number; tree: JoinTree } | null;
  /** How many of the bushy wins split all four tables into two pairs, `(X ⋈ Y) ⋈ (Z ⋈ W)`. */
  twoPairs: number;
}

/** Every graph the explorer's menus can make, searched both ways. */
export function sweepShapes(rowsPerPage: number): SweepResult {
  const result: SweepResult = {
    graphs: 0,
    bushyCheaper: 0,
    byShape: { chain: { graphs: 0, bushyCheaper: 0 }, star: { graphs: 0, bushyCheaper: 0 } },
    best: null,
    twoPairs: 0,
  };
  const choices = EXPLORER_SIZES;
  for (const shape of GRAPH_SHAPES) {
    for (const a of choices) for (const b of choices) for (const c of choices) for (const d of choices) {
      const sizes = [a, b, c, d];
      const { nodes, edges } = fkGraph(shape, sizes, rowsPerPage);
      const search = searchJoinShapes(nodes, edges, rowsPerPage);
      const left = search.leftDeep.get(search.fullMask)!;
      const any = search.bushy.get(search.fullMask)!;
      result.graphs += 1;
      result.byShape[shape].graphs += 1;
      if (any.pages >= left.pages) continue;
      result.bushyCheaper += 1;
      result.byShape[shape].bushyCheaper += 1;
      const tree = any.tree;
      if (tree.kind === 'join' && tree.outer.kind === 'join' && tree.inner.kind === 'join') result.twoPairs += 1;
      const ratio = left.pages / any.pages;
      if (!result.best || ratio > result.best.ratio) result.best = { shape, sizes, ratio, tree };
    }
  }
  return result;
}
