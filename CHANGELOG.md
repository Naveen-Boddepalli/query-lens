# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`DELETE`, the write path's first statement** (plan.md §22.2) — `DELETE FROM table [WHERE ...]`
  removes rows for real, persisted in the Playground the same way the seed-data editor already
  persists an edit. A new parser entry point, `parseStatement`, dispatches to `SELECT` or `DELETE`
  through a shared `Cursor` abstraction (`parse` stays `SELECT`-only for its existing callers).
  Execution is a dedicated find-then-mutate pass (`exec/delete.ts`), not a reused Volcano
  operator — a delete has to find every match before it mutates anything, since removing mid-scan
  could shift what a later step reads — but it narrates through the same `execute`-stage shape
  (`SeqScan`/`IndexScan`, then `Delete`) so the Execute panel reads the same way a `SELECT`'s does.
  It takes real exclusive locks on the heap pages it touches, and removes each row's key from the
  B+Tree with the actual `deleteKey` algorithm — real borrows, merges, and root-collapses, narrated.
  `predicate-pushdown`/`index-selection` are reused unchanged, by wrapping the delete's scan in a
  throwaway `Project *` for optimization and unwrapping it again for both execution and display.
  `BufferPool` gained `markDirty()`: a page a `DELETE` removed a row from now costs a write back to
  disk on eviction, not just a discard — completing the read/write pair `Sort`'s `write()` started,
  shown in the Buffer Pool panel's `writes` stat and the eviction narration ("Page N is dirty — a
  row was deleted from it — so evicting it costs a write back to disk first"). 25 unit tests
  (`__tests__/delete.test.ts`), 1 e2e
