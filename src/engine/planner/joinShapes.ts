/**
 * Bushy plans beside left-deep ones (plan.md §27.5 T4), over the same subset lattice `joinOrder.ts` searches.
 *
 * A **left-deep** plan adds one table at a time, so every join's inner side is a stored table. A **bushy** plan may
 * also join two joined results: for each subset the search tries every way to split it into an outer part and an
 * inner part, not only "which one table goes last" — `2^k − 2` splits for a subset of `k` tables where left-deep tries
 * `k`. The engine only ever *runs* left-deep chains, so these are plans priced, never run.
 *
 * Two choices keep the comparison about shape and nothing else:
 *
 * - **One size per set of tables.** A subset's row estimate is System R's: the product of its tables' rows, with each
 *   join predicate inside it keeping one row in `max(V(a), V(b))` of them. Every plan for the same tables then has the
 *   same size, so two plans differ only in their shape — and the dynamic program is exact: the cheapest plan for a
 *   subset is built from the cheapest plans for its parts. (`joinOrder.ts` estimates each join from the table it adds,
 *   as `cost.ts` does, which can give the same tables different sizes in different orders.)
 * - **Nested loops, as `joinOrder.ts` prices them.** A join whose inner side is a stored table costs
 *   `outer + rows(outer) × pages(inner)`, exactly as there. An inner side that is itself a join is computed once and
 *   written out — `pages(result) = ⌈rows / rowsPerPage⌉` — then read once for every outer row:
 *   `outer + inner + pages(result) + rows(outer) × pages(result)`.
 */

import type { JoinOrderEdge, JoinOrderNode } from './joinOrder.ts';

export type JoinTree = { kind: 'scan'; table: string } | { kind: 'join'; outer: JoinTree; inner: JoinTree };

export interface ShapePlan {
  mask: number;
  tree: JoinTree;
  rows: number;
  pages: number;
}

/** One way the bushy search split a subset: `outer` joined with `inner`, each built its cheapest way. */
export interface ShapeSplit {
  outer: number;
  inner: number;
  pages: number;
}

export interface ShapeSearch {
  /** `nodeNames[i]` is the table bit `i` names in every mask. */
  nodeNames: readonly string[];
  /** Every non-empty subset's row estimate — the same whichever way it is joined. */
  rows: ReadonlyMap<number, number>;
  /** The cheapest left-deep plan for every subset. */
  leftDeep: ReadonlyMap<number, ShapePlan>;
  /** The cheapest plan of any shape for every subset. */
  bushy: ReadonlyMap<number, ShapePlan>;
  /** Every split the bushy search priced for each subset of two or more tables, cheapest first. */
  splits: ReadonlyMap<number, readonly ShapeSplit[]>;
  /** How many candidates each search priced: one per table added last, or one per split. */
  steps: { leftDeep: number; bushy: number };
  fullMask: number;
}

const popcount = (mask: number): number => {
  let count = 0;
  for (let m = mask; m !== 0; m >>>= 1) count += m & 1;
  return count;
};

