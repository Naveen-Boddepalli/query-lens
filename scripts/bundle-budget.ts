/**
 * A gzip budget for `dist/`, checked in CI (plan.md §14.2).
 *
 * The point is not the numbers, it is that they cannot drift silently. A bundle
 * grows one import at a time and nobody notices until the lecture-hall laptop
 * on hotel wifi does — which is the audience §14 question 7 is about.
 *
 * Budgets are set a little above the current size: tight enough that adding a
 * dependency shows up here, loose enough that a normal change does not fail the
 * build. Raising one is a deliberate act with a diff, which is the whole idea.
 *
 * Run: pnpm budget   (after pnpm build)
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/assets';

/** Matched against the chunk name; the first match wins. */
const BUDGETS: { name: string; test: RegExp; kb: number; note: string }[] = [
  { name: 'codemirror', test: /^codemirror-/, kb: 128, note: 'SQL editor, loaded with the Playground route' },
  { name: 'flow', test: /^flow-.*\.js$/, kb: 70, note: 'React Flow + d3-hierarchy' },
  { name: 'react', test: /^react-/, kb: 62, note: 'react + react-dom' },
  // The entry chunk after M13 (plan.md §21.5). Every route is now `React.lazy`,
  // so this is App + Router + the layout shell and little else — down from the
  // ~44 kB it had crept to across `5c7ef5d` and the docs migration, neither of
  // which moved the old 34 kB line. Tight on purpose: a jump here means a page
  // (or its deps) stopped being lazy.
  { name: 'entry', test: /^index-.*\.js$/, kb: 24, note: 'App + Router + layout shell — most commits touch this' },
  // The trace UI: the Playground page, the StageDetail panel it shares with the
  // stage explainers, and the engine-core plumbing (the tracer, the seed data,
  // playback controls) two or more lazy routes now import — rolldown hoists a
  // module into its own chunk the moment a second entry point needs it, which
  // is why `seed-*.js` and `trace-*.js` exist as their own files rather than
  // being duplicated into every page that touches the demo database.
  { name: 'trace-ui', test: /^(PlaygroundPage|StageDetail|stageMeta|types|seed|trace|PlaybackControls|AstTree|BTreePanel|FlowTree|display)-/, kb: 32, note: 'Playground + the shared panel/tree renderers (AstTree, BTreePanel, FlowTree, the two display transformers) that split out once the parser and B+Tree sandboxes became second importers' },
  // The small per-route shells: landing hub, stage index, examples, docs shell,
  // 404, tools index — plus the redesign's shared UI kit (primitives.ts,
  // PageHeader, Hero) that two or more of them import.
  { name: 'routes', test: /^(LandingPage|Hero|PageHeader|primitives|StagePage|StagesIndex|StagesLayout|ExamplesPage|DocsLayout|NotFoundPage|ToolsIndexPage)-/, kb: 12, note: 'lazy per-route chunks + shared UI kit, loaded on navigation' },
  // The §21.3 feature routes: Gallery, Compare, Settings, Assignments, the
  // buffer-pool sandbox, and what they share — the standalone buffer-trace
  // driver (src/engine/bufferTrace.ts), the panel it renders through, and the
  // thin `preferences`/`urlState` helpers. None of it loads unless one of
  // these routes is visited.
  { name: 'standalone-tools', test: /^(GalleryPage|ComparePage|SettingsPage|AssignmentsNewPage|TracePage|BufferPoolToolPage|ParserToolPage|BTreeToolPage|BufferPoolPanel|bufferTrace|preferences|urlState)-/, kb: 24, note: 'Gallery, Tools, Compare, Settings, Assignments, the trace inspector, and the buffer-pool / parser / B+Tree sandboxes (plan.md §21.3, §20.4)' },
  // The `/learn` guided track (plan.md §21.3): the index, one lesson page, the
  // localStorage progress helper, and `lessons.tsx` — the lesson prose plus the
  // link-builder that computes each step from a real engine run. Lazy; loads
  // only when someone visits `/learn`.
  { name: 'learn', test: /^(LearnPage|LessonPage|learnProgress|lessons)-/, kb: 8, note: 'the /learn track: index, lesson page, progress, and the lesson content' },
  // The nine docs pages, folded into one async chunk by vite.config.ts. Loads
  // on the first `/docs` hit, never at first paint.
  { name: 'docs', test: /^docs-.*\.js$/, kb: 16, note: 'integrated MDX docs (plan.md §17.1), lazy' },
  // Raised 14 → 17: @tailwindcss/typography (the docs' `.prose` styling,
  // themed onto the app's own tokens rather than its default palette — see
  // index.css) is a real, one-time addition to the generated stylesheet.
  // Raised 17 → 20: the premium-minimal redesign adds an elevation/shadow
  // scale, hero gradient + grain tokens, three keyframes, themed scrollbars,
  // the `.ql-sheen` top-highlight utility and an expanded `.prose` block — all
  // one-time additions to the generated stylesheet, none of it JS.
  { name: 'css', test: /\.css$/, kb: 20, note: "Tailwind's output, React Flow's stylesheet, the typography plugin, and the redesign's elevation/motion layer" },
  { name: 'runtime', test: /^rolldown-runtime-/, kb: 2, note: 'module loader emitted by rolldown' },
];

