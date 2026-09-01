import type { Database, Row } from './types.ts';

const names = [
  'ada',
  'brendan',
  'carmack',
  'dijkstra',
  'engelbart',
  'fowler',
  'grace',
  'hamilton',
  'iverson',
  'jobs',
  'knuth',
  'lamport',
] as const;

function seedRows(): Row[] {
  return names.map((name, i) => ({
    id: i + 1,
    name,
    email: `${name}@example.com`,
    age: 20 + ((i * 7) % 40),
  }));
}

/**
 * The starting dataset. Small enough to see every row, big enough that a
 * sequential scan spans several pages and actually evicts something.
 * The user can edit these rows and re-run (plan.md §4).
 */
export function createSeedDatabase(): Database {
  return {
    tables: {
      users: {
        name: 'users',
        columns: ['id', 'name', 'email', 'age'],
        rows: seedRows(),
        indexedColumn: 'id',
      },
    },
  };
}
