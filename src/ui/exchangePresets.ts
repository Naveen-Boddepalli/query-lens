import { runParallelJoin } from '../engine/exchange.ts';
import type { JoinExchange, ParallelJoinResult } from '../engine/exchange.ts';
import { createJoinOrderDemoDatabase } from '../engine/seed.ts';
import { ordersAndPayments } from './bigJoinTables.ts';
import type { Database } from '../engine/types.ts';

/**
 * plan.md §27.5 P2: the joins `/tools/parallel`'s exchange section runs, and its one call into the engine. The join-order
 * demo's tables — a small table against a big one, and a join on a key with only five values — and two made here, both
 * big: 2,000 orders and 3,000 payments, one or two per order.
 */

export const EXCHANGE_LABELS: Record<JoinExchange, string> = { broadcast: 'Broadcast the smaller side', repartition: 'Repartition both' };

export interface JoinQuery {
  id: string;
  label: string;
  sql: string;
  about: string;
}

export const JOIN_QUERIES: readonly JoinQuery[] = [
  {
    id: 'small-big',
    label: 'Small with big',
    sql: 'SELECT COUNT(*) FROM employees JOIN timesheets ON employees.id = timesheets.employeeId',
    about: '200 employees against 5,000 timesheets, 25 each.',
  },
  {
    id: 'big-big',
    label: 'Big with big',
    sql: 'SELECT COUNT(*) FROM orders JOIN payments ON orders.id = payments.orderId',
    about: '2,000 orders against 3,000 payments, one or two each.',
  },
  {
    id: 'few-keys',
    label: 'Five keys',
    sql: 'SELECT COUNT(*) FROM projects JOIN employees ON projects.deptId = employees.deptId',
    about: '30 projects against 200 employees on the department: only five values to hash.',
  },
  {
    id: 'all-rows',
    label: 'Every row back',
    sql: 'SELECT * FROM employees JOIN timesheets ON employees.id = timesheets.employeeId',
    about: 'The small-with-big join again, but every joined row goes back to the first worker, not a count.',
  },
];

let db: Database | null = null;

/** The join-order demo's tables, and orders and payments. Built once. */
export function exchangeDatabase(): Database {
  if (!db) {
    const base = createJoinOrderDemoDatabase();
    db = {
      tables: {
        ...base.tables,
        ...ordersAndPayments(),
      },
    };
  }
  return db;
}

/** The tool's link opened on one join: the morsel section at its defaults, the join section as given. */
export function joinHref(queryId: string, workers: number, strategy: JoinExchange): string {
  return `/tools/parallel?jq=${queryId}&jw=${String(workers)}&jx=${strategy}`;
}

export function joinRun(queryId: string, workers: number, strategy: JoinExchange): ParallelJoinResult {
  const query = JOIN_QUERIES.find((q) => q.id === queryId) ?? JOIN_QUERIES[0]!;
  const result = runParallelJoin(query.sql, exchangeDatabase(), { workers, strategy });
  if (!result.ok) throw new Error(`unreachable: a preset join must run — ${result.error}`);
  return result;
}