/**
 * Everything together, so a chunk moving between groups cannot hide growth.
 * Raised 315 → 335 for the §21.3 feature routes (Gallery, Tools, Compare,
 * Settings, Assignments).
 * Raised 335 → 342 for the §20.4 standalone tools — the parser and B+Tree
 * sandboxes, plus the shared panel renderers (FlowTree, BTreePanel, the two
 * display transformers) that split into their own chunks once a second route
 * imported them.
 * Raised 342 → 348 for the `/learn` guided track (two routes plus the lesson
 * content). None of it is first-paint: a chunk loads only when its route
 * is visited.
 */
const TOTAL_KB = 348;

const gzipKb = (bytes: Buffer): number => gzipSync(bytes, { level: 9 }).length / 1024;

let total = 0;
const failures: string[] = [];
const unbudgeted: string[] = [];

// Summed per group, not per file: two stylesheets that each fit the CSS budget
// but together do not is exactly the drift this is meant to catch.
const measured = new Map<string, number>(BUDGETS.map((b) => [b.name, 0]));

for (const file of readdirSync(DIST).sort()) {
  const size = gzipKb(readFileSync(join(DIST, file)));
  total += size;

  const budget = BUDGETS.find((b) => b.test.test(file));
  if (!budget) {
    // A new chunk with no budget is not a pass — it is a gap in this file.
    if (size > 1) unbudgeted.push(`${file} (${size.toFixed(1)} kB)`);
    continue;
  }
  measured.set(budget.name, (measured.get(budget.name) ?? 0) + size);
}

for (const budget of BUDGETS) {
  const size = measured.get(budget.name) ?? 0;
  const over = size > budget.kb;
  console.log(
    `${over ? '✗' : '✓'} ${budget.name.padEnd(11)} ${size.toFixed(1).padStart(7)} kB / ${String(budget.kb).padStart(4)} kB  ${budget.note}`,
  );
  if (over) {
    failures.push(
      `${budget.name} is ${size.toFixed(1)} kB gzip, over its ${String(budget.kb)} kB budget`,
    );
  }
}
console.log(
  `${total > TOTAL_KB ? '✗' : '✓'} ${'total'.padEnd(11)} ${total.toFixed(1).padStart(7)} kB / ${String(TOTAL_KB).padStart(4)} kB`,
);

if (total > TOTAL_KB) {
  failures.push(`total is ${total.toFixed(1)} kB gzip, over the ${String(TOTAL_KB)} kB budget`);
}
if (unbudgeted.length > 0) {
  failures.push(`unbudgeted chunk(s): ${unbudgeted.join(', ')} — add them to scripts/bundle-budget.ts`);
}

if (failures.length > 0) {
  console.error(`\nBundle budget exceeded:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  console.error('\nEither shrink it or raise the budget deliberately, in a commit that says why.');
  process.exit(1);
}

console.log('\nWithin budget.');
