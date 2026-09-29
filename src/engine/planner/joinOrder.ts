/**
 * Selinger-style join ordering by dynamic programming (plan.md §25.4 C4), over the **subset lattice**: for `n`
 * tables there are `2^n - 1` non-empty subsets, and the cheapest way to join every table in a subset is built up
 * from the cheapest way to join every smaller subset one table down — bottom-up, smallest subsets first, exactly
 * the textbook System R algorithm (Selinger et al., 1979).
 *
 * Restricted to **left-deep** orderings on purpose: the engine's own `Join` operator (plan.md §25.4 C3 slice b)
 * only ever executes a left-deep chain, so a bushy plan this module might otherwise consider is one the engine
 * could never actually run. That restriction is also what keeps this simple — a subset's own best plan is just
 * "which table was added last," not "which two smaller subsets were merged," so there is no need to search which
 * way to *split* a subset, only which single table to peel off it.
 *
 * A **cross join is never forbidden**, only costed honestly: when two tables share no join predicate, joining
 * them anyway (`rows(a) × rows(b)`, no selectivity) is a real, always-available option — it just loses the cost
 * comparison so badly that the DP never picks it unless the graph genuinely offers nothing better. Nothing here
 * needs to reason about the join graph's connectivity to avoid a cross join; the real cost already does that.
 *
 * The cost formula mirrors `cost.ts`'s own `Join` case exactly (nested-loop, the engine's default and the one
 * algorithm every join order is meaningful for): `pages = left.pages + left.rows × right.pages`, and
 * `rows = left.rows × right.rows / ndistinct(right's join column)` — see `cost.ts:358-426` for the source this
 * is kept consistent with. Ordering is deliberately scored on **page cost**, not row count: row count alone
 * cannot tell two orders with the same output size but very different rescan cost apart.
 *
 * Deliberately visualization-only (plan.md §25.4 C4's own scoping decision): this module never changes what a
 * real query actually executes as — `runQuery.ts`'s multi-join chain still always runs in the order it was
 * written. `/tools/join-order` and the Playground's own informational note both only ever *show* what this
 * function would have chosen, alongside the real, unchanged plan.
 */

import type { SelectStatement } from '../parser/index.ts';
import type { Table } from '../types.ts';
import { ndistinct } from './cost.ts';

export interface JoinOrderNode {
  name: string;
  rows: number;
  pages: number;
}

/**
 * One join predicate between two tables — undirected for the DP's purposes (either side may end up "added" to
 * the other), so both directions' `ndistinct` travel with the edge: whichever table ends up on the *added* side
 * of a step is the one whose own `ndistinct` bounds the estimate, exactly as `cost.ts`'s `rightDistinct` always
 * reads the *introduced* table's column, never the other side's.
 */
export interface JoinOrderEdge {
  a: string;
  aColumn: string;
  aNdistinct: number;
  b: string;
  bColumn: string;
  bNdistinct: number;
}

/** One option the DP considered for a subset's own last step — every one it tried, not just the winner. */
export interface JoinOrderCandidate {
  addedTable: string;
  /** `false` means no join predicate connected `addedTable` to the rest of the subset — a cross join. */
  viaEdge: boolean;
  rows: number;
  pages: number;
}

export interface SubsetPlan {
  mask: number;
  /** The winning left-deep order to build exactly this subset, first table first. */
  tables: readonly string[];
  rows: number;
  pages: number;
  /** Every table the DP tried adding last for this subset, cheapest first — empty for a singleton, which has no choice. */
  candidates: readonly JoinOrderCandidate[];
}

export interface JoinOrderResult {
  /** `nodeNames[i]` is the table bit `i` names in every `mask` below. */
  nodeNames: readonly string[];
  /** Every non-empty subset's own best plan, keyed by its bitmask. */
  subsets: ReadonlyMap<number, SubsetPlan>;
  /** `subsets.get(fullMask)` — the DP's overall answer. */
  winner: SubsetPlan;
}

