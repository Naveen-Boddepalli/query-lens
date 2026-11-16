/**
 * A join across partitions (plan.md §27.5 X4): two tables spread over the same nodes by `partitioning.ts`, joined on an
 * equality, and what each way of doing it costs in **rows sent over the network** — the price of a distributed join.
 *
 * - **Co-located**: when both tables are partitioned by the same hash of their own join column, on the same nodes, every
 *   row of a key is already on that key's node: each node joins what it holds, and nothing moves. (Range partitioning
 *   is never treated as co-located here: the two tables' ranges are cut from their own key distributions, so their
 *   boundaries do not line up.)
 * - **Broadcast**: the smaller table is copied to every node, and each node joins it with its own share of the larger:
 *   `rows(small) × (nodes − 1)` cross the network.
 * - **Shuffle**: every row of both tables is sent to the node its join key hashes to — unless it is already there — so
 *   equal keys meet: about `(nodes − 1) / nodes` of both tables cross. A row whose key is NULL matches nothing and
 *   stays where it is.
 *
 * Every strategy's matches are counted node by node, and must add up to what joining the two tables in one place
 * gives; a test holds them to it.
 */

import { fnv, hashKeyOf, partition } from './partitioning.ts';
import type { PartitionScheme } from './partitioning.ts';
import type { Row, SqlValue } from './types.ts';

export interface JoinSide {
  name: string;
  rows: readonly Row[];
  /** The column it is joined on. */
  joinColumn: string;
  /** The column it is partitioned by, and how. */
  partitionColumn: string;
  scheme: PartitionScheme;
}

export type DistributedStrategy = 'co-located' | 'broadcast' | 'shuffle';

export interface StrategyCost {
  strategy: DistributedStrategy;
  /** False when the partitioning does not allow it: only co-location can be impossible. */
  possible: boolean;
  /** Rows sent from one node to another. */
  moved: number;
  /** Rows each node joins: its share of both sides once the rows have moved. */
  perNode: number[];
  /** Matches found, summed over the nodes. */
  matches: number;
}

export interface DistributedJoinResult {
  nodes: number;
  /** The smaller table: the one a broadcast copies. */
  broadcastSide: string;
  colocated: boolean;
  strategies: StrategyCost[];
  /** Matches when the two tables are joined in one place. */
  serialMatches: number;
}

/** Matches between rows of `a` and `b` on their join columns, as the engine's `=` decides them: NULL matching nothing. */
function countMatches(a: readonly Row[], aColumn: string, b: readonly Row[], bColumn: string): number {
  const counts = new Map<string, number>();
  for (const row of a) {
    const k = row[aColumn] ?? null;
    if (k !== null) counts.set(hashKeyOf(k), (counts.get(hashKeyOf(k)) ?? 0) + 1);
  }
  let found = 0;
  for (const row of b) {
    const k = row[bColumn] ?? null;
    if (k !== null) found += counts.get(hashKeyOf(k)) ?? 0;
  }
  return found;
}

export function distributedJoin(left: JoinSide, right: JoinSide, nodes: number, virtualNodes: number): DistributedJoinResult {
  const place = (side: JoinSide) =>
    partition(side.rows, side.partitionColumn, { scheme: side.scheme, nodes, virtualNodes, change: { kind: 'none' } }).before;
  const lp = place(left);
  const rp = place(right);
  const n = lp.nodes.length;
  const nodeIds = lp.nodes;
  const rowsOn = (side: JoinSide, placement: typeof lp, node: number) => side.rows.filter((_, i) => placement.rowNode[i] === node);

  const colocated =
    left.scheme !== 'range' &&
    left.scheme === right.scheme &&
    left.partitionColumn === left.joinColumn &&
    right.partitionColumn === right.joinColumn;

  // Co-located: each node joins what it already holds.
  const coPer = nodeIds.map((node) => rowsOn(left, lp, node).length + rowsOn(right, rp, node).length);
  const coMatches = colocated ? nodeIds.reduce((s, node) => s + countMatches(rowsOn(left, lp, node), left.joinColumn, rowsOn(right, rp, node), right.joinColumn), 0) : 0;

  // Broadcast the smaller side to every node.
  const [small, smallPlace, big, bigPlace] = left.rows.length <= right.rows.length ? [left, lp, right, rp] : [right, rp, left, lp];
  const bPer = nodeIds.map((node) => small.rows.length + rowsOn(big, bigPlace, node).length);
  const bMatches = nodeIds.reduce((s, node) => s + countMatches(small.rows, small.joinColumn, rowsOn(big, bigPlace, node), big.joinColumn), 0);
  void smallPlace;

  // Shuffle both sides by the hash of the join key. A row whose key is NULL can match nothing, so it stays put.
  const target = (v: SqlValue, here: number) => (v === null ? here : nodeIds[fnv(hashKeyOf(v)) % n]!);
  let shuffled = 0;
  const leftAt = new Map<number, Row[]>(nodeIds.map((x) => [x, []]));
  const rightAt = new Map<number, Row[]>(nodeIds.map((x) => [x, []]));
  left.rows.forEach((row, i) => {
    const to = target(row[left.joinColumn] ?? null, lp.rowNode[i]!);
    if (to !== lp.rowNode[i]) shuffled += 1;
    leftAt.get(to)!.push(row);
  });
  right.rows.forEach((row, i) => {
    const to = target(row[right.joinColumn] ?? null, rp.rowNode[i]!);
    if (to !== rp.rowNode[i]) shuffled += 1;
    rightAt.get(to)!.push(row);
  });
  const sPer = nodeIds.map((node) => leftAt.get(node)!.length + rightAt.get(node)!.length);
  const sMatches = nodeIds.reduce((s, node) => s + countMatches(leftAt.get(node)!, left.joinColumn, rightAt.get(node)!, right.joinColumn), 0);

  return {
    nodes: n,
    broadcastSide: small.name,
    colocated,
    strategies: [
      { strategy: 'co-located', possible: colocated, moved: 0, perNode: colocated ? coPer : nodeIds.map(() => 0), matches: coMatches },
      { strategy: 'broadcast', possible: true, moved: small.rows.length * (n - 1), perNode: bPer, matches: bMatches },
      { strategy: 'shuffle', possible: true, moved: shuffled, perNode: sPer, matches: sMatches },
    ],
    serialMatches: countMatches(left.rows, left.joinColumn, right.rows, right.joinColumn),
  };
}
