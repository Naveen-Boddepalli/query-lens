/**
 * A gzip budget for `dist/`, checked in CI (plan.md §14.2, reworked by §25.4 H8).
 *
 * The point is not the numbers, it is that they cannot drift silently. A bundle
 * grows one import at a time and nobody notices until the lecture-hall laptop
 * on hotel wifi does — which is the audience §14 question 7 is about.
 *
 * **What is budgeted is what a visitor downloads.** Until v2 this was a handful
 * of chunk-name groups and one sum, and every feature that touched shared code
 * ("trace-ui") had to raise a ceiling that six routes shared — while a new tool
 * could hide inside a group with room to spare. That says nothing about the one
 * question that matters: *how many kilobytes does someone landing on /compare
 * pay?* So each route below is priced as the gzip size of the entry chunk plus
 * that route's own lazy chunk plus every static dependency of either — read from
 * Vite's manifest (`dist/.vite/manifest.json`), the same graph the browser walks.
 * A route can no longer grow another route's ceiling to fit, and **every tool
 * has its own row** (§25.2 Q8: a new tool is its own lazy chunk with its own
 * budget, and may not grow a shared one).
 *
 * Not counted: fonts and images (they are separate, cacheable requests, and
 * `public/` is checked by the deploy notice, §25.4 A4) — this is JS and CSS.
 *
 * Budgets are set a little above the current size: tight enough that adding a
 * dependency shows up here, loose enough that a normal change does not fail the
 * build. Raising one is a deliberate act with a diff, and a comment saying why.
 * The history of the old group ceilings is in git (last version: e28df0d).
 *
 * Run: pnpm budget   (after pnpm build)
 */
import { gzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The parts of a Vite manifest entry this reads. */
export interface ManifestChunk {
  file: string;
  imports?: string[];
  css?: string[];
}
export type Manifest = Record<string, ManifestChunk>;
export interface RouteBudget {
  /** What a reader would recognise: `/compare`, `/tools/btree`. */
  route: string;
  /** Manifest keys (source paths, or `_chunk-…` names) whose closures this route loads *besides the entry's*. */
  roots: string[];
  /** Gzip ceiling for the whole download, in kB. */
  kb: number;
  note: string;
}

/** The entry chunk's own ceiling: the app shell every route pays before anything else (§25.4 H8: keep it ≤ 24 kB). */
export const ENTRY_KB = 24;
export const ENTRY_KEY = 'index.html';

export const gzipKb = (bytes: Buffer): number => gzipSync(bytes, { level: 9 }).length / 1024;

/**
 * A root is a source path (`src/pages/X.tsx`, exact) or the name of a shared chunk the bundler made
 * (`_docs`, matching `_docs-<hash>.js`) — whose hash changes with every build, so it cannot be spelled out.
 */
export function resolveKey(manifest: Manifest, root: string): string {
  if (manifest[root]) return root;
  const shared = Object.keys(manifest).filter((k) => k.startsWith(`${root}-`) && k.endsWith('.js'));
  if (shared.length === 1) return shared[0];
  throw new Error(
    shared.length === 0
      ? `the manifest has no chunk "${root}" — a route's roots must name real chunks`
      : `"${root}" matches several chunks (${shared.join(', ')}) — name one exactly`,
  );
}

/** Every file `key` needs — its own chunk, its stylesheets, and everything it statically imports, transitively. */
export function closure(manifest: Manifest, keys: readonly string[]): Set<string> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`the manifest has no chunk "${key}"`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dep of chunk.imports ?? []) visit(dep);
  };
  keys.forEach((k) => { visit(resolveKey(manifest, k)); });
  return files;
}

export interface RouteResult {
  route: string;
  kb: number;
  budget: number;
  files: string[];
  over: boolean;
}

/** Prices every route with `size(file)` (gzip kB), the entry's closure included in each. */
export function priceRoutes(
  manifest: Manifest,
  routes: readonly RouteBudget[],
  size: (file: string) => number,
): RouteResult[] {
  const entry = closure(manifest, [ENTRY_KEY]);
  return routes.map((r) => {
    const files = [...new Set([...entry, ...closure(manifest, r.roots)])];
    const kb = files.reduce((sum, f) => sum + size(f), 0);
    return { route: r.route, kb, budget: r.kb, files, over: kb > r.kb };
  });
}

/** Files in `dist/assets` that no route and no extra reaches — a chunk with no budget is a gap in this file. */
export function unbudgeted(all: readonly string[], results: readonly RouteResult[], extras: readonly string[]): string[] {
  const covered = new Set([...results.flatMap((r) => r.files), ...extras]);
  return all.filter((f) => !covered.has(f));
}

/* -------------------------------------------------------------------------- */
/* The budgets                                                                 */
/* -------------------------------------------------------------------------- */

const P = (name: string): string => `src/pages/${name}.tsx`;
const T = (name: string): string => `src/pages/tools/${name}.tsx`;

