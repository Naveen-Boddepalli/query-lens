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
  // Raised 32 → 34 for the presenter view (`PresenterView.tsx`, plan.md §22.5) —
  // a room-facing overlay over the same playback and panels, lazy with the
  // Playground route.
  // Raised 34 → 35 for the panel `?` "what am I looking at?" affordance (plan.md
  // §19.2 P1): a disclosure in `StageDetail` plus a two-sentence `help` string
  // and a concept-page `doc` link per stage in `stageMeta` — which also
  // replaced the near-duplicate `STAGE_DESCRIPTIONS` on the `/stages` index, so
  // `routes` shrank and the total barely moved.
  // Raised 35 → 37 for the 60-second tour (`PlaygroundTour.tsx`, plan.md §19.2
  // P1) — the last of §19.2's four onboarding items. Two render modes in the
  // Playground chunk (same call as `PresenterView`): a stepped spotlight and,
  // for `prefers-reduced-motion`, a static numbered overlay.
  // `datasets`/`datasetCatalogue` (plan.md §22.7's preset dataset library) join
  // this group — the Playground and the trace inspector share both.
  // Raised 37 → 38 for the print worksheet (`TraceWorksheet.tsx`, §22.6) —
  // bundled into the Playground chunk, rendered only while printing.
  // `engine-*.js` joined this group once `/tools/planner` (§22.3) became a
  // second importer of the planner + `buildPlan` + `toPlanDisplay`, so rolldown
  // hoisted that shared engine code out of the Playground chunk into its own —
  // a move between chunks, not growth, but it shows here.
  // Raised 46 → 48 for JOIN (§22.2): a `Join` plan node and its nested-loop
  // operator, `createJoinDemoDatabase`'s small `authors`/`posts` fixture, and
  // the cost model's/parser's growth to carry a second table through —
  // `engine-*.js` is the largest single mover, `/tools/planner` (this group)
  // and `/tools/grammar` (`standalone-tools`) both import it.
  // Raised 48 → 49 for hash join, JOIN's second algorithm (§22.2): a
  // `hashJoin` operator in `exec/operators.ts`, the cost model's
  // per-algorithm estimate, and `equalityKeyOf` in `exec/evaluate.ts` — all
  // in `engine-*.js`, which this group still hoists.
  // Raised 49 → 51 for the multi-table schema editor (§22.7): `SchemaEditor.tsx`
  // + `customDatabase.ts` (localStorage load/save, name validation reusing the
  // real tokenizer, the starter database) — the piece JOIN shipped without,
  // so it can finally run from the Playground itself instead of staying
  // `/tools/planner` + `/compare`-only.
  // Raised 51 → 53 for the true vector SVG export (§20.3): `renderSvg.ts` (the
  // shared d3-hierarchy-to-`<svg>` renderer) + `DownloadSvgButton.tsx`, plus
  // `astTreeTones.ts`/`planTreeTones.ts`/`btreeTones.ts` — each tree's own tone
  // map and `toFlow`, split out of its component file so Fast Refresh still
  // works (a component file can only export components) and so `StageDetail`
  // can reuse the exact same map the on-screen tree already renders with,
  // rather than a second one that could drift.
  { name: 'trace-ui', test: /^(PlaygroundPage|PlaygroundTour|TraceWorksheet|StageDetail|stageMeta|datasets|datasetCatalogue|types|seed|trace|runQuery|engine|SqlEditor|PlaybackControls|PresenterView|AstTree|BTreePanel|FlowTree|display|SchemaEditor|customDatabase|renderSvg|DownloadSvgButton|astTreeTones|planTreeTones|btreeTones)-/, kb: 53, note: 'Playground + the presenter view + the SQL editor + the shared panel/tree renderers (AstTree, BTreePanel, FlowTree, the two display transformers) plus the engine core (runQuery and the planner split into their own chunks once a third / second route imported them; SqlEditor split once /challenges became a second) plus the preset dataset library, the print worksheet, LIMIT, ORDER BY + the Sort operator, the full DELETE + INSERT + UPDATE write path, GROUP BY + aggregates, JOIN — both algorithms, the multi-table schema editor, and true vector SVG export (plan.md §22.2, §22.7, §20.3)' },
  // The small per-route shells: landing hub, stage index, examples, docs shell,
  // 404, tools index — plus the redesign's shared UI kit (primitives.ts,
  // PageHeader, Hero) that two or more of them import.
  { name: 'routes', test: /^(LandingPage|Hero|PageHeader|primitives|StagePage|StagesIndex|StagesLayout|ExamplesPage|DocsLayout|NotFoundPage|ToolsIndexPage)-/, kb: 12, note: 'lazy per-route chunks + shared UI kit, loaded on navigation' },
  // The §21.3 feature routes: Gallery, Compare, Settings, Assignments, the
  // buffer-pool sandbox, and what they share — the standalone buffer-trace
  // driver (src/engine/bufferTrace.ts), the panel it renders through, and the
  // thin `preferences`/`urlState` helpers. None of it loads unless one of
  // these routes is visited.
  // Raised 24 → 26 for the slotted-page inspector (`/tools/page`, plan.md §22.3)
  // and its `slottedPage.ts` layout module — a fourth `/tools/*` sandbox, lazy.
  // Raised 26 → 27 for assignment sets (`assignmentSet.ts` + the set panel in
  // `/assignments/new`, §22.4).
  // Raised 27 → 31 for the external-merge-sort sandbox (`/tools/sort`, §22.3):
  // `SortToolPage.tsx` + its `externalSort.ts` plan builder — a fifth `/tools/*`
  // sandbox, lazy, plus the `t=`-aware `urlState` from v13's dataset library
  // which also lands in this group.
  // Raised 36 → 37 for the grammar sandbox (`/tools/grammar`, §22.3):
  // `GrammarToolPage.tsx` + `grammar.ts`'s pure rule data — a seventh
  // `/tools/*` sandbox, lazy, and the smallest of the set.
  // Raised 37 → 38 for `/compare`'s third mode, hash aggregate vs. sort
  // aggregate (§22.2): `ComparePage.tsx` grows an `AggregateCompare` panel,
  // the same shape as `IndexCompare`'s scorecards.
  // Raised 38 → 39 for `/compare`'s fourth mode, nested-loop join vs. hash
  // join (§22.2): a `JoinCompare` panel, the same shape as the other three,
  // plus its own small `authors`/`posts` demo database.
  // Raised 39 → 43 for `/tools/hash-join` (§22.3): `HashJoinToolPage.tsx` +
  // its own driver, `hashJoin.ts` (partitioning, per-level spill, and the
  // bucket-collision build/probe model) — an eighth `/tools/*` sandbox,
  // lazy, and the first to need its own recursive tree renderer.
  { name: 'standalone-tools', test: /^(GalleryPage|ComparePage|SettingsPage|AssignmentsNewPage|TracePage|BufferPoolToolPage|ParserToolPage|BTreeToolPage|PageToolPage|SortToolPage|PlannerToolPage|LocksToolPage|lockSimulation|GrammarToolPage|grammar|HashJoinToolPage|hashJoin|BufferPoolPanel|bufferTrace|slottedPage|externalSort|assignmentSet|preferences|urlState)-/, kb: 43, note: 'Gallery, Tools, Compare, Settings, Assignments (+ assignment sets), the trace inspector, and the buffer-pool / parser / B+Tree / slotted-page / external-merge-sort / planner / locks / grammar / hash-join sandboxes (plan.md §21.3, §20.4, §22.3, §22.4)' },
  // The `/learn` guided track (plan.md §21.3): the index, one lesson page, the
  // localStorage progress helper, and `lessons.tsx` — the lesson prose plus the
  // link-builder that computes each step from a real engine run. Lazy; loads
  // only when someone visits `/learn`.
  { name: 'learn', test: /^(LearnPage|LessonPage|ProgressPage|learnProgress|progress|lessons)-/, kb: 10, note: 'the /learn track (index, lesson page, nine lessons) plus the /progress dashboard, which shares the lesson list' },
  // The `/challenges` puzzles (plan.md §22.4): the index, one challenge page,
  // the pure check list, and the localStorage solved-set. Lazy.
  { name: 'challenges', test: /^(ChallengesPage|ChallengePage|challenges|challengeProgress)-/, kb: 8, note: '/challenges — index, challenge page, the check list, and solved-set storage (plan.md §22.4)' },
  // `html-to-image`, behind the panel "Download PNG" button (§20.3). `import()`ed
  // on the first export, never at route load — the one runtime dependency the
  // app adds beyond its framework and editor.
  { name: 'html-to-image', test: /^html-to-image-/, kb: 8, note: 'panel PNG export, lazy-loaded on first use (plan.md §20.3)' },
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
 * content).
 * Raised 348 → 354 for `html-to-image` behind the panel PNG export (§20.3) —
 * `import()`ed on first use, so still never first-paint.
 * Raised 354 → 357 for five more `/learn` lessons (§22.4 — B+Tree split, edit
 * the seed data, predict, share a moment, when something goes wrong): pure
 * teaching prose in the lazy `learn` chunk, never first-paint, plus small
 * additions to `stepAnnouncement`/`traceFile` from the same v13 batch.
 * Raised 357 → 360 for `/tools/page`, the slotted-page inspector (§22.3): its
 * own lazy chunk plus `runQuery-*.js`, which rolldown hoisted out of `trace-ui`
 * once a third route imported the engine core — a move between groups, not
 * growth, but it shows in the total.
 * Raised 360 → 362 for the presenter view (`PresenterView.tsx`, §22.5) — the
 * room-facing overlay, lazy with the Playground route.
 * Raised 362 → 363 for the `/progress` dashboard (§22.4) and its `progress.ts`
 * localStorage helper — a lazy route plus a few lines in the Playground.
 * Raised 363 → 364 for CSV paste-import in the seed editor (`parseCsv.ts`, §22.7)
 * — a small reader plus the panel in `DataEditor`, both in the Playground chunk.
 * Raised 364 → 368 for `/challenges` (§22.4): the two pages, the check list and
 * the solved-set, plus `SqlEditor-*.js` splitting out of `trace-ui` once the
 * challenge page became its second importer — a move, mostly, but visible here.
 * Raised 368 → 369 for the first-visit hint (§19.2 P1): `FirstVisitHint.tsx` +
 * `firstVisit.ts` in the entry chunk, since `Layout` mounts the one line under
 * the header for a cold visitor to `/playground`.
 * Raised 369 → 371 for the 60-second tour (`PlaygroundTour.tsx`, §19.2 P1) — a
 * spotlight-over-the-real-UI mode and a static numbered-overlay fallback for
 * reduced motion, in the Playground chunk; closes out §19.2's P1 list.
 * Raised 371 → 373 for the preset dataset library (§22.7): `datasets.ts` builds
 * `orders` and `logins` alongside `users`, `datasetCatalogue.ts` holds their
 * copy + preset queries, and the Playground / trace inspector / URL (`t=`) /
 * trace file all learned to carry a dataset id.
 * Raised 373 → 377 for `/tools/sort` (§22.3) — the external-merge-sort sandbox
 * (`SortToolPage.tsx` + `externalSort.ts`), a fifth lazy `/tools/*` route.
 * Raised 377 → 379 for `/tools/planner` (§22.3) — the optimizer sandbox
 * (`PlannerToolPage.tsx`); most of the delta is rolldown hoisting the shared
 * planner code into `engine-*.js` rather than new bytes.
 * Raised 379 → 381 for the cost model (`planner/cost.ts`, §22.2, §7.3) — per-node
 * row/page estimates in the `engine-*.js` chunk, the `~N rows` line in `FlowTree`,
 * and the estimate-vs-actual reconciliation in the plan/optimize/result narration.
 * Raised 381 → 383 for `LIMIT` and `ORDER BY` + a real `Sort` operator (§22.2):
 * a `Limit`/`Sort` plan node and executor operator each, `exec/sort.ts` (the
 * external-merge-sort driver), the buffer pool's new `write` path for spill
 * pages, and the matching additions to `PlanTree`/`AstTree`/`BufferPoolPanel`.
 * Raised 383 → 385 for the write path's first statement, `DELETE` (§22.2):
 * a second parser entry point (`parseStatement`, SELECT or DELETE) sharing
 * every grammar rule with `parse`, `exec/delete.ts` (finds matches, then runs
 * the real `deleteKey` B+Tree algorithm and marks heap pages dirty), and the
 * buffer pool's `markDirty` — a dirty page's eviction now costs a write, not
 * just a discard, completing the read/write pair `write()` started.
 * Raised 385 → 387 for the write path's second statement, `INSERT` (§22.2):
 * `parseStatement` grows a third grammar (an optional column list, a VALUES
 * list of literals, sharing the parenthesised-list plumbing with the column
 * list), `exec/insert.ts` (writes the new row onto the last heap page or a
 * fresh one, then runs the real `insert` B+Tree algorithm — real leaf/internal
 * splits, narrated the same way `/tools/btree` narrates its own), and the
 * matching additions to `AstTree`/`display.ts`. INSERT has no predicate to
 * plan or optimize, so it is also the first statement to skip straight from
 * parse to execute — a real, honest gap in the pipeline tracker, not a bug.
 * Raised 387 → 388 for the write path's third and last statement, `UPDATE`
 * (§22.2), completing it: a fourth grammar (`SET col = value, ...`, reusing
 * INSERT's literal-value parsing), `exec/update.ts` (finds matches exactly
 * the way `DELETE` does, applies the assignments, and — if the indexed
 * column changed — drops the old key and adds the new one through the real
 * `deleteKey`/`insert` algorithms; the delete-then-reinsert pair those two
 * statements already built, reused rather than reimplemented), and
 * `planner/emitUpdate.ts` reusing the same optimizer-wrapping trick
 * `DELETE`'s plan does. The full `INSERT`/`UPDATE`/`DELETE` write path is
 * now real, in the pipeline, not just `/tools/btree`.
 * Raised 388 → 390 for aggregates and `GROUP BY` (§22.2), the largest single
 * addition to the SELECT grammar since v0: a `SelectItem` union (a plain
 * column, or `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` over one), a `HashAggregate`
 * plan node between `Filter` and `Project`, and its operator — the second
 * one here that cannot stream, for the same reason `Sort` cannot, building
 * one hash-table bucket per distinct `GROUP BY` combination. `constant-folding`,
 * `predicate-pushdown` and `index-selection` all learned to see past a
 * `HashAggregate` the same way they already saw past `Sort`/`Limit` — WHERE
 * always applies before aggregation, so pushing a predicate underneath one is
 * never a shortcut. One strategy only; a sort aggregate and the `/compare`
 * mode plan.md names as the point of the pair are a later milestone.
 * Index-only scan (a fourth optimizer rule) fit within the existing budget —
 * no bump needed.
 * Raised 390 → 393 for `/tools/locks` (§22.2 "enforced concurrency" / §22.3):
 * `src/ui/lockSimulation.ts`, a pure two-transaction lock simulator — real
 * blocking, a wait-for graph, deadlock detection and victim selection — with
 * its own driver, the same way `/tools/sort` has one; the SQL pipeline itself
 * stays single-query on purpose, so nothing there needed to change.
 * Raised 393 → 394 for `/tools/grammar` (§22.3): `grammar.ts`'s rule data plus
 * `GrammarToolPage.tsx`'s chip-diagram renderer — the smallest `/tools/*`
 * sandbox yet, since it is pure display over data the parser already defines.
 * Raised 394 → 396 for the sort aggregate and `/compare`'s third mode
 * (§22.2): `SortAggregate`, a second aggregate strategy in `engine-*.js`
 * (a composite-key generalisation of `externalMergeSort`, shared with `Sort`,
 * plus a new streaming collapse pass over the now-sorted rows), and
 * `ComparePage.tsx`'s `AggregateCompare` panel forcing each strategy in turn
 * via `EngineOptions.aggregateStrategy` and scoring the two side by side.
 * Raised 396 → 399 for JOIN (§22.2) — v1's first: a qualified `table.column`
 * reference throughout the parser (`Expr`/`SelectItem` gain an optional
 * `table`), a `JoinClause` AST node and its parse-time validity checks, a
 * `Join` plan node and nested-loop operator (the executor's first two-table
 * `ExecContext`, `joinRight`, sharing one real buffer pool with the FROM
 * table's own heap), and the cost model's join estimate. `/tools/planner`
 * gained a small fixed `authors`/`posts` pair (`createJoinDemoDatabase`) to
 * try it against, without touching `users`' own index toggle.
 * `trace-ui` and `standalone-tools` both bumped for hash join, JOIN's second
 * algorithm, and `/compare`'s fourth mode naming it against nested-loop — the
 * total itself still fits under 399, so it stays put this time.
 * Raised 399 → 403 for `/tools/hash-join` (§22.3): a new lazy route plus its
 * own driver, `hashJoin.ts` — an eighth `/tools/*` sandbox.
 * Raised 403 → 406 for the multi-table schema editor (§22.7): `SchemaEditor.tsx`
 * + `customDatabase.ts` in the Playground chunk, and a small `DataEditor.tsx`
 * change (an optional `onReset`) it reuses for per-table row editing.
 * Raised 406 → 409 for true vector SVG export (§20.3): `renderSvg.ts` +
 * `DownloadSvgButton.tsx`, plus each tree's tone map/`toFlow` moving into its
 * own file so `StageDetail` can reuse them without a second colour table.
 */
const TOTAL_KB = 409;

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