/** Searches both shapes over the subset lattice. `nodes` must be non-empty. */
export function searchJoinShapes(nodes: readonly JoinOrderNode[], edges: readonly JoinOrderEdge[], rowsPerPage: number): ShapeSearch {
  const n = nodes.length;
  if (n === 0) throw new Error('unreachable: searchJoinShapes needs at least one table');
  const nodeNames = nodes.map((t) => t.name);
  const bitOf = new Map(nodeNames.map((name, i) => [name, 1 << i]));
  const fullMask = (1 << n) - 1;

  const rows = new Map<number, number>();
  for (let mask = 1; mask <= fullMask; mask++) {
    let estimate = 1;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) estimate *= nodes[i]!.rows;
    for (const e of edges) {
      const a = bitOf.get(e.a);
      const b = bitOf.get(e.b);
      if (a === undefined || b === undefined || !(mask & a) || !(mask & b)) continue;
      estimate /= Math.max(1, e.aNdistinct, e.bNdistinct);
    }
    rows.set(mask, Math.max(0, Math.round(estimate)));
  }
  const resultPages = (mask: number) => Math.max(1, Math.ceil(rows.get(mask)! / rowsPerPage));

  const leftDeep = new Map<number, ShapePlan>();
  const bushy = new Map<number, ShapePlan>();
  for (let i = 0; i < n; i++) {
    const t = nodes[i]!;
    const leaf: ShapePlan = { mask: 1 << i, tree: { kind: 'scan', table: t.name }, rows: t.rows, pages: t.pages };
    leftDeep.set(leaf.mask, leaf);
    bushy.set(leaf.mask, leaf);
  }

  /** What joining `outer` with `inner` costs, each built the way `plans` says. */
  const join = (plans: Map<number, ShapePlan>, outer: number, inner: number): ShapePlan => {
    const o = plans.get(outer)!;
    const i = plans.get(inner)!;
    const pages =
      popcount(inner) === 1
        ? o.pages + o.rows * i.pages
        : o.pages + i.pages + resultPages(inner) + o.rows * resultPages(inner);
    return { mask: outer | inner, tree: { kind: 'join', outer: o.tree, inner: i.tree }, rows: rows.get(outer | inner)!, pages };
  };

  const splits = new Map<number, ShapeSplit[]>();
  const steps = { leftDeep: 0, bushy: 0 };
  const masks = Array.from({ length: fullMask }, (_, k) => k + 1).sort((a, b) => popcount(a) - popcount(b) || a - b);
  for (const mask of masks) {
    if (popcount(mask) < 2) continue;
    // Left-deep: which one table goes last, in table order — the order `runJoinOrderDP` tries them in.
    let bestLeft: ShapePlan | null = null;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      steps.leftDeep += 1;
      const plan = join(leftDeep, mask & ~bit, bit);
      if (!bestLeft || plan.pages < bestLeft.pages) bestLeft = plan;
    }
    leftDeep.set(mask, bestLeft!);

    // Bushy: every ordered split into a non-empty outer and inner, each its cheapest way.
    const tried: ShapeSplit[] = [];
    let bestAny: ShapePlan | null = null;
    for (let inner = 1; inner < mask; inner++) {
      if ((inner & ~mask) !== 0) continue;
      steps.bushy += 1;
      const plan = join(bushy, mask & ~inner, inner);
      tried.push({ outer: mask & ~inner, inner, pages: plan.pages });
      if (!bestAny || plan.pages < bestAny.pages) bestAny = plan;
    }
    tried.sort((a, b) => a.pages - b.pages);
    splits.set(mask, tried);
    bushy.set(mask, bestAny!);
  }

  return { nodeNames, rows, leftDeep, bushy, splits, steps, fullMask };
}

/** Is every join's inner side a stored table? */
export function isLeftDeep(tree: JoinTree): boolean {
  return tree.kind === 'scan' || (tree.inner.kind === 'scan' && isLeftDeep(tree.outer));
}

/** `(departments ⋈ projects) ⋈ (employees ⋈ timesheets)` — outer on the left, the outermost join unbracketed. */
export function treeText(tree: JoinTree, top = true): string {
  if (tree.kind === 'scan') return tree.table;
  const text = `${treeText(tree.outer, false)} ⋈ ${treeText(tree.inner, false)}`;
  return top ? text : `(${text})`;
}

const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));

/**
 * How many plans there are for `n` tables, cross products included and outer told apart from inner: `n!` left-deep
 * orders, and `(2n − 2)! / (n − 1)!` bushy trees — every binary tree with `n` leaves (a Catalan number of shapes)
 * times every way to place the tables on its leaves.
 */
export function planCounts(n: number): { leftDeep: number; bushy: number } {
  return { leftDeep: factorial(n), bushy: factorial(2 * n - 2) / factorial(n - 1) };
}

/**
 * The same counts for one join graph with no cross product anywhere: a left-deep order where every table added has a
 * predicate to the ones before it, and a bushy tree where every join has a predicate across it.
 */
export function connectedPlanCounts(nodes: readonly JoinOrderNode[], edges: readonly JoinOrderEdge[]): { leftDeep: number; bushy: number } {
  const n = nodes.length;
  const bitOf = new Map(nodes.map((t, i) => [t.name, 1 << i]));
  const pairs = edges.flatMap((e) => {
    const a = bitOf.get(e.a);
    const b = bitOf.get(e.b);
    return a === undefined || b === undefined ? [] : [[a, b] as const];
  });
  const across = (x: number, y: number) => pairs.some(([a, b]) => (x & a && y & b) || (x & b && y & a));
  const fullMask = (1 << n) - 1;
  const left = new Map<number, number>();
  const any = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    left.set(1 << i, 1);
    any.set(1 << i, 1);
  }
  const masks = Array.from({ length: fullMask }, (_, k) => k + 1).sort((a, b) => popcount(a) - popcount(b));
  for (const mask of masks) {
    if (popcount(mask) < 2) continue;
    let l = 0;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (mask & bit && across(mask & ~bit, bit)) l += left.get(mask & ~bit)!;
    }
    left.set(mask, l);
    let b = 0;
    for (let inner = 1; inner < mask; inner++) {
      if ((inner & ~mask) !== 0 || !across(mask & ~inner, inner)) continue;
      b += any.get(mask & ~inner)! * any.get(inner)!;
    }
    any.set(mask, b);
  }
  return { leftDeep: left.get(fullMask)!, bushy: any.get(fullMask)! };
}