/*
 * Ceiling history since H8 (each bump is deliberate, and says why):
 *
 *  - 2026-09-25, composite indexes (§25.4 B3b): the engine chunk grew ~1.6 kB gzip — index specs, prefix lookups, the
 *    leftmost-prefix narration and question, covering scans, composite maintenance in the write paths. Every route that
 *    carries the engine moved up 3–5 kB (its measured size + 2, the H8 slack). Routes without the engine — /examples,
 *    /settings, /study, /tools/{sort,locks,grammar,hash-join}, /docs, the 404 — did not move and did not change.
 *    Earlier growth (non-unique indexes B3a, the index join B4) fit inside the H8 slack.
 *  - 2026-09-25, UNIQUE (B3c), the bulk loader and the Index build compare mode (B3d): +0.6 kB more in the engine and
 *    +1.2 kB in /compare. The engine chunk is in ~25 routes, so every feature that grows it moves all of them; the ceilings
 *    for the routes that went over are now their measured size + 3 (was +2), so a small engine change stops touching the
 *    table. Splitting the engine out of the routes that barely use it (the landing page, /tools/page) is the real fix,
 *    and is not done yet.
 *  - 2026-09-25, the course map and interview roadmap (§25.4 G1): two prose pages, ~7 kB gzip, into the one shared docs
 *    chunk, so /docs moves from 141 to 149. (The entry chunk grew by two lazy routes, which is why /stages and
 *    /stages/:id moved by a hair as well.)
 *  - 2026-09-28, clustered (index-organized) tables (§25.4 B3e, closing B3): `EntryKey.clusterKey`, the
 *    clustered-secondary resolve path in `index/lookup.ts` and `exec/`, and the range/join fallback checks add
 *    ~1 kB gzip to the engine chunk. Four routes that were already sitting within a kB of their ceiling went over:
 *    /learn/:id, /gallery, /challenges, /tools/parser — each moved to its measured size + 3, the same slack every
 *    other engine-carrying route already has.
 *  - 2026-09-29, `ANALYZE` + statistics (§25.4 C1) and a correlated dataset + q-error (§25.4 C2): the new
 *    "Statistics" section in limits.mdx and the ANALYZE section in sql.mdx grow the shared docs chunk enough to
 *    push /docs/concepts/btree from 163 to 166 (163 kB measured + 3) — the one route that was already sitting
 *    exactly at its ceiling with no slack left.
 *  - 2026-09-29, multi-join (§25.4 C3, slice b): `JoinClause[]`, the chain-position parse check, `joinsIn`, the
 *    chain-aware cost-model/narration/execution changes across `buildPlan.ts`/`emit.ts`/`operators.ts`/`runQuery.ts`
 *    grow the engine chunk enough to push nine already-tight routes over: /playground, /stages/:id, /learn,
 *    /compare, /trace, /progress, /challenges/:id, /assignments/new, /tools/btree — each now its measured size + 3,
 *    the same slack every other engine-carrying route already has.
 *  - 2026-09-29, `IN (subquery)` (§25.4 C3, slice c, closing C3): `InSubquery`, `parseInSubquery`,
 *    `subquery.ts`'s `resolveWhereSubqueries`, and the WHERE-narration additions in `emit.ts`/`emitDelete.ts`/
 *    `emitUpdate.ts` grow the engine chunk again, and the new "IN subquery" section in limits.mdx plus the new
 *    paragraphs in sql.mdx grow the shared docs chunk — between the two, eleven more already-tight routes go
 *    over: /, /stages, /learn/:id, /gallery, /challenges, /tools/buffer-pool, /tools/parser, /tools/page,
 *    /tools/planner, /docs, /docs/concepts/buffer-pool — each now its measured size + 3, the same slack every
 *    other route at its ceiling already has.
 *  - 2026-09-29, join ordering by dynamic programming (§25.4 C4): a new route, /tools/join-order (159.9 kB
 *    measured + 3), and the "second opinion" narration in emit.ts pulls `joinOrder.ts` into the engine chunk for
 *    every route that already carries it, pushing /docs/concepts/btree over by a hair (163 kB measured + 3, was
 *    already at its own ceiling from the C1/C2 docs growth).
 *  - 2026-09-30, join algorithm chosen by cost (§25.4 C5, second slice): `join-algorithm-selection` and its
 *    per-candidate cost comparison grew the engine chunk a little, pushing /compare a hair over its ceiling
 *    (168.1 kB measured + 3).
 *  - 2026-10-01, join order chosen by cost (§25.4 C5, third slice): `reorderJoinsIfCheaper`/`rebuildJoinsForOrder`
 *    pull `joinOrder.ts` into the engine chunk for every route that already carries it (not just /tools/join-order
 *    and emit.ts's own narration anymore), pushing four routes over by a hair: /playground (311.3 kB measured + 3,
 *    rounded to 315), /stages/:id, /trace and /tools/btree (each its own measured size + 3).
 *  - 2026-10-01, EXPLAIN ANALYZE's actual-row mislabeling fix: `StepEventBody`'s `execute` variant and `PlanNode`
 *    both gained an optional `table`, so a plan's several `SeqScan`/`Join` nodes stop sharing one `op`-keyed
 *    lookup slot in `explain.ts`. A small, fixed-cost addition to the engine chunk, but two routes were already
 *    sitting exactly at their ceiling with no slack: /learn (166.1 kB measured + 3) and /challenges/:id (283.0 kB
 *    measured + 3).
 *  - 2026-10-01, the "Why not?" panel (§25.4 C5, fourth and closing slice): `index-selection`, `range-index-
 *    selection` and `join-algorithm-selection` each gained a structured `whyNot` (chosen vs. runner-up, both
 *    already-computed page costs) threaded through `Rewrite` and the `optimize`/`plan` step events, plus a new
 *    shared `WhyNotNote` component rendered in the Playground and `/tools/planner`. Three routes were already
 *    sitting exactly at their ceiling: /progress (168.1 kB measured + 3, rounded to 171), /assignments/new (163.1
 *    kB measured + 3) and /tools/planner (165.0 kB measured + 3, the one route with its own direct `WhyNotNote`
 *    import on top of the engine-chunk growth every route above already pays).
 *  - 2026-10-01, the `transactions` preset dataset (§25.4 C6, first slice): a new `DatasetId` member and its
 *    `DATASET_CATALOGUE` entry add to the engine chunk and the shared dataset-picker code every route that
 *    carries either reaches for — a wider set than usual, since the dataset picker itself (not just the
 *    Playground) is shared by several tool/docs demo pages. Six routes were already at their ceiling, each now
 *    its own measured size + 3: / (162.0 → 165), /stages (161.8 → 165), /tools/buffer-pool (166.1 → 169),
 *    /tools/parser (164.5 → 168), /tools/page (162.3 → 166), /docs/concepts/buffer-pool (168.1 → 171).
 *  - 2026-10-01, the LSM-tree sandbox (§25.4 F1, first slice): a new route, /tools/lsm (114.7 kB measured + 3,
 *    rounded to 118) — a self-contained `src/ui/lsm.ts` driver in the same family as `/tools/sort`'s and
 *    `/tools/hash-join`'s, so it does not touch the shared engine chunk and no other route moved.
 *  - 2026-10-02, the B+Tree-vs-LSM `/compare` mode (§25.4 F1, closing slice): pulls in both `src/ui/lsm.ts` and
 *    the new `src/ui/btreeWriteCost.ts` directly into `ComparePage`'s own lazy chunk (not the shared engine
 *    chunk, since neither is imported by any other already-loaded route) — the whole 7.3 kB gzip difference is
 *    this one route's own growth. 171 → 175 (measured 172.0, the usual +3 slack).
 *  - 2026-10-02, extendible and linear hashing (§25.4 F2): a new route, /tools/hash-index (115.5 kB measured
 *    + 3, rounded to 118) — a self-contained `src/ui/hashIndex.ts` driver in the same family as `/tools/lsm`'s,
 *    so it does not touch the shared engine chunk and no other route moved.
 *  - 2026-10-04, LRU-2 (LRU-K, K = 2) added to the engine's shared replacement-policy registry (§25.4 F7, slice 1):
 *    the policy, its type, labels and explanations live in the engine chunk every route that touches the engine
 *    already loads, so the four routes that sit closest to their ceiling took the growth. Each raised by three
 *    kB from its measured size, the usual slack: /gallery 162 → 165, /challenges 164 → 167, /tools/btree 167 →
 *    170, /docs/concepts/btree 170 → 173. /tools/buffer-pool and /compare moved within their own ceilings.
 *  - 2026-10-04, latch crabbing (§25.4 F5): a new route, /tools/latch-crabbing (163.5 kB measured + 3, rounded
 *    to 167). Unlike the standalone sandboxes it drives the REAL engine B+Tree (`engine/index/btree.ts`, the same
 *    code /tools/btree uses), so it pays the shared engine chunk the same way /tools/btree does (ceiling 167).
 *  - 2026-10-14, recovery as a trace in three stages (`RecoveryStepper` in `walPanels.tsx`, `recoveryStages` in
 *    `walTables.ts`): /tools/recovery 129 → 133 (measured 129.5 + 3, rounded up; it was 128.7) and /tools/wal
 *    129 → 133 (129.6 + 3; it was 128.8). Both import `walPanels.tsx`, which grew a stage strip, a slider and the
 *    sentence for a step — 0.8 kB gzip. The Durability dialog shares the panels and is 15.7 of 17.
 *  - 2026-10-13 (split), the settings runner by tool (`challenges/settings/*.ts`, one checker module per tool, loaded
 *    by `settingsRunner.ts` when a challenge of that tool is opened): the settings view's opt-in chunk 36 → 8 (4.6 kB
 *    measured + 3, rounded up; it was 32.3 — the runner carried every tool's driver) and thirteen new opt-in rows, one
 *    per tool, each what that tool's challenges fetch on top of the page and the view: 0.8 kB for the planner and the
 *    join order up to 12.4 for the isolation matrix (the Hermitage suite on both engines), against 32.3 for every one
 *    before. The rows overlap — each counts the shared chunks its tool needs (`settings/shared.ts`, the scenario
 *    modules) — so they do not sum to anything; the set of chunks as a whole grew by 4 kB (603.0 → 607.0), which is
 *    thirteen modules compressing separately. The view fetches its tool's module as it opens, so the first Run
 *    does not wait for it. `OPT_IN`'s `after` may now name more than one chunk: a tool's checks are measured past
 *    the page *and* the view.
 *  - 2026-10-13 (final), lessons and challenges for the remaining tools — the buffer pool, the parser, the grammar,
 *    the planner and the lock table (`sandboxLessons.tsx`, five lessons), two script challenges for the lock sandbox,
 *    six settings challenges, two query challenges, and the lock sandbox's script in its address (`lockScript.ts`).
 *    /learn/:id 185 → 190 (measured 186.6 + 3, rounded up): the five lessons' steps are prose in the one chunk that
 *    carries every lesson's, and the scenarios behind their links are plain data (`sandboxScenarios.ts`), so no tool
 *    driver comes in. /challenges 181 → 186 (182.3 + 3) and /challenges/:id 301 → 306 (302.7 + 3): ten more briefs
 *    in the list, and the groups module (`challenges/groups.ts`) the two pages now share. /tools/locks 117 → 121
 *    (117.2 + 3): the script fold, its URL codec and the small amount of page that uses them; no engine in it. The
 *    settings view is the real cost, 21 → 36 as an opt-in chunk (32.3 + 3): the six new challenges need the
 *    buffer-pool trace, the planner's rule pipeline, the B+Tree and both isolation engines (the Hermitage suite)
 *    to run what a player sets, and all of that is in the one chunk that is opened with a settings challenge —
 *    none of it is in an index route. /learn and /progress gained about half a kB each, inside their ceilings
 *    (they read the manifest, and the new lessons' titles and summaries are in it). Splitting the
 *    runner's handlers by tool, so that a sort challenge does not fetch the isolation engines, is the next thing
 *    to do if this chunk needs to shrink.
 *  - 2026-10-13 (last), challenges for the storage and execution tools (`settingsChallenges.tsx`, ten of them, and the
 *    runner and view behind them): /challenges 176 → 181 (177.2 kB measured + 3, rounded up; it was 173.0) and
 *    /challenges/:id 296 → 301 (297.3 + 3; it was 292.9) for the ten briefs, which are prose in the list. The drivers
 *    are not in either: `settingsRunner.ts` and `SettingsChallengeView` are a new opt-in chunk (18.0 kB measured + 3,
 *    rounded to 21), opened with one of these challenges. Two knock-on costs, both small and both ceilings that were
 *    sitting within 0.1 kB: a driver that a tool's page and a lazy runner both import is now a chunk of its own
 *    (`/tools/hash-index` 117.9 → 118.4, ceiling 118 → 122; the other tools gained less and stayed inside), and
 *    the eight modules that became chunks of their own (the six drivers, `slottedPage` and `storageScenarios`) add
 *    their names to the dependency map the entry carries (87 → 95 names; 23.3 → 23.4 kB), which put /docs and the
 *    three essays that share its chunk from 170.0 to 170.1, ceiling 170 → 174. The shared challenge frame
 *    (`ChallengeFrame.tsx`) was taken out of the script view for the new view to use, which is why that opt-in chunk
 *    reads 28.0 now, against 27.4: the frame is counted in each.
 *  - 2026-10-13 (latest), the lesson index apart from the lesson steps (`learn/lessonIndex.ts`): /learn 185 → 119
 *    (115.9 kB measured + 3, rounded up; it was 181.9) and /progress 187 → 122 (118.3 + 3; it was 183.9). Both only
 *    *list* lessons, so both now read titles, lengths and summaries from the manifest and import neither the lessons'
 *    steps nor the engine behind their Playground links — the engine chunk (about 50 kB gzip) is gone from /learn. The
 *    rest of /progress's drop is its own: it took `STAGES`, a constant, from the engine barrel, which brought
 *    `runQuery` with it, and now takes it from `engine/types.ts`. /learn/:id is unchanged (182.4 against its 185): a
 *    lesson page needs the steps, and the engine for any step that opens the Playground. Loading the steps by group
 *    would take the engine and two thirds of the prose off a storage or transactions lesson, and is the remaining
 *    piece, not done here.
 *  - 2026-10-13 (later), lessons for the sort, the hash join, the join order and the six storage structures
 *    (`storageLessons.tsx`, nine lessons): /learn 179 → 185, /learn/:id 179 → 185 and /progress 181 → 187 (each
 *    measured + 3, rounded up: 181.9, 181.6, 183.9). It is the same cost as the transaction lessons were, for the
 *    same reason — `lessons.tsx` carries every lesson's steps, and its engine import for the Playground links, into
 *    the routes that only list lessons — and the second time that has raised these three by about six kB. A lesson
 *    index of ids, titles and summaries apart from the steps would at least take the engine chunk (about 50 kB gzip)
 *    out of /learn; that is the next thing to do here, not another bump. The scenarios behind the new links are plain
 *    data (`storageScenarios.ts`), so no tool driver comes into any of them.
 *  - 2026-10-13, lessons and challenges for the transaction and durability tools (§25.4, release checklist §2.4):
 *    seven lessons (`transactionLessons.tsx`) and thirteen challenges (`scriptChallenges.tsx`) are prose and data in
 *    the routes that list them, so /learn 173 → 179, /learn/:id 172 → 179, /progress 175 → 181, /challenges 171 →
 *    176 and /challenges/:id 290 → 296 (each measured + 3, rounded up: 175.8, 175.7, 178.0, 172.9, 292.8). The
 *    schedule runner, the protocol comparison and the log machine are NOT in any of them: a challenge's script is
 *    parsed, run and checked in `scriptRunner.ts`, behind the lazily-imported `ScriptChallengeView`, which is a new
 *    opt-in chunk (27.4 kB measured + 3, rounded to 31) fetched only when one of those challenges is opened. The
 *    lesson links are built from plain data (`transactionScenarios.ts`) so that `/learn/:id` does not import the
 *    engines either. The index routes do carry every lesson's steps — a split of the lesson list from its prose would
 *    take that back, and is the first thing to do if /learn needs to shrink.
 *  - 2026-10-12, data-table views for the transaction and durability tools (§H6): `DataView` and the row builders
 *    (`transactionTables.ts`; the matrix's own in `isolationTable.ts`, so the schedule tool does not carry the
 *    Hermitage suite) came into /tools/schedule, /tools/isolation and /tools/concurrency, and the write-ahead-log
 *    panels (`walTables.ts`) into /tools/wal, /tools/recovery and the Durability dialog. /tools/schedule 181 → 185
 *    (measured 181.5 + 3, rounded up), /tools/isolation 177 → 181 (177.0 + 3), the Durability opt-in chunk 14 → 17
 *    (14.3 + 3).
 *  - 2026-10-10, generated questions (§25.4 G4): a new route, /practice (178.3 kB measured + 3, rounded to 182). The
 *    generators call the real engine for their answers (the buffer pool, the B+Tree, the planner, the visibility
 *    rule, the recovery machine), so it pays the shared engine chunk the way the Playground does.
 *  - 2026-10-10, the REPEATABLE READ essay (§25.4 H2): a new prose route, /docs/essays/repeatable-read, in the one
 *    shared docs chunk (168.9 kB measured for the three essays, ceiling 170). The tools index gained three entries in
 *    this stretch (concurrency compare, write-ahead log, crash recovery): /tools 116 → 120 (measured 116.0 + 3, rounded
 *    up), and the entry chunk's growth moved /tools/latch-crabbing 167 → 170 (measured 167.0 + 3).
 *  - 2026-10-10, recovery in the pipeline (§25.4 E4): the Playground records each write statement as log steps
 *    (`durableLog.ts` and `recovery/heap.ts`, imported by the route, plus its own state and button: 1.8 kB gzip), so
 *    /playground 319 → 324 (measured 320.3 + 3, rounded up). The write-ahead-log machine and the dialog are an
 *    opt-in chunk, fetched when the Durability button is pressed (ceiling 14). The new route's entry growth moved
 *    /tools/page 166 → 170 (measured 166.0 + 3, rounded up). The durability sections of `limits.mdx` and `course-map.mdx`
 *    (E1 to E4) are prose in the one shared docs chunk, which took /docs and its two essays 166 → 170 (measured 166.4
 *    + 3, rounded up).
 *  - 2026-10-10, checkpoints, crash and recovery (§25.4 E3): a new route, /tools/recovery (125.4 kB measured + 3,
 *    rounded to 129). It shares the write-ahead-log model with /tools/wal, which now ships the checkpoint and
 *    restart code as well: /tools/wal 125 → 129 (measured 125.5 + 3, rounded up). Neither touches the shared engine
 *    chunk, so no other route moved.
 *  - 2026-10-10, steal and force (§25.4 E2): /tools/wal 122 → 125 (measured 121.6 + 3, rounded up). The two policy
 *    toggles, the crash-image panel and the four-way comparison are all that page's own; the model grew inside the
 *    same standalone module, so no other route moved.
 *  - 2026-10-10, the write-ahead log (§25.4 E1): a new route, /tools/wal (118.9 kB measured + 3, rounded to 122). It
 *    is a self-contained model (`engine/recovery/wal.ts` imports nothing from the engine), so it does not touch the
 *    shared engine chunk and no other route moved.
 *  - 2026-10-10, the concurrency-control compare (§25.4 D6): a new lazy route again grows the entry chunk every page
 *    loads, which pushed the five routes sitting at their ceilings over by a few hundred bytes: /stages 165 → 169,
 *    /gallery 165 → 169 and /docs, with its two essays, 162 → 166 (each measured + 3, rounded up).
 *    /tools/concurrency is 178.3, ceiling 182: it runs five protocols and a serial-order search over the whole
 *    schedule runner. Timestamp ordering's extra rules and the dirty-read check on writes live in `schedule.ts`, which
 *    moved /tools/isolation from 173.1 to 175.1; /tools/schedule is at 179.9 of 181. Both are inside their ceilings,
 *    so neither was raised.
 *  - 2026-10-10, the isolation matrix (§25.4 D5): a new lazy route grows the entry chunk every page loads by a little
 *    (its import and its route element), which is what moved the two routes sitting within a kB of their ceilings:
 *    / 165 → 169 and /assignments/new 166 → 170 (each measured + 3, rounded up). /tools/isolation itself is 173.1,
 *    ceiling 177: it runs eighty schedules through the whole schedule runner, which no other route needs.
 *  - 2026-10-10, versions and snapshots (§25.4 D4): the schedule tool gained the version store's panels, a visibility
 *    question and a buffer-pool scan, none of it shared with another route. /tools/schedule 176 → 181 (measured 177.0 + 3,
 *    rounded up). `mvcc.ts` is imported only by the schedule runner, so no other route moved.
 *  - 2026-10-10, isolation levels (§25.4 D3): `runQuery` recognises `BEGIN ISOLATION LEVEL …` (engine code every route
 *    shares; the level names live in `isolation.ts`, which only the schedule tool imports). /learn 169 → 173,
 *    /tools/btree 170 → 174, and the schedule tool itself 172 → 176 (each measured + 3, rounded up).
 *  - 2026-10-10, enforced locking (§25.4 D2): the accounts seed became parameterised (three rows or twenty), which is
 *    engine code every route shares, and the lock rules moved into `engine/locks/lockTable.ts`. /tools/parser 168 → 172
 *    and /docs/concepts/btree 173 → 177 (each measured + 3, rounded up); /tools/schedule itself is at 171 of 172.
 *  - 2026-10-10, transaction schedules (§25.4 D1): `runQuery` now recognises BEGIN/COMMIT/ROLLBACK and says where they
 *    work, which is engine code every route shares, and the docs gained a Transactions section and two table rows.
 *    /trace 167 → 171, /progress 171 → 175, /docs and the two essays 158 → 162, /docs/concepts/buffer-pool 171 → 175
 *    (each measured + 3, rounded up). `schedule.ts` itself is deliberately NOT in the engine barrel: re-exporting it
 *    added 4.7 kB (1.7 kB gzip) to the shared engine chunk of every route, for one tool that uses it, so the tool
 *    imports it directly. The package barrel can take it back when a subpath export for the transactions work exists.
 *  - 2026-10-10, the scan ring (§25.4 F7): the pool's ring and the range notation for a marked scan are engine code, so the
 *    routes that run the engine grew a little, and the buffer-pool sandbox also gained its Scan ring control. /learn/:id
 *    168 → 172, /challenges 167 → 171, /tools/buffer-pool 169 → 173 (each measured + 3, rounded up).
 *  - 2026-10-05, sequential read-ahead (§25.4 F7, decided: prefetches are reads shown as `prefetch`, and a later request is a
 *    hit): the buffer pool is shared by every route that runs the engine, so /compare 175 → 179, /tools/planner 168 → 172,
 *    /tools/lsm 118 → 121 (each measured + 3, rounded up).
 *  - 2026-10-05, 2Q, a second scan-resistant replacement policy (§25.4 F7, slice 2): it lives in the engine's shared
 *    policy registry, so every route that runs the engine grew a little. /stages/:id 180 → 184, /challenges/:id
 *    286 → 290, /tools/join-order 164 → 168 (each measured + 3, rounded up).
 *  - 2026-10-04, named workspaces (§H7, slice 1): a Workspaces button in Custom mode, and a lazily loaded dialog for
 *    saving, opening, deleting and importing or exporting a workspace file. /playground went from 315.0 to 315.3 kB
 *    (ceiling 315 → 319). The dialog is an opt-in chunk (2.5 kB gzip, ceiling 6), not part of any route's first load.
 *  - 2026-10-04, the essays (§25.4 H2): /docs/essays/index-write-tax and /docs/essays/scan-resistance are prose pages in
 *    the shared docs chunk, so /docs grew from 151.7 to 154.6 kB (ceiling 153 → 158), and each essay route (which
 *    downloads that chunk) gets the same ceiling. The Essays group in docsNav adds a few bytes to the entry chunk every
 *    route pays, which put /tools/join-order just over 163 kB (→ 164). Live widgets were tried and reverted: a lazy or
 *    static import of a shared demo pulled the docs chunk into the entry, costing every route about 50 kB.
 *  - 2026-10-04, the service worker registration and web manifest (§25.4 H1): the registration in main.tsx grew the
 *    entry chunk every route pays from 22.4 to 22.5 kB. /learn/:id was already at its ceiling (167.0 of 167), so
 *    that tipped it over; raised to 168.
 *  - 2026-10-02, row vs. column storage (§25.4 F3, standalone sandbox slice): a new route, /tools/columnar
 *    (114.9 kB measured + 3, rounded to 118) — a self-contained `src/ui/columnar.ts` driver, same family as
 *    `/tools/lsm`'s and `/tools/hash-index`'s, so it does not touch the shared engine chunk and no other route
 *    moved. F3's own real `ColumnScan` operator + projection-pushdown wiring (a genuine engine change) was to be a
 *    separate, later slice of the same item; it was declined by decision on 2026-10-05 (plan.md §25.4 F3).
 *  - 2026-10-14, React 19.3.0 and React Router Dom 7.18.4 merged from main (Dependabot #4, #10, #13): the `react`
 *    chunk (react, react-dom, scheduler) grew from 54.2 to 62.5 kB as this script counts it — gzip level 9, in KiB;
 *    Vite's build output prints the same file as 64.8 kB — and every route pays it through the entry closure. Route
 *    ceilings updated (each measured + 3, rounded up).
 *  - 2026-10-17, flowinger 0.3.0 → 1.0.1: its core grew (touch and pinch on nodes, announcements, a canvas role
 *    that follows what it can do), and the `flow` chunk with it, from 19.9 to 22.9 kB gzip as Vite prints it. Unused
 *    parts are still shaken out (`sideEffects: false`: no MiniMap, Controls or toolbars ship). The entry chunk
 *    imports from `flow`, so every route pays it through the entry closure, as with React 19.3 above: the 36 routes
 *    that went over were raised, each to its measured size + 3, rounded up. Why the entry reaches into `flow` at all
 *    is a separate question (the shell imports two names from it), and the bigger saving if it can stop.
 *  - 2026-10-17, React out of the `flow` chunk: those two names were `react` and `react/jsx-runtime`. A
 *    `codeSplitting` group also takes its modules' dependencies (rolldown's `includeDependenciesRecursively`, on by
 *    default), and groups claim modules in order, so `flow`, listed before `react`, took React's main module,
 *    `react/jsx-runtime` and `react-dom`'s entry as flowinger's dependencies. Every component imports React, so every
 *    route loaded flowinger and d3 too. The `react` group now has `priority: 1` in vite.config.ts and claims them
 *    first: `flow` is 19.0 kB gzip as Vite prints it (was 22.9), `react` 68.3 (was 64.8), and only FlowTree and
 *    StageDetail import `flow`. The 39 routes that draw no tree each fell by about 18.7 kB, and their ceilings were
 *    lowered, each to measured + 3, rounded up (/settings 130 → 111, /tools/locks 133 → 114). The six tree routes fell
 *    by 0.4 kB: /playground 340 → 338; the other five keep their ceilings, which measured + 3 still gives.
 *  - 2026-10-18, `EXISTS` and `NOT EXISTS` as semi- and anti-joins (plan.md §27.5 S1, the first v3 item): the engine's
 *    own chunk (`runQuery`) grew from 49.5 to 53.5 kB gzip as this script counts it (169 → 184 kB raw) — the resolver,
 *    a semi- and an anti-join path in each of the four join operators, the parser's EXISTS grammar with an error and
 *    a hint for each refusal, and the plan's narration, which is most of it. Every route that runs the engine pays it:
 *    the 24 that went over were raised, each to its measured size + 3, rounded up (/playground 338 → 343, / 164 →
 *    168, /tools/planner 187 → 191). The docs chunk grew 1.7 kB with the SQL reference's new section, inside /docs's
 *    ceiling.
 *  - 2026-10-18, UNION, INTERSECT and EXCEPT (plan.md §27.5 S3): the engine chunk grew again, 53.5 → 57.9 kB gzip — the
 *    compound parser, planner, runner and set-operation operator, with their narration — and the docs chunk 1.4 kB with
 *    the reference's new section (the shop preset, S2, added nothing to either). The 28 routes that went over were
 *    raised, each to its measured size + 3, rounded up (/playground 343 → 348, /docs 170 → 174).
 *  - 2026-10-19, `COUNT(DISTINCT x)` (plan.md §27.5 S5): the challenge data, which S4's lesson and challenge had
 *    already filled to within a kilobyte of three ceilings, gained *Count each customer once*, and the engine its
 *    DISTINCT aggregation and narration. The three that went over were raised, each to its measured size + 3, rounded
 *    up: /learn/:id 197 → 201 (197.3), /challenges 190 → 194 (190.6), /challenges/:id 311 → 315 (311.5).
 *  - 2026-10-19, scalar subqueries (plan.md §27.5 S6): the engine chunk, which S4's outer joins and S5's DISTINCT
 *    aggregates had grown inside the slack the S3 bump left, reached 61.6 kB gzip (57.9 after S3) with the scalar
 *    subquery's parser, resolver, errors and narration. The 19 routes that run the engine and went over — none by
 *    more than 1.8 kB — were raised, each to its measured size + 3, rounded up (/playground 348 → 352, / 173 → 177,
 *    /tools/planner 196 → 200).
 *  - 2026-10-19, table aliases and self-joins (plan.md §27.5 S7): the engine chunk 61.6 → 62.8 kB gzip — alias
 *    parsing and scoping, one heap per stored table, ρ in the algebra, the pinned-pool error. The two routes it took
 *    over were raised to measured + 3, rounded up: /gallery 173 → 178 (174.1), /docs/concepts/btree 200 → 205 (201.1).
 *  - 2026-10-19, the precedence graph (plan.md §27.5 T1): /tools/schedule now carries the graph's engine module, its
 *    panel and the replay check (`serialCheck`, which only /tools/concurrency loaded before) — 196.1 kB, raised to
 *    measured + 3, rounded up: 193 → 200. No other route imports them.
 */
