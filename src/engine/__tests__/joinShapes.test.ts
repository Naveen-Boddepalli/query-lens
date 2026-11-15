/**
 * plan.md §27.5 T4 — bushy plans beside left-deep ones over the same subset lattice: how many there are, that the
 * search finds the cheapest of each (checked against every plan, enumerated), and where a bushy one wins.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from '../parser/index.ts';
import { connectedPlanCounts, costOfOrder, isLeftDeep, joinGraphFromAst, planCounts, runJoinOrderDP, searchJoinShapes, treeText } from '../planner/index.ts';
import type { JoinOrderEdge, JoinOrderNode, JoinTree } from '../planner/index.ts';
import { createJoinOrderDemoDatabase } from '../seed.ts';

const RPP = 4;

/** Every plan for `names`, enumerated outright: each split into an outer and an inner part, recursively. */
function allTrees(names: readonly string[]): JoinTree[] {
  if (names.length === 1) return [{ kind: 'scan', table: names[0]! }];
  const out: JoinTree[] = [];
  const n = names.length;
  for (let inner = 1; inner < (1 << n) - 1; inner++) {
    const innerNames = names.filter((_, i) => inner & (1 << i));
    const outerNames = names.filter((_, i) => !(inner & (1 << i)));
    for (const o of allTrees(outerNames)) for (const i of allTrees(innerNames)) out.push({ kind: 'join', outer: o, inner: i });
  }
  return out;
}

const leaves = (t: JoinTree): string[] => (t.kind === 'scan' ? [t.table] : [...leaves(t.outer), ...leaves(t.inner)]);

/** The cost model, written again from its description, for one whole plan. */
function costOf(tree: JoinTree, nodes: readonly JoinOrderNode[], edges: readonly JoinOrderEdge[]): { rows: number; pages: number } {
  const rowsOf = (names: readonly string[]) => {
    let r = names.reduce((acc, name) => acc * nodes.find((t) => t.name === name)!.rows, 1);
    for (const e of edges) if (names.includes(e.a) && names.includes(e.b)) r /= Math.max(1, e.aNdistinct, e.bNdistinct);
    return Math.max(0, Math.round(r));
  };
  if (tree.kind === 'scan') {
    const t = nodes.find((x) => x.name === tree.table)!;
    return { rows: t.rows, pages: t.pages };
  }
  const outer = costOf(tree.outer, nodes, edges);
  const rows = rowsOf(leaves(tree));
  if (tree.inner.kind === 'scan') {
    const t = nodes.find((x) => x.name === (tree.inner as { table: string }).table)!;
    return { rows, pages: outer.pages + outer.rows * t.pages };
  }
  const inner = costOf(tree.inner, nodes, edges);
  const written = Math.max(1, Math.ceil(inner.rows / RPP));
  return { rows, pages: outer.pages + inner.pages + written + outer.rows * written };
}

const crossFree = (tree: JoinTree, edges: readonly JoinOrderEdge[]): boolean => {
  if (tree.kind === 'scan') return true;
  const o = leaves(tree.outer);
  const i = leaves(tree.inner);
  const linked = edges.some((e) => (o.includes(e.a) && i.includes(e.b)) || (o.includes(e.b) && i.includes(e.a)));
  return linked && crossFree(tree.outer, edges) && crossFree(tree.inner, edges);
};

const graphArb = fc.integer({ min: 2, max: 5 }).chain((n) =>
  fc
    .tuple(
      fc.array(fc.integer({ min: 1, max: 400 }), { minLength: n, maxLength: n }),
      fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 400 })), { minLength: n - 1, maxLength: n - 1 }),
      fc.array(fc.tuple(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 400 })), { maxLength: 2 }),
    )
    .map(([rows, tree, extra]) => {
      const nodes = rows.map((r, i) => ({ name: `t${String(i)}`, rows: r, pages: Math.max(1, Math.ceil(r / RPP)) }));
      // A spanning tree of predicates, and now and then one more that closes a cycle.
      const edges: JoinOrderEdge[] = tree.map(([parent, va, vb], k) => ({
        a: `t${String(parent % (k + 1))}`, aColumn: 'x', aNdistinct: va, b: `t${String(k + 1)}`, bColumn: 'y', bNdistinct: vb,
      }));
      for (const [x, y, v] of extra) {
        const a = x % n;
        const b = y % n;
        if (a !== b) edges.push({ a: `t${String(a)}`, aColumn: 'z', aNdistinct: v, b: `t${String(b)}`, bColumn: 'z', bNdistinct: v });
      }
      return { nodes, edges };
    }),
);

describe('how many plans there are (plan.md §27.5 T4)', () => {
  it('n! left-deep orders and (2n − 2)!/(n − 1)! bushy trees, counted against every tree enumerated', () => {
    for (let n = 1; n <= 6; n++) {
      const trees = allTrees(Array.from({ length: n }, (_, i) => `t${String(i)}`));
      expect(planCounts(n), `n = ${String(n)}`).toEqual({ leftDeep: trees.filter(isLeftDeep).length, bushy: trees.length });
    }
    expect(planCounts(4)).toEqual({ leftDeep: 24, bushy: 120 });
    expect(planCounts(10)).toEqual({ leftDeep: 3_628_800, bushy: 17_643_225_600 });
  });

  it('and, for one graph, those with no cross product anywhere', () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const trees = allTrees(nodes.map((t) => t.name)).filter((t) => crossFree(t, edges));
        expect(connectedPlanCounts(nodes, edges)).toEqual({ leftDeep: trees.filter(isLeftDeep).length, bushy: trees.length });
      }),
      { numRuns: 60, seed: 4 },
    );
  });
});

