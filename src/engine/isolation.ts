/**
 * The four isolation levels' names (plan.md §25.4 D3). Kept apart from `transactionControl.ts`, which `runQuery` imports
 * on every run: only the schedule tool needs the labels, and a table of strings is not free in a bundle every route
 * shares.
 */

import type { IsolationLevel } from './transactionControl.ts';

export const ISOLATION_LEVELS: readonly IsolationLevel[] = [
  'read-uncommitted',
  'read-committed',
  'repeatable-read',
  'serializable',
];

export const ISOLATION_LABELS: Record<IsolationLevel, string> = {
  'read-uncommitted': 'READ UNCOMMITTED',
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};
