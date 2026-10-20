import type { PartitionScheme } from '../engine/partitioning.ts';

/**
 * plan.md §27.5 X4: the distributed-join section of `/tools/partitioning` — how each table may be partitioned, and the
 * section's part of the page's link — kept apart from the models, so a lesson linking to it carries none of them.
 */

export interface PartitionChoice {
  id: string;
  label: string;
  scheme: PartitionScheme;
  column: string;
}

export const ORDER_CHOICES: readonly PartitionChoice[] = [
  { id: 'hash-id', label: 'hash of id', scheme: 'hash', column: 'id' },
  { id: 'hash-customer', label: 'hash of customer', scheme: 'hash', column: 'customer' },
  { id: 'range-id', label: 'ranges of id', scheme: 'range', column: 'id' },
  { id: 'consistent-id', label: 'the ring, by id', scheme: 'consistent', column: 'id' },
];

export const PAYMENT_CHOICES: readonly PartitionChoice[] = [
  { id: 'hash-orderId', label: 'hash of orderId', scheme: 'hash', column: 'orderId' },
  { id: 'hash-id', label: 'hash of its own id', scheme: 'hash', column: 'id' },
  { id: 'range-orderId', label: 'ranges of orderId', scheme: 'range', column: 'orderId' },
  { id: 'consistent-orderId', label: 'the ring, by orderId', scheme: 'consistent', column: 'orderId' },
];

export interface JoinPartitionSettings {
  nodes: number;
  orders: string;
  payments: string;
}

export const JOIN_PARTITION_DEFAULTS: JoinPartitionSettings = { nodes: 4, orders: 'hash-id', payments: 'hash-id' };

/** The page's link with the join section set as given (the rest of the page at its defaults). */
export function joinPartitionHref(s: JoinPartitionSettings): string {
  return `/tools/partitioning?jn=${String(s.nodes)}&jo=${s.orders}&jp=${s.payments}`;
}

export function readJoinPartitionSettings(search: string): JoinPartitionSettings {
  const p = new URLSearchParams(search);
  const d = JOIN_PARTITION_DEFAULTS;
  const n = Number(p.get('jn'));
  return {
    nodes: Number.isInteger(n) && n >= 2 && n <= 10 ? n : d.nodes,
    orders: ORDER_CHOICES.some((c) => c.id === p.get('jo')) ? p.get('jo')! : d.orders,
    payments: PAYMENT_CHOICES.some((c) => c.id === p.get('jp')) ? p.get('jp')! : d.payments,
  };
}
