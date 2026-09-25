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
 */
export const ROUTES: readonly RouteBudget[] = [
  { route: '/', roots: [P('LandingPage')], kb: 157, note: 'the landing page' },
  { route: '/playground', roots: [P('PlaygroundPage')], kb: 307, note: 'the Playground: the editor, every stage panel, the engine — the heaviest route, and the one most people land on' },
  { route: '/stages', roots: ['src/ui/StagesLayout.tsx', P('StagesIndex')], kb: 157, note: 'the stage explainers, index' },
  { route: '/stages/:id', roots: ['src/ui/StagesLayout.tsx', P('StagePage')], kb: 173, note: 'one stage explainer' },
  { route: '/learn', roots: [P('LearnPage')], kb: 162, note: 'the lesson track' },
  { route: '/learn/:id', roots: [P('LessonPage')], kb: 159, note: 'one lesson' },
  { route: '/examples', roots: [P('ExamplesPage')], kb: 115, note: 'preset queries' },
  { route: '/gallery', roots: [P('GalleryPage')], kb: 154, note: 'named moments' },
  { route: '/compare', roots: [P('ComparePage')], kb: 165, note: 'index vs scan, policy vs policy, hash vs sort, join algorithms' },
  { route: '/trace', roots: [P('TracePage')], kb: 160, note: 'the trace inspector' },
  { route: '/progress', roots: [P('ProgressPage')], kb: 164, note: 'the progress dashboard' },
  { route: '/challenges', roots: [P('ChallengesPage')], kb: 156, note: 'challenge index' },
  { route: '/challenges/:id', roots: [P('ChallengePage')], kb: 279, note: 'one challenge' },
  { route: '/settings', roots: [P('SettingsPage')], kb: 116, note: 'preferences' },
  { route: '/study', roots: [P('StudyPage')], kb: 122, note: 'the §9 study runner (unlisted); the instrument travels in the link, not the bundle (§25.4 A2)' },
  { route: '/assignments/new', roots: [P('AssignmentsNewPage')], kb: 159, note: 'assignment-link builder' },
  { route: '/tools', roots: [P('ToolsIndexPage')], kb: 116, note: 'the tools index' },
  { route: '/tools/buffer-pool', roots: [T('BufferPoolToolPage')], kb: 161, note: 'buffer-pool sandbox' },
  { route: '/tools/parser', roots: [T('ParserToolPage')], kb: 156, note: 'tokenizer + parser sandbox' },
  { route: '/tools/btree', roots: [T('BTreeToolPage')], kb: 161, note: 'B+Tree sandbox' },
  { route: '/tools/page', roots: [T('PageToolPage')], kb: 158, note: 'slotted-page inspector' },
  { route: '/tools/sort', roots: [T('SortToolPage')], kb: 118, note: 'external merge sort' },
  { route: '/tools/planner', roots: [T('PlannerToolPage')], kb: 161, note: 'planner sandbox' },
  { route: '/tools/locks', roots: [T('LocksToolPage')], kb: 117, note: 'lock simulator' },
  { route: '/tools/grammar', roots: [T('GrammarToolPage')], kb: 116, note: 'the SQL grammar diagram' },
  { route: '/tools/hash-join', roots: [T('HashJoinToolPage')], kb: 118, note: 'Grace hash join' },
  { route: '/docs', roots: ['src/ui/DocsLayout.tsx', '_docs'], kb: 149, note: 'the docs shell and every prose page (one shared chunk)' },
  { route: '/docs/concepts/btree', roots: ['src/ui/DocsLayout.tsx', 'src/pages/DocsContent/concepts/btree.mdx'], kb: 163, note: 'a concept page with a live B+Tree widget' },
  { route: '/docs/concepts/buffer-pool', roots: ['src/ui/DocsLayout.tsx', 'src/pages/DocsContent/concepts/buffer-pool.mdx'], kb: 163, note: 'a concept page with a live buffer-pool widget' },
  { route: '/* (404)', roots: [P('NotFoundPage')], kb: 114, note: 'the not-found page' },
];

/**
 * Lazy chunks loaded *on top of* a route only after an explicit opt-in, so they belong to no route's budget
 * but must still stay small: [manifest key, kB ceiling, why].
 */
export const OPT_IN: readonly { key: string; kb: number; note: string }[] = [
  { key: '_html-to-image', kb: 8, note: 'panel PNG export (§20.3) — fetched on the first click of Download PNG' },
  { key: 'src/perf/inp.ts', kb: 2, note: 'the opt-in INP recorder for the §9 study (§25.4 A6) — fetched only after a participant opts in' },
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
    // Only what the opt-in adds beyond the entry — its shared imports are already paid for by the route.
    const own = files.filter((f) => !closure(manifest, [ENTRY_KEY]).has(f));
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
