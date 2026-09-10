import { createSeedDatabase } from './seed.ts';
import type { Database, Row } from './types.ts';

/**
 * plan.md §22.7: the preset *table* library — a companion to §19.2's preset
 * *query* chips. §4's engine is one table at a time and JOIN-free, so each
 * dataset is a single table; the value is a curated *shape*:
 *
 *   - `users`   — the 48-row baseline (`seed.ts`), a 12-page scan against 8 frames
 *   - `orders`  — 120 rows: a deeper B+Tree and a scan that evicts far harder
 *   - `logins`  — an 8:1 skew on `status`, so the same `=` predicate returns a
 *                 handful of rows or almost all of them
 *
 * Pure data, like `seed.ts`. The UI copy (labels, starter query, preset chips)
 * lives in `src/ui/datasetCatalogue.ts` so the engine stays free of it.
 */

export type DatasetId = 'users' | 'orders' | 'logins';

export const DEFAULT_DATASET: DatasetId = 'users';

export const DATASET_IDS: readonly DatasetId[] = ['users', 'orders', 'logins'];

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

export const DATASETS: Record<DatasetId, DatasetSpec> = {
  users: { id: 'users', table: 'users', make: createSeedDatabase },
  orders: {
    id: 'orders',
    table: 'orders',
    make: () => ({
      tables: {
        orders: {
          name: 'orders',
          columns: ['id', 'customer', 'total', 'status'],
          rows: orderRows(),
          indexedColumn: 'id',
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
          indexedColumn: 'id',
        },
      },
    }),
  },
};