const clampRows = (value: number): number => Math.max(0, Math.round(value));
const popcount = (mask: number): number => {
  let count = 0;
  for (let m = mask; m !== 0; m >>>= 1) count += m & 1;
  return count;
};

/**
 * Runs the DP. `nodes` must be non-empty; a single table has nothing to order and returns immediately with one
 * singleton subset. Capped implicitly by `2^nodes.length` states — teaching-sized graphs only (plan.md's own
 * datasets never approach the twenty-ish tables where this would start to matter).
 */
export function runJoinOrderDP(nodes: readonly JoinOrderNode[], edges: readonly JoinOrderEdge[]): JoinOrderResult {
  const n = nodes.length;
  if (n === 0) throw new Error('unreachable: runJoinOrderDP needs at least one table');
  const nodeNames = nodes.map((t) => t.name);
  const indexOf = new Map(nodeNames.map((name, i) => [name, i]));

  // An edge is undirected for lookup purposes — keyed by the pair of bit indices, lowest first.
  const edgeFor = new Map<string, JoinOrderEdge>();
  for (const e of edges) {
    const ia = indexOf.get(e.a);
    const ib = indexOf.get(e.b);
    if (ia === undefined || ib === undefined) continue; // an edge naming a table outside `nodes` is simply unusable
    edgeFor.set(`${String(Math.min(ia, ib))}-${String(Math.max(ia, ib))}`, e);
  }

  const subsets = new Map<number, SubsetPlan>();
  for (let i = 0; i < n; i++) {
    const t = nodes[i]!;
    const mask = 1 << i;
    subsets.set(mask, { mask, tables: [t.name], rows: t.rows, pages: t.pages, candidates: [] });
  }

  const masksBySize: number[][] = Array.from({ length: n + 1 }, () => []);
  for (let mask = 1; mask < 1 << n; mask++) masksBySize[popcount(mask)]!.push(mask);

  for (let size = 2; size <= n; size++) {
    for (const mask of masksBySize[size]!) {
      const candidates: JoinOrderCandidate[] = [];
      for (let i = 0; i < n; i++) {
        const bit = 1 << i;
        if (!(mask & bit)) continue;
        const prevMask = mask & ~bit;
        const prev = subsets.get(prevMask);
        if (!prev) continue; // unreachable: every smaller mask is filled before this size runs
        const t = nodes[i]!;

        // The cheapest real join predicate connecting `t` to anything already in `prevMask` — there may be
        // several (a star-shaped graph can have `t` adjacent to more than one table already joined in).
        let viaEdge: { rows: number } | null = null;
        for (let j = 0; j < n; j++) {
          if (!(prevMask & (1 << j))) continue;
          const edge = edgeFor.get(`${String(Math.min(i, j))}-${String(Math.max(i, j))}`);
          if (!edge) continue;
          const tDistinct = edge.a === t.name ? edge.aNdistinct : edge.bNdistinct;
          const rows = clampRows((prev.rows * t.rows) / Math.max(1, tDistinct));
          if (!viaEdge || rows < viaEdge.rows) viaEdge = { rows };
        }
        const rows = viaEdge ? viaEdge.rows : clampRows(prev.rows * t.rows);
        const pages = prev.pages + prev.rows * t.pages;
        candidates.push({ addedTable: t.name, viaEdge: viaEdge !== null, rows, pages });
      }

      candidates.sort((a, b) => a.pages - b.pages);
      const winner = candidates[0]!;
      const winnerBit = 1 << indexOf.get(winner.addedTable)!;
      const prevPlan = subsets.get(mask & ~winnerBit)!;
      subsets.set(mask, {
        mask,
        tables: [...prevPlan.tables, winner.addedTable],
        rows: winner.rows,
        pages: winner.pages,
        candidates,
      });
    }
  }

  const fullMask = (1 << n) - 1;
  return { nodeNames, subsets, winner: subsets.get(fullMask)! };
}

