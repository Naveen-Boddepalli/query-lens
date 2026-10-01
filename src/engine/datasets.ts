import { createSeedDatabase } from './seed.ts';
import type { Database, Row } from './types.ts';

/**
 * plan.md §22.7: the preset *table* library — a companion to §19.2's preset
 * *query* chips. §4's engine is one table at a time and JOIN-free, so each
 * dataset is a single table; the value is a curated *shape*:
 *
 *   - `users`     — the 48-row baseline (`seed.ts`), a 12-page scan against 8 frames
 *   - `orders`    — 120 rows: a deeper B+Tree and a scan that evicts far harder
 *   - `logins`    — an 8:1 skew on `status`, so the same `=` predicate returns a
 *                   handful of rows or almost all of them
 *   - `employees` — `department` and `office` are perfectly correlated (plan.md §25.4 C2), so an `AND` of both
 *                   badly underestimates: independence multiplies two fractions that describe the *same* fact
 *   - `transactions` — 3,000 rows (plan.md §25.4 C6): a genuinely taller B+Tree (height 7, measured, against
 *                   `employees`'s 5) and a scan that evicts hard enough to be a real demonstration, not a
 *                   token one — a point lookup or a narrow indexed range still stays a short trace either way
 *
 * Pure data, like `seed.ts`. The UI copy (labels, starter query, preset chips)
 * lives in `src/ui/datasetCatalogue.ts` so the engine stays free of it.
 */

export type DatasetId = 'users' | 'orders' | 'logins' | 'employees' | 'transactions';

export const DEFAULT_DATASET: DatasetId = 'users';

export const DATASET_IDS: readonly DatasetId[] = ['users', 'orders', 'logins', 'employees', 'transactions'];

export function isDatasetId(value: unknown): value is DatasetId {
  return typeof value === 'string' && (DATASET_IDS as readonly string[]).includes(value);
}

export interface DatasetSpec {
  id: DatasetId;
  /** The one table this dataset defines — the name a query's `FROM` must use. */
  table: string;
  make: () => Database;
}

const ORDER_CUSTOMERS = [
  'acme', 'globex', 'initech', 'umbrella', 'soylent', 'hooli', 'stark', 'wayne',
  'wonka', 'tyrell', 'cyberdyne', 'aperture',
] as const;

const ORDER_STATUS = ['paid', 'pending', 'refunded'] as const;

function orderRows(): Row[] {
  return Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    customer: ORDER_CUSTOMERS[i % ORDER_CUSTOMERS.length]!,
    total: 50 + ((i * 37) % 950),
    status: ORDER_STATUS[i % 3]!,
  }));
}

const LOGIN_USERS = [
  'ada', 'brendan', 'carmack', 'dijkstra', 'grace', 'guido', 'hopper', 'ken',
  'knuth', 'lamport', 'linus', 'matz', 'radia', 'ritchie', 'turing', 'yukihiro',
] as const;

function loginRows(): Row[] {
  return Array.from({ length: 80 }, (_, i) => {
    // 1 in 9 is blocked — the deliberate skew: `status = 'blocked'` is a
    // handful of rows after a full scan, `status = 'ok'` is nearly all of them.
    const blocked = i % 9 === 0;
    return {
      id: i + 1,
      user: LOGIN_USERS[i % LOGIN_USERS.length]!,
      status: blocked ? 'blocked' : 'ok',
      attempts: blocked ? 3 + (i % 5) : 1,
    };
  });
}

const DEPARTMENTS = [
  'engineering', 'sales', 'marketing', 'support', 'finance', 'legal', 'design', 'product',
  'people', 'security', 'data', 'research', 'platform', 'growth', 'success', 'partnerships',
  'operations', 'recruiting', 'it', 'facilities', 'compliance', 'strategy', 'brand',
  'localization', 'devrel',
] as const;
const EMPLOYEES_PER_DEPARTMENT = 10;

