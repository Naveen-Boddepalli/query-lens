import { distributedJoin } from '../engine/distributedJoin.ts';
import type { DistributedJoinResult } from '../engine/distributedJoin.ts';
import { ordersAndPayments } from './bigJoinTables.ts';
import { ORDER_CHOICES, PAYMENT_CHOICES } from './joinPartitionLinks.ts';
import type { JoinPartitionSettings } from './joinPartitionLinks.ts';

/** plan.md §27.5 X4: orders ⋈ payments on `orders.id = payments.orderId`, each table partitioned as chosen. */

export const JOIN_VIRTUAL_NODES = 16;

export function joinPartitionRun(s: JoinPartitionSettings): DistributedJoinResult {
  const { orders, payments } = ordersAndPayments();
  const o = ORDER_CHOICES.find((c) => c.id === s.orders) ?? ORDER_CHOICES[0]!;
  const p = PAYMENT_CHOICES.find((c) => c.id === s.payments) ?? PAYMENT_CHOICES[0]!;
  return distributedJoin(
    { name: 'orders', rows: orders.rows, joinColumn: 'id', partitionColumn: o.column, scheme: o.scheme },
    { name: 'payments', rows: payments.rows, joinColumn: 'orderId', partitionColumn: p.column, scheme: p.scheme },
    s.nodes,
    JOIN_VIRTUAL_NODES,
  );
}
