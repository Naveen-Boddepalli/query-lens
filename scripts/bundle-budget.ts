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
 *    moved. F3's own real `ColumnScan` operator + projection-pushdown wiring (a genuine engine change) is a
 *    separate, later slice of the same item.
 */
export const ROUTES: readonly RouteBudget[] = [
  { route: '/', roots: [P('LandingPage')], kb: 165, note: 'the landing page' },
  { route: '/playground', roots: [P('PlaygroundPage')], kb: 319, note: 'the Playground: the editor, every stage panel, the engine — the heaviest route, and the one most people land on' },
  { route: '/stages', roots: ['src/ui/StagesLayout.tsx', P('StagesIndex')], kb: 165, note: 'the stage explainers, index' },
  { route: '/stages/:id', roots: ['src/ui/StagesLayout.tsx', P('StagePage')], kb: 184, note: 'one stage explainer' },
  { route: '/learn', roots: [P('LearnPage')], kb: 169, note: 'the lesson track' },
  { route: '/learn/:id', roots: [P('LessonPage')], kb: 168, note: 'one lesson' },
  { route: '/examples', roots: [P('ExamplesPage')], kb: 115, note: 'preset queries' },
  { route: '/gallery', roots: [P('GalleryPage')], kb: 165, note: 'named moments' },
  { route: '/compare', roots: [P('ComparePage')], kb: 175, note: 'index vs scan, policy vs policy, hash vs sort, join algorithms, B+Tree vs. LSM' },
  { route: '/trace', roots: [P('TracePage')], kb: 167, note: 'the trace inspector' },
  { route: '/progress', roots: [P('ProgressPage')], kb: 171, note: 'the progress dashboard' },
  { route: '/challenges', roots: [P('ChallengesPage')], kb: 167, note: 'challenge index' },
  { route: '/challenges/:id', roots: [P('ChallengePage')], kb: 290, note: 'one challenge' },
  { route: '/settings', roots: [P('SettingsPage')], kb: 116, note: 'preferences' },
  { route: '/study', roots: [P('StudyPage')], kb: 122, note: 'the §9 study runner (unlisted); the instrument travels in the link, not the bundle (§25.4 A2)' },
  { route: '/assignments/new', roots: [P('AssignmentsNewPage')], kb: 166, note: 'assignment-link builder' },
  { route: '/tools', roots: [P('ToolsIndexPage')], kb: 116, note: 'the tools index' },
  { route: '/tools/buffer-pool', roots: [T('BufferPoolToolPage')], kb: 169, note: 'buffer-pool sandbox' },
  { route: '/tools/parser', roots: [T('ParserToolPage')], kb: 168, note: 'tokenizer + parser sandbox' },
  { route: '/tools/btree', roots: [T('BTreeToolPage')], kb: 170, note: 'B+Tree sandbox' },
  { route: '/tools/page', roots: [T('PageToolPage')], kb: 166, note: 'slotted-page inspector' },
  { route: '/tools/sort', roots: [T('SortToolPage')], kb: 118, note: 'external merge sort' },
  { route: '/tools/planner', roots: [T('PlannerToolPage')], kb: 168, note: 'planner sandbox' },
  { route: '/tools/locks', roots: [T('LocksToolPage')], kb: 117, note: 'lock simulator' },
  { route: '/tools/grammar', roots: [T('GrammarToolPage')], kb: 116, note: 'the SQL grammar diagram' },
  { route: '/tools/hash-join', roots: [T('HashJoinToolPage')], kb: 118, note: 'Grace hash join' },
  { route: '/tools/join-order', roots: [T('JoinOrderToolPage')], kb: 168, note: 'Selinger join-order search over the subset lattice' },
  { route: '/tools/lsm', roots: [T('LsmToolPage')], kb: 118, note: 'log-structured merge-tree sandbox' },
  { route: '/tools/hash-index', roots: [T('HashIndexToolPage')], kb: 118, note: 'extendible and linear hashing sandbox' },
  { route: '/tools/columnar', roots: [T('ColumnarToolPage')], kb: 118, note: 'NSM/DSM/PAX row vs. column storage sandbox' },
  { route: '/tools/vector-index', roots: [T('VectorIndexToolPage')], kb: 118, note: 'brute force vs. IVF vs. HNSW vector search' },
  { route: '/tools/latch-crabbing', roots: [T('LatchCrabbingToolPage')], kb: 167, note: 'latch crabbing: naive vs. lock coupling on a scripted B+Tree workload' },
  { route: '/docs', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 158, note: 'the docs shell and every prose page (one shared chunk)' },
  { route: '/docs/concepts/btree', roots: ['src/ui/DocsLayout.tsx', 'src/pages/DocsContent/concepts/btree.mdx'], kb: 173, note: 'a concept page with a live B+Tree widget' },
  { route: '/docs/essays/index-write-tax', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 158, note: 'an essay: prose, with links into the B+Tree sandbox (plan.md §25.4 H2)' },
  { route: '/docs/essays/scan-resistance', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 158, note: 'an essay: prose, with links into the buffer-pool sandbox under LRU and LRU-2 (plan.md §25.4 H2)' },
  { route: '/docs/concepts/buffer-pool', roots: ['src/ui/DocsLayout.tsx', 'src/pages/DocsContent/concepts/buffer-pool.mdx'], kb: 171, note: 'a concept page with a live buffer-pool widget' },
  { route: '/* (404)', roots: [P('NotFoundPage')], kb: 114, note: 'the not-found page' },
];

/**
 * Lazy chunks loaded *on top of* a route only after an explicit opt-in, so they belong to no route's budget
 * but must still stay small: [manifest key, kB ceiling, why].
 */
export const OPT_IN: readonly { key: string; kb: number; note: string; after?: string }[] = [
  { key: '_html-to-image', kb: 8, note: 'panel PNG export (§20.3) — fetched on the first click of Download PNG' },
  { key: 'src/perf/inp.ts', kb: 2, note: 'the opt-in INP recorder for the §9 study (§25.4 A6) — fetched only after a participant opts in' },
  { key: 'src/ui/WorkspaceDialog.tsx', kb: 6, after: 'src/pages/PlaygroundPage.tsx', note: 'the Workspaces dialog (§H7) — fetched only when Custom mode\'s Workspaces button is pressed' },
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
    const base = closure(manifest, o.after === undefined ? [ENTRY_KEY] : [ENTRY_KEY, o.after]);
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
