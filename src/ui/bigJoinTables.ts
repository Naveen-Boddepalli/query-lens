import type { Table } from '../engine/types.ts';

/**
 * plan.md §27.5 P2, X4: two big tables made for joining — 2,000 orders and 3,000 payments, one or two per order — on
 * their own, so a page that joins them across nodes does not carry the parser and the exchange model with them.
 */

let tables: { orders: Table; payments: Table } | null = null;

export function ordersAndPayments(): { orders: Table; payments: Table } {
  tables ??= {
    orders: {
      name: 'orders',
      columns: ['id', 'customer'],
      rows: Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, customer: (i * 37) % 300 })),
    },
    payments: {
      name: 'payments',
      columns: ['id', 'orderId'],
      // Every order once, and every other order twice. Numbered apart from the orders, so a payment's own id says
      // nothing about its order's.
      rows: Array.from({ length: 3000 }, (_, i) => ({ id: 10_001 + i, orderId: i < 2000 ? i + 1 : (i - 2000) * 2 + 1 })),
    },
  };
  return tables;
}
