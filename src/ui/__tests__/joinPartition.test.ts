/** plan.md §27.5 X4 — the partitioning page's join section: orders and payments, partitioned as chosen. */

import { describe, expect, it } from 'vitest';
import { joinPartitionRun } from '../joinPartitionRun.ts';
import { joinPartitionHref, readJoinPartitionSettings } from '../joinPartitionLinks.ts';

const moved = (nodes: number, orders: string, payments: string) =>
  Object.fromEntries(joinPartitionRun({ nodes, orders, payments }).strategies.map((s) => [s.strategy, s.possible ? s.moved : null]));

describe('orders ⋈ payments across the nodes (plan.md §27.5 X4)', () => {
  it('co-located when both are spread by the same hash of the join key: nothing moves, all 3,000 payments match', () => {
    const r = joinPartitionRun({ nodes: 4, orders: 'hash-id', payments: 'hash-orderId' });
    expect([r.colocated, r.serialMatches]).toEqual([true, 3000]);
    expect(moved(4, 'hash-id', 'hash-orderId')).toEqual({ 'co-located': 0, broadcast: 6000, shuffle: 0 });
  });

  it('payments spread by their own id: a shuffle moves 2,224 of them, a broadcast 6,000 orders; on eight nodes 2,627 against 14,000', () => {
    expect(moved(4, 'hash-id', 'hash-id')).toEqual({ 'co-located': null, broadcast: 6000, shuffle: 2224 });
    expect(moved(8, 'hash-id', 'hash-id')).toEqual({ 'co-located': null, broadcast: 14000, shuffle: 2627 });
  });

  it('ranges cut from each table’s own keys never line up; the ring does, when both are on it', () => {
    expect(moved(4, 'range-id', 'range-orderId')).toEqual({ 'co-located': null, broadcast: 6000, shuffle: 3749 });
    expect(joinPartitionRun({ nodes: 4, orders: 'consistent-id', payments: 'consistent-orderId' }).colocated).toBe(true);
  });

  it('reads its own link back', () => {
    const s = { nodes: 6, orders: 'range-id', payments: 'hash-orderId' };
    expect(readJoinPartitionSettings(new URL(joinPartitionHref(s), 'https://x').search)).toEqual(s);
  });
});