/**
 * `department` and `office` are perfectly correlated: every department occupies exactly one office, the way a real
 * team often does. That is exactly the independence assumption `AND` selectivity makes (plan.md §25.4 C2), and
 * exactly what `ANALYZE`'s own per-column statistics (plan.md §25.4 C1) cannot see — nothing there counts how two
 * columns co-occur, only how each behaves alone: `department = 'sales' AND office = 'building-2'` is no narrower
 * than `department = 'sales'` by itself, since office adds no information at all, but the optimizer's multiplied
 * fractions assume it does — badly underestimating (RESEARCH.md §41: Leis et al. found real optimizers off by an
 * order of magnitude or more from exactly this).
 */
function employeeRows(): Row[] {
  return DEPARTMENTS.flatMap((department, d) =>
    Array.from({ length: EMPLOYEES_PER_DEPARTMENT }, (_, i) => ({
      id: d * EMPLOYEES_PER_DEPARTMENT + i + 1,
      department,
      office: `building-${String(d + 1)}`,
      salary: 60000 + ((d * EMPLOYEES_PER_DEPARTMENT + i) * 733) % 80000,
    })),
  );
}

const TRANSACTION_COUNT = 3000;
const TRANSACTION_ACCOUNTS = Array.from({ length: 40 }, (_, i) => `acct-${String(i + 1).padStart(2, '0')}`);

/**
 * 3,000 rows: a genuinely taller B+Tree than any other preset (height 7, measured against `id` with this
 * engine's real `maxKeys = 4` — `employees`'s 250 rows only reaches height 5) and 750 heap pages against the
 * default 8 buffer frames, so a scan that touches most of the table evicts hard enough to be dramatic, not
 * token. `amount` is deliberately unindexed and spans the whole table uniformly, so `amount > 4500` (~10%
 * selectivity) still has to read every one of those 750 pages — `account` is likewise unindexed, 40 repeating
 * values, for the same "an equality still costs a full scan" point a bigger table makes more vivid. Sized by a
 * throwaway probe script measuring the real `height()`/heap-page count across 500–10,000 rows, not estimated
 * (plan.md's own "measure, don't guess") — 3,000 was the smallest size that still reached height 7.
 */
function transactionRows(): Row[] {
  return Array.from({ length: TRANSACTION_COUNT }, (_, i) => ({
    id: i + 1,
    account: TRANSACTION_ACCOUNTS[i % TRANSACTION_ACCOUNTS.length]!,
    amount: 10 + ((i * 97) % 4990),
    status: i % 5 === 0 ? 'failed' : 'settled',
  }));
}

export const DATASETS: Record<DatasetId, DatasetSpec> = {
  users: { id: 'users', table: 'users', make: createSeedDatabase },
  transactions: {
    id: 'transactions',
    table: 'transactions',
    make: () => ({
      tables: {
        transactions: {
          name: 'transactions',
          columns: ['id', 'account', 'amount', 'status'],
          rows: transactionRows(),
          indexedColumns: ['id'],
        },
      },
    }),
  },
  employees: {
    id: 'employees',
    table: 'employees',
    make: () => ({
      tables: {
        employees: {
          name: 'employees',
          columns: ['id', 'department', 'office', 'salary'],
          rows: employeeRows(),
          indexedColumns: ['id'],
        },
      },
    }),
  },
  orders: {
    id: 'orders',
    table: 'orders',
    make: () => ({
      tables: {
        orders: {
          name: 'orders',
          columns: ['id', 'customer', 'total', 'status'],
          rows: orderRows(),
          indexedColumns: ['id'],
        },
      },
    }),
  },
  logins: {
    id: 'logins',
    table: 'logins',
    make: () => ({
      tables: {
        logins: {
          name: 'logins',
          columns: ['id', 'user', 'status', 'attempts'],
          rows: loginRows(),
          indexedColumns: ['id'],
        },
      },
    }),
  },
};
