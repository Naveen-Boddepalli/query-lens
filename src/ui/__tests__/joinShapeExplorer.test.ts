/** plan.md §27.5 T4 — the join-order page's shape explorer: foreign-key graphs, and every one its menus make. */

import { describe, expect, it } from 'vitest';
import { searchJoinShapes, treeText } from '../../engine/planner/index.ts';
import { fkGraph, sweepShapes } from '../joinShapeExplorer.ts';

const RPP = 4;

describe('where a bushy plan wins (plan.md §27.5 T4)', () => {
  it('builds each predicate as a foreign key from the bigger table to the smaller', () => {
    const { nodes, edges } = fkGraph('star', [5, 600, 20, 2000], RPP);
    expect(nodes.map((t) => [t.name, t.rows, t.pages])).toEqual([['A', 5, 2], ['B', 600, 150], ['C', 20, 5], ['D', 2000, 500]]);
    expect(edges.map((e) => [e.a, e.b, e.aNdistinct, e.bNdistinct])).toEqual([['A', 'B', 5, 5], ['A', 'C', 5, 5], ['A', 'D', 5, 5]]);
    // A join of a table with one it references has the referencing table's rows.
    expect(searchJoinShapes(nodes, edges, RPP).rows.get(0b0011)).toBe(600);
  });

  it('two pairs on a chain: the second pair joined once, and read for every row of the first', () => {
    const { nodes, edges } = fkGraph('chain', [5, 600, 5, 20], RPP);
    const search = searchJoinShapes(nodes, edges, RPP);
    expect(search.leftDeep.get(search.fullMask)!.pages).toBe(4952);
    expect(search.bushy.get(search.fullMask)!.pages).toBe(3784);
    expect(treeText(search.bushy.get(search.fullMask)!.tree)).toBe('(A ⋈ B) ⋈ (C ⋈ D)');
  });

  it('across every graph the menus make, bushy wins now and then, and never by much', () => {
    const sweep = sweepShapes(RPP);
    expect(sweep.graphs).toBe(2 * 6 ** 4);
    expect(sweep.bushyCheaper).toBe(425);
    expect(sweep.byShape).toEqual({ chain: { graphs: 1296, bushyCheaper: 345 }, star: { graphs: 1296, bushyCheaper: 80 } });
    expect(sweep.twoPairs).toBe(315);
    expect(sweep.best?.shape).toBe('chain');
    expect(sweep.best!.ratio).toBeGreaterThan(1.3);
    expect(sweep.best!.ratio).toBeLessThan(1.35);
    expect(treeText(sweep.best!.tree)).toBe('(A ⋈ B) ⋈ (C ⋈ D)');
  });
});
