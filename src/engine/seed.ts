import type { Database, Row } from './types.ts';

/**
 * 48 rows at 4 rows per page is 12 pages against 8 buffer frames, so a full
 * sequential scan evicts. That contrast is the point: plan.md §9 wants the
 * scan's eviction storm shown next to an index lookup that touches almost
 * nothing. A table small enough to never evict would make the buffer pool —
 * the product's best differentiator — look inert.
 */
const NAMES = [
  'ada', 'alan', 'barbara', 'brendan', 'carmack', 'carol', 'dennis', 'dijkstra',
  'donald', 'edsger', 'engelbart', 'fowler', 'frances', 'grace', 'guido', 'hamilton',
  'hedy', 'hopper', 'iverson', 'james', 'jean', 'john', 'katherine', 'ken',
  'knuth', 'lamport', 'larry', 'leslie', 'linus', 'lynn', 'margaret', 'mary',
  'matz', 'niklaus', 'radia', 'richard', 'ritchie', 'rob', 'robert', 'shafi',
  'stephen', 'thompson', 'tim', 'tony', 'torvalds', 'turing', 'vint', 'yukihiro',
] as const;

function seedRows(): Row[] {
  return NAMES.map((name, i) => ({
    id: i + 1,
    name,
    email: `${name}@example.com`,
    age: 20 + ((i * 7) % 45),
  }));
}

/**
 * The starting dataset. The user can edit these rows and re-run (plan.md §4).
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