describe('the search over the subset lattice (plan.md §27.5 T4)', () => {
  it('finds the cheapest left-deep plan and the cheapest plan of any shape, as pricing every plan does', () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const search = searchJoinShapes(nodes, edges, RPP);
        const trees = allTrees(nodes.map((t) => t.name));
        const cheapest = (ts: JoinTree[]) => Math.min(...ts.map((t) => costOf(t, nodes, edges).pages));
        const left = search.leftDeep.get(search.fullMask)!;
        const any = search.bushy.get(search.fullMask)!;
        expect(left.pages).toBe(cheapest(trees.filter(isLeftDeep)));
        expect(any.pages).toBe(cheapest(trees));
        // Each is what its own tree costs, and the left-deep one is left-deep.
        expect(costOf(left.tree, nodes, edges).pages).toBe(left.pages);
        expect(costOf(any.tree, nodes, edges).pages).toBe(any.pages);
        expect(isLeftDeep(left.tree)).toBe(true);
        // Every subset has one size, whichever plan built it.
        expect(left.rows).toBe(any.rows);
        for (const [mask, plan] of search.bushy) expect(plan.pages).toBeLessThanOrEqual(search.leftDeep.get(mask)!.pages);
      }),
      { numRuns: 150, seed: 44 },
    );
  });

  it('prices k candidates for a k-table subset left-deep, and 2^k − 2 splits bushy', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((name) => ({ name, rows: 10, pages: 3 }));
    const edges = [{ a: 'a', aColumn: 'x', aNdistinct: 10, b: 'b', bColumn: 'x', bNdistinct: 10 }];
    const search = searchJoinShapes(nodes, edges, RPP);
    // Six pairs, four triples, one quadruple.
    expect(search.steps).toEqual({ leftDeep: 6 * 2 + 4 * 3 + 4, bushy: 6 * 2 + 4 * 6 + 14 });
    expect(search.splits.get(search.fullMask)).toHaveLength(14);
  });
});

describe('the demo query, and where a bushy plan wins (plan.md §27.5 T4)', () => {
  const demo = () => {
    const parsed = parse(
      'SELECT * FROM departments JOIN projects ON departments.id = projects.deptId JOIN employees ON departments.id = employees.deptId JOIN timesheets ON employees.id = timesheets.employeeId',
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    return joinGraphFromAst(parsed.ast, createJoinOrderDemoDatabase().tables, RPP);
  };

  it('on the demo query, the left-deep winner is the planner’s own, and a bushy plan is a little cheaper', () => {
    const { nodes, edges } = demo();
    const search = searchJoinShapes(nodes, edges, RPP);
    const left = search.leftDeep.get(search.fullMask)!;
    const selinger = runJoinOrderDP(nodes, edges).winner;
    expect(left.pages).toBe(selinger.pages);
    expect(treeText(left.tree)).toBe(`((${selinger.tables[0]!} ⋈ ${selinger.tables[1]!}) ⋈ ${selinger.tables[2]!}) ⋈ ${selinger.tables[3]!}`);
    const any = search.bushy.get(search.fullMask)!;
    expect(treeText(any.tree)).toBe('(departments ⋈ projects) ⋈ (employees ⋈ timesheets)');
    expect([left.pages, any.pages]).toEqual([290_252, 288_842]);
    expect(connectedPlanCounts(nodes, edges)).toEqual({ leftDeep: 8, bushy: 40 });
  });
});

describe('why this search gives a subset one size (plan.md §27.5 T4)', () => {
  it('the planner’s own search, whose estimate depends on the order, can keep a cheap subset plan that costs more later', () => {
    const nodes = [
      { name: 'a', rows: 25, pages: 7 },
      { name: 'b', rows: 9, pages: 3 },
      { name: 'c', rows: 33, pages: 9 },
    ];
    const edges = [
      { a: 'a', aColumn: 'x', aNdistinct: 1, b: 'b', bColumn: 'x', bNdistinct: 1 },
      { a: 'b', aColumn: 'y', aNdistinct: 17, b: 'c', bColumn: 'y', bNdistinct: 9 },
    ];
    // {b, c}: b then c is 84 pages and 33 rows, c then b is 108 pages and 17 rows. It keeps the first.
    const dp = runJoinOrderDP(nodes, edges);
    expect(dp.subsets.get(0b110)!.tables).toEqual(['b', 'c']);
    expect(costOfOrder(nodes, edges, ['b', 'c'])).toEqual({ rows: 33, pages: 84 });
    expect(costOfOrder(nodes, edges, ['c', 'b'])).toEqual({ rows: 17, pages: 108 });
    // Adding a to 33 rows costs more than adding it to 17 did.
    expect(dp.winner.tables).toEqual(['b', 'c', 'a']);
    expect(dp.winner.pages).toBe(315);
    expect(costOfOrder(nodes, edges, ['c', 'b', 'a']).pages).toBe(227);
    // With one size per subset, cheapest-per-subset is exact, as the property test above checks.
    const shapes = searchJoinShapes(nodes, edges, RPP);
    expect(shapes.rows.get(0b110)).toBe(17);
  });
});
