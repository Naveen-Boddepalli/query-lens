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
        indexedColumns: ['id'],
      },
    },
  };
}

const AUTHOR_NAMES = ['ada', 'alan', 'grace', 'donald', 'barbara'] as const;

// `authorId` is a real foreign key shape: two authors with several posts,
// one with exactly one, and one with none at all — the ordinary distribution
// a real join produces, not every row matching neatly. Small on purpose: v1
// JOIN is nested-loop only, so every row on one side rescans the *other*
// side whole — small tables keep that honest even before an index-aware join
// strategy exists to speed it up.
const POST_AUTHORS = [1, 1, 1, 2, 2, 3, 3, 3, 3, 4] as const;

/**
 * A small second table, joinable against a small first one (plan.md §22.2) —
 * `authors`/`posts` rather than reusing the 48-row `users`, so a full,
 * unfiltered join stays small enough to read as a trace. Not part of
 * `datasets.ts`'s preset library: those are each one table by design (§22.7);
 * this pair exists to give `/tools/planner` something to JOIN against.
 */
export function createJoinDemoDatabase(): Database {
  return {
    tables: {
      authors: {
        name: 'authors',
        columns: ['id', 'name'],
        rows: AUTHOR_NAMES.map((name, i) => ({ id: i + 1, name })),
        indexedColumns: ['id'],
      },
      posts: {
        name: 'posts',
        columns: ['id', 'authorId', 'title'],
        rows: POST_AUTHORS.map((authorId, i) => ({
          id: i + 1,
          authorId,
          title: `${AUTHOR_NAMES[authorId - 1]}'s post ${String(i + 1)}`,
        })),
        // Two indexes on purpose (plan.md §22.2's "second candidate index"):
        // a query naming both `id` and `title` gives `/tools/planner`'s
        // index-selection rule an actual second candidate to weigh, not just
        // one column that's always the answer. Deliberately *not* `authorId`
        // — it repeats (4 distinct values among 10 rows), and this B+Tree
        // indexes a unique column only (`btree.ts`'s own `insert`: a
        // duplicate key overwrites the previous row's pointer, "last writer
        // wins"). Indexing it would make `WHERE authorId = 1` silently
        // return one row instead of the three that actually match — found by
        // running the query, not by inspection.
        indexedColumns: ['id', 'title'],
      },
    },
  };
}