export const ROUTES: readonly RouteBudget[] = [
  { route: '/', roots: [P('LandingPage')], kb: 177, note: 'the landing page' },
  { route: '/playground', roots: [P('PlaygroundPage')], kb: 352, note: 'the Playground: the editor, every stage panel, the engine — the heaviest route, and the one most people land on' },
  { route: '/stages', roots: ['src/ui/StagesLayout.tsx', P('StagesIndex')], kb: 177, note: 'the stage explainers, index' },
  { route: '/stages/:id', roots: ['src/ui/StagesLayout.tsx', P('StagePage')], kb: 213, note: 'one stage explainer' },
  { route: '/learn', roots: [P('LearnPage')], kb: 113, note: 'the lesson track' },
  { route: '/learn/:id', roots: [P('LessonPage')], kb: 201, note: 'one lesson' },
  { route: '/examples', roots: [P('ExamplesPage')], kb: 110, note: 'preset queries' },
  { route: '/gallery', roots: [P('GalleryPage')], kb: 178, note: 'named moments' },
  { route: '/compare', roots: [P('ComparePage')], kb: 189, note: 'index vs scan, policy vs policy, hash vs sort, join algorithms, B+Tree vs. LSM' },
  { route: '/trace', roots: [P('TracePage')], kb: 180, note: 'the trace inspector' },
  { route: '/progress', roots: [P('ProgressPage')], kb: 116, note: 'the progress dashboard' },
  { route: '/practice', roots: [P('PracticePage')], kb: 189, note: 'generated questions with engine-computed answers, and a Leitner schedule' },
  { route: '/challenges', roots: [P('ChallengesPage')], kb: 194, note: 'challenge index' },
  { route: '/challenges/:id', roots: [P('ChallengePage')], kb: 315, note: 'one challenge' },
  { route: '/settings', roots: [P('SettingsPage')], kb: 111, note: 'preferences' },
  { route: '/study', roots: [P('StudyPage')], kb: 117, note: 'the §9 study runner (unlisted); the instrument travels in the link, not the bundle (§25.4 A2)' },
  { route: '/assignments/new', roots: [P('AssignmentsNewPage')], kb: 178, note: 'assignment-link builder' },
  { route: '/tools', roots: [P('ToolsIndexPage')], kb: 113, note: 'the tools index' },
  { route: '/tools/buffer-pool', roots: [T('BufferPoolToolPage')], kb: 182, note: 'buffer-pool sandbox' },
  { route: '/tools/parser', roots: [T('ParserToolPage')], kb: 199, note: 'tokenizer + parser sandbox' },
  { route: '/tools/btree', roots: [T('BTreeToolPage')], kb: 201, note: 'B+Tree sandbox' },
  { route: '/tools/page', roots: [T('PageToolPage')], kb: 178, note: 'slotted-page inspector' },
  { route: '/tools/sort', roots: [T('SortToolPage')], kb: 113, note: 'external merge sort' },
  { route: '/tools/planner', roots: [T('PlannerToolPage')], kb: 200, note: 'planner sandbox' },
  { route: '/tools/locks', roots: [T('LocksToolPage')], kb: 114, note: 'lock simulator' },
  { route: '/tools/isolation', roots: [T('IsolationToolPage')], kb: 189, note: 'the Hermitage isolation matrix (both engines, computed)' },
  { route: '/tools/recovery', roots: [T('RecoveryToolPage')], kb: 126, note: 'crash recovery: checkpoints, a crash, and ARIES analysis, redo and undo' },
  { route: '/tools/wal', roots: [T('WalToolPage')], kb: 126, note: 'write-ahead log: a pool, a disk, a log and the rule between them' },
  { route: '/tools/concurrency', roots: [T('ConcurrencyToolPage')], kb: 191, note: 'one schedule under five concurrency-control protocols, each really run' },
  { route: '/tools/schedule', roots: [T('ScheduleToolPage')], kb: 200, note: 'transaction schedules (the engine, a shared database, two sessions)' },
  { route: '/tools/grammar', roots: [T('GrammarToolPage')], kb: 112, note: 'the SQL grammar diagram' },
  { route: '/tools/hash-join', roots: [T('HashJoinToolPage')], kb: 114, note: 'Grace hash join' },
  { route: '/tools/join-order', roots: [T('JoinOrderToolPage')], kb: 178, note: 'Selinger join-order search over the subset lattice' },
  { route: '/tools/lsm', roots: [T('LsmToolPage')], kb: 116, note: 'log-structured merge-tree sandbox' },
  { route: '/tools/hash-index', roots: [T('HashIndexToolPage')], kb: 115, note: 'extendible and linear hashing sandbox' },
  { route: '/tools/columnar', roots: [T('ColumnarToolPage')], kb: 114, note: 'NSM/DSM/PAX row vs. column storage sandbox' },
  { route: '/tools/vector-index', roots: [T('VectorIndexToolPage')], kb: 115, note: 'brute force vs. IVF vs. HNSW vector search' },
  { route: '/tools/latch-crabbing', roots: [T('LatchCrabbingToolPage')], kb: 179, note: 'latch crabbing: naive vs. lock coupling vs. optimistic coupling on a scripted B+Tree workload' },
  { route: '/docs', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 174, note: 'the docs shell and every prose page (one shared chunk)' },
  { route: '/docs/concepts/btree', roots: ['src/ui/DocsLayout.tsx', 'src/pages/DocsContent/concepts/btree.mdx'], kb: 205, note: 'a concept page with a live B+Tree widget' },
  { route: '/docs/essays/index-write-tax', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 174, note: 'an essay: prose, with links into the B+Tree sandbox (plan.md §25.4 H2)' },
  { route: '/docs/essays/repeatable-read', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 174, note: 'an essay: prose, with links into the isolation matrix and the schedule tool (plan.md §25.4 H2)' },
  { route: '/docs/essays/scan-resistance', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 174, note: 'an essay: prose, with links into the buffer-pool sandbox under LRU and LRU-2 (plan.md §25.4 H2)' },
  { route: '/docs/concepts/buffer-pool', roots: ['src/ui/DocsLayout.tsx', 'src/pages/DocsContent/concepts/buffer-pool.mdx'], kb: 184, note: 'a concept page with a live buffer-pool widget' },
  { route: '/* (404)', roots: [P('NotFoundPage')], kb: 110, note: 'the not-found page' },
];

