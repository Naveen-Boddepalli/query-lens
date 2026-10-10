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

/**
 * Three bank accounts (plan.md §25.4 D1), the textbook table for a transaction: small enough that a schedule's every
 * row fits on screen, with a `balance` two sessions can disagree about. `id` is a UNIQUE index, so an `INSERT` of a
 * repeated id is rejected the way a primary key would be.
 */
export function createAccountsDatabase(): Database {
  return {
    tables: {
      accounts: {
        name: 'accounts',
        columns: ['id', 'owner', 'balance'],
        rows: [
          { id: 1, owner: 'ada', balance: 100 },
          { id: 2, owner: 'bo', balance: 100 },
          { id: 3, owner: 'cy', balance: 100 },
        ],
        indexes: [{ columns: ['id'], unique: true }],
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
        // Three indexes on purpose. `id` and `title` give `/tools/planner`'s index-selection rule a second
        // candidate to weigh (plan.md §22.2); `authorId` is the foreign key, and it *repeats* — 4 distinct
        // values among 10 rows — so `WHERE authorId = 1` walks an index that holds three entries for one value
        // and returns all three rows (plan.md §25.4 B3). Until then a B+Tree here was unique-only, and
        // indexing this column would have silently returned one row instead of three.
        indexedColumns: ['id', 'title', 'authorId'],
      },
    },
  };
}

/**
 * Four tables, shaped as a tree rather than a chain — `departments` is the hub, connecting to both `employees`
 * and `projects`; `timesheets` hangs off `employees` alone (plan.md §25.4 C4, `/tools/join-order` + the
 * Playground's own join-order note). Sized so join *order* has a real, measured answer rather than an obvious
 * one: `timesheets` is the one genuinely large table (5,000 rows against the other three's tens or hundreds), so
 * whichever join brings it in pays a real cost — but *when* that happens (how large the accumulated join is by
 * the time it does) is what actually separates a good order from a bad one, not simply "big table first" or
 * "big table last." Tuned empirically (the project's own "measure, don't guess" convention) rather than derived:
 * `FROM departments JOIN projects ON departments.id = projects.deptId JOIN employees ON departments.id =
 * employees.deptId JOIN timesheets ON employees.id = timesheets.employeeId` — a natural-looking "hub, then each
 * branch" order — costs 5× the DP-optimal `departments → employees → timesheets → projects`, because visiting
 * `projects` before drilling into `employees` → `timesheets` lets the *other* branch's join happen against an
 * already-larger intermediate. Every foreign key is uniform (rows divide evenly across parents), so the only
 * lever is order, not skew.
 */
export function createJoinOrderDemoDatabase(): Database {
  const DEPARTMENT_COUNT = 5;
  const EMPLOYEES_PER_DEPARTMENT = 40;
  const PROJECTS_PER_DEPARTMENT = 6;
  const TIMESHEETS_PER_EMPLOYEE = 25;
  const employeeCount = DEPARTMENT_COUNT * EMPLOYEES_PER_DEPARTMENT;

  return {
    tables: {
      departments: {
        name: 'departments',
        columns: ['id', 'name'],
        rows: Array.from({ length: DEPARTMENT_COUNT }, (_, i) => ({ id: i + 1, name: `dept-${String(i + 1)}` })),
        indexedColumns: ['id'],
      },
      employees: {
        name: 'employees',
        columns: ['id', 'deptId', 'name'],
        rows: Array.from({ length: employeeCount }, (_, i) => ({
          id: i + 1,
          deptId: Math.floor(i / EMPLOYEES_PER_DEPARTMENT) + 1,
          name: `employee-${String(i + 1)}`,
        })),
        indexedColumns: ['id', 'deptId'],
      },
      projects: {
        name: 'projects',
        columns: ['id', 'deptId', 'name'],
        rows: Array.from({ length: DEPARTMENT_COUNT * PROJECTS_PER_DEPARTMENT }, (_, i) => ({
          id: i + 1,
          deptId: Math.floor(i / PROJECTS_PER_DEPARTMENT) + 1,
          name: `project-${String(i + 1)}`,
        })),
        indexedColumns: ['id', 'deptId'],
      },
      timesheets: {
        name: 'timesheets',
        columns: ['id', 'employeeId', 'hours'],
        rows: Array.from({ length: employeeCount * TIMESHEETS_PER_EMPLOYEE }, (_, i) => ({
          id: i + 1,
          employeeId: Math.floor(i / TIMESHEETS_PER_EMPLOYEE) + 1,
          hours: 1 + (i % 8),
        })),
        indexedColumns: ['id', 'employeeId'],
      },
    },
  };
}

/**
 * `createJoinDemoDatabase`'s pair plus a larger third table, for `/compare`'s JOIN mode (plan.md §25.4 B4). Ten
 * posts on three pages cannot show what an index join is *for* — a probe of `posts` costs more than one scan
 * of it. `comments` is the inner table that can: 120 rows on 30 pages, twelve per post and scattered across them
 * (every tenth row is one post's), indexed on `postId` (a foreign key, so it repeats). One outer row probing that
 * index reads a few tree pages and the pages holding its own twelve comments — well under the thirty a scan reads —
 * while ten outer rows probing it cost more than one scan of the lot, which is the other half of the lesson.
 */
export function createJoinCompareDatabase(): Database {
  const base = createJoinDemoDatabase();
  return {
    tables: {
      ...base.tables,
      comments: {
        name: 'comments',
        columns: ['id', 'postId', 'body'],
        // `i * 7 mod 10` visits every post id in a scrambled order, so one post's comments sit on many pages.
        rows: Array.from({ length: 120 }, (_, i) => ({ id: i + 1, postId: ((i * 7) % 10) + 1, body: `comment ${String(i + 1)}` })),
        indexedColumns: ['postId'],
      },
    },
  };
}