- **`ORDER BY` with a real external-merge-sort `Sort` operator** (plan.md §22.2, completing
  `ORDER BY`/`LIMIT` + external sort) — the run-generation-then-merge algorithm already worked out
  for `/tools/sort` (`src/ui/externalSort.ts`), now over real table rows and, unlike that sandbox,
  with every page it writes or re-reads flowing through the *actual* buffer pool: `BufferPool` gained
  a `write()` path alongside `fetch()`, so a Sort's spill pages compete for the same frames a heap
  scan uses — real evictions of heap pages by spill pages and back, shown in the Buffer Pool panel as
  a new violet "✎ written" mood and a `writes` stat. Page ids are never reused (`sortTempPageCount`
  reserves a fresh block per pass before the pool exists, sized generously above the
  perfectly-packed count — a bound it can defend, not a precise figure it can't, per §12).
  `predicate-pushdown`/`index-selection` see past a `Sort` exactly as they already saw past a
  `Limit`. Sort is the one operator here that cannot stream — combined with `LIMIT` it caps the
  *output*, not the scan, and the narration says so. `exec/sort.ts`, pure and unit-tested; NULLs
  sort last ascending / first descending, Postgres's own default
- **`LIMIT`** (plan.md §22.2, first half of the same backlog item) — a real `Limit`
  plan node and Volcano operator: it stops pulling from the operator tree beneath it once the cap
  is reached and closes it, so `SELECT * FROM users LIMIT 1` genuinely never reads the rest of the
  table — fewer buffer `load` events than the unbounded scan, not just a shorter result. The
  optimizer's `predicate-pushdown` and `index-selection` rules see past an outer `LIMIT`
  transparently, the cost model estimates `min(child, LIMIT n)`, and the AST/plan trees and the
  Parser/Planner/Optimizer panels all show it as a real node
- **In-app EXPLAIN** (plan.md §22.2) — a **Copy as EXPLAIN** button next to Copy as text/Mermaid,
  offered once a query has actually run (the result stage — `EXPLAIN ANALYZE` needs an execution,
  same as Postgres). Prints the final plan tree with the cost model's `est ~N rows` next to the
  `actual N rows` each operator really produced, e.g. `IndexScan users.id  key: id = 5  ·  est ~1
  rows  ·  actual 1 rows`. Pure (`explainToText` in `src/export/toText.ts`), reusing `ViewState`'s
  existing per-operator counts — no new engine surface
- **Cost-based optimizer** (plan.md §7.3, §22.2) — the first engine item off the now-lifted §9 gate
  (see §9's v14 note). Every plan and optimize node carries a `~N rows` estimate and the heuristic
  behind it — an equality is `1 / ndistinct`, an open range is linear over the column's min–max, an
  `AND` multiplies its parts and assumes independence — rendered on the Playground panels and in
  `/tools/planner`. The optimizer's rules still fire without consulting the numbers; the numbers
  *justify* the rewrite: the index-selection narration now reads "the sequential scan reads all 12
  pages to return about 1 row; the index lookup reads about 4", and the result narration reconciles
  the guess against the exact count ("the cost model guessed ~37 … the estimate is a heuristic").
  `src/engine/planner/cost.ts`, pure and unit-tested (`src/engine/__tests__/cost.test.ts`)
- **Three more `/challenges` puzzles** (plan.md §22.4) — *push the filter down* (get predicate
  pushdown to fire without an index lookup), *a lookup on the big table* (an `IndexScan` on the
  120-row `orders`, a level deeper than `users`), and *the selective end of a skew* (a `logins` scan
  returning fewer than 20 rows). A challenge can now target a preset dataset; its check runs there
  and the "step through in the Playground" link carries `t=`
- **`querylens` command-line trace** (plan.md §22.8) — `bin/querylens.ts` runs a query through the
  engine and prints the stage-by-stage trace, or `--json` for scripting. Flags: `--policy`,
  `--dataset` (`users` / `orders` / `logins`), `--no-color` (also honours `NO_COLOR` and a non-TTY
  stream); exit codes 0 / 1 (query error) / 2 (usage). `pnpm querylens` and `pnpm trace` both run it.
  Not yet on npm — `npx querylens` awaits a publish
- **Planner sandbox** at `/tools/planner` (plan.md §22.3) — type a query and see its plan tree,
  canonical next to optimized. Toggle each rewrite rule (predicate pushdown, index selection) and
  the `id` index on or off; a ledger says for each rule whether it fired, found no match, or was
  switched off — so the rule ordering is visible (index selection needs pushdown to have run first).
  `optimize()` gained an optional enabled-rules set
- **Print to a paper worksheet** (plan.md §22.6) — a **Print** link on the Playground (and Ctrl-P)
  lays the current query and its whole trace out as a numbered worksheet: the SQL, the run's
  settings, and every step's narration with the predict-then-reveal steps marked. The `@media print`
  hook now also covers the `/trace` transcript and docs pages, so Ctrl-P on a docs page prints the
  article instead of a blank sheet
- **External merge sort sandbox** at `/tools/sort` (plan.md §22.3) — sort more records than fit in
  memory: run generation makes short sorted runs, then `(buffer pages − 1)`-way merge passes fold
  them into one, with the page-I/O cost (`2 × pages × passes`) broken out. Change the buffer budget
  and watch a whole pass drop. Click any merged run to colour its records by which run each came
  from and light up the runs that fed it. Its own driver (`src/ui/externalSort.ts`) — the engine has
  no `Sort` operator yet
- **Preset dataset library** (plan.md §22.7) — a **Data** chip row above the editor loads `users`
  (the 48-row baseline), `orders` (120 rows — a deeper B+Tree and a scan that evicts far harder), or
  `logins` (an 8:1 skew on `status`, so the same `=` predicate returns 9 rows or 71). Each carries
  its own starter query and preset query chips. The choice rides in the share link as `t=` and in a
  downloaded trace file's `dataset` field (both omitted for the default), and `/trace` reads `t` too
- **The 60-second tour** (plan.md §19.2) — five sequential spotlights over the real Playground
  (editor, pipeline rail, stage panel, narration, transport), not a video or a modal carousel. Skip
  or `Esc` at any point, `←/→` to walk it. It never auto-starts: it opens from the first-visit
  hint's **Take the 60-second tour** link, a **Tour** link by *Present*, or `?tour=1`. Under
  `prefers-reduced-motion` it degrades to a static numbered overlay — the five captions as a list,
  no stepping, no moving spotlight
- **Panel "what am I looking at?" affordance** (plan.md §19.2) — a small `?` next to each stage's
  title in the Playground opens a two-sentence explanation of what that panel shows and a link to
  the concept page (`/stages/:id`, or `/docs/concepts/*` for the buffer pool and the B+Tree). The
  same per-stage text now feeds the `/stages` index, replacing a near-duplicate copy that lived there
- **First-visit hint** (plan.md §19.2) — one quiet line under the header, shown once to a cold
  visitor at the app's own front door (`/playground` with nothing in the URL; a shared-moment link
  carries its own context). It points at the keyboard route into the trace — `Space` to play, the
  arrows to step — retires itself on mount so a reload never brings it back, and has a Dismiss button
  for mid-session. Touch devices get a pointer-appropriate line
- **Preset query chips** above the Playground editor (plan.md §19.2) — *Point lookup*, *Sequential
  scan*, *Lookup, no index*. One click loads and runs, so a first visitor isn't asked to invent SQL.
  The third is a `col = value` equality on a **non-indexed** column — the same shape as the point
  lookup, but the planner can't turn it into a B+Tree lookup, which is the contrast the tool exists
  to show
- **Challenge mode** at `/challenges` (plan.md §22.4) — five goal-shaped puzzles: *make the planner
  use the index*, *force an eviction*, *return exactly one row*, *empty result but real work*, *two
  conditions that still match*. Each has a small editor whose Run result is checked against a pure
  predicate — rows / disk reads / evictions / index-used are shown, with a pass/fail verdict and a
  link to step the run in the Playground. Solved marks kept per-browser; no backend
- **Assignment sets** (plan.md §22.4) — `/assignments/new` can now bundle several links: give each a
  label, *Add to set*, and the panel below emits a numbered Markdown worksheet (paste into an LMS or
  print) and a JSON file, both stamped with a class code. Still no submission and no backend — the
  worksheet *is* the hand-out
- **Import CSV** in the seed-data editor (plan.md §22.7) — paste a block of `id,name,email,age`
  rows instead of typing them. A small quote-aware reader (`src/ui/parseCsv.ts`), bounded to 500
  rows and per-column type-checked; an optional header row is skipped, and a malformed block is
  rejected whole with a reason rather than half-imported — the same "untrusted input" discipline the
  shareable URL follows
- **Progress dashboard** at `/progress` (plan.md §22.4) — a returning-visitor page: lessons marked
  complete, which pipeline stages you have seen in a trace, and your prediction record (right / total,
  hit rate). All read from `localStorage` and all degrade to a "nothing tracked yet" empty state; a
  Clear button wipes it. The Playground records stages and prediction outcomes as you go
- **Presenter mode** (plan.md §22.5, §17.2) — a **Present** button on the Playground (or `?present=1`)
  opens a full-viewport view of the current stage for a lecture hall: the diagram large, the narration
  at heading size, keyboard-driven (Space, ←/→, Esc), with an optional real full-screen toggle.
  Prediction prompts are suppressed while it is open — a "commit before the reveal" card stops a room
  rather than helps it. It is a `role="dialog"` overlay over the same live playback, axe-checked
- **Slotted page inspector** at `/tools/page` (plan.md §22.3) — one heap page of `users` laid out to
  the byte: a fixed header, a line-pointer array, tuples packed from the far end of the page backward,
  and the free space between. A page-size slider makes "rows per page" concrete — four toy rows fill
  about 5% of a 4 KB page, and roughly 87 more would fit. `src/ui/slottedPage.ts` synthesises the
  layout (the engine models a page as just a list of rows, §7); pure and unit-tested. A tuple in the
  map cross-highlights its row in the per-tuple byte table
- **Colour-independent shape cues** (plan.md §22.6, §8) — internal vs leaf B+Tree nodes now carry a
  filled disc / hollow ring glyph before the label, and the buffer-pool moods and stat counts carry
  `✓ / ↓ / ✕ / ↻`, so hit/miss/evict and internal/leaf read without relying on hue — for colour-vision
  deficiency and washed-out projectors. Always on, not a toggle
- **`/trace` transcript view** (plan.md §22.6) — beside the JSON-shaped table, a **Transcript**: a
  numbered list of every step's narration, each line a link into the Playground at that step. A
  **Print** button and an `@media print` rule turn it into a paper worksheet — the one thing in the
  app that prints. `v=transcript` in the URL opens straight to it; it doubles as the §9 study's
  control-group artefact (read the steps rather than step them)
- **Five more `/learn` lessons** (plan.md §22.4, §17.2) — the guided track goes from four to nine:
  *Watch a B+Tree split* (in the `/tools/btree` sandbox — a full leaf, one more key, copy-up then
  push-up), *Edit the seed data* (what the trace changes and what it does not), *Predict before you
  look* (prediction mode and the evidence behind it), *Share a moment* (what the URL encodes, and
  why a bad one drops the dataset whole), and *When something goes wrong* (the panel error boundary
  and its self-writing repro). Each Playground link is still computed from a real engine run
- **Screen-reader narration track** (plan.md §22.6, §8) — the Playground's narration line is now a
  permanently-mounted polite live region, so a screen-reader user stepping the trace hears every event:
  the step position, the narration the event already carries, and — on a gated step, where the
  prediction card previously replaced the narration and silenced it — the question, its options, and
  the verdict. Wording is a pure, unit-tested `src/ui/stepAnnouncement.ts`
- **Download trace / Load trace** (plan.md §22.5) — beside *Copy link to this step*, save the current
  Playground moment as a small JSON file and restore it later. It is the shareable-URL state as a file
  — `sql`, `policy`, `predictOn`, `step`, edited `rows`, plus a build stamp — for a dataset too big for
  a URL, or a bug report that wants the seed data attached. No event stream in the file (the engine
  re-derives it deterministically; use `/trace`'s *Copy JSON* for a frozen one), and it is parsed with
  the same defensiveness as the URL: a missing, out-of-range or schema-mismatched field fails the whole
  load. `src/ui/traceFile.ts`, unit-tested
- **Copy as text** (plan.md §22.5) — a third panel-header action beside Copy as Mermaid and Download
  PNG: the AST, the plan, or the **B+Tree** as a `tree(1)`-style indented list in a bare ` ``` `
  fence, for a review comment or an email. Pure, unit-tested conversion in `src/export/toText.ts`;
  unlike Mermaid it covers the B+Tree, because a fixed-width tree renders a sibling chain fine. The
  clipboard button is now one shared `CopyButton` (was `CopyMermaidButton`)
- **`pnpm record`** (plan.md §20.3, §20.8) — `scripts/record.ts` drives the *built* app in a real
  browser, frame-steps a shareable link over a `--from`/`--to` range, and muxes the result to a GIF
  and a WebM with the shipped fonts and `oklch` colours — the completion of M12 and the moving-picture
  half of the §18.2 launch material. It captures the same live panel DOM the **Download PNG** button
  does, so there is no second renderer to drift (the still-frame sibling of `scripts/build-og.ts`).
  The WebM uses whatever ffmpeg is found, falling back to the copy Playwright bundles (VP8); the GIF's
  `palettegen`/`paletteuse` needs a full ffmpeg, and without one the script still writes the WebM plus
  the numbered frames and prints the two commands to finish the GIF. Not an in-app button, by §20.3
- **Download PNG** (plan.md §20.3, §20.8) — a button on every stage's panel that saves it as an
  image with the app's real typeface and `oklch` colours baked in. `html-to-image` is loaded only
  on the first export, so it never affects page load. Verified in Chromium; may fall back to sRGB
  in Safari (a known `foreignObject`-to-canvas bug), which the FAQ notes
- **Copy as Mermaid** (plan.md §20.3, §20.8) — a button on the AST and plan panels (in the
  Playground and the stage explainers) that copies the tree as a Mermaid `flowchart` in a fenced
  code block, ready to paste into a pull request or a doc. Pure, unit-tested conversion in
  `src/export/toMermaid.ts`; the B+Tree is deliberately excluded (Mermaid draws its sibling chain
  badly)
- **Guided path** at `/learn` (plan.md §17.2, §21.3) — four short, ordered lessons (run your first
  query; follow one row from disk to result; watch a page get evicted; make the planner change its
  mind). Each lesson's steps deep-link into the Playground at the exact point they describe — the
  step number computed from a real engine run, so a lesson can't drift out of sync — and each ends
  with one variable to change and re-run. Completion is marked per-browser in `localStorage`
- **Midpoint-LRU buffer policy** (plan.md §7.5) — InnoDB's midpoint-insertion LRU as a sixth
  replacement policy in the buffer-pool sandbox and Compare: a page read from disk enters an "old"
  sublist and only reaches the "young" one when it is read again, so a one-pass sequential scan
  evicts only its own pages and never the hot set — the failure plain LRU has that this fixes
- **`/compare` — index vs. sequential scan** (plan.md §13) — a second mode alongside the
  replacement-policy comparison: the same query run once with the `id` index and once with it
  removed, scored side by side (trace steps, disk reads, evictions, B+Tree node reads, locks, rows).
  Same rows out, very different work — and a query that cannot use the index says so
- **Assignment reveal-lock** (plan.md §20.5) — `/assignments/new` can now lock the reveal: the
  generated link (`&l=1`) opens the Playground with prediction forced on, the prompt's "skip"
  removed, and the playhead — scrubber included — unable to cross an unanswered prediction. It lifts
  one prompt at a time as the learner commits. The author is warned when the chosen step has no
  prompt for the lock to catch on
- **Trace inspector** at `/trace` (plan.md §21.3) — the raw event stream `runQuery` produces for a
  query, as a filterable table (per-stage toggles, a narration text filter), with each event's full
  JSON on click and a Copy-JSON of the filtered set. Runs the same engine path the Playground does;
  every row links into the Playground at that step. Reads the Playground's own `q`/`p`/`d` link keys
- **B+Tree sandbox** at `/tools/btree` (plan.md §20.4, §21.3) — insert, delete and find keys against
  a live B+Tree, with a fan-out slider and the structural invariants re-checked and shown after
  every edit. Building it required **B+Tree deletion** in the engine (`deleteKey`): leaf and
  internal underflow handled by borrowing from a sibling or merging, root-collapse, and a separator
  rewrite up the descent path so every internal key stays a real leaf key. Covered by property
  tests that assert the tree stays sound after every operation against a set oracle (plan.md §7.6)
- **Parser sandbox** at `/tools/parser` (plan.md §20.4, §21.3) — type any SQL, supported or not, and
  see the tokenizer's stream as a colour-coded ribbon and the recursive-descent parser's AST built
  live, with a recursion-depth readout and the parser's own tokenize/parse error messages. No engine
  change: the AST view is the Playground's, driven straight from `toDisplayTree`
- **Three more buffer-pool replacement policies** — FIFO, second-chance and optimal (Bélády's MIN) —
  selectable in the buffer-pool sandbox and on both sides of `/compare`. They sit behind the existing
  `ReplacementPolicy` interface; `optimal` reads the whole page-reference string as lookahead and
  degrades to FIFO where there is none (the SQL pipeline). The Playground, shareable links and
  `/settings` still offer only LRU and clock sweep, so the pipeline's teaching contrast is unchanged
- `/compare` now pits any two of the five policies against each other, rather than being fixed on
  LRU vs. clock sweep
- **Documentation site** at `/docs`, built with Astro Starlight (plan.md §17.1) — sidebar
  navigation, on-this-page outline, full-text search, and the app's own fonts, colours and
  dark/light toggle. Nine pages: what QueryLens is, Getting started, FAQ, Concepts (buffer pool,
  B+Tree), and Reference (supported SQL, keyboard shortcuts, URL parameters, engine limits). Every
  factual claim in them — step numbers, error message text, engine limits — is checked against
  `src/` rather than written from memory, and the Concepts pages link back into the running app at
  the exact step they describe, verified live rather than assumed. Built by its own isolated
  package (`docs/`) with its own lockfile, so the application's dependency tree is never
  re-resolved by documentation work; `pnpm build:site` builds both, and CI now builds the docs as
  their own step so a broken page fails the same gate a broken app build would
- Self-hosted typefaces: JetBrains Mono and IBM Plex Sans (as `QueryLens Sans`), subset to the 235
  codepoints the app renders, ~30 kB each, preloaded and served under the existing `font-src 'self'`
  CSP. Previously the CSS named a font that was never shipped, so it appeared only for visitors who
  happened to have it installed
- Adjusted fallback faces with measured `ascent-override` / `descent-override` / `size-adjust`, so
  `font-display: swap` costs no layout shift
- Named type scale — six steps, one documented role each, with a display size that gives the scale a
  top. Tailwind's own scale is cleared, so every size in `src/` names its job
- Named motion scale — three durations, three curves — reachable from JavaScript via
  `src/ui/motion.ts`, and collapsing to zero under `prefers-reduced-motion`
- Hover and active states on every diagram element: buffer-pool frames, B+Tree/AST/plan nodes, lock
  rows, result rows and pipeline chips. Eight panels previously had one hover rule between them
- A real footer: Docs · GitHub · Licence · Changelog, and the build SHA, so bug reports identify
  their own build
- `apple-touch-icon.png`, generated from `favicon.svg`
- Scroll-snap between sections on phones
- Tabular figures on every number that changes during playback
- `scripts/build-fonts.py`, `scripts/build-icons.py` and `pnpm og` — the fonts, icons and link-preview
  card are all regenerated from source rather than hand-maintained
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` — open-source governance files
- `CHANGELOG.md` — this file
- `NOTICE` — third-party licence attribution, now also covering the two bundled fonts
- GitHub issue templates and pull request template
- §16 (Visual Design Maturity), §17 (Documentation & User Manual), §18 (Community & Governance) and
  §19 (The Landing Page) added to `plan.md`

### Changed
- Raised the app's type floor: body 14→15px, label 12→13px, code 13→14px, heading 17→20px, display
  24→28px. The 11px `micro` step is retired; 13px is now the smallest text anywhere in the app.
  §16.1's instrument density is otherwise unchanged — verified against the densest panels (the
  eight-frame buffer grid, the compact B+Tree) where nothing overflows
- Tagline is now "Watch a SQL query become a B+Tree traversal." — concrete enough that reading the
  first screen tells you what the tool does
- Corner radius is constant (4px chrome, 2px inside diagrams) and the phone's sticky playback bar no
  longer uses `backdrop-blur`, per the design constraints in `plan.md` §16.1
- Every control now shows a pointer cursor. A `<button>` takes `cursor: default` from the user agent,
  so the cursor had been telling the user nothing
- The link-preview card is regenerated from a real trace at the first buffer eviction; its alt text
  said "four frames" through a change that made it eight
- The header's development-progress badge ("8/8 stages built") is replaced with a Docs link; the
  footer's Docs link now points at the real site instead of the README
- Grandfathered seven dependencies that were pinned inside the project's own 7-day
  `minimumReleaseAge` window before that policy could ever check them — invisible until now because
  CI only ever runs `--frozen-lockfile`, which does not re-resolve. See
  `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` for the list and the reasoning

### Removed
- Release-planning vocabulary from the shipped UI: the `M1`–`M6` milestone codes stageMeta used to
  print ("Arrives in M4") were a sentence about the backlog, not about databases, and unreadable to
  anyone outside the repository. The not-implemented guard they lived in stays — every stage is
  built today, but `STAGES`/`IMPLEMENTED_STAGES` remain separate lists on purpose

### Fixed
- The diagram tree arrived unframed in the panel's corner on some cold loads, and always when the
  page loaded into a background tab — the common case for a shared link. React Flow animates viewport
  moves with a d3-zoom transition, which is driven by `requestAnimationFrame` and so never advances
  in a tab that is not painting. The first framing is now instant, and no framing animates while the
  tab is hidden
- Tree framing measured the pane through React Flow's store, which reports `size.width || 500` — so a
  container measured at zero was indistinguishable from one 500px wide, and the tree was centred on a
  point that did not exist. `FlowTree` now measures its own pane with a `ResizeObserver` and computes
  the viewport transform itself, and the 60ms timeout that raced React Flow's mount is gone
- The favicon's third page bar dropped out at 16px, so the stack read as two

## [0.1.0] - 2026-09-03

### Added
- Complete MVP: Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result
- Recursive-descent SQL parser with AST visualization
- Rule-based query planner with predicate pushdown and index selection
- Buffer pool with pluggable replacement policies (LRU and clock sweep)
- B+Tree index with animated traversal, insert, and point/range lookup
- Volcano-style execution engine (SeqScan, IndexScan, Filter, Project)
- Page-level lock manager with crabbing for index descent
- Predict-then-reveal prompts at four pipeline stages
- Editable seed data with immediate re-execution
- Shareable URL state (query, policy, prediction mode, step index, custom rows)
- Light and dark themes with system preference detection
- Full keyboard navigation (Space, ←/→, Home, Mod+Enter)
- `prefers-reduced-motion` support
- Composited contrast sweep: zero elements below WCAG AA
- Error boundary with copyable crash repro
- CI pipeline (typecheck, lint, test, build) with SHA-pinned GitHub Actions
- Bundle budget enforcement (`pnpm budget`)
- End-to-end tests with Playwright and axe accessibility auditing
- Tested CSP security headers
- 326 unit tests, 14 end-to-end tests

[Unreleased]: https://github.com/Naveen-Boddepalli/QueryLens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Naveen-Boddepalli/QueryLens/releases/tag/v0.1.0