/**
 * What a settings challenge fetches for its own tool, on top of the page and the view (`settingsRunner.ts` loads one
 * module of `src/pages/challenges/settings/` per tool): [tool, kB ceiling, what is in it]. Each is measured + 3,
 * rounded up, as the others are; the isolation matrix's is the only large one, which is the reason they are split.
 */
const SETTINGS_TOOL_CHECKS: readonly (readonly [string, number, string])[] = [
  ['sort', 6, 'the external merge sort driver'],
  ['hash-join', 6, 'the Grace hash join driver'],
  ['join-order', 4, 'the join-order graph and the Selinger search'],
  ['page', 5, 'the slotted-page layout'],
  ['hash-index', 7, 'the extendible and linear hashing driver'],
  ['lsm', 7, 'the LSM tree planner'],
  ['columnar', 6, 'the row-and-column layout planner'],
  ['latch-crabbing', 7, 'the latch-crabbing workload and planner'],
  ['vector-index', 7, 'the brute-force, IVF and HNSW search'],
  ['buffer-pool', 5, 'the buffer-pool trace and its policies'],
  ['planner', 4, 'the planner’s rewrite-rule pipeline'],
  ['btree', 5, 'the B+Tree insert and invariants'],
  ['isolation', 16, 'the Hermitage suite on both isolation engines'],
];