/**
 * The same cost formula `runJoinOrderDP` searches with, applied to one *specific* order instead of searching for
 * the cheapest one — how much a query's own, as-written join order actually costs, for comparison against the
 * DP's own suggestion. `order` must name every one of `nodes` exactly once; the first is the base scan.
 */
export function costOfOrder(
  nodes: readonly JoinOrderNode[],
  edges: readonly JoinOrderEdge[],
  order: readonly string[],
): { rows: number; pages: number } {
  const byName = new Map(nodes.map((t) => [t.name, t]));
  const edgeFor = new Map<string, JoinOrderEdge>();
  for (const e of edges) {
    edgeFor.set(`${e.a}-${e.b}`, e);
    edgeFor.set(`${e.b}-${e.a}`, e);
  }

  const first = byName.get(order[0]!)!;
  let rows = first.rows;
  let pages = first.pages;
  const soFar = [order[0]!];
  for (let k = 1; k < order.length; k++) {
    const t = byName.get(order[k]!)!;
    let bestRows: number | null = null;
    for (const prevName of soFar) {
      const edge = edgeFor.get(`${prevName}-${t.name}`);
      if (!edge) continue;
      const tDistinct = edge.a === t.name ? edge.aNdistinct : edge.bNdistinct;
      const candidateRows = clampRows((rows * t.rows) / Math.max(1, tDistinct));
      if (bestRows === null || candidateRows < bestRows) bestRows = candidateRows;
    }
    pages = pages + rows * t.pages;
    rows = bestRows ?? clampRows(rows * t.rows);
    soFar.push(t.name);
  }
  return { rows, pages };
}

/**
 * Builds the join graph `runJoinOrderDP` needs straight from a parsed, already-resolved multi-join query — the
 * same table/column resolution `buildJoinPlan` (`buildPlan.ts`) already does per step, just collecting it into a
 * graph instead of folding it into a left-deep `Plan`. `tables` must have an entry for `ast.from.name` and every
 * `ast.joins` table name (`runQuery.ts` already resolves exactly this map before planning).
 */
export function joinGraphFromAst(
  ast: SelectStatement,
  tables: Record<string, Table>,
  rowsPerPage: number,
): { nodes: JoinOrderNode[]; edges: JoinOrderEdge[] } {
  const heapPages = (t: Table): number => Math.max(1, Math.ceil(t.rows.length / rowsPerPage));
  const nodeFor = (name: string): JoinOrderNode => {
    const t = tables[name]!;
    return { name, rows: t.rows.length, pages: heapPages(t) };
  };

  const nodes: JoinOrderNode[] = [nodeFor(ast.from.name)];
  const edges: JoinOrderEdge[] = [];
  for (const join of ast.joins ?? []) {
    const { left, right } = join.on;
    if (left.kind !== 'column' || right.kind !== 'column') continue; // unreachable: checkJoinOn guarantees this
    const newTable = join.table.name;
    // checkJoinChain already guarantees exactly one side names newTable and the other a table already in scope.
    const newTableIsLeftOperand = left.table === newTable;
    const bColumn = newTableIsLeftOperand ? left.name : right.name;
    const aColumn = newTableIsLeftOperand ? right.name : left.name;
    const aTable = (newTableIsLeftOperand ? right.table : left.table)!;

    nodes.push(nodeFor(newTable));
    edges.push({
      a: aTable,
      aColumn,
      aNdistinct: ndistinct(tables[aTable]!, aColumn),
      b: newTable,
      bColumn,
      bNdistinct: ndistinct(tables[newTable]!, bColumn),
    });
  }
  return { nodes, edges };
}

/** The table order a multi-join query was actually *written* in — `FROM`'s table, then each `JOIN` in source order. */
export function writtenOrderFromAst(ast: SelectStatement): string[] {
  return [ast.from.name, ...(ast.joins ?? []).map((j) => j.table.name)];
}