/** What is already loaded when a settings challenge fetches its tool's checks: the page and the view. */
const SETTINGS_AFTER = ['src/pages/ChallengePage.tsx', 'src/pages/challenges/SettingsChallengeView.tsx'] as const;

/**
 * Lazy chunks loaded *on top of* a route only after an explicit opt-in, so they belong to no route's budget
 * but must still stay small: [manifest key, kB ceiling, why].
 */
export const OPT_IN: readonly { key: string; kb: number; note: string; after?: string | readonly string[] }[] = [
  { key: '_html-to-image', kb: 8, note: 'panel PNG export (§20.3) — fetched on the first click of Download PNG' },
  { key: 'src/perf/inp.ts', kb: 2, note: 'the opt-in INP recorder for the §9 study (§25.4 A6) — fetched only after a participant opts in' },
  { key: 'src/ui/WorkspaceDialog.tsx', kb: 6, after: 'src/pages/PlaygroundPage.tsx', note: 'the Workspaces dialog (§H7) — fetched only when Custom mode\'s Workspaces button is pressed' },
  { key: 'src/ui/DurabilityDialog.tsx', kb: 17, after: 'src/pages/PlaygroundPage.tsx', note: 'the Durability dialog (§25.4 E4): the write-ahead-log machine, crash and recovery — fetched only when the Playground\'s Durability button is pressed' },
  { key: 'src/pages/challenges/ScriptChallengeView.tsx', kb: 31, after: 'src/pages/ChallengePage.tsx', note: 'a transaction or durability challenge: the schedule runner, the protocol comparison and the log machine — fetched only when one of those challenges is opened' },
  { key: 'src/pages/challenges/SettingsChallengeView.tsx', kb: 8, after: 'src/pages/ChallengePage.tsx', note: 'a storage, execution or isolation challenge: the form and the runner — no driver; each tool\'s own checks are the rows below, fetched when one of its challenges is opened' },
  ...SETTINGS_TOOL_CHECKS.map(([tool, kb, what]) => ({
    key: `src/pages/challenges/settings/${tool}.ts`,
    kb,
    after: SETTINGS_AFTER,
    note: `the ${tool} challenges' checks: ${what} — fetched only when one of those challenges is opened`,
  })),
];

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): number {
  const DIST = 'dist';
  const manifestPath = join(DIST, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`No ${manifestPath} — run \`pnpm build\` first (vite.config.ts sets build.manifest).`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;

  const sizes = new Map<string, number>();
  const size = (file: string): number => {
    let kb = sizes.get(file);
    if (kb === undefined) {
      kb = gzipKb(readFileSync(join(DIST, file)));
      sizes.set(file, kb);
    }
    return kb;
  };

  const results = priceRoutes(manifest, ROUTES, size);
  const failures: string[] = [];

  const entryKb = [...closure(manifest, [ENTRY_KEY])].filter((f) => f.endsWith('.js') && f === manifest[ENTRY_KEY]?.file).reduce((s, f) => s + size(f), 0);
  const entryOver = entryKb > ENTRY_KB;
  console.log(`${entryOver ? '✗' : '✓'} ${'entry chunk'.padEnd(20)} ${entryKb.toFixed(1).padStart(6)} kB / ${String(ENTRY_KB).padStart(3)} kB  the app shell every route pays first (App + Router + layout)`);
  if (entryOver) failures.push(`the entry chunk is ${entryKb.toFixed(1)} kB gzip, over its ${String(ENTRY_KB)} kB budget`);

  const width = Math.max(...ROUTES.map((r) => r.route.length));
  for (const [i, r] of results.entries()) {
    console.log(`${r.over ? '✗' : '✓'} ${r.route.padEnd(width)} ${r.kb.toFixed(1).padStart(6)} kB / ${String(r.budget).padStart(3)} kB  ${ROUTES[i].note}`);
    if (r.over) failures.push(`${r.route} downloads ${r.kb.toFixed(1)} kB gzip, over its ${String(r.budget)} kB budget`);
  }

  const extras: string[] = [];
  for (const o of OPT_IN) {
    const files = [...closure(manifest, [o.key])];
    extras.push(...files);
    // Only what the opt-in adds beyond the entry (and the route it opens from, when it names one): its shared imports are already paid for.
    const afters = o.after === undefined ? [] : typeof o.after === 'string' ? [o.after] : o.after;
    const base = closure(manifest, [ENTRY_KEY, ...afters]);
    const own = files.filter((f) => !base.has(f));
    const kb = own.reduce((s, f) => s + size(f), 0);
    const over = kb > o.kb;
    console.log(`${over ? '✗' : '✓'} ${`opt-in: ${o.key.split('/').pop() ?? o.key}`.padEnd(width)} ${kb.toFixed(1).padStart(6)} kB / ${String(o.kb).padStart(3)} kB  ${o.note}`);
    if (over) failures.push(`the opt-in chunk ${o.key} is ${kb.toFixed(1)} kB gzip, over its ${String(o.kb)} kB budget`);
  }

  const all = readdirSync(join(DIST, 'assets')).filter((f) => /\.(js|css)$/.test(f)).map((f) => `assets/${f}`);
  const total = all.reduce((s, f) => s + size(f), 0);
  console.log(`  ${'all chunks'.padEnd(width)} ${total.toFixed(1).padStart(6)} kB            informational — no visitor downloads all of it, so it is no longer a gate`);

  const orphans = unbudgeted(all, results, extras).filter((f) => size(f) > 0.5);
  if (orphans.length > 0) {
    failures.push(`chunk(s) no route reaches: ${orphans.join(', ')} — add a route (or an opt-in) for them in scripts/bundle-budget.ts`);
  }

  if (failures.length > 0) {
    console.error(`\nBundle budget exceeded:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    console.error('\nEither shrink it or raise the budget deliberately, in a commit that says why.');
    return 1;
  }
  console.log('\nWithin budget.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
