# Project Plan: QueryLens — Interactive Database Internals Visualizer

**Document Status**: v1 shipped and live (first deploy 2026-09-23) · **v2 planned** — retrospective §24, plan §25
**Last Updated**: 2026-09-24

## Executive Summary
QueryLens is a 100% client-side, interactive database internals visualizer built for educational purposes. It executes real SQL queries inside the browser (zero server), rendering step-by-step visualizations of parsing, query planning, B+Tree index traversal, buffer pool eviction, locking, and execution. Designed specifically for students and educators, QueryLens focuses on pedagogical clarity over enterprise performance.

**Where it stands.** v1 is built, gated and deployed: eight real pipeline stages, a write path, three join algorithms, a cost model, nine sandboxes, a learning track, and an A+ / axe-clean deploy with no telemetry — summarised in §24. What it has *not* done is prove that it teaches (the §9 study has not run). **v2 (§25) is therefore not "more SQL"**: it proves the claims first (a SQLite correctness oracle, a runnable study kit), raises the engine's ceiling, makes the optimizer decide, and only then adds the two subjects courses teach after query execution — transactions and recovery — behind a checkpoint on the study's result. Evidence: [RESEARCH.md Part IV](RESEARCH.md#part-iv--v2-research).

---

## 1. One-line pitch
An in-browser, self-built toy relational database engine that visually animates how a SQL query actually flows through Parser → Planner → Optimizer → Execution → Buffer Pool → Index (B+Tree) → Locks → Result — positioned as a learning/interview-prep tool, not a production DB tool.

---

## 2. Goals and Non-Goals

### Goals
- Teach the *concepts* of database internals through direct manipulation: user types SQL, sees it move through every layer, step by step.
- Be 100% honest about ground truth — since we own the engine, every visualized number is true to our model (explicitly labeled as a simplified model, not "how Postgres really works").
- Ship a working, polished single-query-type prototype before expanding SQL coverage.
- **Engage, don't just display.** Evidence on algorithm visualization is that passive viewing does not
  reliably beat reading text; the gains come from prediction, question-answering, and letting learners
  construct their own inputs. QueryLens must be a tool for knowledge construction, not a conveyer of it.
- Zero-cost MVP: client-side only, free hosting tier, no backend required for v0.

### Non-Goals (explicitly out of scope for MVP and possibly ever)
- Full ANSI SQL support.
- Matching real engine behavior (Postgres/MySQL internals) exactly.
- Multi-tenant server-side query execution.
- Production query debugging / APM use case. (A static, paste-in `EXPLAIN` visualiser was weighed
  against this line and deliberately kept as a *separate* product — §20.6 — not folded in here.)
- Concurrent/multi-user real-time collaboration (v1+).

---

## 3. Target User & Core Use Case
- CS students taking DB courses (e.g., CMU 15-445 style curriculum).
- Engineers prepping for systems-design / backend interviews.
- Self-taught developers wanting intuition for "what happens when I run a query."

**Core use case:** User types a simple SQL query → clicks Run → watches an animated, step-through pipeline showing exactly what a (simplified) database engine does, with the ability to pause, step forward/back, and inspect state at each stage.

---

## 4. Scope Definition (MVP)

### Supported SQL subset (v0)
- `SELECT` with column list or `*`
- `FROM` single table
- `WHERE` with simple predicates (`=`, `<`, `>`, `AND`)
- `JOIN` (inner join, single join) — stretch goal for v0, core for v1
- No aggregates, subqueries, or `GROUP BY` in v0

### Supported engine features (v0)
- Hand-written recursive-descent SQL parser → AST
- Simple rule-based query planner (predicate pushdown)
- Fixed-size in-memory "pages" simulating disk storage
- Buffer pool with **pluggable replacement policy — LRU *and* clock sweep**, switchable (visualized as a grid of slots)
- Single B+Tree index structure with visual traversal (insert + point lookup)
- Simplified lock manager (coarse-grained, e.g., single shared/exclusive lock per page) — visual only, not functionally enforced in v0
- Step-through execution model: each pipeline stage is a discrete, inspectable state
- **Predict-then-reveal**: at marked steps, the user commits to an answer (which frame gets evicted?
  which child pointer does the traversal follow?) before the step runs
- **Editable seed data**: the user can change the rows in the table and re-run

### Explicitly deferred to v1+
- Full join algorithms (nested loop → hash join → sort-merge join comparison view)
- Cost-based optimizer with visible cost estimates
- MVCC / transaction isolation visualization
- User accounts, saved queries, progress tracking
- WASM/Rust rewrite of the engine core for performance and "closer to real" feel

*§22 gives each of these an address, a cost against `src/` and a trigger — most stay gated on the §9
study.*

***v2 (§25) re-homes what remains.** Of this list, join algorithms and visible cost estimates shipped in
v1 (the cost model *deciding* between plans is release 2.1, §25.4 C5); MVCC / transaction isolation is
planned as release 2.2 (§25.4 D); the WASM/Rust rewrite is declined in favour of the Web Worker path
(§25.4 C6); user accounts stay out (§25.10).*

---

## 5. Architecture

```
┌─────────────────────────────────────────────┐
│                Browser (Client)               │
│                                               │
│  ┌───────────────┐      ┌──────────────────┐ │
│  │   React UI     │◄────►│  Visualization    │ │
│  │  (SQL editor,  │      │  Layer (React     │ │
│  │  controls)     │      │  Flow / SVG)      │ │
│  └───────┬───────┘      └──────────────────┘ │
│          │                                    │
│          ▼                                    │
│  ┌─────────────────────────────────────────┐ │
│  │   Toy Engine (pure sync module, main     │ │
│  │   thread; kept worker-ready)              │ │
│  │                                            │ │
│  │  Parser → Planner → Optimizer →           │ │
│  │  Execution Engine → Buffer Pool →          │ │
│  │  Page/B+Tree Manager → Lock Manager        │ │
│  │                                            │ │
│  │  Each stage emits a "step event" delta.    │ │
│  │  runQuery() returns the complete event      │ │
│  │  array; the UI folds it to render state.    │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Key architectural decision:** the engine is a **pure synchronous module**, not a Web Worker.

```ts
function runQuery(sql: string, db: Database): { events: StepEvent[]; result: Row[] }
```

Rationale: playback needs **step back**, which means the full event history must be retained regardless — and
once the UI holds the whole array, streaming across a worker boundary buys nothing. Execution over toy data is
microseconds, so there is no jank to prevent. A returned array makes scrubbing an array index (trivially correct)
and keeps debugging and testing straightforward.

The engine is nonetheless kept **worker-ready** — pure functions, no DOM, fully serializable events, zero React
imports — so it can be moved behind `new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' })`
if a v1 feature (a large dataset, the concurrent-query demo) ever needs it.

No backend server is required for v0. Everything — parsing, storage, indexing, "disk" simulation — happens in-memory, in the browser.

**The shell around the engine is a client-side multi-page app.** One `Layout` (disclaimer bar, top
nav, footer) wraps a React Router route tree: the Playground at `/` is the landing page and first
paint (§19), and every other feature — the stage explainers, the standalone tools, the classroom
and comparison surfaces — is its own route that shares the engine, the panels and the design tokens
rather than re-implementing them. The full map, the cross-page conventions and the routing work this
still needs are §21. The docs (`/docs`) are MDX routes inside this same build (§17.1, as of commit
`6eca5ac`) — lazy-loaded, so they cost nothing until visited.

---

## 6. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Engine language | TypeScript **6.0.3 (pinned)** | TS 7 is faster but `typescript-eslint` excludes it (`<6.1.0`); revisit after 7.1 |
| Engine execution context | Main thread, pure sync module | Step-back needs full history anyway; worker-ready for v1 |
| Frontend framework | React + TypeScript | Familiar, large ecosystem, easy state management for step-through UI |
| Routing | React Router 7 (`react-router-dom`), declarative `<BrowserRouter>` | Client-side routes for the stage explainers, tools and classroom pages (§21); the Playground stays first paint. Needs an SPA rewrite on Pages, which is not yet configured — §21.5. Currently the one `^`-ranged dependency; pin it |
| Visualization | **flowinger** (our own renderer, `flowinger` on npm; React Flow's API shape, no dependency) for plan/AST/B+Tree graphs, `d3-hierarchy` for layout math, `motion` for animation | HTML nodes over SVG edges with pan/zoom/drag and nothing else — about a quarter of React Flow's weight in the `flow` chunk; d3-hierarchy supplies tree layout. Replaced `@xyflow/react` |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) | CSS-first config (`@import "tailwindcss"`, `@theme`); no `tailwind.config.js` |
| SQL editor | CodeMirror 6 (`@uiw/react-codemirror` + `@codemirror/lang-sql`) | ~50kB tree-shaken vs Monaco's 2–5MB; a `<textarea>` cannot syntax-highlight |
| Hosting | **Cloudflare** (free tier), on the unified Workers-with-static-assets engine, not classic Pages | Vercel Hobby is non-commercial-only by ToS and pauses past 100GB; Cloudflare serves unlimited static bandwidth. This row previously said Cloudflare "now steers *new* projects to Workers static assets, but Pages is fully supported... revisit only when this project needs a server-side piece" — that framed it as a future, deliberate choice. It was not: creating the project through the dashboard's unified "Workers & Pages" flow landed it on the new engine already (confirmed by its deploy API calls, `/workers/scripts/query-lens/...`, not `/pages/projects/...`), with no server-side piece added and no migration performed. `wrangler.jsonc` (`assets.directory`, `assets.not_found_handling: "single-page-application"`, no `main` — no Worker code exists) is the config this engine actually needs; the old `public/_redirects` SPA rewrite conflicted with it outright — see CHANGELOG's *Fixed* entry for the deploy failure this caused and how it was found |
| Persistence (deferred) | Supabase (free tier) | Only needed if/when adding accounts or saved queries — not in MVP |
| Dev tools | VS Code, Node.js, pnpm, Git/GitHub | All free/open-source |

**v1+ consideration:** rewrite the engine core in Rust compiled to WASM for performance and a more "authentic systems" feel. Not needed for MVP — TypeScript is sufficient at toy-engine scale.

---

## 7. Engine Design Detail

### 7.1 Parser
- Recursive-descent parser (hand-written, no parser-generator dependency for MVP simplicity and easier step-visualization hooks).
- Tokenizer → AST (e.g., `SelectStatement { columns, from, where, join }`).
- Visualization: render the AST as an expandable tree diagram.

### 7.2 Planner
- Converts AST into a logical query plan tree (e.g., `Scan → Filter → Project`).
- Rule-based transformations only in v0 (e.g., predicate pushdown: move `WHERE` filter as close to the scan as possible).
- Visualization: before/after plan tree diagram showing the rewrite.

### 7.3 Optimizer
- v0: rule-based only, deterministic, no cost model.
- ~~v1 stretch: simple cost estimates (row count heuristics) to justify plan choices, shown as annotated numbers on plan nodes.~~ **Done, v14.** `src/engine/planner/cost.ts` — per-node row and page estimates from named textbook heuristics (equality = `1/ndistinct`, open range = linear over the column min–max, `AND` = product under independence), annotated onto every plan/optimize tree as a `~N rows` line with its basis, and reconciled against the executor's real count in the result narration. The rules still fire without consulting the numbers; the numbers justify the rewrite in words.

### 7.4 Execution Engine
- Iterator/Volcano-style execution model (`next()` pull-based) — classic and easy to animate step-by-step, since each `next()` call is a natural visualization tick.
- Physical operators: `SeqScan`, `IndexScan`, `Filter`, `Project`, (v1: `NestedLoopJoin`).
  ~~`Sort`, `Limit`~~ **done, v14** — `Limit` is a plain short-circuiting pull; `Sort` is the one
  operator here that cannot stream (§22.2), and its own driver (`exec/sort.ts`) is the only one that
  writes, not just reads, through the buffer pool.

### 7.5 Storage Layer (Pages + Buffer Pool)
- Fixed-size pages (e.g., simulate 4KB pages, but store toy data — a handful of rows per page for visual clarity).
- Buffer pool: fixed number of frames (e.g., 8 for visual simplicity), visualized as a grid showing
  hit/miss/eviction in real time as the scan runs.
- **Replacement policy is pluggable behind a single interface, and v0 ships two:**
  - **LRU** — the textbook policy, the one every course teaches.
  - **Clock sweep** — what PostgreSQL actually does. Each frame carries a `usage_count` (capped at 5),
    incremented on access; eviction walks the frames circularly, decrementing on each pass, and evicts the
    first frame with `refcount == 0 && usage_count == 0`.

  This exists because **textbook LRU is not what real databases do** — Postgres avoids LRU lists specifically
  to dodge latch contention, and InnoDB uses midpoint-insertion LRU to survive sequential scans. Teaching
  "eviction = LRU" would create exactly the misconception §12 warns about. Offering both turns the honesty
  problem into the product's best teaching moment ("same access pattern, two policies, different victim"),
  and clock sweep — a hand rotating around a ring of frames — animates better than a reordering list.
  InnoDB-style midpoint LRU **shipped v12** as `midpoint` — a fresh page enters an "old" sublist and
  only reaches the "young" one on a re-access, so a one-pass scan flushes only itself.
- "Disk" is simulated as a simple in-memory array/map standing in for persistent storage — page fetch introduces a simulated latency to visually distinguish "buffer hit" vs "disk read."

### 7.6 Index (B+Tree)
- Hand-built B+Tree supporting insert and point/range lookup.
- **The split rule, stated precisely** (this is where most implementations go wrong):
  **leaf split → COPY up** (the separator goes to the parent *and stays in the leaf*, since leaves must hold
  every key); **internal split → PUSH up** (the middle key moves to the parent and is *removed* from the node).
  Applying one rule where the other belongs yields a tree that looks plausible and silently returns wrong rows.
- Property-based tests come **before** the visualization: insert N random keys, then assert (a) every key is
  findable, (b) the leaf sibling chain is sorted, (c) all leaves are at equal depth, (d) every non-root node is
  at least half full.
- Use a **small fan-out (3–4 keys per node)** so splits happen constantly and are visible. Real fan-out is in
  the hundreds and would never split on a demo dataset — a case where the simplified model teaches better.
- Visualization: classic node-and-pointer tree diagram, animated traversal (highlight the path from root to leaf as a lookup executes).

### 7.7 Lock Manager (simplified)
- v0: visual-only simulation — shows a lock icon appearing/disappearing on the page being accessed, coarse-grained (page-level), not functionally enforced (no real concurrent transactions yet).
- v1: introduce a second simulated "concurrent" query to demonstrate lock contention/blocking visually.

### 7.8 Step Event Model
Every stage emits a structured event, e.g.:
```ts
type StepEvent =
  | { stage: "parse", ast: ASTNode }
  | { stage: "plan", planTree: PlanNode }
  | { stage: "optimize", before: PlanNode, after: PlanNode }
  | { stage: "execute", op: string, rowsProduced: number }
  | { stage: "buffer", action: "hit" | "miss" | "evict", pageId: number }
  | { stage: "index", action: "traverse", nodeId: string }
  | { stage: "lock", action: "acquire" | "release", pageId: number }
  | { stage: "result", rows: Row[] }
```
Every event also carries a `label: string` (human-readable narration — this is what turns an animation into a
lesson) and an optional `predictable?: PredictionPrompt` (the hook for the predict-then-reveal layer in §4).

**Events are deltas, not snapshots.** View state at step *n* is derived by folding:

```ts
const stateAt = (events: StepEvent[], n: number) =>
  events.slice(0, n).reduce(applyEvent, initialState);
```

Memoise per index, or keep a running state and apply an inverse on step-back. Do **not** deep-clone engine
state per step: it bloats memory, makes events non-diffable, and — the real cost — forfeits the ability to
animate *the transition*, which is the entire product. An eviction must be a frame visibly leaving, not
grid-N swapped for grid-N+1.

Operators emit via a **trace buffer**: an `emit(event)` callback is passed down into every operator, the query
runs to completion, and the array is returned. (If v1 ever needs genuinely lazy execution, the alternative is
generators — `function* next(): Generator<StepEvent, Row | null>` — but that is more machinery than v0 needs.)

This event stream is the single contract between engine and UI — makes the UI a pure renderer of engine state, and makes the engine independently testable without any UI code.

---

## 8. UI/UX Plan

- **SQL input panel**: CodeMirror 6 with `@codemirror/lang-sql` (~50kB tree-shaken). A `<textarea>` cannot syntax-highlight — reaching highlighting from there means the transparent-textarea-over-`<pre>` overlay hack, a multi-day tar pit of font metrics and scroll sync. CodeMirror also unlocks inline error squiggles fed by our own parser, which makes the parse stage feel real.
- **Pipeline view**: horizontal or vertical stage tracker (Parser → Planner → Optimizer → Execution → Buffer Pool → Index → Locks → Result), current stage highlighted.
- **Stage detail panel**: changes based on selected/active stage — tree diagram for parser/planner, grid for buffer pool, node graph for B+Tree.
- **Playback controls**: Play, Pause, Step Forward, Step Back, Reset, speed slider.
- **First run happens without being asked for.** The default query, seed table and trace are all
  deterministic, so the app runs them on load and opens on a parsed AST rather than an empty box —
  a pre-populated example beats a blank start for any tool with a learning curve, and the empty state is
  otherwise the largest element on the screen. Pressing Run must also *visibly* respond (advance to
  step 1), or a first-time user will press it twice believing it failed.
- **Predict-then-reveal prompts**: at marked steps the run halts and asks the user to commit before revealing.
  Natural prompt points fall straight out of the §7.8 event union — `buffer:evict` (which frame?),
  `index:traverse` (which child pointer?), `optimize` (where does the filter move to?), `result` (how many rows?).
  This is the single highest-leverage feature in the product and it is cheap: a modal over an event stream
  that already exists. **The prompt must sit against the panel it is about** — the spatial contiguity
  effect (g = 0.63 over 58 comparisons) is the same order as the effect that justified building
  prediction at all, and asking "which child pointer?" while the buffer pool is on screen gives it back.
- **A shareable URL.** Query, policy, prediction mode and step index live in the address bar, so a link
  reproduces a *moment*: §9's study can start every participant identically, an instructor can set
  "predict what happens at step 13" as homework, and what gets posted publicly is the eviction storm
  rather than a home page. It also means a refresh no longer discards an edited dataset.
- **Editable seed-data grid**: change the rows, re-run, see a different trace.
- **Policy toggle**: LRU ⇄ clock sweep on the buffer pool panel.
- **Accessibility** (cheap now, invasive later): the Play/Pause controls already satisfy WCAG 2.2.2
  (Pause, Stop, Hide). Honour `prefers-reduced-motion` by snapping between states instead of tweening —
  it does *not* replace the controls, both are required. Keyboard shortcuts throughout
  (Space = play/pause, ←/→ = step); learners in training settings lean on them heavily. The narration
  line is a permanently-mounted polite live region (§22.6), so a screen-reader user stepping the
  trace hears each event — position, then the `label` the event already carries, then the prediction
  question and its verdict on a gated step.
  A one-off contrast sweep decays on the next style change, so **axe runs in CI as a regression net**
  (§14) — but automated tooling catches only 30–57% of WCAG failures, so the manual sweep stays the
  real check and is repeated at each visual change, not annually.
- **Disclaimer banner** (persistent, not just footer text): "This is a simplified educational model of database internals, not the exact behavior of any real database engine."

---

## 9. Validation Strategy (before building breadth)
1. Build **one query type end-to-end first**: an indexed point lookup (`SELECT * FROM users WHERE id = 5` with an index on `id`).
2. Get the full pipeline animation working and polished for just this case.
3. Build the **non-indexed sequential scan as query #2** and demo the two side by side. A point lookup touches
   only ~3 pages and never evicts, so on its own it makes the buffer pool — the product's best differentiator —
   look static. The scan's eviction storm is what makes the index lookup feel like magic.
4. **Validate with a post-test, not a satisfaction survey.** Give 5–10 target users five mechanism questions
   they could only answer by having understood it ("here is a full buffer pool and an access sequence — what
   gets evicted?"), and compare against a control group who read a good text explanation of the same material
   for the same duration.

   This replaces v1's "ask if the animation builds intuition." Self-report is precisely the measure that failed
   in the literature — people reliably say yes to pleasant animations regardless of what they learned, and
   polished animation has repeatedly failed to beat a well-written text document. If QueryLens cannot beat a
   good blog post, that is the signal to have **before** spending ten weeks on animation polish.
5. Only after validating the format, expand to: `WHERE` on other non-indexed columns, then joins.

**v14 — the gate is lifted, deliberately.** The post-test study (steps 4–5) has not run, and this
section still describes the experiment worth running. What has changed is that it is no longer a
*blocker*: building the §22 engine-depth backlog behind an unscheduled study left the roadmap
stalled, so the decision is to build breadth now and run the study against the deeper engine when it
happens. §12's first risk — breadth before validation — is accepted with eyes open. The MVP contrast
(indexed lookup vs. sequential scan) is unchanged and remains the thing the study measures; the
cost model (§7.3), `Sort` / `ORDER BY` (§22.2), the write path, multi-table + JOIN, and the
remaining `/tools/*` sandboxes are now the active queue, not "post-§9".

**v21 — the study becomes runnable, and gets a checkpoint.** Lifting the gate left the study
*unscheduled*, and every tranche since has widened the product it would have to measure. §25.4 A2 builds
a self-serve **study kit** (an unlisted `/study` route, no network, a fixed post-test disjoint from any
in-app bank) so participants can take part remotely, and §25.6 installs a **checkpoint before release 2.2**
— the first that adds a second subject — with a decision table for each possible result. A note on
power: with 5–10 participants per arm the study can only detect a very large effect (n ≈ 15.7/d² per arm:
~11 for d = 1.2, ~63 for d = 0.5); write it up as an exploratory signal (RESEARCH.md §39).

---

## 10. Milestones & Rough Timeline (solo, part-time)

| Milestone | Scope | Est. Time |
|---|---|---|
| M0 | Project scaffold: React + TS + Vite + Tailwind v4 + Vitest, basic UI shell (no worker wiring) | ~0.5 week |
| M1 | Parser + AST visualization for single-table SELECT | 1-2 weeks |
| M2 | Planner + basic optimizer (predicate pushdown) + plan tree visualization | 1-2 weeks |
| M3 | Storage layer: pages + buffer pool + LRU **and clock-sweep** visualization | 2 weeks |
| M4 | B+Tree index + traversal visualization | 2-3 weeks |
| M5 | Execution engine wiring (Volcano-style iterators) tying all stages together | 1-2 weeks |
| M6 | Lock manager visual layer | 1 week |
| M6.5 | Predict-then-reveal layer + editable seed-data grid | 1 week |
| M7 | Polish: playback controls, a11y (reduced-motion, keyboard), disclaimer, styling, demo-ready | 1-2 weeks |
| **MVP complete** | Full pipeline for indexed point lookup **+ sequential-scan contrast** (§9) | **~10-14 weeks part-time** |
| M8 | **Production readiness — the deploy gate (§14):** CI, error boundary, security headers, licence, supply-chain settings, link preview | ~1 day (P0) + 2-3 days (P1) — **both done** |
| M9 | **UI/UX readiness (§15):** first-run trace, Run feedback, native dialog, shareable URL, prompt placement, responsive height | ~1 day (P0) + 2-3 days (P1) — **both done** |
| M10 | **Visual design maturity (§16) + landing page (§19):** self-hosted typefaces, named type/space/motion scales, hover states across every diagram panel, footer, first-screen framing | ~1.5 days (P0) + 1 week (P1) — **P0 done** |
| M11 | **Docs, manual, licensing & governance (§17–§18):** docs site, Getting Started, the two manual pages the §9 study needs, `LICENSE-DOCS`, font licensing, README restructure | ~1 week (P0/P1) + ongoing — **docs site built, see note** |
| M12 | **Portable artefacts (§20.3):** ~~copy-as-Mermaid (AST, plan), PNG export of any panel~~ **done v12**; ~~`scripts/record.ts` for launch GIFs/WebM~~ **done v13**. Complete. No backend, no new engine code — feeds the §18.2 launch post | ~1 week |
| M13 | **Site structure — routing consolidation (§21.5):** SPA rewrite so deep links resolve, delete the dead `src/router.tsx`, correct the "single page" 404 and the stale `index.html` title, code-split routes, one nav manifest. Gates every new page because a multi-page app whose links 404 is not one | ~1 day — **done (v9), + 3 regressions it uncovered** |
| v1 | Expand SQL coverage: joins, cost estimates, InnoDB midpoint-LRU as a third policy. **§20/§21 v1 tranche — shipped (v10):** the non-SQL event driver (`src/engine/bufferTrace.ts`, ahead of schedule), the Buffer Pool standalone (`/tools/buffer-pool`, LRU/clock only — extra policies still open), assignment links (`/assignments/new`, no reveal-lock yet), the query gallery (`/gallery`), the comparison view (`/compare`, buffer-pool half only). **v12:** the parser and B+Tree standalones (`/tools/parser`, `/tools/btree` + B+Tree delete), `/trace`, `/learn`, four more buffer-pool policies (FIFO, second-chance, Bélády, InnoDB midpoint-LRU), the assignment reveal-lock, the full-pipeline half of Compare, and M12's copy-as-Mermaid and PNG export. **v13:** M12's `scripts/record.ts` (`pnpm record` — GIF/WebM of a trace range), completing M12. **v14 — §9 gate lifted (§9's v14 note):** the cost-based optimizer (`planner/cost.ts` — cost estimates on plan nodes), in-app **EXPLAIN** (`explainToText`, estimate next to actual on the result stage), `LIMIT` (a real Volcano short-circuit), and `ORDER BY` with a real external-merge-sort `Sort` operator whose spill writes and re-reads run through the actual buffer pool (`exec/sort.ts`, `BufferPool.write()`) — the full §22.2 engine-depth item that was the reason the gate mattered — and the complete write path: `DELETE`, `INSERT` and `UPDATE`, all real in the pipeline, not just `/tools/btree`. One broader parser entry point (`parseStatement`) dispatches all four statement kinds; `DELETE`/`UPDATE` find matches with a dedicated pass and reuse `predicate-pushdown`/`index-selection` via a throwaway `Project *` wrapper; every index change runs the real `deleteKey`/`insert` B+Tree algorithms, including `UPDATE` running both in sequence when the indexed column itself changes, since a tree has no in-place rekey; `BufferPool` gained `write()` (fresh pages) and `markDirty()` (a writeback on eviction) to complete the read/write pair — and a third optimizer rule, `constant-folding` (two literals, or a column compared with itself, folded to a boolean and dropped from the predicate when always true), running first so the rules and cost model after it see the simplified form — and a hash aggregate for `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` and `GROUP BY`, the largest single addition to the SELECT grammar since v0: a `SelectItem` union replaces the flat column-name list, `HashAggregate` sits between `Filter` and `Project` as the second operator here that cannot stream, and all three optimizer rules see past it exactly as they already saw past `Sort`/`Limit`. Its second strategy followed in the same milestone: a sort aggregate (`SortAggregate`) computing the identical `groupBy`/`aggregates` by sorting the input on the `GROUP BY` columns first — `externalMergeSort` generalised to a composite-tuple key so `Sort` and `SortAggregate` share one driver — then a streaming pass collapsing runs of equal keys, with `EngineOptions.aggregateStrategy` (defaulting to `'hash'`, so nothing existing changes) the seam `/compare`'s new third mode uses to force each side and score them: same groups out either way, only the sort aggregate ever spills — and a fourth optimizer rule, `index-only-scan`: when the SELECT list needs nothing but the indexed column, the B+Tree leaf's key already answers the query, so `emitIndexLookup` gained a `touchHeap` flag that skips the heap page's fetch and lock entirely — a real, measured discount (3 pages instead of 4 on the seed data), priced honestly by the cost model rather than claimed — and enforced concurrency, real at last as `/tools/locks`'s own driver (`src/ui/lockSimulation.ts`, pure and total like `externalSort.ts`): two transactions, real blocking, a wait-for graph rebuilt fresh on every request, deadlock detection, and victim selection (the youngest transaction in the cycle). The SQL pipeline's own lock manager stays untouched — v0 runs one query at a time, so nothing there ever contends. And the grammar sandbox (`/tools/grammar`): `src/ui/grammar.ts` holds the v0 grammar as data, mirroring `parser.ts`'s own BNF comment, rendered as a keyword-pill-and-clickable-box diagram; `__tests__/grammar.test.ts` is the actual drift guard, checking every rule reference and keyword against the real tokenizer and running one representative query per rule through the real parser — it caught two real grammar-data bugs and one real drift bug in `parser.ts`'s own comment while it was being written. And v14's last item, `JOIN`: `FROM t1 JOIN t2 ON t1.a = t2.b`, an implicit inner join computed by nested-loop — the only algorithm so far. Qualified `table.column` references (`Expr`/`SelectItem` gained an optional `table`) are the real new grammar surface, required on every reference once a query joins two tables and validated against the tables the query actually names, so ambiguity is refused rather than silently resolved. The `Join` node's two children are always a bare `SeqScan` (no predicate pushdown into either side yet); its executor rescans the right side whole per left row — the same reset every operator's `open()` already means — with both tables' heaps sharing one real buffer pool, so the rescans' cost is genuinely counted, not claimed; the cost model prices it at `left × right / ndistinct(right key)` rows and `leftPages + leftRows × rightPages`, the honest nested-loop number. `GROUP BY`, `ORDER BY` and an aggregate SELECT item all stay unsupported combined with a `JOIN` for now, each rejected at parse time. Reachable today via `/tools/planner`'s small fixed `authors`/`posts` pair (`createJoinDemoDatabase`). Its second algorithm followed in the same milestone: hash join, `Join.algorithm` widened to `'nested-loop' | 'hash'`, a `hashJoin` operator that drains the right side once into a plain `Map` keyed by a new `equalityKeyOf` (mirroring `compare`'s own coercion exactly, so the two algorithms can never disagree on which rows match), then streams and probes the left side rather than rescanning — priced by the cost model at `left.estPages + right.estPages` against nested-loop's repeated-rescan number, and forced explicitly by `EngineOptions.joinStrategy` the way `aggregateStrategy` already forces an aggregate strategy. `/compare` gained its fourth mode naming the two against each other on the same `authors`/`posts` pair, deliberately under `bufferFrames: 2` — the demo's 5 heap pages otherwise fit entirely inside the default 8 frames, which would let nested-loop's rescans hit cache and hide the very difference the mode exists to show. The multi-table schema editor followed in the same v14 push (§22.7): `SchemaEditor.tsx` + `customDatabase.ts`, a fourth "Custom" data chip in the Playground — add a table, declare an index, edit its rows in a nested `DataEditor`, JOIN across tables the user built themselves, kept local to the browser (`localStorage`, deliberately outside the URL/trace-file scheme). And v14's last item, true vector SVG export (§20.3): `renderSvg.ts` draws the AST, plan and B+Tree trees as real `<rect>`/`<text>`/`<path>` from the same d3 layout `FlowTree` already computes, wrapping text with a fixed monospace character-width estimate rather than any DOM measurement, and resolving each tree's *existing* tone map (no second colour table) through a two-step pipeline — a DOM element resolves `var()`/`color-mix()`, then a 1×1 canvas rasterises the result to plain `rgb()`, since current Chrome's `getComputedStyle` now preserves `oklch()` rather than normalising it, which would have silently reproduced the exact "imports inconsistently" problem this feature exists to fix. **Nothing is left open from this push.** **v15:** the two manual pages the §9 study needed (§17.2, `/docs/manual/eviction` and `/docs/manual/btree-split`) and the §9 study's own materials (`STUDY.md` — control-group reading text, five mechanism questions, a scoring rubric), then sort-merge join, `JOIN`'s third algorithm (§22.2): `Join.algorithm` widened to `'nested-loop' | 'hash' | 'sort-merge'`, sorting both sides on the join key (each its own `externalMergeSort` call, real spill I/O) and merging the two sorted lists in one generator-driven pass that replays a repeated key's full matching run on both sides rather than a plain two-pointer merge, which would silently drop all but the first pairing once the join column isn't unique — the sort key runs through `equalityKeyOf`'s own coercion so it can never disagree with the other two algorithms on which rows match, the same property hash join's mixed-type test already defended. `/compare`'s join mode is now a genuine three-way, each column flagged only where it isn't the best of the three. And v15's last item, predicate pushdown into a `Join`'s own children: a new optimizer rule, `join-predicate-pushdown`, splits a `WHERE` clause's conjuncts by which table they qualify (every reference is qualified once a query has a `JOIN`, so there is no ambiguity) and pushes each single-table conjunct into that side's own `SeqScan`, with its table qualifier stripped — a scan reads that table's raw rows, and a qualified reference against them would silently match nothing. A conjunct naming both sides (including the join predicate itself, restated in `WHERE`) stays a residual `Filter` above the `Join`, unchanged. Needed no multi-join grammar, unlike join order — it rewrites one `Join`'s two existing children, not an ordering choice among several — and needed no cost-model change either, since a filtered `SeqScan`'s estimate already flows into the `Join`'s own row estimate. And v15's last item, a second candidate index: `Table.indexedColumn?: string` widened to `indexedColumns?: string[]`, `buildIndexes` chaining independent single-column B+Trees over one heap with no page-id collisions, and `index-selection` picking the more selective candidate by `ndistinct` when two or more match — honestly narrated as a tie when they're equally selective, not as one falsely "beating" the other, a bug caught live against the shipped `posts` fixture before it shipped. `posts` now indexes `id` and `title` (not `authorId`, which repeats — this B+Tree assumes a unique key). `SchemaEditor.tsx`'s index picker became a real multi-select. **v16:** three quick §23.1 hygiene items. `vite.config.ts`'s `output.advancedChunks` → `output.codeSplitting` (rolldown deprecated the former in favour of the latter, same `groups: [{ name, test }]` shape — no behavior change, just the warning gone). `LICENSE-DOCS` (CC BY 4.0), plus a "Docs licence" link in `Footer.tsx`'s Project column pointing at it — the footer already carried a "CC BY 4.0 docs" badge (v-unknown, predates this session) but nothing to link to. And undo/redo in `DataEditor.tsx`: a `past`/`future` row-snapshot stack, with repeated keystrokes into the same cell folded into a single undo step (a `lastEditTarget` ref, cleared on any structural change) rather than one step per character — add-row, remove-row and CSV-import each push their own step. `SchemaEditor.tsx` got the same `past`/`future` shape over its own `working: Database`, one entry per add-table, remove-table, or a committed row edit from its nested `DataEditor` — no per-keystroke coalescing needed there, since every mutation at that level is already a discrete, deliberate action. Both are button-driven only (↶ Undo / ↷ Redo in each footer); `Ctrl+Z`/`Ctrl+Y` were deliberately left out, since binding them on a dialog full of plain `<input>`s would fight the browser's own native per-field undo rather than complement it. **v17:** B+Tree leaf-chaining range scans (§23.1) — `>`, `<`, `>=`, `<=` and `BETWEEN` on an indexed column now descend the tree once and walk the leaf sibling chain horizontally, instead of falling back to a full scan the way every range predicate did before this. The grammar gained `<=`/`>=` (the tokenizer already lexed them, just to reject them) and `BETWEEN lo AND hi`, desugared to `col >= lo AND col <= hi` at parse time rather than a new `Expr` kind — the two comparisons that come out are indistinguishable from ones written by hand, so every conjunct-walking piece of the engine (the optimizer, the cost model, `evaluate.ts`) handles a `BETWEEN` for free. A new optimizer rule, `range-index-selection`, runs right after `index-selection` and only ever sees a plan the equality rule left untouched — an equality conjunct on any indexed column always wins, by rule order alone, never a cost-model comparison; at most one lower and one upper bound per column are consumed, a second bound in the same direction stays a residual recheck. The new `IndexRangeScan` plan node and its executor operator (`index/rangeLookup.ts`'s `emitRangeStart` for the vertical descent, `nextInRange` for the horizontal walk) pull one matching row at a time — as lazily as every other operator — narrating a `chain-next` step each time a leaf runs out and the walk follows its sibling pointer to the next one, real B+Tree traversal, not a shortcut. Priced with a dedicated `boundedRangeSelectivity`, not `selectivityOf`'s `AND` path: a range's own lower and upper bound are the *same* column, not two independent ones, so multiplying their separate fractions would double-discount a `BETWEEN` (§12) — this instead computes the true linear-density interval overlap directly, provably identical to the existing single-bound formula when one side is left at the column's own min or max. `FlowTree.tsx`'s sibling edges (the B+Tree's dashed leaf-chain lines, always drawn) now get the same `.is-active` treatment a lit hierarchical edge already gets when both its leaves were actually visited, so `BTreePanel` highlights the real horizontal path a scan took rather than just the static chain. Deliberately excluded from `DELETE`/`UPDATE`'s own optimizer pass (`WRITE_PATH_RULES`, a new exported rule set) — their executors only know how to run a `SeqScan` or a single-row `IndexScan` to find the rows to touch, not an `IndexRangeScan`'s multi-row walk, and reaching one in would have silently fallen back to "no filter at all" rather than erroring; a dedicated regression test locks this in. No index-only variant — always touches the heap, one page per matching row, the same granularity `IndexScan`'s own single row already costs. Fixed two real reflexive-comparison bugs in `optimize.ts`'s constant-folding along the way (`age <= age`/`age >= age` were folding to `false`, and `foldLiteralCompare`'s own `<=`/`>=` cases were silently falling through to `>`) — both caught by review before `<=`/`>=` could reach them, not by a failing test. 55 new unit tests, 1 new e2e; live-verified against the shipped `posts`/`users` fixtures, including watching the trace narrate two real sibling hops across a wide range. **v18:** live interactive component embeds in the Concepts docs (§23.1, closing §17.4's last open DoD checkbox) — `concepts/btree.mdx` gets `BTreeMiniDemo` (`src/ui/DocsBTreeDemo.tsx`), a single "find a key" input over a 14-key tree rendered through the exact `search()`/`BTreePanel` pair `/tools/btree` already drives; `concepts/buffer-pool.mdx` gets `BufferPoolMiniDemo` (`src/ui/DocsBufferPoolDemo.tsx`), the same `runBufferTrace`/`BufferPoolPanel` pair with its own LRU/clock-sweep toggle, stepped through a fixed eight-page reference string chosen so page 0 gets read three times before pages 4 and 5 need room — both policies keep it, but clock sweep visibly takes more steps to get there than LRU's direct lookup, the actual cost/benefit trade. Both reuse existing panels exactly as scoped, no new visualisation code. Building them surfaced a real bundle-architecture problem: `vite.config.ts`'s `docs` codeSplitting group forces every `DocsContent/` module into one shared chunk so nine light prose pages cost one round trip — but once two of those pages import `BTreePanel`/`FlowTree`/the engine's trace machinery, the *same* forced grouping merged all of that into the shared chunk too, so a bare FAQ visit would have paid for a B+Tree panel it never touches (measured: `docs` 15.5 → 49.8 kB). Fixed by excluding just those two pages from the group, so they fall to rolldown's own default chunking and share the *existing* chunk Playground already gets that code from, rather than a forced duplicate — landed at 18.7 kB combined for genuinely new glue code, not 34. **v19, closing §23:** the expanded challenge pack, four new puzzles built on v15–v17's own features. "The sort spill" makes `ORDER BY` write enough runs (`writes(events) >= 5`) that the spill is unmistakably real, not a one-row degenerate case. "Hash beats loop" is the first challenge whose database isn't a `DatasetId` at all — `Challenge` gained an optional `database: () => Database` (here, `createJoinDemoDatabase`'s `authors`/`posts` pair) and `engineOptions` (`{ bufferFrames: 2 }`, the same reason `/compare`'s own JOIN mode forces it — at the default 8 frames the 5-page demo fits entirely in cache and the two algorithms cost the same, hiding the very contrast the challenge exists to teach); its `check` is also the first to take the raw SQL text as a second argument, since proving hash actually beats nested-loop means rerunning the player's own query a second time under `joinStrategy: 'hash'` and comparing two real page-read counts, not trusting an estimate. "The dirty eviction" needed no new engine surface, just a wide enough `UPDATE` that a page it already dirtied gets evicted before the statement ends (`writtenBack` on an `evict` event). "The range leap" is the most direct consequence of v17 landing at all: a range predicate on the indexed column versus one on `age`, unindexed and still a full 12-page scan. `challengeStats` grew three fields (`writes`, `dirtyEvictions`, `usesRangeScan`) so the page's own stats grid gives feedback toward every new goal, not just the four solved-or-not messages. 12 new/updated unit tests, 2 new e2e — including one confirming the "step through in the Playground" link correctly disappears for the one challenge whose database the Playground's own URL scheme has no way to name. **v20, closing §18 and this whole §23 tranche:** the README restructure. 682 lines → 82 — badges, a three-sentence pitch, the links row, Learn more, Status, Commands, Deploying, Testing. The 600 lines that came out were **not** moved verbatim into a new docs Architecture page as originally planned (§18.4): the README's own decision-log content had drifted to v0-era scope by the time this shipped — "two optimizer rules" (now six), a SQL grammar excluding `JOIN`/`GROUP BY`/writes/`<=`/`>=`/`BETWEEN` (all shipped versions ago), and a description of a separate `docs/` Astro package and `pnpm build:site`, both removed in v9. Moving that forward would have shipped known-false documentation, so the new [Architecture](src/pages/DocsContent/architecture.mdx) page was written fresh instead, verified against `src/` as it stands — the engine/UI split, the event model, the Volcano executor's current operator list, all six optimizer rules in order, storage, locks, and a short "how to extend it" for contributors. The same staleness turned out to reach two Reference pages that predated this session entirely: [Supported SQL](src/pages/DocsContent/reference/sql.mdx) still said "QueryLens only runs SELECT" and rejected `<=`/`>=`; [Engine limits](src/pages/DocsContent/reference/limits.mdx) still said "no aggregates, no GROUP BY, no joins, no writes, no cost estimation" — years after all of those shipped. Both rewritten to match the engine as it actually runs today. `docs` chunk grew 18.7 → 24.8 kB for the new content — real documentation weight, not code, and the ceiling moved with it rather than the number being argued down to fit. | Post-MVP |
| **v2** | **Product v2 — planned in §25 (v21).** Six releases, evidence in [RESEARCH.md Part IV](RESEARCH.md#part-iv--v2-research). *T0:* tag v1 as `1.0.0` (§24). **2.0 — Trust & ceiling:** **M14** Trust (SQLite differential oracle, §9 study kit, "report a confusing step", name + domain decision) · **M15** Ceiling I (`OR`/`NOT`/`IN`/`LIKE`/`IS NULL` with three-valued logic, `DISTINCT`/`HAVING`, relational-algebra view) · **M16** Ceiling II + launch kit (non-unique + composite indexes, index nested-loop join, course map, CLI / engine / MCP on npm, per-route budgets). **2.1 — M17 The optimizer, honestly:** statistics + q-error, multi-join + outer join, DP join order, cost-based choice + "Why not?", Web Worker + larger data. **2.2 — M18 Transactions** (gated on the §9 checkpoint, §25.6): schedules as input, enforced locks, isolation levels, MVCC, the Hermitage matrix. **2.3 — M19 Durability:** WAL, steal/force, ARIES. **2.4 — M20 Storage engines & access methods** (parallelisable): LSM + Bloom, hash indexes, columnar, vectorized, latch crabbing, vector index. **2.5 — M21 Reach & the learning layer** (parallel): confidence ratings, misconception challenges, generated quiz (after §9), PWA, embeds, a11y depth, workspaces, i18n if a maintainer appears. Main line 2.0→2.3 ≈ 31–39 weeks part-time | Planned (§25) |
| v2+ (v3 horizon) | **Each its own plan (§20.5–§20.6):** graded submission (first backend), the Visual `EXPLAIN` viewer; distributed databases and parallel execution (§25.9). The interactive-embed package is superseded by iframe embeds in 2.5 (H2). The B+Tree standalone (§20.4) shipped in v12 | Not committed |

M8 sits between "the app works" and "the URL is public." It is not polish — every item on the P0 list in
§14 fails *silently* if skipped, which is why it gets its own gate rather than being folded into M7.

**Both gates are through P0 and P1.** What is left in either is P2: the light theme (§15.3, whose
estimate this document had wrong — see the note there), undo for row deletion, and the standing
obligation to re-run the contrast sweep at each visual change. Two of §14.6's checks stay open until
the URL is live, because nothing can fetch the site before it exists.

**M10 and M11 are ordered, not parallel.** M10 changes what the app looks like; M11 screenshots it.
Writing the manual first means rewriting it. The one exception is the FAQ, which is prose about the
model rather than the pixels and can be written at any point — and should be, since it is the page
that decides whether a sceptical visitor stays.

**M11's README restructure is blocked on M11's own docs site**, which is why both sit in the same
milestone: moving 500 lines out of the README before there is somewhere for them to go is deletion.

**M12 is the only build milestone §20 adds, and it is deliberately small.** The analysis of a
twelve-item idea list returns exactly three things that need no backend, no new engine code and no
roadmap fork — and they are the three that produce the GIF and the link the §18.2 launch post is
made of. Everything else §20 examined is v1 or its own plan, gated on the §9 study, because that
study is still the one experiment that says whether any of the rest is worth building.

**M13 adds no feature — it makes the ones already shipped reachable.** Client routing landed for
the stage pages, but the deploy config never caught up: without an SPA rewrite, a hard load of
`/stages/parse` serves the 404 page, so the "multi-page" app is one page plus a set of links that
break when shared. M13 is the day that closes, and it is a hard prerequisite for every route §21
adds after it — there is no point publishing `/tools/buffer-pool` to a URL that only works if you
navigated there from inside the app.

**§22 adds no milestone either.** It is the feature-and-tool backlog behind the §9 study — engine
depth (joins, a cost model, the write path), more `/tools/*` sandboxes, and the learning and reach
surfaces a returning visitor needs. The two or three items cheap enough to fold into M12 — an
ASCII-art trace export, trace JSON import/export, the `aria-live` narration track — are flagged as
such in §22.9; everything else waits on the experiment.

---

## 11. Cost Summary
- Development: $0 (own hardware, free/open-source tools).
- Hosting: $0 (Cloudflare Pages free tier — unlimited static bandwidth, 500 builds/month).
- CI: $0 (GitHub Actions is free for public repositories).
- Domain (optional): ~$10-15/year.
- Persistence/accounts (deferred, optional in v1+): $0 on free tiers (Supabase/Firebase) at MVP scale.

**Total to ship MVP: $0, or ~$10-15/year if a custom domain is desired.**

Two places where a decision in §14 could introduce a bill, both optional and both deferred:

- **Error tracking.** Sentry's free tier covers 5k errors/month, which this will not approach. The real
  cost is ~30 kB of SDK and a third-party origin in `connect-src`, not money.
- **Analytics.** Cloudflare Web Analytics is free; the cookieless alternatives (Plausible, Fathom) start
  around $9/month, or $0 self-hosted. §14 recommends shipping with neither.

---

## 12. Key Risks
- **Scope creep**: temptation to support more SQL/optimizer sophistication before validating the core teaching format. Mitigation: strict adherence to Section 9 (validate single query type first).
- **Engagement, not fidelity, is what drives learning.** The strongest risk in the whole plan: the evidence
  (Hundhausen/Douglas/Stasko meta-study of 24 experiments — only 11 significant) is that passive viewing does
  not reliably beat reading text, *"no matter how high the level of their epistemic fidelity."* Note that
  epistemic fidelity is exactly what §2 optimizes hardest for. Fidelity is table stakes for credibility;
  it is not the variable that teaches. Mitigation: the prediction layer is MVP scope (§4, §8), not v1.
- **Visualization quality is the actual product**: if animations are clunky or confusing, the SQL/engine correctness underneath won't matter. Budget disproportionate time to UI/animation polish relative to engine breadth.
- **Clarity of "simplified model" framing**: must be unmistakable in-product (not buried in a README) that this doesn't represent real engine internals exactly, to avoid misleading learners.
- **Silent client-side failure.** With no server there is no error rate, no log and no alert: an uncaught
  throw is a blank page that nobody reports, and §9's validation study would read it as "the format didn't
  work" rather than "the app crashed." This is the risk §14's P0 list exists to close, and it is the one
  that most directly threatens the plan's only real experiment. Mitigation: an error boundary whose
  fallback hands the user a copyable repro (the SQL, the seed rows, the step index — the entire state that
  produced the crash).
- **The first thirty seconds.** The interface currently opens on an empty 432px box and responds to its
  own primary button with no visible change. A visitor who arrives from a link, understands nothing in
  ten seconds and presses Run to no apparent effect leaves — and §9's post-test never gets taken. The
  engine being correct underneath does not survive that; this risk sits upstream of every pedagogical
  one already listed. Mitigation: §15's P0, which is a day's work.
- **Building v2 on an unvalidated v1** (v21). The first risk above — breadth before validation — was
  accepted at v14 and has compounded through every tranche since; v2 proposes three more subjects
  (transactions, recovery, storage engines). Mitigation: the study becomes runnable (§25.4 A2), the
  second-subject releases sit behind a checkpoint on its result (§25.6), and each new subject must be
  *computed by the engine and checked against an external oracle* rather than scripted (§25.1, §25.2).
- **A shared name** (v21). "QueryLens" is in use by at least five unrelated products, including a
  commercial SaaS for *explaining production queries* — the audience §2 excludes. Searchers land on the
  wrong tool, and every backlink from the launch post raises the price of changing it. Mitigation: decide
  before launch (§25.4 A5; RESEARCH.md §45).
- **Checklist ceremony.** The opposite failure: importing a service-shaped production checklist into an
  application with no server, no secrets and no user data, and spending three weeks on secret rotation,
  uptime monitoring and incident tiers that reduce no risk here. Mitigation: [RESEARCH.md §21](RESEARCH.md#21-what-i-deliberately-left-out)
  names what is deliberately *not* being done, so skipping it is a decision on the record rather than an
  oversight to be re-litigated.

---

## 13. Future Directions (post-v1, not committed)
- Rust + WASM engine rewrite for performance and authenticity.
- Course/curriculum packaging (structured lessons, quizzes tied to visualizations).
- Comparison mode: same query, different index strategy, side-by-side. (Shipped at `/compare`: the
  buffer-pool half — one access pattern, two policies — in v10; the full-pipeline index-vs-no-index
  half, as scorecards, in v12; a third mode, hash aggregate vs. sort aggregate, in v14. §21.3.)
- Community query-sharing (would require backend + persistence).

**§20 takes the export, spin-off and classroom items further** — analysed against the code,
sequenced, and mostly deferred with named triggers. The bullets above are the one-line form; the
course-packaging and query-sharing lines in particular are expanded there (§20.4–§20.5).

**§22 takes the engine line** — "expand SQL coverage: joins, cost estimates" — and the
learning-surface ideas, counted against `src/` the same way: JOIN with a join-algorithm comparison,
an external sort that spills through the buffer pool, a cost-based optimizer that justifies the index
choice §9 rests on, the write path, and MVCC/WAL marked as second products.

**§25 takes the v2 line** — after v1 shipped, the syllabus, competition and evidence were re-read
(RESEARCH.md Part IV) and the list above was re-sorted: MVCC and WAL move from "second products" to
planned, gated releases (2.2, 2.3); a Rust/WASM rewrite is declined in favour of a Web Worker; comparison
mode's remaining halves and the course/curriculum packaging become a course map (§25.4 G1); community
query-sharing stays out (it needs a backend, §25.10).

---

## 14. Production Readiness — the deploy gate

> Added in v3 from [RESEARCH.md Part II](RESEARCH.md#part-ii--production-readiness). M7 finished the
> application; this section is everything *around* it that is currently missing.

**The framing that keeps this short.** QueryLens has no server, no database, no auth, no user data, no
secrets and no third-party call — `runQuery` is a pure function and the deliverable is a folder of static
files. So most of a standard production checklist genuinely does not apply, and importing it anyway is the
failure mode named in §12. What is actually left is seven questions:

1. Does it survive its own bugs?  2. Can anyone tell when it breaks?  3. Is the artifact reproducible and
reversible?  4. Is the supply chain that produced it trustworthy?  5. Does the browser know what the page
may do?  6. May other people legally use it?  7. Does it load and respond on the audience's hardware —
a lecture-hall laptop, not the author's?

Everything below answers one of those. [RESEARCH.md §21](RESEARCH.md#21-what-i-deliberately-left-out)
lists what is deliberately excluded, so that "we skipped it" reads as a decision rather than an oversight.

### 14.1 P0 — before the URL is shared with anyone outside

Roughly one focused day. Each of these fails *silently* if skipped, which is why it gates the deploy.

| # | Item | Where | Why it gates |
|---|---|---|---|
| 1 | **CI on PR and `main`** — `typecheck`, `lint`, `test`, `build`, with `--frozen-lockfile` and Node from `.node-version` | `.github/workflows/ci.yml` | 281 tests, all green, and nothing runs them. With a Pages Git integration, a bad merge ships |
| 2 | **Actions hardened** — every action pinned to a full 40-char commit SHA; `permissions: contents: read` at workflow level | same file | Mutable tags are how `tj-actions/changed-files` (2025) and `trivy-action` (2026) exfiltrated CI secrets. Free to do at the start |
| 3 | **Error boundary + root handlers** — one boundary at the app root, one around `StageDetail`; `onUncaughtError`/`onRecoverableError` on `createRoot`; `window.onerror` and `unhandledrejection` | `src/main.tsx`, new `src/ui/ErrorBoundary.tsx` | An uncaught throw is currently a blank page. M6.5 made the engine's input user-editable, so this is not hypothetical |
| 4 | **The fallback hands over a repro** — SQL string, seed rows, policy, step index, build SHA, all copyable, with a link to open an issue | same | The crashing state is four serialisable values that `App` already holds. This is the only bug report that will ever arrive |
| 5 | **Security headers** — the tested CSP plus HSTS, Permissions-Policy, COOP (§14.3) | `public/_headers` | A CSP guessed rather than tested breaks the SQL editor — see §14.3 |
| 6 | **`LICENSE`** — MIT or Apache-2.0 | repo root | Public repo with no licence = all rights reserved. §13's "course packaging" is illegal for the instructor until this exists |
| 7 | **Supply-chain settings committed** — `minimumReleaseAge: 10080`, `blockExoticSubdeps: true`, explicit `allowBuilds` | `pnpm-workspace.yaml` | pnpm 11 defaults to 1440 minutes, but `pnpm config get minimumReleaseAge` returns `undefined` here — we are relying on an implicit default that CI's pnpm may not share |
| 8 | **Link preview + `robots.txt`** — an `og:image` (the buffer pool mid-eviction), canonical URL | `index.html`, `public/` | Distribution is a link posted to HN, Reddit or a course page. The preview card *is* the landing page, and it is currently a grey box |
| 9 | **Version stamp** — commit SHA in a `<meta>` and a console banner | `index.html` via Vite `define` | Otherwise no bug report can be tied to a build |
| 10 | **`404.html`** | `public/` | No routing, so no SPA rewrite needed — but a typo'd path should offer a way back |

### 14.2 P1 — the fortnight after launch, before the §9 study

**Status: done, with one item's premise corrected by §15.1.**

- ~~**Split the bundle.**~~ **Done differently, on purpose.** The item assumed React Flow and
  d3-hierarchy "render nothing until Run" — which stopped being true the moment §15.1 item 1 made the
  app run its first trace on load. The AST tree *is* first paint now, so lazy-loading it would trade a
  measured comprehension win for a smaller number. What shipped instead is a split for **caching**:
  four chunks (codemirror 116 kB, flow 61 kB, react 54 kB, app 24 kB gzip) so a returning visitor
  re-downloads the ~24 kB that actually changed rather than 264 kB. The durable half of the item —
  **a gzip budget in CI** — shipped as written (`scripts/bundle-budget.ts`, `pnpm budget`).
- **Measure INP before optimising it.** ✅ *as far as it can be measured off-device.*
  `src/engine/__tests__/stepLatency.test.ts` pins the half that can regress silently: the fold memoises
  (asserted by reference identity, not by timing), walking backwards after walking forwards re-folds
  nothing, and a full walk of the longest trace stays inside a single interaction's budget. React's
  render and React Flow's layout are the other half and jsdom timings for them would be fiction — those
  still need field data from real hardware, which is what this item said to collect *before* optimising.
- **UI tests.** ✅ Four new files, 45 tests. The gate array (blocks, unblocks, never re-locks on the way
  back, does not trap a scrubber), the keyboard shortcuts including the `code`-not-`key` space bar and
  the disabled-while-modal case, the data editor's modality and type preservation, and the URL state's
  round trip plus every way a hostile link can be malformed. Two of these caught real defects while
  being written: Testing Library's cleanup was never registered (no `globals: true`), and jsdom 30
  implements none of the `<dialog>` methods.
- **One Playwright smoke test** against the built output: load → Run → step to end → assert result rows.
  This is the only test that catches "the deploy is broken."
- **axe in CI + `eslint-plugin-jsx-a11y`.** ✅ Both. axe runs inside the Playwright suite against the
  built page (wcag2a/2aa/21a/21aa) and reports zero violations; jsx-a11y runs in `pnpm lint`. Each
  found one real defect on its first run: axe caught that the SQL editor's actual `role="textbox"` —
  CodeMirror's `contenteditable`, not the wrapper the label was on — had no accessible name, and
  jsx-a11y caught the data editor's backdrop-click handler. Still a regression net, not a compliance
  claim: automated tooling catches 30–57% of WCAG failures (§8).
  **Note:** `eslint-plugin-jsx-a11y@6.10.2` declares a peer range ending at ESLint 9 and this project
  is on ESLint 10. It loads and its rules run correctly; the range is stale metadata, not a conflict.
- **Renovate or Dependabot**, grouped and scheduled. ✅ `.github/dependabot.yml` — weekly npm batches
  grouped by what breaks together (CodeMirror, React, dev), monthly for the SHA-pinned actions, which is
  exactly the case a human never re-resolves by hand.
- **Settle the telemetry question** (§14.4) and write the answer into the README either way. ✅ Shipped
  with none, and the README says so under *Deploying*.

**One thing the release-age floor cost, worth knowing before the next `pnpm add`.** `minimumReleaseAge:
10080` is a *resolution-time* rule, and pnpm re-resolves every direct dependency whenever package.json
changes — so adding any package fails on whichever existing pins happen to be under a week old
(eight were). `--frozen-lockfile` is unaffected, which is why CI never sees it. The fix is not to
weaken the floor or to accumulate `minimumReleaseAgeExclude` entries, which would be unbounded once a
transitive dependency trips it too: run the one-off as
`pnpm install --config.minimumReleaseAge=0` **after checking the ages of what you are actually adding**.
The floor's real job — stopping a fresh release being adopted silently — is done by the error itself,
which appears exactly when a human is at the keyboard.

### 14.3 The security headers, tested rather than assumed

The CSP below was verified by serving the real `dist/` under policy and reading console violations.
**The result was not what a copy-pasted policy would have given:** the build emits zero inline scripts, so
`script-src 'self'` needs no hashes or nonces — but a strict `style-src 'self'` **breaks the SQL editor**,
because CodeMirror's `style-mod` styles itself by assigning `textContent` to a runtime `<style>` element.
Hashes don't fix it (the content changes as modules mount). `'unsafe-inline'` for *styles only* is the
right call, and it is now a decision with a reason rather than a default.

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  Permissions-Policy: geolocation=(), microphone=(), camera=()
  Cross-Origin-Opener-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

Notes: `frame-ancestors` is ignored in a `<meta>` tag and must be a real header — `public/_headers` gives
that for free. Do **not** add `X-Frame-Options` (superseded) or `X-XSS-Protection` (deprecated); the 2026
advice is to drop headers, not accumulate them. `connect-src 'self'` will need editing the day analytics
or error tracking is added, which is a feature: it puts §14.4's decision in a diff instead of leaving it
silent. Verify with Mozilla Observatory and securityheaders.com — A+ is achievable here with no exceptions.

### 14.4 The telemetry decision, stated rather than drifted into

There is no telemetry of any kind today, and **"no backend, no accounts, nothing leaves your browser" is a
real feature for a classroom tool**, not merely an absence. It also collides with §9: if the app throws on
a study participant's machine, the post-test returns "it didn't work for me" and the result cannot be told
apart from a teaching failure.

**Recommendation: ship with none, and rely on P0 item 4** — the copyable repro is the bug report that would
actually have arrived anyway. Revisit exactly once, when the §9 study is scheduled with users you cannot
sit beside; Sentry for the duration of the study is the pragmatic call there, with
`build.sourcemap: 'hidden'` so maps are uploaded but not served. If analytics is ever added, note that
Cloudflare Web Analytics still processes IPs and user agents — personal data under GDPR even with no
cookies — while the cookieless tools (Plausible, Fathom, Umami) claim no consent banner is required.
Whichever way it goes, the README states it.

### 14.5 P2 — ongoing, once there are users

- Repeat the composited-contrast sweep at every visual change; axe only guards against regression.
- Review dependency upgrades in batches; keep `pnpm audit --prod` clean.
- Revisit **TypeScript 7** when 7.1 ships a stable compiler API and `typescript-eslint` supports it (§6).
- Revisit **Cloudflare Workers static assets** the first time a server-side piece is needed (§6) — not before.
- Write the rollback down before it is needed: Pages retains previous deployments and rolls back in one
  click, which is only useful if that sentence exists somewhere at 2am.

### 14.6 Definition of done

The URL may be shared publicly when all ten P0 items are true, and specifically when:

- [x] A pull request cannot merge without `typecheck`, `lint`, `test` and `build` passing.
      *`.github/workflows/ci.yml` runs all four on PR and `main`, every action pinned to a
      40-char SHA, `permissions: contents: read`. **The branch-protection rule that makes it
      blocking is a GitHub setting, not a file** — it has to be switched on in the repo.*
- [x] Forcing a throw inside a panel shows a fallback with a copyable repro, not a blank page.
      *Verified by forcing a throw in `BufferPoolPanel` against the running app: the rest of the
      trace stayed live, and the fallback carried build SHA, page, browser, error, component
      stack and the four repro values.*
- [x] securityheaders.com reports A or A+, and the SQL editor is still styled under the live CSP.
      *Both now verified against the real first deploy
      (`https://query-lens.1234naveenboddepalli.workers.dev`), not just a local `dist/` serve:
      securityheaders.com's actual scan reports **A+**, every header from §14.3's policy present
      byte-for-byte, `X-Frame-Options` correctly absent in favour of `frame-ancestors`. The editor
      renders styled with zero console errors on the live page.*
- [x] `LICENSE` exists and the README names it.
- [x] Pasting the URL into Slack or Twitter shows an image of the product.
      *`public/og.png` (1200×630, the buffer pool mid-eviction) plus `og:`/`twitter:` tags with an
      absolute URL. Verified live: `og.png` serves 200/image/png, and `og:url`/`og:image` resolve
      to the real deployed domain — which needed its own fix first. The fallback in
      `vite.config.ts` assumed `CF_PAGES_URL` would be set and hardcoded `query-lens.pages.dev` as
      a backup; neither held once the project turned out to run on the unified
      Workers-with-static-assets engine rather than classic Pages (§6) — Cloudflare sets no
      equivalent URL variable for a Workers Builds deploy, and the hardcoded guess had never been
      checked against a real DNS lookup, so it silently pointed at a domain that does not resolve.
      Caught only by checking the live `og:url`/`og:image` tags against the real deployment.*
- [x] The live page reports which commit it was built from.
      *`<meta name="querylens:build">` in the served HTML and a console banner, both from the
      same `define`.*

---

## 15. UI/UX Readiness — the comprehension gate

> Added in v4 from [RESEARCH.md Part III](RESEARCH.md#part-iii--uiux-production-readiness), which drove
> the running app on desktop and phone and measured what it does. §14 asks whether the deploy is safe;
> this asks whether the first visitor understands anything.

**The bar, stated so it does not drift.** This product has no signup, no funnel and nothing to convert.
Its success metric is already written: §9's post-test — can someone answer a mechanism question they
could not answer before. **Every item here earns its place by removing something standing between a
learner and the mechanism**, which is why standard product-UX work (onboarding tours, activation
checklists, engagement nudges) is absent and something a normal review would rank low — where the
question sits relative to the diagram — is P1.

The audit's summary: *better built than it looks, worse composed than it is built.* Contrast, keyboard
support, ARIA semantics and reduced-motion handling are all done properly and measured as passing
([RESEARCH.md §32](RESEARCH.md#32-what-is-already-right-and-should-not-be-touched)). Almost nothing below
is about how it looks.

### 15.1 P0 — before the URL is shared (with §14's P0)

Under a day, and each one was measured rather than guessed.

| # | Item | Where | Why it gates |
|---|---|---|---|
| 1 | **Run the default trace on load** | `App.tsx` | The empty state is the biggest element on screen and teaches nothing; on a phone it is 53% of the viewport. Everything needed is deterministic and already there |
| 2 | **Make Run visibly respond** — advance to step 1, name the step count where the eye is | `App.tsx` | Today the panel, narration and tracker are unchanged; only a 12px `0/0`→`0/33` counter moves. The documented consequence is the user pressing it again |
| 3 | **Native `<dialog>` + `showModal()`** for the data editor | `DataEditor.tsx` | Three measured defects: focus never enters, Escape does not close, Tab reaches the background. The native element fixes all three and deletes code |
| 4 | **`color-scheme: dark`** | `index.css` | Currently `normal`, so scrollbars, the `<select>` popup and the caret render as light-mode chrome |
| 5 | **Platform-correct modifier key** | `App.tsx`, `ShortcutHints.tsx` | `⌘` is hardcoded for every user; there is no platform detection in `src/`. The binding is right, only the label lies |
| 6 | **Hide the keyboard hints on touch** | `ShortcutHints.tsx` | A phone is told about Space, ←, →, Home and ⌘↵ |
| 7 | **Un-pin the eight `text-[10px]`/`text-[11px]` values** | various | Verified: at a doubled root font size everything scaled except these eight, which stayed 10px and 11px |
| 8 | **Scrubber at ≥24px** | `PlaybackControls.tsx` | Measured 16px tall, under WCAG 2.2 SC 2.5.8 (AA) — and it is the control a touch user depends on most |

### 15.2 P1 — the fortnight after launch, before the §9 study

**Status: done.**

- **Shareable URL state** ✅ `src/ui/urlState.ts`. Query, policy, predict on/off and step index ride in
  the address bar; edited rows travel as arrays of values rather than repeated objects, and only when
  they differ from the seed. `replaceState`, never `pushState` — stepping a 33-event trace would
  otherwise bury the previous page under 33 history entries — debounced, because it also fires on every
  keystroke. Opening a link at step 13 marks the prompts *before* 13 as skipped and leaves the one *at*
  13 pending: those earlier questions were never put to this reader, and leaving their gates armed would
  freeze playback on something they have not seen. The URL is the one input this app takes from a
  stranger, so every field is parsed defensively and a dataset that does not match the schema is dropped
  whole rather than half-restored — a partly-restored table would render a trace that is simply a lie.
- **Put the prompt against its panel** ✅ **Both halves, not just the cheap one.** The panel follows the
  question when one is pending (unless a stage is explicitly pinned), *and* the prompt moved out of the
  authoring column to sit directly beneath the diagram it is about.
- **Responsive height** ✅ The panel fills its column with a `min-height` floor and a `60dvh` ceiling on
  phones. The old comment was right that the controls must not move mid-step and wrong that freezing the
  panel is how: the height now comes from the viewport rather than from what the current step happens to
  render, which is stable for the same reason without letterboxing a 1440×900 monitor.
- **Mobile as read-first** ✅ The trace column is ordered before the authoring column on a phone and
  after it on a wide screen, so a link opens on the visualization and the SQL editor is what you scroll
  *to*. Playback controls stick to the bottom of the viewport within the trace column, in thumb reach.

### 15.3 P2 — once there are users

- **A light theme. ✅ Done — but the estimate in this section was wrong, and the correction is the
  useful part.**
  "The tokens are already semantic, so this is a second block of values plus a toggle, not a redesign"
  is true of `--color-surface`, `--color-ink` and friends — and false of the diagrams, which are where
  the product actually lives. Counted: **47 hardcoded Tailwind palette colours** outside the token
  system, in `AstTree` (24), `PlanTree` (12), `stageMeta` (8) and `LockPanel` (3), every one of them a
  `border-{hue}-400/60 bg-{hue}-400/10 text-{hue}-200` triple tuned for light-on-dark. On white the
  fills vanish and the `-200` labels fail AA outright. So the real shape of this work was: collapse those
  47 into semantic hue pairs, *then* the second block of values and the toggle. The groundwork was the
  job; the theme is the easy part after it.

  **The groundwork was done first.** All 47 are gone: five `--color-hue-*` / `--color-hue-*-ink` pairs for
  the diagrams (a line colour that reads on either background, and a label colour that is the half which
  has to flip) plus eight `--color-stage-*` tokens for the pipeline tracker's accents, which are a
  separate scale on purpose — they label a chip rather than a node, and sharing one scale would make the
  tracker and the diagrams disagree about what "the parse colour" is. Values are Tailwind's verbatim, so
  the refactor changed nothing on screen: all 18 tokens verified pixel-identical against Tailwind's own
  values, and the contrast sweep reproduces 5.29:1 with 0 failures across all five views at the same
  element counts as before. **What remains is genuinely what this section originally claimed** — a
  second block of values and a toggle.

  The two reasons it is not optional forever are unchanged: roughly one adult in three has astigmatism,
  for whom light-on-dark text haloes, and §13's course path runs through a projector, where dark UIs
  wash out.
- ~~Restore focus to the trigger when the editor closes~~ ✅ free with the native `<dialog>`, and Apply
  and Reset were routed through `close()` so they return focus like Escape and the Close button do.
- Consider undo for row deletion. — still open.
- Re-run the composited contrast sweep at every visual change (§8). ✅ **Re-run after the §15.2 layout
  work**: 62–129 elements per view across the default view, a pending prediction, the buffer pool, the
  result and the data editor — 0 failures, minimum 5.29:1, matching the recorded baseline exactly.
  Worth recording that the first run of the sweep reported 57 failures and all 57 were the sweep's own
  bug: it parsed `oklch()` as if it were `rgb()`, and its alpha compositing hardcoded the result to
  opaque, so a semi-transparent stack fell through to white. A contrast tool that has not been tested
  against a known-good page is a random number generator.

### 15.5 After the first bug report

Three defects, none of which the audit in Part III would have caught, because two of them only appear
in states it did not visit and the third only in a browser it did not use.

- **A pinned stage looked like a broken one.** Selecting a chip holds the panel there while the trace
  runs on — deliberate, useful, and silent. The report was "the graph is not updating when I step".
  The panel now names the held stage and offers a one-click release. Worth generalising: a mode that
  changes what the primary interaction does has to say so where that interaction happens, not in a
  1px ring somewhere else.
- **The result panel grew the page instead of scrolling.** §15.2 replaced a fixed `h-[27rem]` with a
  `min-height` plus `flex-1`, which is right only if the row has a definite height to divide. It did
  not: the grid row was auto-sized, so a 43-row result made the row 1300px tall in a 900px viewport.
  The desktop layout is now a fixed-height shell and the panels scroll inside it.
- **A phone scrolled sideways**, found while testing the fix above. Grid and flex children default to
  `min-width: auto` and will not shrink below their content, so a long email column pushed the page
  wider rather than letting the table's own scroller work.
- **The fixed-height shell above silently clipped every page that never got its own scroller.** The
  fix two bullets up only made the *Playground's own panels* scroll inside the fixed shell; `/stages`
  and `/docs` each separately noticed the same problem for their own `<Outlet />` and patched it
  locally. Every other routed page — `/learn`, `/challenges`, `/tools` and several of its sandboxes,
  plain prose or lists with no scroll container of their own — was never patched, and on desktop
  simply lost whatever fell past one viewport with no way to reach it, reported as "the Learn page
  is not scrolling." `Layout.tsx`'s shared `<Outlet />` wrapper now carries the `overflow-y-auto`
  `/stages`/`/docs` had each been adding for themselves, so the invariant applies once, everywhere,
  instead of per-page as each page happens to need it.

- **The B+Tree's zoom controls overlapped its leaf row.** React Flow's `<Controls>` float inside the
  pane; for this graph the bottom-right corner is where the leaves are. Moving them into the panel
  header — beside the hint that already described them — costs no canvas height, which a strip above
  the graph did: it clipped the bottom row by exactly its own height. The first fix was worse than the
  bug, and only a screenshot showed it.

The lasting change is not the four fixes but where they are pinned down: `e2e/regressions.spec.ts`
walks all 33 steps asserting the panel matches the current stage, asserts the zoom controls sit
geometrically outside the canvas box, checks overflow at two viewports on both a short and a long
trace, and asserts the console stays silent across a full playthrough. None of
that is expressible in jsdom, which is why §14.2's "one Playwright smoke test" turned out to be the
load-bearing item on that list.

### 15.4 Definition of done

- [x] A first-time visitor who touches nothing sees a real trace, not an empty box.
      *The app opens at step 1 of the 33-step default trace: AST on screen, narration written,
      pipeline tracker on Parser. This turned out to need a second fix — see the note below.*
- [x] Pressing Run changes something they are already looking at.
      *Run lands on step 1 rather than 0, and the trace length is named under the button that
      built it ("33 steps in this trace · showing step 1") instead of only in the 12px counter
      on the far side of the screen.*
- [x] The data editor takes focus, closes on Escape, and does not leak Tab to the page behind it.
      *Native `<dialog>` + `showModal()`. Focus-in and `:modal` were verified in real Chrome;
      Escape is covered by a test against a spec-mirroring jsdom shim, because jsdom 30
      implements none of the dialog methods and CDP-injected keys cannot raise a browser-level
      close request (a bare `<dialog>` ignores them too). Playback shortcuts are suspended while
      it is open, so ←/→ no longer step a trace nobody can see.*
- [x] Every shortcut label matches the key on the user's actual keyboard.
      *`src/ui/platform.ts` uses CodeMirror's own Apple test, so the label cannot disagree with
      the keymap. On a touch device the hints and the Run suffix are dropped entirely.*
- [x] A link reproduces a specific query at a specific step.
      *Query, policy, prediction mode, step index and — only when customised — the rows. Covered by 19
      unit tests and one end-to-end test against the built page.*
- [x] The app is legible on a projector and to a reader who cannot use light-on-dark.
      *Light theme with a three-state System/Light/Dark toggle, resolved before first paint, verified
      by sweep and axe in both palettes (§15.3).*
- [x] Nothing on screen is pinned below the user's chosen font size.
      *Measured: at a doubled root font size every text node now scales exactly 2×, with none
      left under 16px. Beyond the eight the audit found, this also caught the SQL editor itself
      (`.cm-editor` was 13px) and React Flow's attribution badge.*

**One regression, found by measuring rather than by looking.** Running the trace on load moves
the first React Flow canvas into the very first render, before its container has been measured —
and *every* viewport call, `fitView` and `setCenter` alike, is a silent no-op while React Flow's
store reports a width of 0. The tree rendered unframed in the corner. The fit is now gated on
`useStore(s => s.width)`, which also buys a refit on window resize; the unfocused case frames
every node through the same d3 maths rather than handing off to `fitView`, so one code path
serves both. Worth recording that the first two attempts at this fix were aimed at the wrong
thing: a hidden browser pane throttles `requestAnimationFrame`, so the animated transform never
lands, which looks identical to a fit that never ran.

> **Correction, M10.** The paragraph above is wrong on both counts, and the thing it dismissed
> was the actual cause. `requestAnimationFrame` was not a distraction: React Flow moves the
> viewport through a d3-zoom transition whenever it is given a duration, d3-timer advances those
> on rAF, and a tab that is not painting never fires one — so the move was created, never ticked,
> and nothing retried it. That is why the symptom was intermittent, and why it was *reliable* for
> anyone opening the link into a background tab. And the `useStore(s => s.width)` gate this
> paragraph describes never worked: React Flow's store does `width: size.width || 500`, so it does
> not report a width of 0 — it reports 500, which the gate reads as ready and the framing maths
> reads as a real pane. The fix that holds is in §19.4: measure the pane with a `ResizeObserver`,
> compute the transform and hand it to `setViewport`, never animate the first framing or any
> framing while `document.hidden`, and depend on the `panZoom` instance rather than a timeout.
> Three e2e tests now hold it, each verified to fail against the code it replaced.

---

## 16. Visual Design Maturity — the "not AI-generated" gate

> Added in v5, **rewritten in v6 against a measured audit of the code rather than an impression
> of it.** §14 asks whether the deploy is safe, §15 asks whether the first visitor understands
> anything, and this asks whether the product looks *intentional* — designed by a person with
> opinions, not assembled component-by-component by a tool optimising for "looks plausible."

**What the v5 draft got wrong, and why it is worth saying so.** v5 listed the symptoms a
generic design audit lists: too many type sizes, spacing off a grid, jump-cuts, no hover states.
Three of those four are either overstated or backwards here, and one much larger problem was
missed entirely. The audit below is counted, not eyeballed — the same discipline §15 credits for
paying for itself.

### 16.0 The audit — what the code actually says

| Claim in v5 | What a count of `src/` shows | Verdict |
|---|---|---|
| "Six type sizes with no documented purpose" | Six sizes, but the distribution is the story: `text-xs` ×30, `text-sm` ×20, `text-2xs` ×15, `text-3xs` ×10 — **55 of 77 usages are ≤ 12px** — against exactly **one** `text-lg` and one `text-base` in the entire application | **Misdiagnosed.** The problem is not too many sizes, it is that there is no *top* to the scale. Everything is chrome; nothing is a headline. Deleting a size makes this worse |
| "Collapse all padding to a 4px/8px grid" | The four most common spacing values are `py-1.5` (6px), `gap-2` (8px), `px-2.5` (10px), `py-1` (4px). The half-steps are not strays — they are the majority, and they are what makes a dev-tool density readable | **Wrong target.** Forcing this to a 4px grid is a redesign that would inflate every panel. The base unit here is 2px; the fix is to *name* the scale that already exists, not replace it |
| "Jump-cuts between states where a transition would help" | 28 `transition`/`duration`/`animate` usages already in `src/` | **Overstated.** Motion exists; what is missing is a *documented* set of durations and curves, so the next component matches the last one by rule rather than by memory |
| "Interactive elements with no hover feedback" | Confirmed, and worse than stated: **every diagram panel has zero hover states** — `AstTree`, `PlanTree`, `BTreePanel`, `BufferPoolPanel`, `LockPanel`, `ResultPanel`, `FlowTree` and `PipelineTracker` between them contain one `hover:` rule, in `StageDetail` | **Confirmed, promote to P0.** These are the panels the product is *for* |

**And the thing v5 missed, which is the largest single tell in the app.**

`src/index.css` declares `--font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace`,
and **no `@font-face` rule exists and no font file is served.** The typeface only appears for
visitors who happen to have installed it locally — a population that skews to exactly the developers
who would notice, which is why it survived this long. Everyone else gets their OS default, meaning
the app's typography is currently *unchosen*. `public/_headers` sets `font-src 'self'`, so a Google
Fonts link would be blocked by the project's own CSP — correctly. Self-hosting is the only route,
and it carries a licence obligation (§17.3).

An unchosen typeface is the first item on every published list of AI-design tells, alongside the
indigo-to-purple gradient and the three-rounded-cards feature row. QueryLens has neither of the other
two — its palette is a deliberate OKLCH system with semantic storage-layer hues and a documented
reason for each — which is precisely why the font is now the weakest link.

### 16.1 Design direction — the constraints, written down before the work

The published diagnosis of generic-looking UI is consistent: it is what a model produces when it
fills in taste decisions nobody made. The counter is not better prompting, it is **making the
decisions explicitly and writing them where the next change can see them.** This subsection is that
document. It is short on purpose; a design language nobody can recite is not a design language.

1. **Two typefaces, both chosen, both self-hosted.** A monospace for everything the engine emits —
   SQL, page IDs, keys, counters, narration — and a text face for prose and headings. The monospace
   is JetBrains Mono (already named; now actually shipped). The text face must be a deliberate
   choice and must **not** be Inter, for the same reason a house should not be beige: it is the
   default, and defaults read as absence of choice. A grotesk with real character at small sizes and
   an open licence is the brief.

   **Chosen: IBM Plex Sans** (OFL 1.1), shipping as `QueryLens Sans` — see §17.3 for why the subset
   cannot keep the upstream name. It was built for technical interfaces, and its flared terminals
   and double-storey `a` and `g` still read as themselves at the 11–12px where 55 of this app's 77
   type usages live, which is the only size range that actually matters here. It is also the closest
   of the candidates to constraint 3's instrument reference class: engineering, not marketing.
2. **One accent, and it is already spent.** `--color-accent` (a cyan) is the interaction colour. The
   storage semantics — hit/miss/evict, internal/leaf — are *data* colours and are never borrowed for
   chrome. No second accent, no gradient anywhere in the chrome. The diagrams are allowed colour
   because the colour carries meaning; the frame around them is not.
3. **The instrument aesthetic, not the SaaS aesthetic.** The reference class is an oscilloscope, a
   profiler, a debugger — dense, flat, high-information, borders over shadows. Explicitly rejected:
   `rounded-2xl` cards, `shadow-lg` lifts, `backdrop-blur`, hero gradients, three-icon feature rows.
   Radius stays small and constant (4px chrome / 2px inside diagrams).
4. **Asymmetry is allowed.** Equal thirds is the layout a generator reaches for. The pipeline is a
   sequence with a wide middle; the layout should say so.
5. **Motion is causal.** Anything that moves does so because something changed, and the duration
   says how far it travelled. Nothing animates on load for decoration.

These five are the acceptance criteria for every item below. An item that satisfies its own
checkbox while violating one of these has not been done.

### 16.2 P0 — before the URL is shared publicly

Roughly a day and a half. Reordered from v5: the font work is new and first, the spacing rewrite is
gone, and the hover audit is promoted out of P1.

| # | Item | Where | Why it matters |
|---|---|---|---|
| 1 | **Ship the typefaces.** Self-host JetBrains Mono as a subset WOFF2 (Latin + the box-drawing and arrow glyphs the diagrams use), served from `/fonts/`, declared with `@font-face` and `font-display: swap`. Add a chosen text face for prose and headings. Preload only the two faces above the fold. Verify against `font-src 'self'`, and add the `size-adjust`/fallback metrics so the swap does not reflow | `public/fonts/` [NEW], `src/index.css`, `index.html` | The app currently has no typography of its own. Everything else in this section is polish on top of a font nobody chose |
| 2 | **Give the scale a top, then name every step.** Add a display and a heading size above the current ceiling so the H1 and stage titles are not 14px, and name the six steps by role — `--text-display`, `--text-heading`, `--text-body`, `--text-label`, `--text-micro`, `--text-code` — on a minor-third-ish ratio. Six *named* sizes is a scale; six unnamed ones is an accident. Delete nothing until a role is proven unused | `src/index.css`, `App.tsx`, `StageDetail.tsx` | A named scale with a documented role per step is the single strongest signal of intentional design |
| 3 | **Name the spacing scale that already exists.** Declare `--space-0.5` (2px) through `--space-6` (24px) on a 2px base, map the values already in use onto it, and document the density rule: 2px steps inside dense chrome, 4px steps and up for layout. Fix only the genuine strays (`p-0.5`, `py-0`, `px-0`, `mt-2.5`) | `src/index.css`, all components | The grid exists; nobody can point at it. A scale someone can name is the difference between "dense" and "inconsistent" |
| 4 | **Hover and active states on every diagram element** — buffer-pool frames, B+Tree nodes, AST and plan nodes, lock rows, result rows, pipeline chips. Border-brighten plus a 1px background lift; `cursor: pointer` on the ones that are clickable, and nothing on the ones that are not, so the cursor tells the truth | `panels/*.tsx`, `PipelineTracker.tsx` | Zero hover states across eight panels is the audit's hardest finding. These panels *are* the product |
| 5 | **Three named durations, three named curves.** `--dur-fast` 120ms (state flips), `--dur-base` 180ms (panel and stage changes), `--dur-slow` 320ms (diagram layout moves); `--ease-enter`, `--ease-exit`, `--ease-morph`. Replace every literal duration. Never `transition: all` — list the properties. Every one collapses to `0ms` under the existing reduced-motion hook | `src/index.css`, all animated components | Motion already exists (28 sites); what is missing is the rule that makes the 29th match |
| 6 | **Acknowledge Run.** The trace takes ~50ms, so a spinner would flash and read as jank. Use the show-delay pattern: nothing before ~150ms, and if a spinner does appear, hold it ~400ms minimum. Under the threshold, a single-frame press state on the button is the whole acknowledgement | `App.tsx`, `PlaybackControls.tsx` | Professional tools acknowledge every action; they do not flash a spinner to prove they did |
| 7 | **Tabular figures everywhere a number can change** — step index, page IDs, `usage_count`, hit/miss counters, the data grid. `font-variant-numeric: tabular-nums` | `src/index.css` | Digits that jitter during playback are the most visible possible defect in a step-through tool, and the fix is one declaration |
| 8 | **The favicon at every size it is actually used.** The existing `favicon.svg` is sound; what is missing is a 180×180 `apple-touch-icon.png` and a check that the mark still reads at 16px — most marks do not | `public/`, `index.html` | The favicon is the brand at its smallest |
| 9 | **A footer that is a footer.** `DisclaimerBanner` is a top bar and should stay one — §12 wants the disclaimer unmissable. Add a *separate* real footer: project name, one-line tagline, Docs · GitHub · Licence · Changelog, and the build SHA already stamped into the page | `Footer.tsx` [NEW], `App.tsx` | A build SHA in the footer is what a tool built by an engineer looks like. It also makes bug reports self-identifying |
| 10 | **Scroll-snap on mobile** — `scroll-snap-type: y proximity` with `scroll-snap-align: start` on each section, so the trace and editor settle rather than drift | `src/index.css` | One CSS property, and mobile feel is where hand-assembly shows most |

### 16.3 P1 — the fortnight after launch

- **Focus-visible ring audit at 3:1 against every surface it lands on.** The ring exists and is
  consistent; what has not been measured is its contrast against `--color-surface-3` and against the
  diagram fills, where it is at its weakest. Interaction states must *increase* contrast, never
  merely change hue
- **Empty, loading and error states for every panel.** Today a panel with nothing to show renders an
  empty box. Each needs a one-line statement of what will appear and what to do to make it appear —
  "No index scan in this plan. Add `WHERE id = …` and re-run." Empty states are where thought about
  failure becomes visible
- **Skeletons at the geometry of the incoming content** on first paint, sized to the real panels so
  nothing shifts. Not shimmer for its own sake — the point is zero layout shift
- **Optical alignment pass** — icons against text baselines, the play triangle inside its button, the
  clock hand against its ring. ±1px where perception beats geometry
- **Typographic detail** — curly quotes in prose, `&nbsp;` joining values to units (`4&nbsp;KB`,
  `⌘&nbsp;K`), no orphaned words in the narration line
- **Hit targets** — ≥24px everywhere, ≥44px on touch, with the hit area expanded beyond the visual
  target rather than the target inflated

### 16.4 P2 — ongoing

- **`tokens.json`** — export the token system so course themes, embeds and the docs site theme from
  one source rather than three drifting copies
- **Motion specification** — one page: what moves, how far, how fast, why. The §16.2 item 5 tokens
  are the vocabulary; this is the sentence
- **Component gallery** — every panel, every state, both themes, on one page. Not for users; for
  making the next visual change without fear
- **A second opinion.** Every item here is self-assessed. Before the §9 study, put the app in front
  of one person who designs for a living and ask a single question: "what tells you a developer made
  this rather than a designer?" Budget one afternoon and take notes rather than defending

### 16.5 Definition of done

**P0 complete.** Every box below is ticked; the text face chosen against §16.1's brief is
IBM Plex Sans, shipping as `QueryLens Sans`.

- [x] Both typefaces are self-hosted, subset, preloaded, and render under `font-src 'self'` with no
      console warning and no layout shift on swap. *Verified by serving `dist/` behind the real
      header from `public/_headers` rather than assuming it: both faces load, one fetch each, zero
      console output. `public/fonts/`, built by `scripts/build-fonts.py`.*
- [x] The type scale has six named steps with a documented role each, and a display size above 16px
      exists and is used. *`--text-display` 24px on the wordmark; Tailwind's own scale is cleared
      with `--text-*: initial`, so every size in `src/` now names its job.*
- [x] Every spacing value in `src/` maps to a named `--space-*` token; the density rule is written
      down in `index.css`. *Naming the scale first reversed three of the four "strays" this section
      listed — see the note in `index.css`; only `mt-2.5` was a genuine one.*
- [x] Every diagram element has a hover state and an active state, and `cursor: pointer` appears on
      exactly the clickable ones. *The cursor half was larger than the audit found: a `<button>`
      takes `cursor: default` from the user agent, so every control in the app was pointing an arrow
      at the user. Fixed globally in `index.css`.*
- [x] Every transition uses a named duration and a named curve; no `transition: all` remains; all
      collapse under `prefers-reduced-motion`. *The tokens themselves collapse to `0ms`, so
      `src/ui/motion.ts` hands React Flow's viewport animations the same zero without knowing why.*
- [x] Every changing number renders with `tabular-nums`.
- [x] `apple-touch-icon.png` exists, is linked, and the mark is legible at 16px. *The check this item
      asks for found the third page bar dropping out at 16px, so its opacity went 0.32 → 0.45 and the
      stack reads as three again. `scripts/build-icons.py` regenerates both and asserts it still
      matches `favicon.svg`.*
- [x] A footer exists with Docs · GitHub · Licence · Changelog and the build SHA.
- [x] Mobile scroll snaps between sections.
- [x] Nothing in the app violates the five constraints in §16.1 — in particular, no gradient in the
      chrome, no `rounded-2xl`, no `shadow-lg`, and no Inter. *One violation existed and is gone: the
      phone's sticky playback bar used `backdrop-blur`, which constraint 3 rejects by name. It is an
      opaque surface plus the border it already had.*

**The licence obligations §17.3 attached to this work are done with it**, because they land with the
font files rather than after them: `OFL.txt` ships beside each face, `NOTICE` covers both, and the
subsets are renamed off the reserved font name — but only where one exists. IBM Plex reserves
"Plex", so its subset ships as `QueryLens Sans`; JetBrains Mono declares no reserved name, so its
subset keeps the family name, because accurate attribution beats an invented one when the licence
does not require the change. `public/fonts/README.md` records that reasoning, and the build script
refuses to write a file that still carries a reserved name.

---

## 17. Documentation, User Manual & Licensing

> Added in v5, **revised in v6**: the docs-tool choice is reopened (v5 picked a Vue framework for a
> React application), the user manual is restructured around minimalist, task-oriented principles
> rather than a chapter per stage, and the licensing section grows to cover the two obligations the
> project has actually incurred — prose is not code, and a bundled font is not either.

The README is 665 lines and growing. It is a technical decision log — invaluable for contributors,
overwhelming for a student who wants to know what a buffer pool does. This section splits that
content into the right containers, and §19 builds the door people arrive at.

### 17.1 Documentation site — the tool decision, reopened

v5 chose VitePress on the grounds of speed and Vite-nativeness. Both are true. The problem is that
**VitePress is Vue**, and QueryLens is React 19. Every interactive doc page — the thing that would
make these docs worth reading rather than skimming — would need a Vue wrapper around a React root,
or would have to give up on embedding the app entirely.

Three candidates, judged on the one axis that actually differs for this project:

| Tool | Embedding a live React B+Tree in a docs page | Other considerations |
|---|---|---|
| **VitePress** | Vue SFCs; a React component needs a manual mount wrapper per instance and loses SSR | Fastest dev loop of the three; simplest config; the docs you would copy from (Vite, Vitest) use it |
| **Docusaurus** | React-native, MDX, components import directly | The broadest plugin ecosystem — versioning, OpenAPI, PWA. Heavier build, heavier client, and none of the plugin surface is needed here |
| **Astro Starlight** | React is a first-class island: `<BTreeDemo client:visible />` in MDX, and the JS ships only for that island | Minimal JS by default; Cloudflare acquired the Astro team in January 2026, and the host here is already Cloudflare Pages |

**Decision: Astro Starlight**, because the deciding requirement is embedding real components from
`src/` into explanation pages, and it is the only one of the three where that costs nothing. It also
keeps the docs bundle near zero on the pages that are pure prose, which is most of them. VitePress
remains the right answer for a Vue project; this is not one.

**If the embed requirement is dropped, the decision flips back to VitePress** — it is simpler and
faster, and every doc page becomes a link into the app instead. Decide this before writing pages,
not after: it is cheap now and a migration later.

**The blocker nobody would find until deploy day:** `public/_headers` sets
`frame-ancestors 'none'`. Any plan to `<iframe>` the live app inside a docs page is dead on arrival
under the project's own CSP. Three ways out, in order of preference:

1. **Import the components, not the app** (what Starlight buys). No iframe, no CSP change, and the
   demo is a real `BufferPoolPanel` fed a canned trace.
2. **Link out with a shareable URL** (§15/§17.2 already build this). Zero cost, zero risk, and the
   reader lands in the real app at the exact step — but they leave the page.
3. **Relax `frame-ancestors` to the docs origin only.** A real widening of the attack surface for a
   cosmetic gain. Only if 1 and 2 both fail.

**Hosting:** same Cloudflare Pages project, docs at `/docs`, so one deploy, one origin, one set of
headers, and relative links between app and docs never break. A `docs.querylens.dev` subdomain is a
DNS change later, not a decision now.

**Structure (Diátaxis).** The framework's four modes — tutorial (learn), how-to (do), reference
(look up), explanation (understand) — matter here for one reason above all: its central rule is
**never mix two modes on one page.** A tutorial that stops to explain B+Tree fan-out helps nobody.
This project is unusually prone to that mistake, because the subject matter is inherently
explanatory and the temptation to teach mid-instruction is constant.

| Section | Content | Audience | Diátaxis mode |
|---|---|---|---|
| **Getting Started** | 3 minutes: open → type → Run → step → what each panel shows. One outcome, no theory, no options | First-time users, students | Tutorial |
| **User Manual** | Task-shaped how-tos (§17.2) | Students using it as a study tool | How-to |
| **Concepts** | "What is a B+Tree?", "Why does a buffer pool exist?", "What does a planner decide?" — each illustrated by an embedded QueryLens component and honest about where the model diverges from Postgres and InnoDB | CS students, interview preppers | Explanation |
| **Reference** | Supported SQL subset, keyboard shortcuts, URL parameters, the step-event schema, engine limits (fan-out 3–4, 8 frames, coarse locks) | Anyone checking a fact | Reference |
| **Architecture** | Engine internals, the event model, how to add an operator or a stage. The README's architecture and decision-log sections move here verbatim | Contributors, forkers | Reference + Explanation |
| **FAQ** | "Is this a real database?", "Can I use this in my course?", "How accurate is it?", "Where is my data stored?", "Can I embed it?" | Instructors, sceptics | — |
| **Changelog** | Rendered from the root `CHANGELOG.md`, single source | Returning users | Reference |

**Write order, because a docs site is abandoned in the order it is written:** FAQ (shortest, highest
traffic, answers the question that decides whether anyone stays) → Getting Started → the Buffer Pool
and B+Tree manual pages → Reference → Concepts → Architecture last, because that content already
exists in the README and moving it is mechanical.

> **Status, session after v6.** The tool decision above shipped rather than stayed a decision:
> Astro Starlight is live at `/docs` on the same Cloudflare Pages project, built by its own
> isolated package (`docs/`, its own `pnpm-workspace.yaml` and lockfile — see the file for why:
> installing anything re-resolves the whole tree, and the app's 7-day `minimumReleaseAge` then
> rejects the install over packages the app itself had already pinned inside that window).
> `pnpm build:site` builds both; CI builds docs as its own step so a broken page fails the gate a
> broken app build would. Nine pages exist — the index, Getting Started, FAQ, both Concepts pages,
> and all four Reference pages — each fact in them checked against `src/` rather than written from
> memory (a first draft of the buffer-pool page claimed LRU and clock sweep evict *different*
> frames on a uniform scan; running it showed they pick the same one, which is what the page's own
> explanation says two paragraphs later — the draft had it backwards). The footer and header
> "Docs" links point at `/docs/` and an end-to-end test proves that URL and the docs build agree.
>
> Two things from this section remain open. The docs get their own type scale rather than
> inheriting the app's §16.1 tokens — deliberately, and `docs/src/styles/querylens.css` explains
> why — so if a future pass unifies them, start there. And the licensing formalization below
> (`LICENSE-DOCS`, the CC BY 4.0 footer notice) was not done alongside the site: it is its own
> P1 item with its own open questions (SPDX placement, the REUSE decision already recorded), and
> doing it partially to close this note felt worse than leaving it explicitly open.
>
> **Status update, v9 — the tool decision was reversed.** Commit `6eca5ac` removed the isolated
> `docs/` Astro package and rebuilt the nine pages as MDX/Markdown routes inside the app's own
> Vite build (`@mdx-js/rollup`, lazy-loaded into one `docs-*.js` chunk, rendered through
> `src/ui/DocsLayout.tsx`). The trade this section weighed still holds — Starlight is the better
> answer for a Vue-free docs *site* — but the embedding requirement won: a docs page can now
> `import` a real component from `src/` with no wrapper, one build, one origin, one header set,
> and `pnpm build:site`/the separate CI docs step are gone. What the migration did **not** finish,
> and was debt: ~~the pages render no visible `<h1>`~~, ~~in-content links still use Starlight's
> trailing-slash form~~, ~~`prose prose-invert` locking the docs to the dark palette~~ — all fixed
> in v11, along with two bugs the fix surfaced that had nothing to do with the original list: every
> `.md` page's imported components (`<Steps>`, `<Card>`) had been rendering as escaped text, not
> components, since this migration (`@mdx-js/rollup` compiles `.md` as plain CommonMark unless the
> extension is `.mdx` — now all nine are), and three reference pages' markdown tables rendered as
> literal pipe characters (`remark-gfm` was missing). Still open: the dropped `template: splash`/
> `hero` frontmatter (its content is now inline prose instead, which is the fix), and the five
> `^`-ranged MDX dependencies against §14.2's pin rule (`rehype-slug`, `remark-gfm` added in v11 are
> exactly pinned; the four inherited from `6eca5ac` are not, and remain migration debt).

### 17.2 User Manual detail

The manual is the part that turns a demo into something people return to. Its shape follows
Carroll's minimalist findings — readers learn faster from short, task-shaped chunks than from
comprehensive narrative, and a wall of text is abandoned rather than skimmed. So:

**The rules for every page:**

- **Titled by the task, not the component.** "Watch a page get evicted", not "The Buffer Pool
  Panel." The reader arrives with an intent, not a component name.
- **Under one screen.** If it does not fit, it is two tasks.
- **Starts at an action, not at background.** Theory lives in Concepts and is linked, not inlined.
- **Every screenshot annotated.** Annotated screenshots measurably beat prose for task completion;
  bare ones mostly add page weight.
- **Ends with a "try this" that changes one variable** — "switch LRU to clock sweep and re-run the
  same query: which frame dies now, and why is it a different one?"
- **Every page opens the app at the state it describes**, via the §15 shareable URL. A manual for an
  interactive tool that cannot put you inside the tool is a book about a bicycle.

**The pages:**

1. **Run your first query** — the 2-minute path, end to end.
2. **Follow one row from disk to result** — the spine of the whole product, crossing every stage
   once. If a reader reads one page, this is it.
3. **Watch a page get evicted** — and the companion: **compare LRU against clock sweep** on one
   access pattern. The §9 study tests this; the manual should teach it.
4. **Watch a B+Tree split** — copy-up at a leaf, push-up internally, and why using the wrong one
   yields a tree that looks right and returns wrong rows (§7.6).
5. **Make the planner change its mind** — edit a predicate, watch predicate pushdown fire or not.
6. **Edit the seed data** — add, edit, delete rows; what changes downstream and what does not.
7. **Predict before you look** — what prediction mode is, the evidence it rests on (RESEARCH.md),
   how to skip it when demonstrating to a room (the checkbox, `x=0`, or **presenter mode** —
   `?present=1` / the *Present* button — which suppresses it and enlarges the view, §22.5).
8. **Share a moment** — what the URL encodes, how to link to an exact step, and why a malformed URL
   drops the dataset rather than half-restoring it.
9. **Keyboard reference** — the full table; the in-app hints are a reminder, not a reference.
10. **When something goes wrong** — reading the error boundary, copying the repro, filing it.

**For instructors** — a short page of its own, because it is a different reader with a different
question: what the model does and does not claim, which stages map to which weeks of a 15-445-style
syllabus, how to link to a specific state from a slide, and the licence position on classroom use
(§17.3).

### 17.3 Licensing & legal

Current state: MIT `LICENSE`, `NOTICE` listing five production dependencies, `license: "MIT"` in
`package.json`. That is a correct and complete position **for the code**. Two things the project is
about to acquire are not code.

| Item | Position | Status |
|---|---|---|
| **Code** | MIT. Unchanged, and the right choice: an educational tool wants the fewest possible reasons for a student or an instructor to hesitate | Done |
| **Documentation and prose** | **CC BY 4.0**, declared in the docs site footer and in `LICENSE-DOCS`. MIT is a software licence; applying it to prose is a category error that leaves an instructor who wants to reproduce a manual page in courseware guessing. CC BY 4.0 is the permissive-with-attribution answer for non-software work, and dual-licensing code and docs separately is standard practice | [NEW] — P1 |
| **The bundled font** (§16.2 item 1) | JetBrains Mono is SIL OFL 1.1. Self-hosting means *distributing* it, which brings obligations MIT does not: ship `OFL.txt` alongside the font files, keep the copyright notice, and — the one that actually bites — **a subset is a modified version, so it must not carry the reserved font name.** Name subset files `querylens-mono-*.woff2`, not `jetbrains-mono-*.woff2`, and say what they are in `NOTICE`. Same analysis for the chosen text face before it is bundled | [NEW] — P0, lands with §16.2 item 1 |
| **`NOTICE`** | Extend to cover the fonts and to state the docs licence. Keep listing production dependencies only — a transitive dump helps nobody and rots immediately | Update |
| **SPDX identifiers** | Add `SPDX-License-Identifier` to `LICENSE`, `LICENSE-DOCS` and the font directory's README so machine tooling can read the split. **Not** per-source-file headers: the root licence covers `src/`, and 60 files each gaining a two-line header is noise that will drift | Partial — P2 |
| **Full REUSE compliance** | The FSFE REUSE spec (every file individually licensed, machine-verifiable via `reuse lint`) is the rigorous end of this. Worth it for a project vendoring code from several sources; overkill for one with a uniform `src/` and a handful of vendored assets. Revisit if third-party code ever lands inside `src/` | Decided: not now |
| **Third-party disclosure page** | `pnpm licenses list --prod` output rendered on a docs page, for anyone embedding QueryLens in courseware and needing to answer procurement | P2 — docs site |
| **Per-file headers in `src/`** | Not doing. The root LICENSE covers everything | Decided: not doing |

**The instructor question, answered explicitly somewhere a search can find it** — MIT plus CC BY 4.0
means: use it in a course, fork it, screenshot it, put it behind a university login, translate it.
Attribution is the only ask. Saying this in the FAQ in plain words is worth more than either licence
file, because the person who needs it will not read either.

### 17.4 Definition of done

- [x] The docs framework decision is recorded with its embedding requirement, and the site builds
      and deploys at `/docs` on the same Cloudflare Pages project. *Already done (v6, tool decision
      reversed at v9, commit `6eca5ac` — see §17.1's status notes) — the docs are now MDX routes
      inside the app's own Vite build (`src/App.tsx`'s `docs` route, `src/ui/DocsLayout.tsx`), so
      one `pnpm build` and one Cloudflare Pages project cover both; verified `/docs`,
      `/docs/getting-started`, and `/docs/faq` all render correctly from a real build.*
- [x] FAQ answers "Is this a real database?", "Where is my data stored?", and "Can I use this in my
      course?" *Already done (v6) — all three are `##` sections in `faq.mdx` with direct answers;
      confirmed live at `/docs/faq`.*
- [x] Getting Started exists and a first-time user completes it without opening the README.
      *Already done (v6) — `getting-started.mdx` is a self-contained walkthrough (open the app →
      read the pipeline tracker → step → play → try the scan-vs-index contrast → predict-then-reveal)
      with no README reference; confirmed live at `/docs/getting-started`.*
- [x] The two manual pages the §9 study depends on — eviction and B+Tree split — exist, each with
      ~~annotated screenshots~~, a "try this", and a link that opens the app at that state. **Done —
      see the status note below the checklist for why screenshots were dropped.**
- [x] At least one Concepts page embeds a real component from `src/` rather than a screenshot (or
      the embed requirement is explicitly dropped and the tool choice revisited with it). **Done,
      v18** — both Concepts pages do: `concepts/btree.mdx` embeds `BTreeMiniDemo`, a live `search()`
      over the exact `BTreePanel` `/tools/btree` uses; `concepts/buffer-pool.mdx` embeds
      `BufferPoolMiniDemo`, the exact `BufferPoolPanel` with its own LRU/clock-sweep toggle.
- [x] `LICENSE-DOCS` exists (CC BY 4.0) and the docs footer states it. **Done, v16** — the footer
      already carried a "CC BY 4.0 docs" badge; it just had nothing to link to until now (`Footer.tsx`'s
      Project column gained a "Docs licence" link alongside the existing MIT "Licence" one).
- [x] `OFL.txt` ships with the font files, subset files are renamed off the reserved font name, and
      `NOTICE` covers both fonts. *Already done (v13/v14) — `public/fonts/querylens-{mono,sans}-OFL.txt`,
      both renamed off their reserved names, `NOTICE` covers both.*
- [ ] No docs page mixes two Diátaxis modes. *Audited all eleven pages against a live build. Nine
      are clean. Two pairs still mix: both Manual pages carry a paragraph-length mechanism
      explanation after their steps — `manual/eviction.mdx`'s "Where they actually disagree" and
      `manual/btree-split.mdx`'s "Why the two rules can't swap" — which is exactly the theory
      §17.2's own rule says "lives in Concepts and is linked, not inlined"; and both Concepts pages
      (`concepts/btree.mdx`, `concepts/buffer-pool.mdx`) carry a "Try this" section giving explicit
      run-this-query, step-through instructions, which is How-to content inside an Explanation page.
      (Architecture's Reference-plus-Explanation blend is §17.1's own deliberate classification, not
      counted here.) Leaving unchecked rather than deciding unilaterally whether that's worth
      rewriting or accepting as the project's house style.

> **Status, v15.** The two manual pages shipped: `/docs/manual/eviction` ("Watch a page get evicted")
> and `/docs/manual/btree-split` ("Watch a B+Tree split"), a new **Manual** nav group between
> Introduction and Concepts in `docsNav.ts`. Both follow §17.2's rules — task-titled, start at an
> action, end with a "try this" that changes exactly one variable — with one deliberate deviation:
> **no screenshots.** Getting Started already established the pattern this project actually uses for
> an interactive tool — a live shareable-URL link the reader opens and drives themselves — and a
> static image of a thing whose entire point is stepping through it would be the weaker teaching aid,
> not a stronger one. Every link and every stated outcome (which frame gets evicted, which keys land
> in which node after a split) was verified against the running app, not written from memory.
>
> The eviction page's "compare LRU against clock sweep" companion needed a real divergence, and the
> pipeline's own sequential-scan link (already cited in `concepts/buffer-pool.mdx`) doesn't provide
> one — on a uniform scan the two policies agree, which is the honest fact that page already states.
> The [buffer-pool sandbox](https://query-lens.pages.dev/tools/buffer-pool)'s `ref`/`frames`/`policy`
> URL state — built exactly for this, per its own doc comment — does: the skewed reference string
> `0 1 2 0 0 0 3 4 5` at 3 frames already existed as a property test
> (`storage.test.ts`, "disagree once one page is hot"); running it live confirmed LRU evicts the hot
> page (0) while clock sweep keeps it resident, a "try this" that is a single dropdown change, not a
> new query to construct.
>
> The B+Tree page's two split demos are similarly exact rather than illustrative: `keys=1,2,3&fanout=3`
> then inserting `4` triggers the leaf split (copy-up, verified against `btree.ts`'s own
> `splitLeaf`); `keys=1,2,3,4,5,6,7,8,9&fanout=3` then inserting `10` triggers the cascading root
> split (push-up, verified against `insertIntoParent`) — both confirmed live rather than hand-traced,
> since an off-by-one in a manually simulated split is exactly the kind of error this section warns
> against shipping.

---

## 18. Community & Governance

> Added in v5; **status updated in v6.** A public repository with no CONTRIBUTING.md, no Code of
> Conduct and no issue templates says "I have not thought about other people using this." These
> files are the difference between "someone's project" and "a project someone can join."

**Status: the P0 and P1 files all exist.** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
`CHANGELOG.md`, both issue-template forms and the PR template are written, and the README carries
badges and links to all of them. What remains in this section is P2 and the README restructure,
which is blocked on the docs site (§17.1) having somewhere to put the content.

### 18.1 Repository governance files

| File | Content | Status |
|---|---|---|
| `CONTRIBUTING.md` | fork → clone → `pnpm install` → `pnpm dev` → change → `pnpm test` → PR. Code style (ESLint enforces it), Conventional Commits, architecture boundaries (`src/engine/` is pure, `src/ui/` renders), the release-age floor caveat | Done |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1, linked from CONTRIBUTING and README | Done |
| `SECURITY.md` | Scope ("client-side only, no server, no auth, no user data, no secrets"), reporting via GitHub Security Advisories, 48h/7d/14d SLA, proactive measures | Done |
| `CHANGELOG.md` | Keep a Changelog format, v0.1.0 baseline | Done |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Structured form: description, repro, error-boundary output, expected, browser, OS, "I searched existing issues" | Done |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Problem, proposal, pipeline area, alternatives, "I checked plan.md" | Done |
| `.github/PULL_REQUEST_TEMPLATE.md` | Description, issue, type, testing, screenshots for visual changes, checklist | Done |
| `.github/ISSUE_TEMPLATE/config.yml` | Point "Question" at GitHub Discussions rather than Issues, so the tracker stays a tracker | P2 — [NEW] |
| `.github/FUNDING.yml` | Only if the project acquires active users | P2 |
| `CITATION.cff` | GitHub renders a "Cite this repository" button from it. Cheap, and this is a teaching tool with a plausible path into a syllabus or a paper's reference list | P2 — [NEW] |

### 18.2 Social presence

**Still deferred, and deliberately.** There is no public URL to promote. When there is:

- **A written launch post first, socials second.** The distributable artefact is a post that explains
  one thing well — the LRU/clock-sweep contrast, or the copy-up/push-up split rule — with a GIF and
  a link that opens the app at that exact step. Everything else is a pointer to it
- **Twitter/X and Bluesky** — cross-posted. The DB/systems audience is on both, and animation GIFs
  are this product's natural format
- **GitHub Discussions** — enable at launch. Lower barrier than Discord, lives with the code, and is
  indexed by search engines, which a Discord is not
- **Reddit** — r/programming, r/compsci, r/databasedevelopment. No subreddit until >50 active users
- **Hacker News** — one shot; it goes with the written post, not before it
- **Discord** — premature. A dead Discord is worse than none
- **YouTube** — high value, real production cost. After the §9 study validates the format

### 18.3 README badges

Done — CI, licence, TypeScript version and PRs-welcome are at the top of the README. Remaining
refinement: normalise all four to `style=flat-square` so they read as one row rather than four
imports, and drop any badge that would ever show a stale or misleading value.

### 18.4 README restructure

**Done, v20.** 682 lines → 82. Badges, a three-sentence pitch, the links row, **Learn more**
(pointing at the in-app docs, `plan.md`, `RESEARCH.md`), **Status**, **Commands**, **Deploying**,
**Testing** — the README is a front door now, not a decision log.

Two things this shipped differently from the target shape sketched below, both because the
missing piece doesn't exist yet rather than being dropped: no GIF (nothing currently generates one
into the repo — `pnpm record` produces a file, not a committed asset) and no "Try it" live link
(no canonical deployed URL is recorded anywhere in the repo to link to honestly). **Acknowledgments**
was dropped outright — there was no actual content to put there, and an empty section header is
worse than none.

The decision-log content that moved out — architecture, the optimizer, storage, the B+Tree,
execution, locks — did **not** move verbatim as originally planned below. Verbatim would have
copied the README's own v0-era description forward: by the time this shipped, the README's "two
optimizer rules" was six, its SQL grammar excluded `JOIN`/`GROUP BY`/writes/`<=`/`>=`/`BETWEEN` that
had shipped versions ago, and it still described a separate `docs/` Astro package and
`pnpm build:site`, both removed in v9. Rather than move known-stale prose into the docs site and
call it done, the new [Architecture](src/pages/DocsContent/architecture.mdx) page was written fresh,
verified against `src/` as it stands today — and the same staleness turned out to affect two
Reference pages that predated this session entirely: **[Supported SQL](src/pages/DocsContent/reference/sql.mdx)**
still said "QueryLens only runs SELECT" and rejected `<=`/`>=`, and **[Engine limits](src/pages/DocsContent/reference/limits.mdx)**
still said "no aggregates, no GROUP BY, no joins, no writes" — both rewritten to match the engine
as it actually runs now. The original decision-log entries themselves aren't lost: this file
already narrates every one of those decisions, in more detail and kept current, which is what the
new Architecture page links to for the *why* behind anything it states as fact.

Original target shape, for the record — largely followed, with the deviations above:

1. Title, badges, one-line description
2. A GIF, not a screenshot — the product is motion, and a still cannot show a page being evicted
3. **What is this?** — three sentences
4. **Try it** — the live link, above every other link
5. **Features** — 8–10 one-line bullets
6. **Quick start (developers)** — clone, install, dev, test
7. **Documentation** — the docs site
8. **Contributing**, **Licence** (code MIT, docs CC BY 4.0), **Acknowledgments**

### 18.5 Definition of done

- [x] `CONTRIBUTING.md` exists and is linked from the README.
- [x] `CODE_OF_CONDUCT.md` exists with the Contributor Covenant v2.1.
- [x] `SECURITY.md` exists with reporting instructions and scope statement.
- [x] `CHANGELOG.md` exists with v0.1.0 as the baseline.
- [x] `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` exist.
- [x] `.github/PULL_REQUEST_TEMPLATE.md` exists.
- [x] README has badges at the top.
- [x] README links to CONTRIBUTING.md, CODE_OF_CONDUCT.md, and SECURITY.md.
- [x] GitHub Discussions is enabled and `ISSUE_TEMPLATE/config.yml` routes questions there. **Done**
      — `.github/ISSUE_TEMPLATE/config.yml` routes to Discussions with `blank_issues_enabled: false`;
      Discussions itself enabled by the repo owner in Settings → General → Features (unverified here
      — the repo returns 404 to an unauthenticated API check, and no `gh`/API credential is available
      in this sandbox to confirm directly).
- [x] README restructured to user-facing format, under 120 lines (blocked on §17.1). **Done, v20**
      — see §18.4's own status note for what shipped and what was deliberately deferred (a GIF, a
      live "Try it" link, Acknowledgments).

---

## 19. The Landing Page — the first fifteen seconds

> New in v6. v5 treated the landing page as one row in a docs-site table, and `index.html` treats
> the Open Graph card as the landing page. Neither is enough: the OG card is what convinces someone
> to click, and this section is about what happens in the fifteen seconds after they do.

**The decision that has to come first: is the landing page a separate page, or is the app the
landing page?**

For most products the answer is a separate marketing page. For this one it is not, and the reasoning
is worth writing down rather than re-deriving later. QueryLens is comprehensible in about four
seconds of watching — a query moves through stages and things light up. A marketing page describing
that is strictly worse than the thing itself, and it puts a click between the visitor and the
product for no gain. The published guidance for developer-tool pages says the same thing from the
other direction: make the tool testable in the hero, put the demo above the fold, and replace "book
a demo" with "try it".

**Decision: the app at `/` is the landing page.** §15 already did most of the work — a trace runs on
load, so the first paint is the product mid-explanation rather than an empty editor. What is missing
is the framing around it that answers *what is this and why should I care* without a single click,
and without stealing space from the app for returning visitors.

This decision constrains §21: the app is a multi-page application, but the Playground is the hub and
stays the first thing a cold visitor sees. The other routes are for the returning visitor and the
instructor, and the top nav that leads to them has to stay quiet enough not to pull a first-timer
off the running trace.

### 19.1 What the first screen must do

Five jobs, in priority order. Each has a failure mode that is specific and observable.

| # | Job | How | Fails as |
|---|---|---|---|
| 1 | **Say what this is in one line, in the visitor's words** | A tagline in the header beside the wordmark: *"Watch a SQL query become a B+Tree traversal."* Concrete nouns. Not "Build faster. Ship smarter." — weightless headline copy is itself one of the published tells of a generated page | "A database internals visualizer" — true, and it says nothing a title tag did not |
| 2 | **Prove it, without a click** | Already true: the trace runs on load. Protect it. The first paint must never be an empty editor, a modal, or a cookie banner (there are no cookies, so there is no banner — a real advantage, and worth stating in the FAQ) | A hero that describes the product sitting above the product |
| 3 | **Make the next action obvious** | One primary action — the SQL editor with a caret in it and a query already there. Everything else (theme, share, docs, data editor) is secondary and looks it | Five buttons of equal weight; the visitor picks none |
| 4 | **Establish honesty immediately** | The disclaimer bar already does this, at the top, unmissable. It is a trust asset, not a compliance cost — an educational tool that states its own limits is more credible, not less | Burying it in a footer, where §12's misconception risk goes unaddressed |
| 5 | **Offer the way deeper without cluttering** | The §16.2 footer: Docs · GitHub · Licence · Changelog · build SHA. Below the fold, findable, quiet | Docs links that never appear, so nobody reads the manual §17 spent a fortnight writing |

### 19.2 First-visit affordances — P1, after the P0 above

- **A first-visit-only strip**, one line under the header, dismissed permanently to `localStorage`:
  *"New here? Press Space to step through the trace, or take the 60-second tour."* Returning visitors
  never see it. First visitors get a route that does not require reading anything
- **The 60-second tour** — 5–6 sequential highlights over the real UI, driven by the real trace, not
  a video and not a modal carousel. Skippable at any point, never auto-replayed, and it must respect
  `prefers-reduced-motion` by degrading to a static numbered overlay
- **Three preset queries as chips** above the editor — *point lookup*, *sequential scan*, *the same
  query with the index dropped*. One click each, and the third is the §9 contrast the whole product
  is built to show. A blank editor asks a visitor to invent a query before they know what the tool
  does with one
- **A "what am I looking at?" affordance on every panel** — a small `?` opening a two-sentence
  explanation and a link to the Concepts page. This is the seam between §19 and §17 and the most
  likely path from app to docs

### 19.3 The shareable card is still the real landing page

Most visitors will decide from the link preview before the page loads. `index.html` gets this right
already — absolute URLs, 1200×630 image, alt text, a title that is a sentence rather than a product
name. Two items remain:

- **The OG image is a static PNG of the buffer pool mid-eviction. Regenerate it from a real trace
  whenever the visual design changes** (§16), or it becomes a picture of an app that no longer
  exists — the most quietly embarrassing failure mode available
- **Verify the card in the wild** once the URL is live: X, Slack, Discord, LinkedIn, iMessage.
  §14.6 already holds this check open

### 19.4 Definition of done

**P0 complete. All four of §19.2's P1 items shipped (v13): the preset query chips, the first-visit
hint, the panel `?` affordance, and the 60-second tour.**

- [x] The first paint on a cold load shows a completed trace, a tagline, and ~~a focused editor~~ — no
      modal, no banner, no empty state. *Protecting this turned up two real defects, both fixed.*

      *One: the diagram arrived unframed in the panel's corner on some cold loads, and always when
      the page loaded into a **background tab** — how a link posted to HN or Reddit is routinely
      opened. React Flow animates a viewport move with a d3-zoom transition, d3-timer drives those
      off `requestAnimationFrame`, and a tab that is not painting never fires one, so the move was
      created, never ticked, and never retried. The first framing is now unconditionally instant —
      which §16.1 constraint 5 wanted anyway, since nothing should animate on load for decoration —
      and no framing animates while the tab is hidden.*

      *Two, found while reviewing a second independent fix for the first: the framing was measuring
      the pane through React Flow's store, which does `width: size.width || 500`. A container it has
      measured at zero is therefore indistinguishable from one genuinely 500px wide, and framing
      against that invented number centres the tree on a point that does not exist. `FlowTree` now
      measures its own pane with a `ResizeObserver` and computes the transform itself via
      `setViewport`, so the number is either real or zero. The 60ms timeout that raced React Flow's
      mount is gone with it: the framing effect now depends on the `panZoom` instance, which also
      makes it re-frame if that instance is rebuilt.*

      *Three e2e regression tests cover it — the symptom across repeated cold loads, the cause with
      animation frames held, and the hidden-tab re-frame — each verified to fail against the code it
      replaces.* **Departure: the editor is deliberately not focused.** §15
      binds Space to play/pause, so a caret in the editor on load would turn the app's primary
      interaction into typing a space — and §19.2's own first-visit hint is *"Press Space to step
      through the trace"*. On a phone it would also raise the keyboard over the trace, against §15.2's
      read-first model. The editor still reads as the primary input without holding focus; this
      checkbox and §15's keyboard model cannot both be satisfied, and §15's is load-bearing.
- [x] A visitor who does nothing but read the first screen can say what QueryLens does. *The tagline
      is now "Watch a SQL query become a B+Tree traversal." — the previous line, "see what your SQL
      actually does", was the failure mode §19.1 names: true, and saying nothing the title tag did not.*
- [x] Exactly one element on the first screen reads as the primary action.
- [x] Preset query chips exist and the third demonstrates the §9 index/no-index contrast. — §19.2, P1
      *`PRESETS` above the `SqlEditor` in `PlaygroundPage`: point lookup, sequential scan, and a
      lookup on a **non-indexed** column — the same equality shape as the first, but no index to use,
      which is the §9 contrast. One click loads and runs. The literal "same query, index dropped"
      form (an index-off toggle) is `/compare`'s index-vs-scan mode, kept there.*
- [x] First-visit hint appears once, is dismissible, and never returns. — §19.2, P1
      *`FirstVisitHint` under the header, mounted by `Layout` only for a bare `/playground` — a
      shared-moment link (`?q=…`) is someone else's onboarding, not a cold first visit. It retires
      itself on mount (a reload never brings it back) and the Dismiss button removes it mid-session;
      both write `querylens:seen-hint`. One quiet accent-tinted line, the completed trace fully
      visible below it — the "no banner on first paint" of item 1 is about marketing chrome standing
      in front of the product, and §19.2 mandates this strip by name. The copy is the keyboard route
      into the trace (`Space`, then the arrows) and a **Take the 60-second tour** link. Touch devices
      get a pointer-appropriate line instead.*
- [x] Every Playground panel has a "what am I looking at?" affordance — a `?` opening a two-sentence
      explanation and a link onward. — §19.2, P1
      *A disclosure in `StageDetail`, shown only when the Playground passes `withHelp` (not on
      `/stages/:id`, which is already the explainer, nor in the room-facing presenter view). The
      two-sentence text and the concept link are a new `help` / `doc` pair per stage in `stageMeta`;
      six stages point at their `/stages/:id` page and the buffer pool and index point at their
      `/docs/concepts/*` page — the only two stages with a dedicated docs concept. Consolidating the
      text there also let the near-duplicate `STAGE_DESCRIPTIONS` on the `/stages` index be deleted.
      The `?` covers all eight stages through the one panel container; the `/tools/*` sandboxes carry
      their own `PageHeader` description and are out of scope for this item.*
- [x] The tour is skippable, reduced-motion-safe, and never auto-replays. — §19.2, P1
      *`PlaygroundTour`, five sequential spotlights over the real Playground — editor, pipeline rail,
      stage panel, narration, transport — found by `data-tour` attributes, so the component holds no
      reference to that page's state. A dim ground with the box-shadow cut-out on one region at a
      time and a caption pinned to whichever viewport edge is clear of it; Skip and Esc leave at any
      point, `←/→` walk it (playback shortcuts suspend while it is open, as they do for the data
      modal). It never auto-starts — only the first-visit hint's link, the **Tour** link by
      *Present*, or `?tour=1` (a course link, or the hint's hand-off when its chunk beat the
      Playground's — a `sessionStorage` one-shot backs the window event). `prefers-reduced-motion`
      swaps the whole thing for `StaticTour`: one panel, the five captions as a numbered list, a
      **Got it** button, no stepping and no moving spotlight — §19.2's required fallback.*
- [x] The OG image is regenerated after the §16 visual pass ~~and verified on at least three
      platforms~~. *Regenerated by `pnpm og` (`scripts/build-og.ts`), which drives the built app to
      step 91 of the sequential scan — the first eviction — through the app's own shareable-URL
      format and screenshots it, so the card cannot drift from the design again without someone
      choosing not to re-run it. The alt text was already stale: it said "four frames" through a
      change that made it eight. **Verification on three platforms stays open until the URL is
      live**, alongside §14.6's two other held-open checks.*

---

## 20. Spin-offs, Exports & Adjacent Tools

> New in v7. A dozen feature and spin-off ideas arrived as a list across four audiences —
> slide-makers, CS-course instructors for three different courses, EdTech graders, and DBAs. This
> section is that list, **counted against `src/` rather than against the architecture diagram**,
> sequenced, and — for most of it — deferred with a named trigger rather than a maybe. The reason
> for the deference is §12's first risk: the project is solo and part-time, the §9 study that
> decides whether the core teaching format works has not been run, and adding four audiences before
> validating one is scope creep with a plan stapled to it. What survives into a milestone is the
> subset that costs a week, needs no server, and builds the §18.2 launch post — that is §10's M12.

### 20.1 The filter, and the architecture reality-check

Every item below is scored on four questions before it is scheduled at all:

1. **Does it serve the §9 study?** — the only experiment in the plan. An item that hands the study a
   cleaner instrument or a tighter control jumps the queue.
2. **Does it serve the §18.2 launch?** — the launch post is a GIF and a link that opens the app at
   one step. An item that produces that artefact is worth building *before* launch, not after.
3. **Does it need a backend, or break "nothing leaves your browser"?** — §14.4 and the FAQ both sell
   the zero-telemetry position as a feature, not an absence. Anything that needs a server, or
   collects a keystroke from a third party, is a different product with a different privacy
   statement — not a feature flag.
4. **Does it fork the audience?** — the audience (§3) is a learner. A DBA debugging a production
   plan is not that person, wants different things, and is served by a different competitive set.

**What "the engine is decoupled from the UI" actually buys, and what it does not.** The claim is
true — `src/engine/` is pure, synchronous, React-free and returns a serialisable `StepEvent[]`, and
`src/ui/` is a fold over that array. Four things the framing tends to assume, which a count of `src/`
does not support:

| Assumption | What `src/` shows | Where that puts the cost |
|---|---|---|
| "The diagrams are SVG you can lift out" | Every panel is Tailwind **HTML**. `FlowTree` (AST, plan, B+Tree) is flowinger (formerly React Flow), whose nodes are absolutely-positioned `<div>`s — only the *edges* are SVG | A clean vector export is a **new renderer**, not `.outerHTML`. §20.3 |
| "Spin a stage out as a standalone tool" | Every panel today is driven by `runQuery(sql, db)` → `events[]` → `projector.at(step)`. There is **no path** to drive a panel from a hand-authored operation sequence (`insert(15)`, a page-reference string) | Each standalone needs a non-SQL driver that emits the same events. §20.2, §20.4 |
| "Embed the app in a blog with an `<iframe>`" | `public/_headers` sets `frame-ancestors 'none'`, deliberately (§14.3, §17.1) | The literal iframe is dead on arrival under the project's own CSP. §20.3 |
| "Watch the B+Tree rebalance on delete" | ~~`src/engine/index/` exports `insert`, `search`, `descend`, `height` — **no delete**~~ **Done, v12.** `deleteKey` handles underflow (borrow / merge), root-collapse and the separator rewrite, with the property tests §7.6 demands (`btreeDelete.test.ts`). Drives `/tools/btree` | — |

None of these kills an idea. They move where the work is.

### 20.2 Three shared primitives

Most of the list collapses onto three pieces of infrastructure. Building these once, well, is the
optimisation — the alternative is five half-versions of each, one per feature.

1. **`src/export/` — a pure module, on the same rules as `src/engine/`.** `toMermaid(tree)` and
   `renderSvg(view, state)` as pure functions: no DOM, fully unit-testable, mirroring the engine
   boundary the project already enforces. Consumed by in-app buttons, by `scripts/` (the OG card and
   the §20.3 recordings), and by the docs build. `scripts/build-og.ts` is the proof this pays off —
   it already drives the built app headlessly; a shared renderer is what stops the button and the
   script from drifting apart.
2. **A non-SQL `StepEvent` driver.** A thin adapter that takes a command sequence and calls the
   engine's own primitives (`insert`, `pool.pin`, …) while threading the same `emit` the SQL path
   uses — so the existing panels and the existing fold render it unchanged. This is the seam every
   standalone in §20.4 needs. Roughly a day, plus B+Tree delete if the DSA module is in scope.
3. **A single-panel page with a chrome level.** `src/pages/StagePage.tsx` is already 60% of this: it
   mounts one `StageDetail` in isolation over a demo state. Generalise it to
   `<PanelPage panel driver chrome="minimal | full" />`. This is what a standalone renders through,
   what an embed serves, and what an assignment link opens.

The fourth backbone already exists: the shareable URL (`src/ui/urlState.ts`). It is the input format
for recordings, the transport for assignment links, and the "open the app here" target of every
export.

### 20.3 Presentation & content export (slide-makers, technical writers)

| Item | Verdict | Cost against this codebase | What a generic version gets wrong |
|---|---|---|---|
| **Copy as Mermaid** (AST, plan) | **Done — v12** | `src/export/toMermaid.ts` + a button in `StageDetail`'s header. The B+Tree is deliberately left out — Mermaid lays out a sibling chain badly | Including the B+Tree — Mermaid lays out a B+Tree with a sibling chain badly. AST and plan are where PR-and-Notion pasting actually happens |
| **PNG export of any panel** | **Done — v12** | `html-to-image@1.11.13`, lazy `import()`ed; a `Download PNG` button in the `StageDetail` header on every implemented stage. Font inlining and `oklch()` verified working in Chromium; Safari's known `foreignObject` bugs are documented in the FAQ, not fought | Assuming it is caveat-free — the self-hosted woff2 has to be inlined into the capture, and `oklch()` fills need a renderer that rasterises through `foreignObject`. Test in Safari, where that path has known bugs |
| ~~**True vector SVG export** (papers, slides)~~ **Done, v14.** `src/ui/renderSvg.ts` — a dedicated renderer emitting real `<rect>`/`<text>`/`<path>` from the *same* d3-hierarchy layout `FlowTree`'s own `build()` already computes (`nodeSize`, the same tree/row spacing), so an export matches what was on screen. Deliberately never touches the DOM for geometry: every label/detail line in the app is already `font-mono`, so a fixed monospace character-width estimate (`wrapMonospace`) wraps text correctly with no text measurement at all. Colour is the one place this can't stay fully pure — `resolveTone` reuses each tree's *existing* `tones` map verbatim (no second colour table to drift out of sync — an anti-drift test imports the three real maps and asserts every entry classifies) by recognising the app's own two Tailwind conventions (`hue-<name>` design tokens, or `[var(--color-<name>)]` naming one directly) and resolving them through an injected `resolveColor` callback, which keeps the layout/wrapping pure and unit-testable. The real, browser-backed resolver (`resolveCssColor`) is a two-step pipeline, not one: a throwaway element's computed `color` resolves any `var()`/`color-mix()` reference — the only step that can, since those need a real cascade — and then a 1×1 canvas *rasterises* that value to concrete 8-bit RGBA, because current Chrome's `getComputedStyle` now **preserves** `oklch()`/`oklab()` rather than normalising to `rgb()` the way it used to; skipping the rasterisation step would have reproduced the exact "imports inconsistently" problem this feature exists to fix, just via an unsupported colour function instead of `foreignObject` — caught by inspecting an actual downloaded file in the browser, not by any unit test. `AstTree`/`PlanTree`/`BTreePanel` each had their `TONES`/`toFlow`/`ICONS` moved into a sibling data file (`astTreeTones.ts`/`planTreeTones.ts`/`btreeTones.ts`) — Fast Refresh only works on a file that exports nothing but components, so `StageDetail.tsx` (which renders the new **Download SVG** button beside **Download PNG**) imports the data directly rather than duplicating it. 18 new unit tests, 1 e2e (all three trees, checked for zero `oklch`/`oklab` in the output) | ~2–3 days. A dedicated `renderSvg` emitting real `<rect>/<text>/<path>` from the d3 layout `FlowTree` already computes — the grid and lock rows are trivial; the three trees share one renderer because they share `FlowNode` | `html-to-image`'s `toSvg` produces HTML wrapped in `<foreignObject>`, which Illustrator, Inkscape and PowerPoint all import inconsistently. That is not "a high-quality SVG" — it is a screenshot with extra steps |
| **Animation export (GIF/WebM)** | **Done, v13 — a script, not a button.** `pnpm record "<link|q=…>" --from N --to M` (`scripts/record.ts`), Playwright frame-stepping the built app and muxing with ffmpeg (`$FFMPEG_PATH` → `PATH` → Playwright's bundled copy; GIF needs a full ffmpeg, WebM does not) | Doing it in-browser: a GIF encoder is ~40 kB of bundle for a feature used monthly, 256 colours wreck the OKLCH palette and the anti-aliased type, and a 131-step scan takes 20–30 s to encode client-side. The script gets the real fonts and colours, and it *is* the §18.2 launch artefact |
| **Interactive embeds (iframes)** | **v1+, gated on demand** | The URL is already the embed: an author links "scrub through this trace" and it opens the real app at the step. A true in-page embed is either a CSP-relaxed `/embed` entry — safe *here* only because the app has no auth, no actions and no secrets to clickjack — or a published `@querylens/embed` component package. Both are real work; neither is warranted before someone asks | Treating `frame-ancestors 'none'` as an oversight. It is a decision (§14.3); relaxing it globally to make a blog embed work trades the project's cleanest security property for a cosmetic gain |

M12 takes the three that need no backend and no engine change and that produce the launch artefacts
§18.2 already calls for. The other two wait.

### 20.4 Standalone educational modules (DSA, OS, compilers courses)

All three render through primitives §20.2 #2 and #3, and all three live at `/tools/*` on the **same
deploy** — one origin, one header set, per the §17.1 precedent — not on separate domains. §21.3
gives them their routes and their URL-state schemas; §21.5's SPA rewrite (M13) is a prerequisite
for any of them being linkable.

- **Buffer Pool as an OS-course tool — the strongest candidate, v1.** It needs no missing engine
  feature: the pool already runs LRU and clock and emits `hit/load/miss/evict/sweep`. "A mock stream
  of page requests" is an array of page IDs fed to `pool.pin` in a loop — a ~40-line driver. It
  fills a real gap (LRU vs clock is a notoriously hard lecture), and it *is* §9's contrast, so it
  doubles as a tighter study instrument than the whole pipeline. **Done, v10; v12 added the four
  policies this called for** — FIFO, second-chance, Bélády-optimal, and §7.5's promised InnoDB
  midpoint-LRU — each a per-file addition behind the `ReplacementPolicy` interface (`onLoad` was
  added to it for midpoint, so a load can insert at the old sublist rather than the young one).
- **B+Tree as a DSA-course tool — done, v12.** The visualisation, the animated traversal and the
  display transformer already existed; the missing half was B+Tree **deletion**, which
  `src/engine/index/btree.ts` now has — `deleteKey`: leaf and internal underflow (borrow-from-
  sibling, then merge), root-collapse, and a separator rewrite up the descent path, with the
  property-based tests §7.6 mandates (`btreeDelete.test.ts`, `validate` clean after every op vs. a
  `Set` oracle). The UI around it was small as predicted: a number pad, the tree re-rendered whole
  through the Playground's `BTreePanel`, a fan-out slider, `deleteKey`'s step log narrated, the
  invariants shown as a badge. Stepping the restructure itself (new `index` event kinds) is a later
  addition.
- **Parser as a compilers-course tool — done, v12.** The playground already showed the
  recursive-descent parse building an AST live with error squiggles. The new surface was the
  **token ribbon**: `tokenize` re-exported from `src/engine/index.ts`, rendered as colour-coded
  chips, with recursion depth and both tokenize- and parse-error messages. The parser's cursor
  *within* the ribbon (a couple of new event kinds) is the same later addition the B+Tree tool's
  restructure-stepping is.

### 20.5 Instructor & assessment tools (EdTech)

This category splits cleanly on question 3 of the §20.1 filter.

- **Assignment *links* — no backend, v1.** The shareable URL already encodes the seed data, the
  query and the step; prediction prompts are engine-generated, so "predict what happens at step 13"
  is already `?s=13&x=1`. What is missing is a thin authoring surface — set rows, set query, pick
  the step, get a link — and an "assignment mode" flag that withholds the reveal and the explanation
  until the learner commits. This stays entirely client-side and keeps every promise the FAQ makes.
- **Graded submission — its own plan, post-v1, gated on §9.** "Answers are scored and submitted back
  to the instructor" is the **first backend in the entire plan**: a store keyed by assignment and
  student, a results view, therefore an identity notion (a class code at least), plus student
  answers at rest — which is personal data, which is a consent surface, a privacy policy, and
  possibly FERPA. It reverses §14.4's "nothing leaves your browser" for those users. That can be a
  deliberate choice, but the mitigation has to be structural: a **separate opt-in surface**
  (`/classroom`, or its own subdomain) with its own privacy statement, so the core tool keeps its
  position. And it is premature until the §9 study says the format teaches — grading a format that
  does not is effort spent upside-down. This is the moment §14.3 anticipated, where `connect-src` in
  `_headers` stops being `'self'` and the change shows up as a diff.

### 20.6 Developer tooling — the DBA track

**This category collides with a Non-Goal, and writing that down is the point.** §2 lists "Production
query debugging / APM use case" as out of scope, possibly forever.

- **Visual `EXPLAIN` viewer — its own product, its own plan.** Pasting a real
  `EXPLAIN (FORMAT JSON)` and drawing it is *not* APM: no live connection, no agent, no metric over
  time. It is a plan pretty-printer. But it forks the audience (question 4) — the reader is now a
  DBA, and the competitive set is `explain.dalibo.com` and `pev2`, not a textbook — and the code
  saving is narrow: `FlowTree` would render a `FlowNode`, but a Postgres plan node carries ~40
  fields, MySQL's format is unrelated, and "highlight the bottleneck" is a heuristic engine of its
  own (row-estimate error, seq scan on a large relation, sort spilling to disk). `src/engine/` is
  untouched by any of it. If it is pursued it is `querylens-explain`, sharing the design system and
  the `FlowTree` component through the §16.4 `tokens.json` and component-gallery path — not this
  engine and not this plan. Recorded here so "we kept it separate" reads as a decision, not an
  omission.
- **Standalone SQL linter/formatter — declined.** The parser is a deliberate v0 subset (§4): one
  table, `=` / `<` / `>` / `AND`, one join as a stretch goal. A formatter people would actually use
  has to handle the SQL they write — CTEs, window functions, subqueries, `GROUP BY`, dialect quirks
  — all of which this parser rejects with a squiggle. A real one is `sql-formatter` off npm, which
  shares no code with QueryLens. The linting that does make sense here already exists: CodeMirror
  plus our own parser errors, scoped to the supported subset, inside the app.

### 20.7 Decision log

| Item | Verdict | Earliest | Trigger to revisit |
|---|---|---|---|
| Copy as Mermaid (AST, plan) | **Done, v12** | M12 | — |
| PNG export of a panel | **Done, v12** | M12 | — |
| `scripts/record.ts` (GIF/WebM) | **Done, v13** (`pnpm record`) | M12 | — |
| True vector SVG export | **Done, v14** (`renderSvg.ts` — real `<rect>`/`<text>`/`<path>`, colour resolved through a DOM-then-canvas pipeline to plain `rgb()`, never `oklch()`) | v1 | — |
| Buffer Pool standalone | **Done, v10; FIFO / Second-Chance / Bélády / midpoint-LRU added v12** | v1 | — |
| B+Tree standalone | **Done, v12** (delete + property tests built with it) | v1 | Stepping the split / borrow / merge restructure (new `index` event kinds) is the obvious extension |
| Parser standalone (token ribbon) | **Done, v12** | v2 | Stepping the parser's cursor through the ribbon (new event kinds) is the obvious extension |
| Assignment links (client-side) | **Done, v10; reveal-lock added v12** | v1 | — |
| Graded submission (backend) | Own plan | post-v1 | §9 validates the format, then a separate surface |
| Interactive embed (package or CSP entry) | Own plan | v1+ | A named author needs an in-page embed |
| Visual `EXPLAIN` viewer | Own product | — | A decision to serve DBAs — not this plan |
| Standalone SQL formatter | Declined | — | The parser grows materially past the v0 subset |

Nothing here changes the MVP or the §9 study. M12 is one small, launch-facing milestone; everything
else waits behind the experiment that decides whether it is worth building.

### 20.8 Definition of done — M12 only

- [x] **v12.** `src/export/toMermaid.ts` is a pure, unit-tested function (`astToMermaid` /
      `planToMermaid` over the display trees; sequential `nN` ids sidestep Mermaid id-escaping), and
      a **Copy as Mermaid** action in the AST and plan panel headers (`StageDetail`, so both the
      Playground and the stage explainers) writes a valid ` ```mermaid ` fenced block to the
      clipboard. Not the B+Tree, per §20.3.
- [x] **v12.** A **Download PNG** button on every implemented stage's panel (`StageDetail` header)
      produces an image with the real fonts and `oklch` colours embedded. `html-to-image@1.11.13`
      (the app's one runtime dependency beyond React / Router / CodeMirror), `import()`ed on first
      use so it never touches first paint; a same-origin `<a download href="data:…">` saves it,
      unblocked by `img-src 'self' data:`. Verified in Chromium (an e2e asserts the PNG magic bytes
      and size); Firefox untested here but the same path; Safari's `foreignObject`→canvas has known
      colour bugs, documented in the FAQ rather than worked around.
- [x] **v13.** `scripts/record.ts` (`pnpm record "<link|q=…>" --from N --to M`) frame-steps the
      *built* app through Playwright — the `scripts/build-og.ts` pattern, generalised from one frame
      to a range — waits on `document.fonts.ready`, screenshots each step, and muxes a GIF and a
      WebM. ffmpeg is resolved `$FFMPEG_PATH` → `PATH` → the copy Playwright bundles; the WebM is
      VP9 or (bundled build) VP8, and the GIF's two-pass `palettegen`/`paletteuse` runs only with a
      full ffmpeg — without one the script still writes the WebM and the numbered frames and prints
      the exact commands to finish the GIF. Prediction is forced off in the URL so no gate stalls
      the playhead; an assignment `l=1` is stripped. Output lands in the git-ignored `build/`.
- [x] **v13.** One renderer path: `record.ts` screenshots the same live panel DOM the **Download
      PNG** button rasterises (same components, tokens, font files), so there is no second drawing
      to drift — the guarantee §20.2 #1 asks for, held the same way `build-og.ts` holds it.
- [x] **v13.** `CHANGELOG.md` has the `pnpm record` entry; the FAQ's "Can I get the diagrams out?"
      now names the GIF/WebM script alongside the two in-app buttons. No §2 non-goal is crossed — it
      is a maintainer script for docs/launch material, not an APM or production surface.

---

## 21. The Multi-Page Application — routes, pages & the feature catalogue

> New in v8. Commit `5c7ef5d` added client-side routing and a stage section; `ad2bc59` added the
> docs site. The app is no longer "a single page" — the phrase still in `public/404.html` — but
> nothing wrote down what the page map *is*, which routes are load-bearing, or what a second and
> third feature area cost once there is a shell to hang them on. This section is that map. It adds
> no feature that §13 or §20 did not already name; it gives each one an address, a URL-state
> schema, a place in the navigation and a build status, and it fixes the routing that a count of
> `src/` shows is half-wired.
>
> **Status, v9 — M13 shipped.** §21.5's seven-item P0 is done (see §21.8). The SPA rewrite,
> the dead `router.tsx`, the stale 404 and `index.html` copy, per-route `React.lazy`, the
> `src/routes.ts` nav manifest, and the `react-router-dom` pin all landed together. Doing it
> turned up more than the list said it would: the desktop fixed-height shell and the mobile
> scroll-snap had *both* been dropped from the layout when `5c7ef5d` moved it into `Layout.tsx`
> (two `e2e/regressions.spec.ts` tests had been red since, alongside a bundle budget that had
> been failing just as long — the multi-page entry never got its 24 kB line updated). All three
> are fixed. Commit `6eca5ac` also reversed §17.1's Astro decision in between — the docs are now
> integrated MDX routes — which simplified this section rather than complicating it: one build,
> no docs/app seam. The stale Astro references below are corrected; the leftover *docs-content*
> debt from that migration (no visible page headings, in-content links still using Astro's
> trailing-slash form, `prose-invert` locking the docs to dark) is real and tracked separately,
> not part of M13.

### 21.1 Where routing stands — counted

**What exists** (`src/App.tsx`, the live route tree):

| Route | Page | State |
|---|---|---|
| `/` | Playground | `src/ui/urlState.ts` — query, policy, predict, step, edited rows |
| `/stages` | Pipeline index — eight stage cards | none |
| `/stages/:stageId` | Stage explainer + one isolated `StageDetail` over a demo trace | `:stageId` only |
| `/examples` | Three curated queries, each a link into `/?sql=…` | none |
| `/docs/*` | Integrated MDX routes (commit `6eca5ac` replaced the Astro build — §17.1), one lazy chunk | per-page (static) |
| `*` | `NotFoundPage` (in-app) | — |

**Five things a count finds wrong with it:**

1. **No SPA rewrite.** `public/` has `_headers` and `404.html` but no `_redirects`. On Cloudflare
   Pages a hard load of `/stages/parse` — a refresh, a shared link, a new tab — matches no static
   file and serves `404.html`, which carries `noindex`. Every route except `/` is reachable only by
   in-app navigation. For an app whose entire distribution model is a shared link (§14.1, §19.3),
   this is the deploy-day blocker. The fix is one file: `/*  /index.html  200`, with Pages'
   static-asset-first ordering leaving `/docs/*` and `/assets/*` untouched.
2. **`src/router.tsx` is dead code.** It exports a `createBrowserRouter` data router that nothing
   imports; `App.tsx` uses the declarative `<BrowserRouter><Routes>` form instead. Two route trees,
   one wired — the unwired one will drift and then mislead.
3. **`public/404.html` still says "QueryLens is a single page — there is nothing at this address."**
   Written before the stage section existed. With an SPA rewrite in place the hard-404 page should
   only ever show for a genuinely unroutable path, and its copy should say that.
4. **`index.html` `<title>` and `og:title` are `QueryLens — see what your SQL actually does`** — the
   exact line §19.4 recorded as the *rejected* tagline, replaced in the app header by "Watch a SQL
   query become a B+Tree traversal." The document metadata never took the change. Align it, or note
   deliberately why the two differ.
5. **Routes are not code-split.** `router.tsx`'s comment claims pages are lazy-loaded; neither file
   uses `React.lazy`. Today the whole app is one entry, so `/stages` pays for the Playground's
   CodeMirror and `/examples` — pure prose — pays for React Flow. Fine at two sections; not fine at
   eight.

`react-router-dom` is also the one dependency on a `^` range (§6); pin it while the routing is
being touched.

### 21.2 The shape — a hub, not a site

The instinct when a site goes multi-page is equal-weight navigation: a bar of peers, a home page
that is a directory. That is wrong here for the reason §19 spends a section on — the Playground *is*
the product, comprehensible in four seconds of watching, and a cold visitor who clicks "Stages"
before the first trace finishes has been sent away from the thing that would have convinced them.

So: **one hub, quiet spokes.**

- **`/` is the hub and the first paint.** It never becomes a launcher screen. The trace runs on
  load; the nav is present but visually secondary (§19.1 job 3).
- **The spokes are for the second visit and the instructor.** Stage explainers, tools, the gallery,
  compare, classroom — a returning learner working through the pipeline, or a teacher building a
  link for a class. None of them is on the path a first-timer needs.
- **Every spoke has a way back into the hub at the relevant state** — an "Open in Playground" action
  that carries the query and step through the §21.4 URL layer. The spokes explain; the hub is where
  you *do*.
- **The docs (`/docs`) are the fourth surface**, deliberately a different build (§17.1). The app
  links into them; they link into the app by shareable URL, never by iframe (`frame-ancestors
  'none'`).

### 21.3 The route catalogue

Grouped by area. **Status** is `built` / a milestone / `v1` / `v2` / `own plan`, matching §10 and
§20. A route marked `own plan` is named here for the map and the navigation, not scheduled.

**Hub**

| Route | Page | Primary feature | URL state | Status |
|---|---|---|---|---|
| `/` | Playground | Author SQL, run, step the full pipeline, predict-then-reveal, edit seed rows, switch policy | query, policy, predict, step, rows | built |

**Learn**

| Route | Page | Primary feature | URL state | Status |
|---|---|---|---|---|
| `/stages` | Pipeline index | Eight stage cards, grouped Query Processing / Runtime / Concurrency / Output | — | built |
| `/stages/:stageId` | Stage explainer | Prose + one isolated live panel over a canned trace; prev/next through the pipeline | `:stageId` | built |
| `/learn` | Guided path | Four §17.2 tasks as an ordered track — run your first query, follow one row disk-to-result, watch a page get evicted, make the planner change its mind — with a `localStorage` completion mark (`querylens:learn`; a convenience, degrades to unmarked). Primary nav | — | **built** — v12 |
| `/learn/:lessonId` | One lesson | The task as numbered steps; each step's "open this in the Playground" link is a deep link whose step is computed from a real engine run (`GalleryPage`'s discipline), and each lesson ends with a "try this" that changes one variable. An unknown id redirects to `/learn` | `:lessonId` | **built** — v12; nine lessons v13 |
| `/challenges` · `/challenges/:id` | Challenge mode | Eight goal-shaped puzzles (§22.4); each `:id` runs its query against its dataset (`users` by default, or an `orders` / `logins` preset) and checks a pure predicate over the `RunResult`, with a stats readout, a verdict, a solved-set (`querylens:challenges`) and a step-in-Playground link (carrying `t=`) on a pass. Footer nav | `:id` | **built** — v13 |

**Explore**

| Route | Page | Primary feature | URL state | Status |
|---|---|---|---|---|
| `/examples` | Examples | Curated queries; each opens the Playground | — | built (3; grow it) |
| `/gallery` | Moment gallery | Named, deep-linked traces — a point lookup, the eviction storm (LRU and clock), the optimizer's rewrite — each card computes its own step via `events.findIndex(...)` against a real run, so an engine change fails the page rather than shipping a stale link. The index-dropped contrast and a B+Tree split/merge moment are not here yet — both are now just one more moment to add (B+Tree delete landed in v12) | per-card share string | **built** |
| `/compare` | Comparison view | Three modes. **Replacement policies**: two buffer-pool traces (`src/engine/bufferTrace.ts`) stepping together on one reference string, synced by *access index*, flagging the first differing victim — either side any of the five policies (v12). **Index vs. sequential scan** (v12): the same SQL run once with the `id` index and once with it removed (`indexedColumn` dropped from the table — the optimizer and `runQuery` both key off it), scored side by side — trace steps, disk reads, evictions, B+Tree node reads, locks, rows. This is §13's full-pipeline half, at the altitude of the numbers rather than stepped panels. **Hash aggregate vs. sort aggregate** (v14): the same GROUP BY query run once with each strategy forced via `EngineOptions.aggregateStrategy`, scored side by side — trace steps, disk reads, pages written, evictions, groups produced. Same groups out either way; only the sort aggregate ever writes a page | reference string + both policies, or the query (session-local) | **built** |
| `/trace` | Trace inspector | The raw `StepEvent[]` for a query as a filterable table (per-stage toggles + a narration text filter) with per-row JSON and a **Copy JSON** of the filtered set — plus a **Transcript** view (v13): a numbered, printable prose list of every step's narration, each a Playground link. Runs the same `runQuery` the Playground does; each row's `#` opens the Playground at that step (§21.4 #4). Reads `q`/`p`/`d`/`v`/`t`; footer-only nav (§21.2) | `q`, `p`, `d`, `v`, `t` | **built** — v12; transcript v13; `t` v13 |

**Tools** (§20.4 — each renders through the §20.2 `PanelPage` primitive)

| Route | Page | Primary feature | URL state | Status |
|---|---|---|---|---|
| `/tools` | Tools index | What each standalone is for, and who it is for, and which are not built yet | — | **built** |
| `/tools/buffer-pool` | Buffer pool sandbox | Type or generate a page-reference string; step it against any of six policies — LRU, clock sweep, FIFO, second-chance, optimal (Bélády), midpoint-LRU (InnoDB) — through the exact `BufferPoolPanel` the Playground uses, driven by `runBufferTrace`. No SQL, no table. `optimal` reads the whole reference string as lookahead (the SQL path has none, so it degrades to FIFO there) | reference string, frames, policy | **built** — v12 added the four non-pipeline policies |
| `/tools/btree` | B+Tree sandbox | `insert` / `delete` / `find` number pad; watch it split on insert and borrow or merge on delete; fan-out slider; structural invariants re-checked and shown after every edit | `keys`, `fanout` | **built** — v12; B+Tree deletion (`deleteKey`) built with it |
| `/tools/parser` | Parser sandbox | Arbitrary text → live token ribbon → live AST (the Playground's `AstTree`, from `toDisplayTree`) with recursion depth and the parser's own tokenize/parse error messages | source text (`src`) | **built** — v12 |
| `/tools/page` | Slotted page inspector | One heap page of `users` laid out to the byte — header, line-pointer array, tuple data packed from the far end, free space between — with a page-size slider that shows how much a real 4 KB page would hold. `src/ui/slottedPage.ts` synthesises the layout (the engine's `Page` is only a `Row[]`, §7); a tuple cell in the map cross-highlights its table row | `page`, `bytes` | **built** — v13 |
| `/tools/sort` | External merge sort | Sort N shuffled records with a fixed memory budget: run generation → `(memPages−1)`-way merge passes → one sorted run, with the `2·pageCount·(1+passes)` page-I/O cost broken out. `src/ui/externalSort.ts` is the driver (no `Sort` operator yet, §22.2). Parameter-driven, no playback; click a merged run to colour its records by source and light the runs that fed it | `n`, `page`, `mem`, `seed` | **built** — v13 |
| `/tools/planner` | Planner sandbox | Type a query; see its canonical plan tree next to the optimised one, with a checkbox per rewrite rule (predicate pushdown, index selection) and one for the `id` index, plus a ledger saying for each rule whether it fired, found no match, or was switched off. Every node is annotated with the cost model's `~N rows` estimate and its heuristic (v14). `optimize` takes an optional enabled-set; validation is `runQuery`'s own | `q`, `idx`, `rules` | **built** — v13 |

**Classroom** (§20.5)

| Route | Page | Primary feature | URL state | Status |
|---|---|---|---|---|
| `/assignments/new` | Assignment author | Pick a preset or custom query, a policy and the step to land on; get a link with prediction forced on and (v12) **the reveal locked** — `&l=1` makes the Playground seal the trace at the landing step until the learner commits: no "skip" on the prompt, and `usePlayback`'s new `ceiling` stops the scrubber (which `gates` deliberately does not) from crossing an unanswered prompt. The lock lifts one prompt at a time. The author is warned when the chosen step carries no prompt. **v13:** *Add to set* collects labelled links into a numbered Markdown worksheet + a JSON file (§22.4) | encoded in the produced link (`q`/`p`/`x`/`s`/`l`) | **built** — v12; assignment sets v13 |
| `/a/:id` | Open an assignment | Superseded by the above — there is no server-side id to decode, so an assignment *is* a Playground link rather than a separate route. Kept here as the originally-planned shape, struck by the simpler one that shipped | — | not built, and not needed as specified |
| `/classroom` | Graded track | Submit scored answers back to an instructor — its own plan, its own privacy statement, likely its own subdomain (§20.5) | — | own plan |

**Meta**

| Route | Page | Primary feature | URL state | Status |
|---|---|---|---|---|
| `/settings` | Settings | Default eviction policy and default predict-on, persisted to `localStorage`, read by the Playground only when a URL does not already specify one — the same precedence the theme already follows. Theme has its own header toggle already; reduced-motion and tabular figures are not per-visitor settings (the first follows the OS, the second is unconditional CSS), so neither is here | — | **built** |
| `/shortcuts` | Keyboard reference | The full table; the in-app hints are a reminder, not a reference (§17.2 page 9). May instead be a docs page — decide with §17 | — | v1 or docs |
| `/about` | About | What the model claims and does not, credits, the licence position in plain words. May instead be the FAQ's landing — decide with §17 | — | v1 or docs |
| `/embed/*` | Embed surface | Stripped, read-only `PanelPage`; the only route served without `frame-ancestors 'none'`, safe here only because the app has no auth, actions or secrets (§20.3) | share string | own plan |

That is roughly twenty routes. Four existed before this pass; **M13** made those four linkable;
the v1 tranche named in §10 — gallery, the buffer-pool tool, compare, assignment links, settings —
**shipped in the same push**, ten routes built in total. The rest is v2 or its own plan. The
catalogue is a map, not a backlog.

> **Status, v10 — the v1 tranche shipped.** `/gallery`, `/tools`, `/tools/buffer-pool`, `/compare`,
> `/settings` and `/assignments/new` are built, routed, in the nav manifest, and covered by
> `e2e/features.spec.ts` plus a new `src/engine/bufferTrace.ts` with its own unit tests. The
> buffer-pool tool and Compare share one primitive — `runBufferTrace`, a page-reference-string
> driver over the *same* `createBufferPool` the SQL path uses, folded through the *same*
> `createTraceProjector` and rendered by the *same* `BufferPoolPanel` — which is exactly §20.2 #2's
> promised seam, arriving a milestone early because Compare needed it too. Three things shipped
> smaller than §21.3 first described, each recorded at its row above rather than smoothed over:
> Gallery has no B+Tree-split or index-dropped moment yet (nothing in the current engine produces
> either); Compare is the buffer-pool half of §13's idea only, not the full pipeline; and assignment
> links do not yet withhold the reveal until the learner commits, they only default prediction to
> on. `/tools/buffer-pool`'s policy list is LRU and clock only — FIFO, Second-Chance and
> Bélády-optimal stay open per §20.4. New nav: the header carries seven primary items now
> (Playground, Stages, Gallery, Tools, Compare, Examples, Docs); Settings and Assignments sit in the
> footer only (§21.2's hub-and-spoke — an instructor feature has no business in a cold visitor's
> first look). Full gate green: typecheck, lint, 338 unit tests, build, bundle budget (two new
> groups — `standalone-tools` and a widened `trace-ui` — see `scripts/bundle-budget.ts`), 26 e2e,
> and a manual axe pass on all six new routes with zero violations.

### 21.4 Cross-page conventions

The pages are cheap only if they share machinery. Five conventions make that true.

1. **One shell.** `src/ui/Layout.tsx` — disclaimer bar, top nav, footer — wraps the whole route
   tree and is never forked per page. A section that needs its own secondary nav (Stages has a
   sidebar) nests a layout inside it, as `StagesLayout` already does.
2. **One panel-in-isolation primitive.** `StagePage` is the prototype; §20.2 #3 generalises it to
   `<PanelPage panel driver chrome="minimal | full" />`. The stage explainers, all three tools, the
   embed surface and each `/compare` pane are the same component with a different driver.
3. **One URL-state layer.** `src/ui/urlState.ts` is Playground-only today and writes history with a
   raw `history.replaceState`, outside React Router. Generalise it to `useShareState(schema)` —
   per-page typed schemas, still parsed defensively as untrusted input (it stays the one value the
   app takes from a stranger), but writing through React Router's own `navigate({ replace: true })`
   so the two histories cannot desync. `replaceState` not `pushState` stays the rule: stepping a
   trace must not bury the back button.
4. **One "Open in Playground" contract.** Every explanatory page hands its current query and step to
   the hub through that layer. This is the seam between §21 and §17 — the most likely path from a
   docs concept to the running app — and it must land the reader on the exact step, not the top.
5. **One nav definition.** Top nav, footer links and any section sidebar come from a single route
   manifest, so a new route appears in all three or none. The current three (`TopNav`, `Footer`,
   `Sidebar`) already drift; collapsing them is part of M13.

**Rendering strategy, stated so it does not drift.** The app is client-rendered; the docs are
Astro-prerendered. The prose-heavy new routes — `/about`, `/learn`, the `/gallery` copy — would
read better prerendered and be more findable by search. The decision (M13 or v1, not later): either
those routes move into the Astro build alongside the docs, or the SPA gets a build-time prerender
crawl. **Default: keep them in the app, CSR, and revisit only if search referral ever matters** — a
learning tool's traffic is a shared link, not a search result, and a second rendering path is a
standing tax. Recorded so the choice is deliberate rather than accreted one route at a time.

### 21.5 P0 — routing consolidation (M13, ~1 day)

**Done, v9 — all seven, see §21.8 for how each landed.** Each of these gates the same way: a
multi-page app whose deep links 404 is a single-page app with extra buttons.

| # | Item | Where | Why it gates |
|---|---|---|---|
| 1 | **SPA rewrite** — `/*  /index.html  200`, verified against `/stages/parse` on a cold load and a refresh | `public/_redirects` [NEW] | Without it every route but `/` serves the `noindex` 404 on a shared link. This is the item |
| 2 | **Delete or adopt `src/router.tsx`** — one route tree, and it is the one `App.tsx` renders | `src/router.tsx`, `src/App.tsx` | Two trees, one wired: the dead one drifts and then someone edits it |
| 3 | **Correct the 404 copy** — it no longer describes a single-page app; say what an unroutable path is and link home | `public/404.html` | It currently contradicts the product |
| 4 | **Align `index.html` metadata** — `<title>`, `description`, `og:title` to §19's tagline, or a comment on why they differ | `index.html` | The card is the landing page (§14.1); its title is three versions stale |
| 5 | **Code-split routes** — `React.lazy` per page, so `/examples` does not ship React Flow | `src/App.tsx` | Cheap now, structural later; the `router.tsx` comment already claims it is done |
| 6 | **One nav source** — `TopNav`, `Footer` and `Sidebar` read one route manifest | `src/ui/` | A route that exists but appears in no nav is a route nobody finds |
| 7 | **Pin `react-router-dom`** — off the `^` range onto an exact version (§6, §14.2) | `package.json` | Every other dependency is pinned; the router should not be the exception while it is load-bearing |

### 21.6 P1 / P2 — the feature routes

**The v1 tranche shipped (v10) — see the status note under §21.3.** What follows is the order it
went in, kept for the record, plus what is left.

1. ~~**`/gallery`**~~ — done. A card is a share string and a caption, computed against a real run
   rather than a hand-typed step.
2. ~~**`/tools/buffer-pool`**~~ — done, and it produced the shared primitive
   (`src/engine/bufferTrace.ts`) the next item needed too.
3. ~~**`/assignments/new`**~~ — done, minus the reveal-withholding half (§21.3's row for it is
   explicit about the gap). `/a/:id` was dropped in favour of the plain Playground link — no
   server-side id exists to decode, so inventing one would have been complexity with nothing behind
   it.
4. ~~**`/compare`**~~ — done. Shipped as the buffer-pool half of §13's idea (v10); the
   full-pipeline index-vs-no-index half landed as a second mode in v12 — scorecards of the same
   query with and without the `id` index, rather than two stepped `PanelPage`s.
5. ~~**`/settings`**~~ — done, scoped to default policy and default predict-on; reduced-motion and
   tabular figures turned out not to be per-visitor settings once considered (§21.3's row explains
   why).

P2 / v2: all shipped in v12. Still open (own plans / v1+): true vector SVG export (§20.3),
`/classroom`, `/embed/*`, and the deferred stepping additions (parser cursor, B+Tree restructure —
new event kinds).

**v12 cleared the rest of the §21.6 list.** `/tools/parser` is the live token ribbon + `AstTree` +
recursion depth + the parser's own errors (§21.3's row). `/tools/btree` is the number-pad REPL over
`insert` / `deleteKey` / `search`, and the B+Tree **deletion** it needed was built with it (borrow /
merge / root-collapse / separator rewrite, with §7.6's property tests). `/trace` is the raw-event
inspector — filterable table, per-row JSON, jump-to-step links — running the same `runQuery` as the
Playground, footer-only. **`/learn`** is the §17.2 tasks as an ordered track (four at v12, nine at
v13 — B+Tree split, edit the seed data, predict, share a moment, when something goes wrong; the
keyboard reference stays in the docs), each step deep-linking to an engine-computed Playground step
or a `/tools/*` sandbox, with `localStorage` completion marks. **Assignment
links** gained the reveal-lock
they were always missing: `&l=1` seals the trace at the landing step until the learner answers
(`usePlayback` `ceiling`, no "skip"). **`/compare`** gained a second mode — index vs. sequential
scan on the same query, scored side by side — closing §13's full-pipeline half. The buffer-pool
tool and Compare's policy mode gained four policies behind the existing `ReplacementPolicy`
interface — `fifo`, `second-chance`, `optimal` (Bélády; needs an optional lookahead array on
`BufferState` that `runBufferTrace` fills and the SQL path leaves empty), and `midpoint` (InnoDB
midpoint-insertion LRU, §7.5; needs an optional `onLoad` hook so a load can enter the old sublist
rather than the young one). `ReplacementPolicyName` is now these six, but the Playground picker,
`urlState` and `/settings` still allow-list `lru`/`clock`, so §9's contrast and every shared link
are untouched.

### 21.7 Risks specific to going multi-page

- **Diluting the hub.** Every nav item is an invitation to leave the trace. Mitigation: §21.2's
  hub-and-spoke, the nav stays visually secondary (§19.1), and the first-run hint still points at
  Space, not at the nav.
- **Deep-link 404s.** The one in §21.5 item 1. Until the rewrite ships, publish no URL but `/`.
- **A second rendering path.** Prerendering the prose routes means Astro-in-the-app or a prerender
  crawl — a standing tax on every build. §21.4 defaults to not paying it; the risk is paying it by
  accident, one route at a time.
- **Bundle creep.** Eight route chunks that each `import` a panel can each pull React Flow.
  Mitigation: the `flow` vendor chunk (`vite.config.ts`) is already shared; keep panels behind
  `PanelPage` so the import graph stays one edge deep, and keep the CI bundle budget covering the
  entry, not just the whole.
- **Nav drift.** Three nav components today, already inconsistent. §21.5 item 6, or it compounds per
  route.
- **Back-button surprise.** The URL layer writes with `replace`. A user who steps a trace then hits
  Back expects the previous *page*, which `replace` gives them and `push` would not. The rule holds;
  the risk is a future contributor "fixing" it to `push`.
- ~~**The docs/app seam.**~~ **Gone as of commit `6eca5ac`.** The docs were an isolated Astro
  package until then; they are now MDX routes in the one Vite build, so there is no second build
  system, no cross-origin, and no `base`-rewrite to trip on. The e2e check that the nav's "Docs"
  link resolves to real docs content stays as a cheap guard.

### 21.8 Definition of done — M13

**Done, v9.** All seven P0 items shipped together; three regressions the list did not name were
found and fixed alongside (see the status note under §21).

- [x] A hard load of `/stages/parse`, `/stages`, `/examples` and `/docs/faq` — refresh and new tab
      — renders the app, not the 404 page. *`public/_redirects` (`/* /index.html 200`) for
      Cloudflare; `e2e/regressions.spec.ts` asserts the app half (the shell renders, the content
      renders, the standalone 404 copy is absent) against the built output. The Cloudflare rewrite
      itself needs the live URL, like §14.6's other held-open checks.*
- [x] `src/router.tsx` is gone. *It was dead code — nothing imported it; `App.tsx` has the tree.*
- [x] `public/404.html` describes an unroutable path, not "a single page," and links home. *Reframed
      as the last-resort "the app didn't load" page it now is, since the rewrite means React Router
      renders ordinary unknown routes as `NotFoundPage`.*
- [x] `index.html` `<title>` and `og:title` match the app's own tagline. *"watch a SQL query become
      a B+Tree traversal", with a comment recording that the old line was §19.4's rejected one.*
- [~] `/examples` downloads neither the React Flow nor the CodeMirror chunk. *CodeMirror (367 kB) —
      and `PlaygroundPage`, `StageDetail`, `docs` — are confirmed absent, asserted by e2e. React
      Flow still preloads on every route: the `codeSplitting` groups config in `vite.config.ts`
      (renamed from the now-deprecated `advancedChunks` in v16 — same grouping, so this is
      unaffected) hoists that chunk into the entry graph. Un-sharing it moves every chunk hash
      (§14.2's caching story), so it is a separate change, tracked apart from M13.*
- [x] Top nav and footer are generated from one manifest (`src/routes.ts`). *The stages sidebar
      stays built from `STAGE_META`, the canonical stage list — a different axis, deliberately not
      folded in.*
- [x] `react-router-dom` is pinned to an exact version. *`7.18.3`; the five `^`-ranged deps the
      `6eca5ac` MDX migration added are noted as migration debt, not changed here.*
- [x] The bundle budget covers the entry chunk and the lazy chunks. *`entry` 24 kB (was a stale
      34 that had been failing since `5c7ef5d`), plus new `trace-ui`, `routes` and `docs` groups so
      a page that stops being lazy fails the build.*

---

## 22. Feature Depth & the Tool Catalogue — the post-validation backlog

> New in v13. §20 counted a spin-off list against `src/` and sequenced it; §21 gave every route an
> address. Neither took §13's first future — *"expand SQL coverage: joins, cost estimates"* — or
> §4's "explicitly deferred to v1+" list and did the same work on them. This section is that pass,
> together with the smaller tool, learning and reach ideas that have accrued since v8.
>
> **v14: the §9 gate is lifted (§9's v14 note).** This stops being a "post-validation" backlog and
> becomes the active build queue — the cost model landed first (§22.2), and `Sort`, the write path,
> the multi-table schema + JOIN, and the remaining `/tools/*` sandboxes follow in roughly that
> order. The MVP contrast and M12/M13 are still untouched; §12's breadth-before-validation risk is
> accepted explicitly. Items still marked **Deferred** / **Own product** below (MVCC, WAL, the
> in-app quiz, the published packages) stay deferred on their *own* triggers, not on §9.

### 22.1 The filter — §20.1's four questions, plus one

§20.1 asks: does it serve the §9 study, does it serve the §18.2 launch, does it need a backend or
break "nothing leaves your browser", does it fork the audience. All four apply unchanged.
Feature-depth items get a fifth, because they are the ones most able to dilute the product without
looking like they do:

5. **Does it deepen the §9 contrast, or widen away from it?** The product shows one thing well: an
   indexed point lookup against a sequential scan, and — on the eviction that falls out of the scan
   — LRU against clock sweep (§9). An item that sharpens that contrast, or gives it a second
   instance at another layer (a hash join beside a nested-loop join; a cost estimate that
   *justifies* the index choice the optimizer already makes), earns its place. An item that adds a
   parallel subject — MVCC, WAL, window functions — is a second product sharing a codebase, and is
   not worth starting before the §9 result is in.

### 22.2 Engine depth — SQL and pipeline coverage

The engine today reaches two tables at once only through `JOIN`; every other statement is still
`SELECT`/`DELETE`/`INSERT`/`UPDATE` against one table, `=`/`<`/`>`/`AND`, one index each
(`src/engine/seed.ts`, `planner/plan.ts`, `exec/operators.ts`). Everything below extends that. With
the §9 gate lifted (v14) this is the active queue: the cost model, `LIMIT`, `Sort` / `ORDER BY`, the
full `INSERT`/`UPDATE`/`DELETE` write path, `constant-folding`, both aggregate strategies for
`GROUP BY`, an index-only scan, enforced concurrency (as `/tools/locks`'s own driver), and both a
nested-loop and a hash `JOIN` are done (v14); sort-merge join is done too (v15, closing the
join-algorithm trio), and so is predicate pushdown into a `Join`'s own children — it turned out not
to need multi-join grammar at all, only a WHERE conjunct already qualified to one side. Join order is
the one item still gated on multi-join grammar support v0 does not have yet.

| Item | Cost against `src/` | Earliest | What a generic version gets wrong |
|---|---|---|---|
| **JOIN + a join-algorithm comparison** — a `Join` plan node and nested-loop / hash / sort-merge operators, join order in `optimize.ts`, a fourth `/compare` mode | 2–3 wk, and needs the multi-table schema (§22.7) first | v1 core (already §4/§13) | Showing the three as interchangeable. The lesson is *when each wins* — small build side → hash; inputs already sorted, or sorted output needed → merge; tiny outer with an index on the inner → nested-loop. **Nested-loop done, v14:** `FROM t1 JOIN t2 ON t1.a = t2.b` — an implicit inner join, exactly one per query, an equi-join `ON` between one qualified column from each side. Qualification is the load-bearing new grammar piece: `Expr`/`SelectItem`'s `column` variant gained an optional `table`, required on every reference once a query joins two tables (there is no ambiguity resolution — v0 asks the query to say which table) and validated against the tables actually named, so a bare `id` or a qualifier naming a third table both fail at parse time with a specific message. The `Join` node's two children are always a bare `SeqScan` — v1 pushes no predicate into either side — and its executor rescans the right side whole for every left row, reusing the exact re-`open()` reset every operator's Volcano contract already means; the two tables' heaps share one real buffer pool, the right's pages numbered right after the left's, so the rescans' cost is genuine, counted disk activity, not a claimed one. The cost model prices it as `left × right / ndistinct(right key)` rows and `leftPages + leftRows × rightPages` — the honest, unflattering nested-loop number. **Hash join done, v14 — the second algorithm.** `Join.algorithm` widened to `'nested-loop' | 'hash'`; a new `hashJoin` operator drains the right side once into a plain `Map` keyed by `equalityKeyOf(rightColumn)` (a NULL key is never inserted — the same "NULL never matches NULL" rule nested-loop's own `compare('=', ...)` already enforces), then streams the left side, probing instead of rescanning. `equalityKeyOf` (`exec/evaluate.ts`) is the load-bearing piece: it mirrors `compare`'s exact coercion (a number and a numeric string collide the same way `compare('=', 5, '5')` already says `true`), so the two algorithms can never disagree on which rows match — checked directly with a mixed-type test. No partitioning or spill; the hash table lives entirely in memory, the same simplification `HashAggregate` already makes for `GROUP BY` (Grace hash join's partition spill is `/tools/hash-join`'s own deferred future work). The cost model prices it at `left.estPages + right.estPages` — each side read once — against nested-loop's `leftPages + leftRows × rightPages`; same row estimate either way, since the algorithm changes I/O, not cardinality. `EngineOptions.joinStrategy` (`'nested-loop'` by default) is how `/compare`'s new fourth mode forces each side explicitly, the same way `aggregateStrategy` already does for `GROUP BY` — and because the tiny `authors`/`posts` demo (5+10 rows, 5 heap pages) fits entirely inside the default 8 buffer frames, that comparison forces `bufferFrames: 2` too, or every rescan after the first would just hit cache and the two algorithms' disk-read counts would tie despite doing genuinely different work. 11 new unit tests, 1 e2e. Deliberately narrow beyond both algorithms: no `GROUP BY`, `ORDER BY` or aggregate SELECT item combines with a `JOIN` yet (each rejected at parse time), and the optimizer does not reach into one at all — `predicate-pushdown`/`index-selection` simply never match a `Join`-rooted plan, so a `WHERE` clause is always a residual `Filter` above it, not pushed into either scan. Reachable today via `/tools/planner`'s two small fixed tables, `authors`/`posts` (`createJoinDemoDatabase`), sitting alongside `users` without touching its own index toggle, via `/compare`'s fourth mode, and now via the Playground's own **Custom** data mode too (§22.7's schema editor). **Sort-merge join done, v15 — the third algorithm.** `Join.algorithm` widened to `'nested-loop' | 'hash' | 'sort-merge'`; the new `sortMergeJoin` operator sorts *both* sides on the join key — each its own `externalMergeSort` call, real spill I/O through `ctx.pool`, exactly the driver `Sort`/`SortAggregate` already use — then merges the two sorted lists in a single generator-driven pass (`sortMergeMatches`), replaying the full matching run on both sides for a repeated key rather than a plain two-pointer merge, which would silently miss all but the first pairing once the join column isn't unique. The sort key is `equalityKeyOf`'s own coercion, not raw comparison — the same property hash join's mixed-type test defends, now proven for sort-merge too: a value `compare('=', ...)` calls equal must sort adjacent, or the merge could miss it. Each side's own sort scratch gets a fresh, non-colliding page-id block (`runQuery.ts` reserves one per side, sized against each table independently — the first case two sort reservations were ever needed in the same query). Costed like hash (`left.estPages + right.estPages`, each side read once) plus both sides' own spill (`2 × spill pages`, mirroring `Sort`'s own "at least run generation" estimate) — honestly pricier than hash, cheaper than nested-loop's rescans on anything but a tiny table. `/compare`'s join mode is now a genuine three-way (renamed "JOIN algorithms" from "Nested-loop join vs. hash join"), each column flagged only where it isn't the best of the three, not merely worse than one specific other. Like `Sort`, cannot produce a row until *both* sides are fully sorted, so a `LIMIT` above it caps only the merge's output, not the sorting that already happened — the same honest gap `Sort`'s own doc comment names. 12 new unit tests, 1 e2e updated. **Predicate pushdown into a `Join`'s own children, done in the same push.** A new optimizer rule, `join-predicate-pushdown`, splits a `WHERE` clause's conjuncts by which table they name — every reference is qualified once a query has a `JOIN` at all, so there is no ambiguity to resolve — and pushes each single-table conjunct into that side's own `SeqScan`, stripping its table qualifier first (a scan reads that table's raw, unqualified rows; a qualified reference would silently match nothing). A conjunct naming both sides — or the join predicate itself, restated in `WHERE` — can only be checked once a row from each side is paired, so it stays a residual `Filter` above the `Join` exactly as before. This needed no multi-join grammar at all, unlike join order: it is a rewrite of the one `Join` node's two existing children, not an ordering choice among several. The cost model needed no changes either — `estimateNode`'s `SeqScan` case already prices a `.filter`, so a pushed conjunct's selectivity flows into the `Join`'s own row estimate for free. 12 new unit tests (five of them fixing two now-stale test titles/comments the old "always a residual" behavior had made permanent-sounding), 0 new e2e. **Still open:** join order, which needs multi-join grammar support v0 does not have; and reaching `index-selection` into a `Join`'s own children, so a pushed conjunct that happens to match an index still runs as a full scan rather than a lookup |
| ~~**`ORDER BY` / `LIMIT` + external merge sort**~~ **Done, v14 — both halves.** `LIMIT`: a real `Limit` plan node and operator that stops pulling once the cap is reached and closes the tree beneath it, so an unfulfilled `SeqScan` genuinely never reads the rest of the table. `ORDER BY`: a real `Sort` plan node and operator (`exec/sort.ts`) running the textbook external-merge-sort algorithm (`/tools/sort`'s worked example, generalised to real rows) over the actual table — `memPages` pages sorted in memory make one run each, later passes merge `memPages − 1` runs at a time — and every run/merge-pass page it writes or re-reads goes through the *real* buffer pool: a new `BufferPool.write()` path, competing for the same frames a heap scan uses (real evictions of heap pages by spill pages and back). Page ids are never reused (`sortTempPageCount` reserves a fresh block per pass, sized generously above the perfectly-packed count); `runQuery.ts` adds the reservation before the pool exists. `predicate-pushdown`/`index-selection` see past a `Sort` exactly as they do a `Limit` (`unwrapSort`/`rewrapSort`); the cost model prices a Sort's own spill I/O; `Sort` combined with `Limit` caps the *output*, not the scan — Sort must see every row before it can produce one, and the narration says so. `BufferPoolPanel` gained a `writes` stat and a violet "✎ written" mood | ~1 wk | v1 | An in-memory `.sort()` with a cap. The spill *is* the teaching — it puts sequential writes and merge-pass reads through the buffer pool, a shape the current single query cannot make |
| ~~**Aggregates + `GROUP BY` — hash aggregate vs. sort aggregate**~~ **Done, v14 — both strategies, plus the `/compare` mode.** `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` in the SELECT list, and `GROUP BY` on one or more columns, are real — a `SelectItem` union (plain column, or an aggregate call) replaces the old flat column-name list. **Hash aggregate:** a `HashAggregate` plan node sits between `Filter` and `Project`, computed by an operator that — like `Sort` — cannot stream: it builds one hash-table bucket per distinct `GROUP BY` combination (a single bucket, with no `GROUP BY`, over the whole input) on its first pull, then streams the finished groups. **Sort aggregate:** a `SortAggregate` node computes the identical `groupBy`/`aggregates` by sorting the input on the `GROUP BY` columns first — `externalMergeSort` generalised from a single-column key to a composite tuple, so `ORDER BY`'s `Sort` and `SortAggregate` share one driver rather than two — spilling through the real buffer pool exactly as `Sort` does, then a single streaming pass collapses each run of equal keys into a group. Same output, same row count either way; only the I/O differs, which is the entire point of naming two strategies. Nothing in the pipeline picks between them on its own: `EngineOptions.aggregateStrategy` (`'hash'` by default, so every existing caller is unaffected) is how `/compare`'s third mode forces each side explicitly, the same way its index-vs-scan mode forces "no index" by dropping `indexedColumn`. `constant-folding`/`predicate-pushdown`/`index-selection` all see past *either* aggregate node the same way they already saw past `Sort`/`Limit` (`unwrapAggregate`/`rewrapAggregate` now cover both), and the cost model prices a `SortAggregate`'s own spill on top of `HashAggregate`'s existing group-count estimate. 19 new unit tests, 1 e2e | ~1 wk after `Sort` | **Done, v14** | Only one strategy would have left nothing to compare — the `/compare` axis was the whole point of naming two |
| ~~**Cost-based optimizer with visible estimates**~~ **Done, v14.** `planner/cost.ts` — per-node row/page estimates from named heuristics (equality `1/ndistinct`, open range linear over the column min–max, `AND` = product/independent), rendered as a `~N rows` line with its basis on every plan/optimize tree and in `/tools/planner`, and reconciled against the executor's real count in the result narration. The rules do not consult the numbers; `emit.ts` annotates the trees and the index-selection step's narration carries the scan-vs-lookup page comparison. 19 unit tests (`__tests__/cost.test.ts`) | ~1 wk; no new operator, no schema change, no backend | **Done, v14** — first engine item off the lifted §9 gate | Inventing costs with a decimal point the model cannot defend — §12's "plausible but false". The honest version shows the heuristic *and* the actual count together, the way the `EXPLAIN` row below does |
| ~~**Write path — `INSERT` / `UPDATE` / `DELETE`** — puts B+Tree insert/split and `deleteKey` (built v12) *in the pipeline*, not just `/tools/btree`, plus dirty-page writeback~~ **Done, v14 — all three statements.** A single broader parser entry point, `parseStatement`, dispatches `SELECT`/`DELETE`/`INSERT`/`UPDATE` on the first keyword, sharing every grammar piece below statement level (`Cursor`, `parseExpr`, the parenthesised-list and literal-value parsers); `parse` stays `SELECT`-only for its existing callers. `DELETE` and `UPDATE` find their matches with a dedicated find-then-mutate pass (`exec/delete.ts`, `exec/update.ts`) rather than a reused Volcano operator — mutating mid-scan could shift what a later step reads — but narrate through the same `execute`-stage shape `SELECT` uses, take real exclusive locks on the pages they touch, and reuse `predicate-pushdown`/`index-selection` unchanged by wrapping the scan in a throwaway `Project *` for optimization. `INSERT` writes the new row onto the last heap page if it has room or a fresh one otherwise (`BufferPool.write()`, the same fresh-page path `Sort`'s spill uses); `DELETE`/`UPDATE` instead mark the page they changed dirty (`BufferPool.markDirty()`), so an evicted dirty page costs a write back, not just a discard. Every index change runs the real B+Tree algorithm, never a stand-in: `deleteKey` for a removal, `insert` for an addition (real leaf/internal splits, narrated by node-count and height before/after) — and `UPDATE` runs *both in sequence* when the indexed column itself changes, since a B+Tree has no in-place rekey, which is why it was scoped as the hardest of the three. `INSERT` has no predicate to plan, so it is the one statement that skips the Planner and Optimizer stages entirely and goes straight from parse to execute — an honest gap the pipeline tracker shows, not a bug. No heap-mutation step is needed anywhere: `ctx.heap`/`ctx.tree` are rebuilt fresh every `runQuery()` call, so the Playground persists the *new* table (`RunResult.write`) rather than patching the old one | ~1.5 wk | v1 | Skipping the writeback. "The page is now dirty, so evicting it costs a disk write" is the buffer pool's other half |
| **More optimizer rules, each a visible before/after** — projection pushdown, constant folding, `col = col`, `OR`→`IN`. **`constant-folding` done, v14:** a comparison whose truth value never depends on the row — two literals (`5 > 3`), or a column compared with itself (`age = age`, covering `col = col`) — folds to a boolean at optimize time, and an always-true conjunct drops out of the predicate (`X AND true ≡ X`). Deliberately does not act on an always-false conjunct: v0's plan shape has no node for "this scan returns no rows" without inventing one, so a `1 = 2`-shaped clause is left exactly as written — the query still runs correctly either way, just without the optimization. Runs first, ahead of `predicate-pushdown`, so a folded predicate is what the later rules and the cost model see. `projection pushdown` stays out of scope: v0's heap stores whole rows per page (§7), so narrowing which columns a scan "reads" would save nothing real to demonstrate — the kind of discount §12 rules out. `OR`→`IN` needs `OR` in the grammar first, which v0 does not have | ~½ day each behind the existing `Rule` seam in `optimize.ts` | v1 | Stopping too late and rewriting a query into something the learner can no longer recognise as theirs |
| ~~**In-app `EXPLAIN` / `EXPLAIN ANALYZE`**~~ **Done, v14.** A **Copy as EXPLAIN** button beside Copy as text/Mermaid, offered once the query has actually run (the result stage — `EXPLAIN ANALYZE` needs an execution, same as Postgres). `explainToText` (`src/export/toText.ts`) walks the final annotated plan tree and, for each operator, prints the cost model's `est ~N rows` next to the `actual N rows` `ViewState.operators` already tracked — no new engine surface, no new `RunResult` field. 7 unit tests, 1 e2e | ~½ day once the cost model exists | **Done, v14** | Confusing it with §20.6's paste-in-real-Postgres viewer (declined, own product). This explains *QueryLens's own* query — no dialect parser, no bottleneck heuristic |
| **Composite & covering indexes** — an index-only scan (never touches the heap), and two candidate indexes the optimizer must choose between. **Index-only scan done, v14:** a fourth optimizer rule, `index-only-scan`, fires after `index-selection` when the SELECT list needs nothing but the indexed column itself — the leaf's key already *is* the answer, so `emitIndexLookup` gained a `touchHeap` parameter (default `true`, every existing caller unchanged) that skips the heap page's fetch and lock entirely when passed `false`. A new `IndexOnlyScan` plan node and executor operator; the cost model prices it at the B+Tree's height alone, no `+1` for a heap page it never reads — a real, measured discount (3 pages instead of 4 on the seed data), not a claimed one. Deliberately narrow: no residual conjunct allowed (a recheck needs the row), and no `Sort`/`HashAggregate` in between (an index-only result is always exactly one row). **Second candidate index done, v15.** `Table.indexedColumn?: string` widened to `indexedColumns?: string[]` — each entry its own independent single-column B+Tree, not a composite (multi-column) key over several columns at once, which stays open below. `buildIndexes` (`index/build.ts`) builds them in turn, each starting where the last one's own page ids left off, so however many a table declares, none collide with the heap's or each other's; `pageCountFor` widened the same way, to the *highest* of every tree's `nextPageId`. `ExecContext.tree: BPlusTree | null` became `trees: Record<string, BPlusTree>`, looked up by the column an `IndexScan`/`IndexOnlyScan` node already names — the write path (`insert`/`delete`/`update.ts`) loops over every declared column, maintaining each tree in turn, and `UPDATE` only reindexes the ones whose own column actually changed. `index-selection` picks the more selective candidate when two or more each have a matching equality conjunct, by `ndistinct` — the same fact the cost model's own equality-selectivity estimate already rests on, not a new page-cost comparison inside the rule (§12's "plausible but false" line). A genuine tie (both candidates equally selective) is narrated honestly as a tie broken by declaration order, not as one "beating" the other — caught live against the shipped `posts` fixture (`id`/`title`, both fully unique) before it shipped wrong. `posts` ships with exactly that second index now, `title` — deliberately not `authorId`, which repeats (4 distinct among 10 rows): this B+Tree's `insert` is "last writer wins" on a duplicate key (v0 indexes a unique column, by design), so indexing a repeating column would make `WHERE authorId = 1` silently return one row instead of three — found by actually running the query against the first choice, not by inspection. `SchemaEditor.tsx`'s single-index `<select>` became a real `<select multiple>`; `customDatabase.ts`'s defensive parse validates every entry names a real column and none repeats. 20 new unit tests (five of them the tie-narration case above), 2 e2e (one new, one extended to a real two-index selection). **Still open:** true composite (multi-column) indexes, and reaching `index-selection`'s own choice into a `Join`'s children | ~1 wk, rides the cost model | v1 | Treating "index-only" as a footnote. It is a third point on the lookup-vs-scan line §9 draws |
| **Enforced concurrency** — a second transaction, a waiter queue on the lock manager (`locks/lockManager.ts` tracks holders but not waiters), real blocking, deadlock detection with victim selection. **Done, v14, as `/tools/locks`'s own driver:** `src/ui/lockSimulation.ts` is pure and total, like `externalSort.ts` — two named transactions place `shared`/`exclusive` requests against numbered pages; a conflicting request joins a real FIFO waiter queue per page (batching consecutive compatible `shared` waiters, stopping at the first `exclusive`, the standard fairness trade-off); every request rebuilds the wait-for graph fresh and checks for a cycle back to itself. Victim selection: the *youngest* transaction in the cycle — the one whose first request came later — is aborted, its locks released and its blocked requests promoted where that makes room. `src/engine/locks/lockManager.ts` (the SQL pipeline's own, single-query lock tracker) is untouched on purpose: v0 runs one query at a time, so nothing there ever contends | ~1.5 wk | v1–v2; powers `/tools/locks` (§22.3) | Drawing the deadlock without the victim choice. Deciding whom to abort — youngest transaction, fewest locks held — is the interesting half |
| **MVCC / snapshot isolation** (§4 deferred) — tuple versions, `xmin`/`xmax`, a visible snapshot, vacuum; the natural home for the lock panel to become real | large | **v2, hard-gated on §9** — a second product by question 5 | — |
| **WAL + crash recovery** — a redo log, checkpoint, replay-after-crash; pairs with steal/no-steal and force/no-force in the buffer pool | large | **v2, hard-gated on §9** — a second product | — |

### 22.3 New standalone tools (`/tools/*`)

Every one renders through §20.2's primitives — `PanelPage` and the non-SQL `StepEvent` driver
(`bufferTrace.ts` is the worked example) — and slots into §21.3's catalogue with a route and a
URL-state schema. None needs a backend.

| Route | What it is | Cost | Earliest |
|---|---|---|---|
| `/tools/planner` | ~~Toggle optimizer rules and table stats, hand-author a predicate, watch the plan rewrite~~ **Done, v13.** Takes SQL (like `/tools/parser` — the "non-SQL driver" is infrastructure that does not exist and a text box sidesteps it); shows the canonical plan next to the optimised one, a checkbox per rewrite rule (`optimize` gained an optional enabled-set; `OPTIMIZER_RULES` is exported) and one for the `id` index, and a ledger saying for each rule whether it fired, found no match, or was turned off. **v14:** every node now carries the cost model's `~N rows` estimate and its heuristic — the "table stats" this row deferred. Validation is `runQuery`'s own | ~2 days — the rules already exist; it needs the non-SQL driver | v1 |
| `/tools/locks` | ~~Two transaction timelines; place lock requests, watch a wait-for edge form and a deadlock resolve~~ **Done, v14.** `T1`/`T2`, four numbered pages, a request form (transaction, page, mode) and a per-transaction "release" button on each held lock. A per-page state grid shows every holder and waiter directly — the wait-for edges are legible without a separate graph drawing, since a waiter card sits right next to the holder card it names. A **Deadlock example** button seeds the classic two-cycle in one click; the timeline narrates each step, coloured by what actually happened (grants and promotions green, the deadlock itself red, everything else neutral) rather than by which API call produced it, since one deadlocked request's own narration bundles both the bad news and the good | rides §22.2's enforced lock manager | v1–v2 |
| `/tools/sort` | ~~External merge sort — run generation, k-way merge, an I/O counter~~ **Done, v13.** `src/ui/externalSort.ts` is the driver (§4 has no `Sort` operator yet): given a record count and a memory budget it lays out the whole plan — the sorted runs from run generation, every `(memPages−1)`-way merge pass after, and the `2·pageCount·(1+passes)` page I/O. `/tools/sort` renders it, no playback — parameter-driven and cross-highlighted like `/tools/page`: click a merged run to colour its records by source and light the runs that fed it. `memPages` clamped ≥ 3 so the fan-in makes progress | ~3 days, or free once §22.2's `Sort` exists | v1 |
| `/tools/hash-join` | ~~Build and probe phases, hash collisions, partition spill (Grace hash join). The engine's own hash join (§22.2, v14) has no partitioning or spill — this tool's own driver would need to invent the collision/spill visualisation from scratch, the same way `/tools/sort` doesn't just render `Sort`~~ **Done, v14.** `src/ui/hashJoin.ts` is the driver: given a build-key list, a probe-key list and a memory budget, `planHashJoin` lays out the whole plan up front, the same "own driver, no playback" shape `externalSort.ts` established — `numPartitions = memPages − 1`, each level's `h1` a Knuth multiplicative hash keyed by a *different* constant per level (so a partition still too big after one pass genuinely redistributes on the next, rather than repeating the same split), a hard depth cap of 2 so a heavily-skewed build side (many equal keys, which no hash of the value alone can ever separate) still terminates rather than recursing forever. A leaf partition's build phase hashes again with `h2 = key mod numBuckets`, `numBuckets` sized so two keys share a bucket on average — collisions are the point, not an edge case — and its probe phase reports each probe key as a genuine match, a bucket collision that still failed the equality check, or a clean miss. `HashJoinToolPage.tsx` renders every partitioning level as its own row (a dashed box split further, a solid one is a leaf), and a leaf's own bucket table and match/miss list below, selectable by clicking a leaf. One real bug caught by looking at the tool in the browser, not by any of the 19 unit tests written first: an initial level-1 multiplier (40503) was itself a multiple of 3, so at the tool's own default parameters (`numPartitions = 3`) every key collapsed into a single partition — the "split" was a silent no-op. Fixed by picking multipliers confirmed coprime to 2–5, plus a 20th, regression test reproducing the exact scenario | own driver, ~3 days | **Done — v14** |
| `/tools/page` | ~~A slotted-page inspector: header, slot array, tuple data, free space, for one 4 KB page~~ **Done, v13.** `src/ui/slottedPage.ts` synthesises the layout (the engine's `Page` is only a `Row[]`, §7 — not "a pure view over `storage/page.ts`" as scoped, but no engine change); the tool is the map + a per-tuple byte table with cross-highlight, and a page-size slider so four toy rows visibly fill 5% of a 4 KB page | ~2 days | **Done — v13** |
| `/tools/grammar` | ~~A railroad diagram of the supported subset, generated from the parser's own structure so it cannot drift (`GalleryPage`'s discipline)~~ **Done, v14.** `src/ui/grammar.ts` holds the grammar as data — a `GrammarPart` union (literal, rule reference, choice, optional, repeat) — mirroring `parser.ts`'s own BNF comment line-for-line, not a curved-arrow railroad but the same information: a keyword pill, a clickable box for a rule reference that jumps to that rule's own row, a dashed bracket for anything optional, a loop glyph with its separator for anything repeated. `__tests__/grammar.test.ts` is the actual anti-drift mechanism `GalleryPage`'s discipline calls for: every rule reference must resolve to a real rule, every all-caps literal must be a real tokenizer keyword or a real aggregate function name, and one representative query per rule is run through the *real* `parseStatement` — 21 tests, and two of them caught real bugs during development (three missing terminal rules for `identifier`/`number`/`string`, and `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` not being tokenizer keywords, which `AGGREGATE_FNS` — now exported from `parser.ts` — exists to recognise by name instead). Building it also caught a real, pre-existing drift bug: `parser.ts`'s own header comment had gone stale, missing `GROUP BY` entirely from a rule written before aggregates existed — fixed alongside | ~2 days | **Done — v14** |

### 22.4 Learning & classroom surfaces

- **The six missing `/learn` lessons.** ~~The track is four (§21.3); §17.2 lists ten manual pages.~~
  **Done, v13.** Five added — B+Tree split, edit the seed data, predict before you look, share a
  moment, when something goes wrong (`make the planner change its mind` had already shipped as
  lesson four; the keyboard reference stays a docs page, not a task). Each is an ordered lesson whose
  Playground links are engine-computed (`src/pages/learn/lessons.tsx`'s existing rule); the B+Tree
  split lesson links to `/tools/btree` instead, via a new fixed-link field on a step. No engine
  change.
- **Challenge mode.** ~~Goal-shaped puzzles with a client-side check~~ **Done, v13 — eight puzzles.**
  `/challenges`, each a **pure predicate over a `RunResult`**: the first cut of five (`use the
  index`, `force an eviction`, `exactly one row`, `empty result but real work`, `AND that still
  matches`) plus three more that lean on v13 — `push the filter down` (predicate-pushdown fires but
  index-selection does not, the inverse of `use the index`), `a lookup on the big table` (an
  `IndexScan` on `orders`, a level deeper than `users`), and `the selective end of a skew` (a scan
  on `logins` that returns fewer than twenty rows). A `Challenge` may now name a `dataset` (§22.7);
  the check runs against it and the "step through in the Playground" link carries `t=`. Each
  `/challenges/:id` has a `SqlEditor`, a Run-&-check button, a rows / disk-reads / evictions /
  index-used readout and a verdict; solved marks in `localStorage` (`challengeProgress.ts`); footer
  nav. No backend, no engine change.
- **Progress dashboard.** ~~Stages visited, lessons done, prediction hit-rate — `localStorage`,
  degrades to empty. Feeds the second visit.~~ **Done, v13.** `/progress` (footer nav): lessons
  complete (`learnProgress.ts`), pipeline stages seen (`src/ui/progress.ts` — the Playground unions
  `visited` into `localStorage` each step), and the prediction record (recorded on each committed
  answer). All degrade to a "nothing tracked yet" empty state; a Clear button wipes both stores.
- **In-app quiz / self-check.** A bank of mechanism questions scored client-side, with a streak in
  `localStorage`. **The caveat is the whole decision:** the §9 post-test is exactly this shape, so
  shipping the study's own bank in the app contaminates the study. A disjoint bank is fine; the same
  one is not. Trigger: after the §9 study runs, not before.
- **Assignment sets.** ~~Bundle several `/assignments/new` links into one sheet with a class code,
  as a URL or a downloadable JSON.~~ **Done, v13.** An "Add to set" step on the authoring form
  collects labelled links; the panel below emits a numbered **Markdown worksheet** (to paste into an
  LMS or print) and a **JSON** file (`src/ui/assignmentSet.ts`, unit-tested). Stops short of graded
  submission — §20.5's backend line is unchanged.

### 22.5 Export & presentation (extends §20.3)

- **Copy as text / ASCII trace.** ~~A pure function beside `src/export/toMermaid.ts` that renders
  the AST, plan or tree as monospace art for a code review or an email — no renderer, no CSP
  question.~~ **Done, v13.** `src/export/toText.ts` (`astToText` / `planToText` / `indexTreeToText`),
  a `tree(1)`-style indented list in a bare ` ``` ` fence, behind a shared **Copy as text** button
  in `StageDetail`'s header. Landed as the Mermaid export's twin — and it *does* take the B+Tree,
  which a fixed-width tree renders fine where Mermaid could not (§20.3).
- **Trace export / import as JSON.** ~~"Download this trace", "load a trace from a file". §14.1 item 4
  already assembles the crashing state for the error boundary; this generalises it.~~ **Done, v13.**
  `src/ui/traceFile.ts` + **Download trace** / **Load trace** beside the Playground's *Copy link*.
  The file is that reproducer made round-trippable — `sql` / `policy` / `predictOn` / `step` / `rows`
  + a build stamp, and deliberately **no `events`** (the engine re-derives them; a second copy could
  only drift — §15.2 one level up). Parsed as untrusted input on the way back in, failing the whole
  load on a bad field. No backend, no engine change.
- **Presenter mode.** ~~Full-screen, larger type, auto-advance on an adjustable dwell, prediction
  suppressible, keyboard-only.~~ **Done, v13.** `src/ui/PresenterView.tsx` — a full-viewport overlay
  on the Playground (`?present=1` opens it on load, a **Present** button otherwise) over the same
  live `playback` and trace: the current stage panel large, the narration at `text-heading`, the
  transport, and a `role="dialog"` with a focus trap and `Esc` to leave. Prediction is suppressed
  while it is open (`askToPredict = predictOn && !presenting`) — a prompt card mid-demo stops the
  room. "Auto-advance on a dwell" is the existing Play + speed selector; the browser Fullscreen API
  is offered where available. Axe-clean (the smoke suite now checks the overlay too). No engine change.
- **B+Tree copy-as-Mermaid.** §20.3 left it out because Mermaid lays a sibling chain out badly —
  still true for `graph`; a `classDiagram` with explicit rank hints is a maybe. Low priority, v1+.
- **`@querylens/embed` component package.** §20.3's v1+ item, gated on a named author asking for an
  in-page embed. Unchanged; listed here for completeness.

### 22.6 Accessibility & reach

- **Live narration track (`aria-live`).** ~~Every `StepEvent` already carries a `label` written as
  narration (§7.8); routing it to a polite live region lets a screen-reader user step the trace and
  hear each event.~~ **Done, v13.** The wiring existed but was subtly broken for the case that
  matters most: the narration `<p>` was swapped out for the prediction card on a gated step, so it
  re-mounted with the very text it needed to announce and a screen reader stayed silent. It is now
  permanently mounted (`aria-atomic`), drops to `sr-only` while the card shows, and `stepAnnouncement`
  (pure, unit-tested) feeds it the position, then the narration, then the prediction question and its
  verdict. §8's accessibility bullet points at it.
- **Full text transcript.** ~~The narration lines as a numbered, linkable, printable list, each line
  a deep link into the Playground. Overlaps `/trace` but prose, not JSON — and it doubles as a
  control-group artefact for §9.~~ **Done, v13.** A **Transcript** view on `/trace` beside the
  table (`v=transcript` opens straight to it): a numbered `<ol>` of every event's `label`, each row
  a Playground link, with a **Print** button and an `@media print` block (`src/index.css`) that
  drops everything but the list so it prints as a paper worksheet. No new route.
- **Non-colour encoding for the storage hues.** ~~Hit/miss/evict and internal/leaf are hue-only
  today. Add a shape or texture channel — always on, not a mode — for colour-vision deficiency and
  projector wash-out.~~ **Done, v13.** The redesign's node/mood *labels* (`INTERNAL`/`LEAF`,
  `HIT`/`DISK READ`/`EVICTED`/`SWEPT`) already carried a text channel; v13 adds a pre-attentive
  glyph in front of each — a filled disc vs a hollow ring for internal vs leaf (`FlowTree`
  `kindIcons`), and `✓ / ↓ / ✕ / ↻` on the buffer moods and the stat counts — so the distinction
  survives a washed-out projector at the back of a lecture hall. Always on, no mode.
- ~~**Print stylesheet.** A query and its trace as a printable worksheet, for a room without laptops.
  ~1 day. v1–v2.~~ **Done, v13.** A **Print** link on the Playground (and Ctrl-P) renders
  `src/ui/TraceWorksheet.tsx` — the query, the run's settings, and a numbered list of every step's
  narration with the predict-then-reveal steps marked. It is mounted *only* while printing (a
  `beforeprint` / `matchMedia('print')` effect + `flushSync`), so its copy of the whole trace never
  sits in the on-screen DOM. The `@media print` hook in `src/index.css` generalised from the
  transcript's `[data-transcript]` to a shared `[data-print]`, which also picks up the `/trace`
  transcript and the docs article — so Ctrl-P on a docs page now prints the page, not a blank sheet.
- **i18n scaffold.** §17.3's licence position already contemplates translation. String extraction
  plus one non-English locale is v2 — do not build the machinery before someone commits to
  maintaining a locale.

### 22.7 Data & input

- ~~**Multi-table schema editor.** The hard prerequisite for JOIN (§22.2): add and rename tables and
  columns, declare an index. `src/engine/seed.ts` is one table today.~~ **Done, v14.** `Database.tables`
  already held more than one table (`Record<string, Table>`) — nothing in the engine actually required
  "one table" once JOIN's `runQuery.ts` needed a second heap sharing the buffer pool with the first, so
  the whole item came down to a UI: `src/ui/customDatabase.ts` (`loadCustomDatabase`/`saveCustomDatabase`,
  `localStorage`-backed, opening on the same `authors`/`posts` starter `/tools/planner` uses) and
  `src/ui/SchemaEditor.tsx` (add a table — name, comma-separated columns, an optional index — remove
  one, or open its rows in a nested `DataEditor`, native `<dialog>`s stacking fine). A table/column name
  is validated by literally tokenizing it and checking for exactly one `identifier` token
  (`isValidName`) — reusing the real tokenizer rather than a hand-written regex means a SQL keyword is
  rejected for free (it tokenizes as `'keyword'`, not `'identifier'`), with zero risk of drifting from
  what `runQuery` will actually accept. The Playground gained a fourth "Data:" chip, **Custom**,
  alongside the three presets — `isCustom` is deliberately its own boolean, not a fourth `DatasetId`:
  widening that closed 3-value union would have dragged `urlState.ts`'s positional-by-known-columns `d=`
  encoding, `traceFile.ts`'s `TraceState.dataset`, and `datasets.test.ts`'s one-table-per-preset
  assertion into supporting an open-ended schema they were never designed for. A custom database is
  therefore **local only** — kept in `localStorage`, never in the URL or a trace file (`Download trace`
  is disabled with a tooltip explaining why while Custom is active) — the same privacy footing as
  `challengeProgress.ts`. `DataEditor` gained one optional prop, `onReset?`, so the row editor it already
  had could be reused as-is for a user's own table, which has no "seed" to reset to. 29 unit tests for
  the driver, 7 for `SchemaEditor`, 1 e2e covering the whole flow — add a table, edit its rows, JOIN it
  against an existing one in the real Playground, reload and confirm it persisted, switch back to a
  preset and confirm a clean exit. Column renaming after creation is deliberately out of scope for v1 —
  the query text itself would not follow along, so the honest v1 is "define columns once, at creation."
- ~~**Preset dataset library.** `users`, `orders`, a small `lineitem`, and a deliberately skewed
  distribution for the selectivity/cost story. §19.2's preset *query* chips have a companion in
  preset *tables*. **Note alongside §19.2**, ~2 days, rather than fresh scope.~~ **Done, v13.**
  `src/engine/datasets.ts` builds three single-table shapes (`§4` is one table at a time, JOIN-free,
  so `lineitem` without JOINs would just be "another table" — dropped): `users` (the 48-row
  baseline), `orders` (120 rows — a deeper B+Tree and a scan that evicts far harder), and `logins`
  (an 8:1 skew on `status`, so `= 'blocked'` returns 9 rows and `= 'ok'` returns 71 — the
  selectivity contrast, without the §9-gated cost framing). `src/ui/datasetCatalogue.ts` carries
  each one's label, blurb, starter query and preset *query* chips. A `Data:` chip row above the
  editor switches them; a new `t=` share key (and a `dataset` field in the trace file, both absent
  for the default) reproduces the choice, and `/trace` reads `t` too. The seed editor already took a
  `table` prop, so it followed for free.
- **CSV / paste import into the seed grid.** ~~A bounded row count, parsed as untrusted input — the
  §15.2 rule for the URL applies.~~ **Done, v13.** An **Import CSV** panel in the seed editor:
  `src/ui/parseCsv.ts` is a small RFC-4180-ish reader (quotes, `""`, embedded commas), total and
  bounded (500 rows, per-column type-coerced, an optional header row skipped), rejecting a malformed
  block whole with a reason — the §15.2 discipline. Unit-tested.
- **Larger datasets + the Web Worker.** §5 keeps the engine worker-ready for exactly this: a
  depth-3–4 B+Tree and a genuinely thrashing pool need more than 48 rows, and past some size the
  main-thread fold may jank. Trigger: a lesson or the cost model needs a tree taller than two. The
  worker move is designed (§5), not new design work.

### 22.8 Platform & ecosystem

- **`@querylens/engine` as a published package.** `src/engine/` is already pure, synchronous,
  React-free and serialisable (§5); publishing it lets others build lessons, graders and embeds on
  the same trace contract. Zero backend. Trigger: a second consumer exists. Do not publish an API
  before there is a caller — every export becomes a compatibility promise.
- **`npx querylens "SELECT …"`.** ~~A CLI that prints the trace in the §22.5 ASCII form.
  `scripts/trace.ts` is already this internally; publishing it is packaging, ~2 days.~~ **Built,
  v13 — not yet published.** `bin/querylens.ts` is the CLI: a positional query, `--policy`,
  `--dataset` (the §22.7 presets), `--json` for scripting, `NO_COLOR` / non-TTY colour suppression,
  and exit codes (0 ok, 1 query error, 2 usage). It is a thin wrapper over `runQuery` — the render
  functions and the arg parser are pure and unit-tested (`bin/__tests__/querylens.test.ts`).
  `package.json` has the `bin` entry; `pnpm querylens` and `pnpm trace` both run it, and the old
  `scripts/trace.ts` is gone. The remaining step is a deliberate one: a `dist/` build so it runs
  without `--experimental-strip-types`, a `files` allow-list, and `npm publish` — until then
  `npx querylens` is `node bin/querylens.ts` for anyone with the repo.
- **Operator / stage plugin seam.** §17.1's "how to add an operator or a stage" is a docs page; a
  real registration API turns QueryLens into a teaching *platform*. v2+, and only if the two items
  above find users.
- **`tokens.json`.** Already §16.4 P2; repeated here only as the shared dependency of the embed
  package, the CLI's coloured output and any future course theme.

### 22.9 Decision log

| Item | Verdict | Earliest | Trigger to revisit |
|---|---|---|---|
| Copy-as-text / ASCII trace | **Done, v13** (`toText.ts`, "Copy as text" — AST, plan **and** B+Tree) | M12 | — |
| Trace JSON export / import | **Done, v13** (`traceFile.ts` — Download / Load trace on the Playground) | M12 | — |
| `aria-live` narration track | **Done, v13** (`stepAnnouncement.ts` + the permanent narration live region; §8 pointer added) | v1 | — |
| The six missing `/learn` lessons | **Done, v13** (five added → nine lessons; keyboard ref stays a docs page) | v1 | — |
| Full text transcript | **Done, v13** (`/trace` Transcript view + print stylesheet) | v1 | — |
| Non-colour hue encoding | **Done, v13** (glyph channel on B+Tree nodes + buffer moods/stats) | v1 | — |
| Cost-based optimizer | **Done, v14** (`planner/cost.ts` — `~N rows` + heuristic on every plan/optimize node and in `/tools/planner`, estimate-vs-actual in the result narration; `__tests__/cost.test.ts`) | v1 | — |
| More optimizer rules | **`constant-folding` done (v14)** | v1 | Projection pushdown out of scope (no real I/O to save in a row-oriented heap) — **re-opened by §25.4 F3**, whose columnar `ColumnScan` gives it something to save; `OR`→`IN` needs `OR` in the grammar first — **`OR` lands in §25.4 B1** |
| In-app `EXPLAIN` | **Done, v14** (**Copy as EXPLAIN** on the result stage — `explainToText`, estimate next to actual per operator) | v1 | — |
| `ORDER BY` / `LIMIT` + external sort | **Done, v14** (`Limit` — a real Volcano short-circuit; `Sort` — `exec/sort.ts`, a real external merge sort spilling through the actual buffer pool, `BufferPool.write()`) | v1 | — |
| Aggregates / `GROUP BY` | **Done, v14** — hash aggregate, sort aggregate, and the `/compare` mode naming both | v1 | — |
| Write path (`INSERT`/`UPDATE`/`DELETE`) | **Done, v14** (all three statements — `exec/delete.ts`, `exec/insert.ts`, `exec/update.ts`; `BufferPool.markDirty()`/`write()`) | v1 | — |
| Composite / covering indexes | **Index-only scan done (v14); a second candidate index, chosen by selectivity, done (v15)** | v1 | Non-unique indexes (B3a), composite/leftmost-prefix (B3b), `UNIQUE` (B3c), bulk-load (B3d) and clustered (B3e): **done, v2.0 — §25.4 B3 complete** |
| JOIN + join-algorithm compare | **All three algorithms and predicate pushdown into a `Join` done (v14–v15)**, plus `/compare`'s join mode naming all three | v1 | Join order: **planned, v2.1 (§25.4 C3–C4)** — needs the multi-join grammar. An index nested-loop join is **done, v2.0 (B4)** |
| Multi-table schema editor | **Done, v14** (`SchemaEditor.tsx` + `customDatabase.ts` — a fourth "Custom" data chip in the Playground, local-only via `localStorage`, not the URL or a trace file) | v1 | Column rename after creation, still out of scope |
| CSV / paste import | **Done, v13** (`parseCsv.ts` + an Import CSV panel in the seed editor) | v1 | — |
| Preset dataset library | **Done, v13** (`datasets.ts` + `datasetCatalogue.ts` — `users` / `orders` / `logins`, a `Data:` chip row, a `t=` share key; `lineitem` dropped as JOIN-free filler) | v1 (with §19.2) | — |
| `/tools/planner` | **Done, v13**; **v14** adds the cost model's `~N rows` + heuristic on every node (the "table stats" it had deferred) | v1 | — |
| `/tools/page` (slotted-page inspector) | **Done, v13** (`slottedPage.ts` + `/tools/page`) | v1 | — |
| `/tools/sort` | **Done, v13** (`externalSort.ts` — its own driver; run generation, k-way merge passes, the page-I/O count, cross-highlighted) | v1 | — |
| `/tools/grammar` | **Done (v14)** (`grammar.ts`'s rule data, mirroring `parser.ts`'s own BNF; 21 anti-drift tests) | v1–v2 | — |
| `/tools/locks` | **Done (v14)** | v1–v2 | — |
| `/tools/hash-join` | **Done (v14)** (`hashJoin.ts` — Grace hash join, its own driver: partitioning, per-level spill, bucket collisions) | v1–v2 | — |
| Challenge mode | **Done, v13** (`/challenges` — eight `RunResult` predicates, three of them on the `orders` / `logins` presets, + solved-set) | v1 | — |
| Progress dashboard | **Done, v13** (`/progress` — lessons, stages seen, prediction record) | v1 | — |
| Assignment sets | **Done, v13** (`assignmentSet.ts` + a set panel on `/assignments/new` — Markdown worksheet + JSON) | v1 | — |
| Presenter mode | **Done, v13** (`PresenterView.tsx` — `?present=1` overlay on the Playground) | v1 | — |
| Print stylesheet | **Done, v13** (`TraceWorksheet.tsx` + a **Print** link on the Playground; the `[data-print]` `@media print` hook also covers `/trace` and docs) | v1–v2 | — |
| In-app quiz / self-check | **Planned, v2.5 (§25.4 G4) — as *generated* questions**, disjoint from the study's fixed bank | post-§9 | The §9 study has run (contamination) |
| Enforced concurrency + deadlocks | **Done (v14)**, as `/tools/locks`'s own driver (`src/ui/lockSimulation.ts`) | v1–v2 | — |
| `npx querylens` CLI | **Built, v13; unpublished** (`bin/querylens.ts` — query + `--policy` / `--dataset` / `--json`, pure render + arg-parse unit-tested; `npm publish` is the deliberate remaining step) — **publish planned, v2.0 (§25.4 H3)**, with an MCP wrapper (H4) | v1–v2 | — |
| `@querylens/engine` package | **Planned, v2.0 (§25.4 H3), as 0.x** — the trigger is met: the site and the CLI already are two consumers | v2 | npm-scope decision |
| Operator / stage plugin seam | Deferred | v2+ | The package and CLI find users |
| MVCC / snapshot isolation | **Planned, v2.2 (§25.4 D) — gated** | v2 | §25.6 checkpoint on the §9 result |
| WAL / crash recovery | **Planned, v2.3 (§25.4 E) — gated** | v2 | 2.2 shipped |
| B+Tree copy-as-Mermaid | Maybe | v1+ | A `classDiagram` layout proves acceptable |
| `@querylens/embed` | **Superseded by iframe embeds + essays, v2.5 (§25.4 H2)**; a package stays deferred | v2 | Verify CSP on a preview deploy first |
| i18n | **Conditional, v2.5 (§25.4 H5)** | v2 | A maintainer commits to a locale |
| Window functions / CTEs / full grammar | Declined | — | §4's subset stops teaching something it should |
| Visual `EXPLAIN` (paste-in real plans) | Declined here | — | §20.6 — a decision to serve DBAs, not this plan |

### 22.10 What this section deliberately does not add

In the discipline of §20 and [RESEARCH.md §21](RESEARCH.md#21-what-i-deliberately-left-out):

- **No milestone.** §20 added M12 and §21 added M13 because each had a small, launch-facing,
  do-it-now core. §22's do-it-now items — the ASCII trace export, trace JSON import/export, the
  narration track, the `/learn` lessons — fold into M12 or land incrementally in v1. The rest is a
  backlog behind the §9 study.
- **No MVP change and no §9 change.** The indexed-lookup-vs-sequential-scan build and the post-test
  that validates it are exactly as §9 leaves them.
- **No reversal of "nothing leaves your browser"** beyond the surface §20.5 already isolated (graded
  submission, its own privacy statement, its own subdomain).
- **No bigger parser than the teaching needs.** Window functions, recursive CTEs, a real dialect —
  out, for §4's reason: more grammar is more surface with no intuition the v0 subset does not
  already deliver.
- **No APM / production-plan tooling.** §2's non-goal and §20.6's separate-product line both stand.

---

## 23. Active Build Tranche (v15+) — Engine Depth, Join Algorithms & Interactive Polish

> Added in v15 after shipping M11's manual pages and the §9 study instruments. With the §9 gate
> lifted (§9, v14) and the write path, hash join, external sort, and SVG export all completed, this
> tranche takes the remaining high-leverage engine items, educational tools and UX gaps, filtered
> through §20.1/§22.1's 5 questions. Every item deepens the core teaching contrast (disk I/O, algorithm
> choice, physical execution), respects zero-backend isolation, and builds on existing engine primitives.
>
> **Status, v20 — closed.** Every item in §23.1's table and every line in §23.2's execution order is
> done, including the `README.md` restructure named under item 1's Clean Licensing & Governance row
> (§18.4): Vite chunking, `LICENSE-DOCS`, both editors' undo/redo, sort-merge join, range scans,
> predicate pushdown into Join, the two Concepts embeds, the four new challenges, and the README
> restructure itself, which surfaced and fixed two more stale Reference pages
> ([Supported SQL](src/pages/DocsContent/reference/sql.mdx), [Engine limits](src/pages/DocsContent/reference/limits.mdx))
> along the way. Nothing from this tranche remains open.

### 23.1 Tranche Items — Scoped and Vetted

| Item | Scope & Implementation | Cost against `src/` | Educational Contrast / Justification |
|---|---|---|---|
| **Sort-Merge Join (3rd join algorithm) + 3-way Compare** — **done, v15** | Complete the classic join triad. `SortMergeJoin` operator (`exec/sortMergeJoin.ts`) sorts left and right by join key (reusing `externalMergeSort`), then streams both with dual-pointer matching and duplicate run rewinding. Extends `Join.algorithm` to `'nested-loop' \| 'hash' \| 'sort-merge'` and `/compare` mode 4 to a 3-way view. | ~4–5 days; reuses `externalMergeSort` and `equalityKeyOf` | Teaches when each wins: Hash Join wins for unsorted inputs with a small build side; Nested-Loop wins for tiny outer with indexed inner; Sort-Merge wins when inputs are already sorted or downstream requires sorted output. |
| **B+Tree Range Scans (Leaf-Chaining Traversal)** — **done, v17** | B+Trees beat hash tables primarily because of ordered leaf chains. `engine/index/btree.ts` already has leaf `next` sibling pointers. Extend `index-selection` in `optimize.ts` to recognize range predicates (`>`, `<`, `>=`, `<=`, `BETWEEN`). Add `IndexRangeScan` plan node and operator: descend once to the start leaf, then step horizontally along sibling pointers without re-descending. Highlight horizontal path in `BTreePanel`. | ~3–4 days; `btree.ts` already links leaves | Demonstrates horizontal leaf pointer traversal vs vertical tree descent — one of the most fundamental concepts in database indexing. |
| **Predicate Pushdown into Joins** — **done, v15** | Currently, `WHERE` with `JOIN` acts as a top-level `Filter` after the entire join completes. Add `join-predicate-pushdown` rule in `optimize.ts`: evaluate conjuncts in `WHERE`, identify single-table predicates, and push `Filter` (or `IndexScan`) below the `Join` operator directly onto each child scan. | ~2–3 days; pure AST/Plan rewrite rule | Teaches the huge I/O and CPU reduction of filtering before joining: cutting 100 rows to 5 prior to nested-loop eliminates 95 full rescans of the inner table. |
| **Live Interactive Component Embeds in Docs (closes §17.4 DoD)** — **done, v18** | Replace static explanations on Concepts pages with live, interactive mini-widgets (`DocsComponents.tsx`). Embed interactive B+Tree sandbox in `concepts/btree.mdx` and interactive frame visualizer in `concepts/buffer-pool.mdx`. | ~2 days; uses existing UI panels in compact mode | Fulfills Carroll's minimalist documentation rule and closes the last open M11 definition-of-done checkbox without breaking Diátaxis separation. |
| **Expanded Challenge Pack (Joins, Spills & Writebacks)** — **done, v19** | 4 new goal-oriented puzzles in `/challenges`: (1) "The Sort Spill" (force external sort to spill temp pages to buffer pool), (2) "Hash Beats Loop" (craft a query where hash join beats nested-loop on disk reads), (3) "The Dirty Eviction" (perform an `UPDATE` that forces an evicted dirty page writeback), and (4) "The Range Leap" (use range scan to touch fewer pages than sequential scan). | ~1–2 days; pure `RunResult` predicates | Gives learners structured hands-on targets for the newly added v14 engine features (Sort, Join, Write path). |
| **DataEditor & SchemaEditor Safety (Undo/Redo)** — **done, v16, buttons only** | Add an in-memory undo/redo history stack in `DataEditor.tsx` and `SchemaEditor.tsx` with `Ctrl+Z` / `Ctrl+Y` and an explicit Undo button. | ~1 day; pure React state | Closes open UX debt from §15 (plan.md:894) preventing accidental loss of custom tables or row edits. |
| **Clean Licensing & Governance (closes §17.4 / §18)** — **done, v16/v20** | Ship `LICENSE-DOCS` (CC BY 4.0), verify `OFL.txt` font notice, and restructure `README.md` to be under 120 lines (moving architecture deep dives into docs). | ~1 day | Closes all open documentation and legal readiness checkboxes. |
| **Vite Chunking Modernization** — **done, v16** | Replace deprecated `advancedChunks` in `vite.config.ts` with Rollup `output.manualChunks` / Vite 8 `codeSplitting`. | ~0.5 day | Resolves the build deprecation warning and strictly ensures heavy libraries (`@xyflow/react`, CodeMirror) load only on routes that use them. |

### 23.2 Prioritized Execution Order

1. **Quick Polish & Governance (0.5–1 day) — done, v16 except where noted:**
   - ~~Modernize Vite chunking configuration in `vite.config.ts`.~~ Done: `output.advancedChunks` → `output.codeSplitting` (same `groups` shape, rolldown's own migration path — the deprecation warning is gone).
   - ~~Add `LICENSE-DOCS` (CC BY 4.0)~~. Done: root `LICENSE-DOCS` file, plus a "Docs licence" link in `Footer.tsx`'s existing Project column (the footer already stated "CC BY 4.0 docs" as a badge — see `Footer.tsx:121` — it just had nothing to link to). Font licenses were already verified (§17.3, v13/v14: `NOTICE` + per-font `OFL.txt`).
   - ~~`README.md` restructure.~~ Done, v20 (§18.4): 682 lines → 82, plus a new [Architecture](src/pages/DocsContent/architecture.mdx) docs page written fresh rather than moved verbatim, since the README's own decision-log content had drifted to v0-era scope. Two Reference pages — [Supported SQL](src/pages/DocsContent/reference/sql.mdx) and [Engine limits](src/pages/DocsContent/reference/limits.mdx) — turned out to have the same staleness (predating this session) and were rewritten too.
   - ~~DataEditor / SchemaEditor undo history (closes §15).~~ Done, both: `DataEditor.tsx` has a `past`/`future` snapshot stack, with keystrokes into the same cell coalesced into one undo step (tracked by a `lastEditTarget` ref) so undo doesn't mean "hold Z through every character typed." `SchemaEditor.tsx` got the same shape over its own `working: Database` — one entry per add-table, remove-table, or a committed row edit from its nested `DataEditor` — no coalescing needed, since every mutation there is already discrete.
2. **Engine Depth: Sort-Merge Join (3–4 days) — done, v15:**
   - ~~Implement `SortMergeJoin` operator in `src/engine/exec/sortMergeJoin.ts`.~~ (Landed as `sortMergeJoin` in `exec/operators.ts` rather than its own file — small enough to sit beside `hashJoin`/`join` without a new module.)
   - ~~Wire into `runQuery.ts`, cost model `cost.ts`, and `/compare` mode 4.~~
3. **Engine Depth: B+Tree Leaf-Chaining Range Scans (3 days) — done, v17:**
   - ~~Support range predicates in optimizer (`optimize.ts`).~~ `range-index-selection`, a new rule right after `index-selection`; only fires when no equality candidate exists (an equality always wins first, by rule order, never a cost comparison).
   - ~~Implement `IndexRangeScan` and animate sibling traversal in `BTreePanel`.~~ New plan node, executor operator (`index/rangeLookup.ts` for the narrated traversal), and a new `chain-next` step event; `FlowTree.tsx`'s sibling edges get the same `.is-active` treatment a lit hierarchical edge already gets, so the panel highlights the actual horizontal hops a scan took, not just the static dashed chain.
4. **Optimizer: Predicate Pushdown into Joins (2 days) — done, v15:**
   - ~~Push single-table conjuncts below `Join` node.~~
5. **Interactive Docs & Challenge Expansion (2 days) — done, v18–v19:**
   - ~~Embed live mini-widgets into `src/pages/DocsContent/concepts/*.mdx`.~~ Done, v18: `BTreeMiniDemo`/`BufferPoolMiniDemo` (`src/ui/DocsBTreeDemo.tsx`, `src/ui/DocsBufferPoolDemo.tsx`), reusing the existing `BTreePanel`/`BufferPoolPanel` exactly as scoped. Had to pull both pages out of `vite.config.ts`'s shared `docs` codeSplitting group once built — forcing them in merged `BTreePanel`/`FlowTree`/the engine's trace code into the *one* combined docs chunk every other docs page shares too (measured: 15.5 → 49.8 kB), rather than the small shared chunk Playground already gets them from.
   - ~~Add the 4 new v14-focused challenges to `/challenges`.~~ Done, v19: Sort Spill, Hash Beats Loop, Dirty Eviction, Range Leap. Widened `Challenge` with an optional `database` (a one-off `Database` no `DatasetId` names — the `authors`/`posts` JOIN demo) and `engineOptions` (forces `bufferFrames: 2` for Hash Beats Loop, the same reason `/compare`'s own JOIN mode does), and `check` now also receives the raw SQL text so Hash Beats Loop can rerun it itself under `joinStrategy: 'hash'` and compare two *real* algorithms rather than an estimate.



---

## 24. Where v1 Stands — the Retrospective

> Added in v21 (2026-09-24), the day after the first deploy. §1–§23 are the decision log of *how* v1 was
> built; this section is the one-page answer to *what it is*, *what it proved* and *what it did not* —
> the input to §25. Method and evidence: [RESEARCH.md Part IV](RESEARCH.md#part-iv--v2-research).
>
> **Numbering.** Two schemes coexist in this document. "**v1**" and "**v2**" in §24–§25 mean **product
> releases**: v1 is the application as deployed on 2026-09-23 — every tranche labelled v10–v20 in §10 and
> the appendix is *inside* v1 (those are build-revision counters, not releases); v2 is what §25 plans,
> delivered as releases 2.0–2.5. v1 is tagged **`v1.0.0`** (on the deployed commit `2b9a37d`, 2026-09-23);
> the CHANGELOG's `[1.0.0]` header and `package.json`'s `1.0.0` landed in the commit after the tag, so the
> tag itself still carries `0.0.0` in `package.json` — a published tag is not moved.

### 24.1 What v1 is

A 100% client-side, zero-server, zero-telemetry toy relational database engine — written from scratch in
TypeScript — that animates a SQL statement through **Parser → Planner → Optimizer → Execution → Buffer
Pool → B+Tree Index → Locks → Result**, one inspectable step at a time. Every number on screen is the
engine's own. The engine is a **pure synchronous function** (`runQuery(sql, db)` → events + rows) with no
React, no DOM and no async; the UI folds the event array into state, which is what makes scrubbing
backwards, share links, trace files and the CLI all fall out of one contract (§5, §7.8). The learner
*predicts before each reveal* and *edits the data*, because the evidence (§12, RESEARCH.md Part I) says
engagement, not fidelity, is what teaches. Live at `https://query-lens.1234naveenboddepalli.workers.dev`
(Cloudflare Workers static assets, `wrangler.jsonc`).

### 24.2 v1 by the numbers **[counted from the repo, RESEARCH.md §36]**

| | |
|---|---|
| First commit → first deploy | **23 days** (2026-09-01 → 2026-09-23), 106 commits — against §10's 10–14 weeks for the MVP alone |
| Source | 23.7k lines TS/TSX (8.7k in `src/engine/`, **0 files import React**) + 0.9k lines MDX |
| Tests | **1,170 unit** (56 files, 9.6k lines) + **79 e2e** (2.0k lines, axe in both themes) |
| Surface | 14 top-level routes · 8 stage explainers · 9 lessons · 12 challenges · 9 `/tools/*` · 12 docs pages |
| Engine | 4 statements · 6 optimizer rules · 3 join algorithms · 2 aggregate strategies · 6 buffer-pool policies · cost estimates on every node |
| Bundle | **377.9 / 424 kB** gzip; `standalone-tools` 42.7/43 and `trace-ui` 55.5/56 are **at their ceilings** |
| Quality | securityheaders.com **A+** · axe clean · CI: 6 jobs + a gate, SHA-pinned actions, read-only token · no telemetry |
| Validation | **§9 post-test not run** |

### 24.3 What shipped, by layer

| Layer | Shipped in v1 |
|---|---|
| **Engine** | Tokenizer + recursive-descent parser (`SELECT`/`INSERT`/`UPDATE`/`DELETE`; `WHERE` with `=` `<` `>` `<=` `>=` `BETWEEN` `AND`; `GROUP BY` + 5 aggregates; `ORDER BY`; `LIMIT`; one `JOIN`) → planner → six-rule optimizer (`constant-folding`, `predicate-pushdown`, `join-predicate-pushdown`, `index-selection`, `range-index-selection`, `index-only-scan`) → cost annotations → Volcano executor (`SeqScan`, `IndexScan`, `IndexOnlyScan`, `IndexRangeScan`, `Filter`, `Project`, `Sort`, `Limit`, `HashAggregate`, `SortAggregate`, nested-loop / hash / sort-merge `Join`) → buffer pool (LRU + clock in the pipeline; + FIFO, second-chance, Bélády, InnoDB midpoint-LRU in the sandbox; dirty writeback) → B+Tree (insert, delete with borrow/merge, point, range with leaf chain) → page-level lock tracker |
| **Playground** | Run / step / scrub / speed; predict-then-reveal; editable seed rows + CSV import + undo/redo; 3 datasets + a **Custom** multi-table schema editor; share links; trace files; presenter mode; print worksheet; a 60-second tour; keyboard shortcuts |
| **Learn** | 9 lessons that deep-link into the exact step · 12 challenges (each a pure predicate over a run) · `/progress` · 8 stage explainers · a gallery of named moments · `/compare` (index vs scan · policy vs policy · hash vs sort aggregate · three join algorithms) |
| **Sandboxes** | Buffer pool · parser · B+Tree · slotted page · external merge sort · planner · locks (2 transactions, deadlock, victim) · grammar · Grace hash join |
| **Classroom** | Assignment links with a reveal-lock, and sets (Markdown worksheet + JSON) · presenter · `/trace` inspector + printable transcript |
| **Export** | Copy as Mermaid / text / EXPLAIN · PNG · vector SVG · trace JSON · GIF/WebM recorder (`pnpm record`) · a CLI (`bin/querylens.ts`, built, **unpublished**) |
| **Docs** | 12 in-app MDX pages: getting started, task-shaped manual, concepts with live widgets, reference, architecture, FAQ; `LICENSE` (MIT) + `LICENSE-DOCS` (CC BY 4.0) |
| **Platform** | Light/dark/system theme · CSP + full header set (A+) · error boundary with a copyable repro · `aria-live` narration · non-colour encoding · gzip budget in CI · supply-chain floor (`minimumReleaseAge`, `allowBuilds`, `blockExoticSubdeps`) · own renderer `flowinger` for the trees |

### 24.4 The path, in one line each

| Stage | What happened |
|---|---|
| M0–M7 | The MVP: the eight-stage pipeline for a point lookup + the sequential-scan contrast; predict-then-reveal; editable data |
| M8, M9 | The deploy gate (§14) and UX gate (§15): CI, error boundary, headers, licence · run-on-load, native dialog, share URL, light theme |
| M10, M11 | Visual design + landing page (§16, §19) · docs, manual, licensing, governance (§17, §18) |
| M12, M13 | Portable artefacts (Mermaid / PNG / GIF) · site structure: SPA rewrite, code-splitting, one nav manifest |
| Builds v10–v13 | The multi-page app: gallery, tools, compare, learn, challenges, progress, assignments, presenter, print |
| Builds v14–v15 | **§9's *blocking* lifted.** Cost model, EXPLAIN, `LIMIT`/`ORDER BY` (external sort), the write path, aggregates ×2, index-only scan, `JOIN` ×3 + pushdown, schema editor, SVG export, locks / hash-join / grammar tools |
| Builds v16–v20 | Hygiene, undo/redo, B+Tree range scans, live docs widgets, four more challenges, README + Architecture rewrite |
| First deploy, 2026-09-23 | Needed **three fixes that no local check could have found**: an install-script allowlist written in the wrong YAML shape, an SPA rewrite that formed a redirect cycle on the newer Cloudflare engine, and a canonical URL pointing at a domain that never resolved (CHANGELOG, *Fixed*) |

### 24.5 What v1 proved — and did not

**Proved.**
1. **A real engine can be honest and still teachable.** Pure, synchronous, React-free, 1,170 tests; every
   visual is derived from events, so nothing can disagree with the engine.
2. **The multi-page tool shape ships accessibly and safely** — A+ headers, axe-clean in both themes, an
   accessible narration track, no third-party origin.
3. **Scope discipline held** — every tranche went through §20.1 / §22.1 and the backlog was worked in
   order, not by enthusiasm.
4. **Build speed is not the constraint.** 23 days against a 10–14 week estimate.

**Did not prove.**
1. **That it teaches.** The §9 post-test has never run; the prediction layer stands on literature, not on
   a measurement of *this* tool. §12's first risk (breadth before validation) was accepted at v14 and has
   grown with every tranche since.
2. **That anyone will come.** No launch, no traffic; the name is shared with at least five unrelated
   products (RESEARCH.md §45) and the live URL is a `workers.dev` subdomain with an account name in it.
3. **Correctness beyond self-consistency.** "True to this engine" has no external oracle behind it.
4. **Field performance.** INP on a lecture-hall laptop is still unmeasured (§14.2).
5. **That the deploy path is understood.** Three fixes on the first attempt say config was written
   against assumptions the platform had not been asked to confirm.

### 24.6 The known-limits ledger — v1's honest ceiling

From `reference/limits.mdx`, mapped to where §25 addresses each. **A sceptical student hits the first two
in ten minutes.**

| v1 limit | v2 item |
|---|---|
| Every B+Tree assumes a **unique key**; a duplicate silently overwrites (so `posts` cannot index `authorId`) | B3 — **closed by slice a, 2026-09-25** |
| A `JOIN` **never consults an index** — "nested-loop wins with a tiny outer and an indexed inner" cannot be shown | B4 — **closed 2026-09-25** (`index-nested-loop`; still forced from `/compare`, not chosen) |
| No `OR` / `NOT` / `IN` / `LIKE` / `IS NULL` / `DISTINCT` / `HAVING` / `OFFSET` / outer joins / subqueries | B1, B2, C3 |
| At most two single-column indexes per table (a docs claim, never enforced — corrected); no composite / covering / unique | B3 — composite, covering and `UNIQUE` **closed by slices b–c** |
| One `JOIN` per query — so no join *order* — and no `GROUP BY` / `ORDER BY` / aggregate beside it | C3, C4 |
| Rules fire on structure; **cost never decides**; no statistics, no plan enumeration | C1–C5 |
| Locks are visual-only: no transactions, one query at a time | D |
| No log, no recovery | E |
| Row store only; 48–120-row datasets (trees ≤ ~3 levels); engine on the main thread | F3, C6 |
| A custom database lives in `localStorage` only — not shareable | H7 |
| Narration is English strings emitted by the engine | H5 |

---

## 25. QueryLens v2 — Trust, Ceiling, and the Next Two Subjects

> Added in v21 (2026-09-24). Evidence: [RESEARCH.md Part IV](RESEARCH.md#part-iv--v2-research) (§36–§46);
> what v1 is: §24. This section plans **product v2** as six releases, 2.0–2.5, milestones **M14–M21**
> (§10). It follows §20 / §22 / §23's discipline: every item has a cost against `src/`, a dependency and a
> trigger; every subject that widens the product past §9's contrast is *gated*, not banned; and §25.10
> says what it does not add.

### 25.1 The thesis — v2 is not "more SQL"

1. **v1's largest unknown is evidence, not engineering** (§24.5). 23 days of building bought an engine;
   nothing yet says it teaches. v2 must spend effort where time could not.
2. **The course syllabus has a hole exactly where v1 stops.** Against CMU 15-445 Fall 2026's 23 content
   lectures v1 covers **6, partly covers 7, and misses 10** — and the six lectures from concurrency-control
   theory through recovery (**18–23, 26% of the course**) are all misses (RESEARCH.md §38).
3. **Two ceilings show in the first ten minutes** (§24.6): unique-key indexes, and joins that never use one.
4. **Competitors already own the breadth of scripted animations** — LSM, WAL, isolation levels, slotted page
   (RESEARCH.md §37). The moat is the thing a script cannot do: **outcomes computed by running the engine**
   and checkable against external ground truth (SQLite; Hermitage).

So the order is **Prove → Raise the ceiling → Make the optimizer decide → Add transactions → Add recovery →
Broaden storage engines**, with **reach and the learning layer** as a parallel track.

### 25.2 The filter — §20.1's four, §22.1's fifth, plus three

§20.1 (serves the §9 study? serves the launch? needs a backend / breaks "nothing leaves your browser"?
forks the audience?) and §22.1's fifth (deepens the §9 contrast or widens away?) all apply unchanged.
v2 **knowingly** answers the fifth with "widens" for transactions, recovery and storage engines — the
"second products" §22.1 named — which is why they sit behind a gate (§25.6) rather than in 2.0. Three new
questions, each earned by something v1 got wrong or nearly did:

6. **Does it ship with a lesson, a challenge and a text alternative?** A tool without the first two is a
   demo; a visualization without a data-table view is an accessibility regression (RESEARCH.md Part II §17).
7. **Does it keep the engine pure?** Concurrency, crashes and faults enter as **inputs** — a schedule, a
   fault point — never as threads, timers or `async` inside `src/engine/`. That is what keeps traces
   replayable, shareable and testable (RESEARCH.md §42).
8. **Does it fit a per-route budget?** `standalone-tools` and `trace-ui` are at their ceilings (§24.2).
   A new tool is its own lazy chunk with its own budget row; it may not grow a shared group to fit.

### 25.3 Release plan

| Release | Milestone | Theme | Scope (item IDs, §25.4) | Est. | Gate |
|---|---|---|---|---|---|
| **T0** | — | Cut v1 | **Done.** Tag `v1.0.0` at `2b9a37d`; CHANGELOG `[Unreleased]` → `[1.0.0] - 2026-09-23` and `package.json` → `1.0.0` in the next commit | — | — |
| **2.0** | **M14** Trust | Prove it | A1–A6: SQLite oracle, §9 study kit, "report a confusing step", name + domain | 3–4 wk | none — start now |
| | **M15** | Ceiling I | B1, B2, B5, B6: expressions, `DISTINCT`/`HAVING`, relational-algebra view | 3–4 wk | — |
| | **M16** | Ceiling II + launch | B3, B4 (real indexes, index join) · G1, H3, H4, H8 (course map, CLI/engine/MCP, budgets) | 4–5 wk | — |
| **2.1** | **M17** | The optimizer, honestly | C1–C6: statistics, q-error, multi-join + outer join, DP join order, cost-based choice + "Why not?", Worker | 8–10 wk | 2.0 |
| **2.2** | **M18** | Transactions | D1–D6: schedules, enforced locks, isolation levels, MVCC, the Hermitage matrix, CC compare | 8–10 wk | **§9 checkpoint** (§25.6) |
| **2.3** | **M19** | Durability | E1–E4: WAL, steal/force, checkpoints + crash + ARIES | 5–6 wk | 2.2 |
| **2.4** | **M20** | Storage engines & access methods | F1–F7: LSM + Bloom, hash indexes, columnar, vectorized, latch crabbing, vector index, pool depth | 8–10 wk, **parallelisable** | each passes Q6 |
| **2.5** | **M21** | Reach & the learning layer | G2–G6, H1, H2, H5–H7: confidence, misconception challenges, **generated quiz**, PWA, embeds, i18n, a11y depth, workspaces | 8–11 wk, **parallel track** | quiz after §9 |

**Main line 2.0 → 2.3 ≈ 31–39 weeks part-time; everything ≈ 11–14 months serial, or 7–9 months with 2.4 and
2.5 run alongside.** Estimates are in §10 / §22's units and are ceilings, not promises: v1 beat its own
estimate 3–4×. The schedule risk in v2 is **validation and maintenance, not typing** (§24.5, §25.7).

### 25.4 The item catalogue

Costs are against the modules that exist today (paths verified 2026-09-24). "Rel." is the release.

#### A. Trust — make the claims checkable

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **A1** | 2.0 | **SQLite oracle + metamorphic tests** | **Built, 2026-09-25 — and it paid for itself on its first run.** `oracle/` (top-level, Node-only; never imported by `src/`): (a) **metamorphic** — buffer size, page size, policy, join algorithm, aggregate strategy and index presence never change the rows; the optimized plan agrees with a direct evaluation of the predicate over the raw rows (NoREC-shaped); after writes an index lookup finds what a scan does; the trace is deterministic. (b) **Differential vs `node:sqlite`** (no dependency, no bundle bytes) with `fast-check` over generated typed tables (few distinct values, many NULLs, keys that overlap across two tables) and grammar-derived statements — `SELECT`/`WHERE`/`ORDER BY`/`LIMIT`, aggregates + `GROUP BY`, `JOIN`, and sessions of up to three writes followed by a read — with the engine options drawn per session so every join algorithm and both aggregate strategies are checked; multisets compare unordered, `ORDER BY … LIMIT` compares the *keys* of the first n rows (ties make the rows undefined). (c) TLP moves to B1, which is what introduces `NOT` and `IS NULL`. **A coverage suite fails the build if the generators stop reaching every optimizer rule, join algorithm, aggregate strategy, empty tables, NULLs or row-changing writes** — first-cut generators fired `index-only-scan` 5 times in 1,500 sessions, which is how a vacuous oracle looks; and injected bugs (`<` as `<=`, a `SUM` that drops a value, a hash join that indexes NULL keys, a sort-merge join that skips equal keys) are each caught. **A divergence ledger** (`oracle/ledger.ts`): seven runnable entries, each asserting both engines' recorded answers *and that they still differ*, so a fixed gap makes its own entry fail. CI runs seeded and bounded (1,000 cases/property — raised from 200 after injected bugs in rare query shapes survived 200 and 400 and die at 800 — part of `pnpm test`); `.github/workflows/oracle.yml` runs 20,000 with a fresh printed seed weekly, read-only, SHA-pinned. Docs page **"How we know the answers are right"**, its ledger table drift-tested against the ledger. **Bugs found and fixed:** `WHERE id > NULL` on an indexed column returned rows (a NULL bound read as "no bound"); `DELETE FROM t WHERE k = k` deleted the NULL-`k` rows (`constant-folding` called a column compared with itself always true — under three-valued logic it is UNKNOWN). Both have minimal regressions in `src/engine/__tests__/oracleFindings.test.ts`, verified to fail on the old code | 1–1.5 wk → **built in a day** |
| **A2** | 2.0 | **§9 study kit** | **Built, 2026-09-24 — not yet run.** As planned it was to be a fixed post-test inside an unlisted route; building it exposed a conflict with `STUDY.md` (the questions and control text must never ship publicly), so the design changed: `/study` is an inert **runner** and the whole instrument — consent, reading or lessons, questions, timings — travels in each participant's link *fragment* (`#p=…`, never sent to a server), generated from `STUDY.md` by `pnpm study links`. Kiosk mode (no nav or footer, so the control arm is not one click from the app's own explanations), reload-resume, timestamp-driven clocks, a copyable result code; `pnpm study collate` writes a **blind** scoring sheet (participant and arm removed) and `report` prints descriptive per-arm results with no p-value. An e2e test fails the build if study text ever reaches `dist/`. See STUDY.md §4 | built: ~1 wk; run: calendar |
| **A3** | 2.0 | **"Report a confusing step"** | **Built, 2026-09-25.** A link under the Playground's narration opens a prefilled GitHub **issue form** (`.github/ISSUE_TEMPLATE/confusing_step.yml`) carrying the build, the step ("step 7 of 33 — stage `buffer`"), the narration that was showing, the query and a share link that reopens the exact moment; the link is derived from the same `shareQuery` the address bar uses, so it can never disagree with Copy link. A plain `<a>` with `noreferrer` — nothing is sent until the reader presses Submit on GitHub; the FAQ says so. The URL degrades in three steps (drop the edited rows from the link, drop the link, drop the query) to stay under 6,000 characters. **Found on the way:** the crash report and the footer link used `issues/new?body=…`, but `config.yml` sets `blank_issues_enabled: false`, and with blank issues off GitHub sends a bare `issues/new` to the template chooser, losing the body — so both now name a template (`bug_report.yml`'s `description` / `repro` / `error-boundary` fields; the footer goes to `/issues/new/choose`), and three template links still pointed at the old `QueryLens` repo name. **Needs the repository to be public:** an unauthenticated request to `github.com/Naveen-Boddepalli/query-lens` (and its API) returns 404 as of 2026-09-25, so every GitHub link on the deployed site — this one, the footer's, the changelog's — is a dead end for a visitor until it is. Complements the crash repro | 1 day → **built** |
| **A4** | 2.0 | **Release discipline** | **Built, 2026-09-25** (T0, the v1.0.0 cut, was already done). `RELEASING.md`: a release is one commit with the tag *on it* (1.0.0's tag sits on the deployed commit and its `package.json` still says `0.0.0`); notes are **derived** — `pnpm release-notes [version]` (`scripts/release-notes.ts`, tested against the real CHANGELOG) turns a CHANGELOG section into the GitHub release body, so the two cannot disagree. A **deploy-config list** (`scripts/deploy-config.ts`: `wrangler.jsonc`, `public/`, `index.html`, `pnpm-workspace.yaml`, `.node-version`, each with why only a real deploy can judge it) feeds a non-blocking CI job that annotates a PR touching any of them, plus a PR-template checkbox — CI cannot know a preview was looked at, so it notices and asks. The post-deploy check (deep link, 404, headers, canonical/og URLs, robots, build stamp) is written down as the three 1.0.0 failures suggest | ½ day → **built** |
| **A5** | 2.0 | **Name, domain, launch** | **Name decided, 2026-09-24: keep "QueryLens", always paired with the descriptor "a database internals visualizer"** (the site's `<title>` already led with it; `package.json` and the README now do too). Why not rename: no namespace forces it — the unscoped npm names `querylens` and `query-lens` are unclaimed and nothing exists under `@querylens`; the repo lives at `Naveen-Boddepalli/query-lens`; and a rename touches the wordmark, favicon, OG card, `localStorage` keys, the CLI's name and every doc, for a problem a descriptor mostly solves (people find an education tool by "B+Tree visualizer", not by name). Why not the domains: `querylens.com`, `.io`, `.ai`, `.cc` and `.tech` are registered by others. **Domain — needs you to buy it:** `querylens.org` and `.net` show as unregistered in WHOIS, `.dev` and `.app` as not found in their registries' RDAP (WHOIS for Google's TLDs is inconclusive) — **confirm at a registrar; I checked, I cannot buy.** Recommendation: **`querylens.org`** (an education / open-source signal, matching MIT + CC BY docs). Then in the Cloudflare dashboard add it under the `query-lens` project's *Domains* and set `VITE_SITE_URL` in the build environment; the `vite.config.ts` fallback is then updated to match. **Revisit if** a rival contests the name or post-launch feedback shows confusion — rename while it is still cheap | decision made; domain: 1 day once bought |
| **A6** | 2.0 | **Field performance without telemetry** | **Built, 2026-09-25 — the opt-in half; CrUX waits for traffic.** `src/perf/inp.ts`: a participant may tick a *separate, unticked* box on the study's consent screen to have their own device's **INP** recorded — via the Event Timing API, grouped by `interactionId`, one outlier forgiven per 50 interactions (web.dev's definition), the true interaction total taken from `performance.interactionCount` so fast interactions still count toward the percentile — and included in the result code, with cores / viewport width / touch as context. It runs in the *app's* tabs (the lessons open in a new one) and reads through `localStorage`; it is a **lazy 1.1 kB chunk** fetched only after opt-in, never on `/study`, the opt-in is a **deadline** (3 h) rather than a flag so an abandoned session stops being measured, and it is captured once and deleted when the session ends. `pnpm study collate` puts it in the private map (never the blind sheet) and `report` prints median / worst / good / needs-work / poor with the honest caveat that a few devices are an anecdote. Verified in Chromium end to end: an 80 ms click handler in the lesson tab lands in the result code as `inp ≥ 60`. **CrUX** (Chrome's public field data) needs traffic; once the site has some, read it with PageSpeed Insights or the CrUX API for the origin — nothing to build, and it is on RELEASING.md's after-launch list | ½ day → **built** |

#### B. Raise the engine's ceiling

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **B1** | 2.0 | **SQL tier 2a — expressions** | **Built, 2026-09-25, in three slices. B1a — predicates, built 2026-09-25:** `OR` / `NOT` / parentheses (precedence `OR` < `AND` < `NOT` < a test), `<>` / `!=`, `IS [NOT] NULL`, `[NOT] IN (…)`, `[NOT] LIKE`, `NOT BETWEEN`, with real three-valued truth tables in `exec/evaluate.ts` (`NOT UNKNOWN` is UNKNOWN; `x NOT IN (1, NULL)` is never TRUE); `Expr` became a tree walked by `childrenOf`/`mapChildren` so the pushdown rules and column checks cover every node; `exprToSql` parenthesises exactly where the tree needs it; the cost model gained `OR` (inclusion–exclusion), `NOT`, null-fraction, `IN` and `LIKE` selectivities, each labelled; a top-level `OR` is one opaque conjunct so an `AND`ed equality beside it still becomes an `IndexScan`, and `<>` / `OR` / `IN` / `LIKE` are never index candidates. Checked by **ternary-logic partitioning** (`oracle/tlp.test.ts` — a predicate, its negation and its `IS NULL` partition the table; catches a broken `NOT` and the old `col = col` bug with no external oracle, and is blind to a *consistently* wrong truth table, which the SQLite comparison covers) and by the differential run, with `LIKE` in QueryLens's case-sensitive mode (SQLite's default differs — ledger entry `like-case-sensitivity`); mutation checks on each new branch are all killed. `OR`→`IN` stays deferred: without a multi-key index lookup it would be cosmetic. **B1b — arithmetic, built 2026-09-25:** `+ - * / %`, unary minus and parentheses in `SELECT` (computed columns, named by `AS` or by their own normalised text), `WHERE`, and `UPDATE … SET` (every value evaluated against the row *as it was*, so `SET a = b, b = a` swaps); `INSERT` folds arithmetic on literals (`-5`, `2 * 3`) before writing. Number rules live in `value.ts`, shared by the parser, executor and optimizer: NULL in, NULL out; `x / 0` and `x % 0` are NULL (SQLite's rule; PostgreSQL errors); whole-number `/` truncates toward zero; text that is a number is used as one, other text makes the result NULL. `constant-folding` now works out constant arithmetic once (`id = 2 + 3` → `id = 5`), and *then* `index-selection` fires — while `id + 1 = 6` correctly cannot use the index (the misconception G3 wants a challenge for). Projection became `expressions` when any item is computed. **Limits, on purpose:** `*` cannot sit beside other items (`SELECT *, x` — found by the oracle), no arithmetic on an aggregate or beside `GROUP BY`, none in `ORDER BY`. **Checked by** the oracle drawing integer-only trees for `/` and `%` (where the engines agree) and `+ - *` trees over reals, with zero and negative operands over-drawn after a mutation check showed division-by-zero, `%`-sign and folding bugs surviving 200 cases; two ledger entries (`arithmetic-on-text`, `division-of-whole-reals` — numbers carry no int/real distinction). **B1c — `OFFSET`, built 2026-09-25:** `LIMIT n OFFSET m` (an `OFFSET` needs its `LIMIT`, as in SQLite); the `Limit` operator discards the first `m` rows *after* everything beneath has produced them and says so — "that is the cost of OFFSET" — so deep pagination visibly reads more, the cost model subtracts the skipped rows before capping, and the optimizer keeps the offset through its rewrites. **B1 is complete.** Original shape: `OR` / `NOT` / parentheses · `IN (…)` · `LIKE` · `IS [NOT] NULL` with real **three-valued logic** · arithmetic in `SELECT` / `WHERE` · `OFFSET`. Seams: `parser/parser.ts` (`parseExpr`), `parser/ast.ts`, `exec/evaluate.ts`, `planner/optimize.ts` — whose conjunct-walkers assume AND-only, so a disjunction is one opaque conjunct; `OR`→`IN` (§22.9's deferred rule) becomes possible; **index union stays out of scope** — plus `ui/grammar.ts` and its drift test, `sql.mdx`, `limits.mdx` in the same commit | 2 wk |
| **B2** | 2.0 | **SQL tier 2b** | **Built, 2026-09-25, in two slices. `HAVING`:** an aggregate call is now an `Expr` node (`COUNT(*) > 1`, `SUM(pay) / COUNT(*) >= 90`) legal only in the parser's HAVING context — in a `WHERE` it is an error that points at HAVING, the way to say "WHERE filters rows *before* grouping, HAVING filters groups *after*"; a `Having` plan node sits above the aggregate and the rewrite rules see through it as one unit, so a `WHERE` is still pushed below the aggregate (index lookup, pushdown) and a HAVING is never touched; aggregates that only the HAVING mentions are computed too (`aggregateSpecsOf`); the cost model labels its guess as a default because aggregate values have no column statistics. Checked by the oracle (HAVING mixing selected and unselected aggregates with grouped columns under `AND`/`OR`/`NOT`, each aggregate compared with a literal of its own type — mixed-type comparison being a ledger entry) and by mutation (a Having that passes everything, a rewrite that drops it, an unselected aggregate never computed — all killed). `COUNT(DISTINCT x)` is named as unsupported. **`DISTINCT`:** `SELECT DISTINCT` above the `Project`, below any `Limit` — a streaming `HashDistinct` by default and a blocking `SortDistinct` (external merge sort in its own spill block, sorted by the `ORDER BY` column first so the order survives) when `aggregateStrategy` is `'sort'`: **the third hash-vs-sort compare**, shown by `/compare`'s aggregate mode with `SELECT DISTINCT` presets and honest about the contrast — a `LIMIT` above a `HashDistinct` stops the scan early (the test counts 2 rows read), above a `SortDistinct` it cannot (60). Rows are equal when every column is equal under `=`'s own coercion and NULL equals NULL; the sort run found that a hash key which told `1` from `'1'` while the sort ordered them equal left non-adjacent duplicates, so both now share `equalityKeyOf`. `ORDER BY` must name a selected column (PostgreSQL's rule; SQLite is lenient). The optimizer rules see through the node (`unwrapLimit` now peels `Limit` and `DISTINCT`). `COUNT(DISTINCT x)` is named as unsupported. Verified by the oracle (DISTINCT on selects, aggregates and joins under both strategies, biased toward projections that can actually repeat) and by mutation — where a rewrite that silently drops the DISTINCT survived 200 and 400 cases and died at 800, so **the CI default rose to 1,000 cases/property** (~2 s). Original shape: `DISTINCT` — via hash *or* sort on the existing `aggregateStrategy` seam, a **third** hash-vs-sort compare — and `HAVING` | 1 wk |
| **B3** | 2.0 | **Index realism** | **Slice a — non-unique indexes — built, 2026-09-25.** An index entry is `(value, page, slot)`: the row's own address is the tie-breaker (InnoDB's row id, PostgreSQL's TID), so the tree stays unique and splits, borrows and merges are untouched. `compareKeys` orders entries by value then address; a *probe* (`{values, bound: 'low' | 'high'}`) sorts just before or after every entry sharing a value, and is what a descent or a range bound aims at. `buildIndex` sets `tiebreak: true`; the sandbox trees keep plain keys. An equality descends toward the *first* entry — going left of a separator equal to the value, because a run can straddle one (the narration says so, and the prediction prompt is skipped there: the plain rule would give the wrong answer) — then reads along the leaf and hops to the sibling only when the leaf's **high key** says the value continues, so a unique value costs what it always did and no leaf is read past the end of a run. `IndexScan` and `IndexOnlyScan` return one row per entry; the lookup fetches the first match's heap page and each later one is fetched as it is pulled (a `LIMIT` stops the walk early — tested); `DELETE`/`UPDATE` carry each match's row address so they drop and re-add exactly *that* entry. The cost model prices a repeated value as `N/ndistinct` heap pages plus the extra leaves the run spans. **Also fixed:** a range scan's leaf hops never read the sibling leaf through the buffer pool though the cost model priced them — now they do, so an `EXPLAIN ANALYZE` estimate and its actual agree. `posts.authorId` is indexed in the join demo (the case v1's seed comment said it could not be). **Checked by:** the oracle indexes columns that repeat (`n`, `s`, `r`, `t_id`, `v`) and biases lookups and writes toward them, and an UPDATE may `SET` an indexed column; after *every* generated write the harness validates each tree and compares its entry count per value with the table (`runQuery`'s `afterWrite` hook — each statement rebuilds its indexes, so nothing else would notice a tree maintained wrongly); mutation-checked (a delete that drops the wrong entry, an update that forgets to move it, a lookup that stops after one leaf — all killed); coverage asserts repeated-value lookups, multi-row index writes and re-indexing updates are reached; a 20,000-case run is clean; property tests interleave inserts and deletes of single entries at every fan-out against a model. **Slice b — composite indexes and the leftmost-prefix rule — built in two parts; part 1 (2026-09-25):** `Table.indexes: IndexSpec[]` (`{columns}`) beside the `indexedColumns` shorthand; `indexSpecsOf` merges them into one list and an index is named by its columns joined (`a, b`), which is how a plan node and `ExecContext.trees` say *which* index. Entries hold every column's value (`EntryKey.values`); the lookup takes a **leftmost prefix** and matches every entry that starts with it. `index-selection` takes, per index, the run of leading columns that each have an equality — the run stops at the first gap, which *is* the rule — and compares candidates by the product of their per-column selectivity; `IndexScan` gained `keys` (the prefix values), labelled `IndexScan t.(a, b)` and detailed `key: a = 1 AND b = 2`. **The rule is said aloud:** the plan stage names an index it could not enter (\"The index on (a, b) cannot help: the predicate constrains `b` but not `a`…\") — also when other rules fired, where the old \"nothing fired\" note never ran — and a *leftmost-prefix* predict-then-reveal question is asked when only some columns are named. **Covering:** the index-only-scan rule now fires for any query that reads only the index's own columns, and the scan builds its rows from the entries (`IndexOnlyScan t.(a, b)`, no heap page). Writes maintain composite entries (`drops key (2, 3)`); an index join can probe a composite index through its leading column (`IndexProbe kids.(k, x)`); the Custom database's *Manage tables* takes `a+b, c+d` (validated, persisted, described in the table list). **Found by the oracle on the way:** the tree compared NULL equal to `''` (a later column can hold NULL, so `(0, NULL)` matched the prefix `(0, '')`) — NULL now sorts first and equals only NULL; a regression test pins it. The oracle now declares 1–3-column composite indexes (some leading with the join key), aims lookups at leftmost prefixes — and, one time in six, at a *non*-prefix, which must fall back to a scan without changing the answer — and writes through them; after every write the harness compares each tree's whole keys with the table's rows; coverage asserts composite lookups, covering scans, refusals, writes and join probes are all reached; mutation-checked (a prefix that compares only the first column, a rule that skips the gap, a covering scan that reverses its columns — all killed); 20,000 cases clean. **Also fixed:** the optimizer's \"Estimated cost decides it\" was false — the rules fire on shape, never cost, so an index over a repeated value could be chosen and lose; it now says \"agrees\" or \"disagrees\" and, when the index costs more than the scan, that the rule took it anyway. **Part 2 (2026-09-25):** a range on the column *after* an equality prefix (`a = 1 AND b > 5`) becomes an `IndexRangeScan` with a `prefix` — one descent to where the range begins inside the prefix's run (past the run's NULLs, which sort first and never satisfy a range), then along the leaf chain until the entries stop starting with the prefix; a candidate that can narrow further beats one that cannot, and a per-row `rangeHolds` recheck (with `compare`'s own rules) guards NULLs and mixed types. **`DELETE`/`UPDATE` can now find their rows by a range** — `exec/writeScan.ts` runs an `IndexRangeScan` (and now holds the one copy of the index-lookup match code `delete.ts` and `update.ts` each carried), so `WRITE_PATH_RULES` is every rule and `DELETE FROM t WHERE id > 50` no longer scans the table. The oracle adds prefix-plus-range lookups and range writes; coverage asserts both; mutation-checked (a range that runs past its prefix, a range write that claims nothing, a start that skips the wrong entries — all killed); 20,000 cases clean. **Slice c — `UNIQUE` — built, 2026-09-25.** `IndexSpec.unique`; a unique constraint *is* an index lookup, so `INSERT` and `UPDATE` ask the index whether the new key is there **before** changing anything (`exec/unique.ts`: "INSERT checks the UNIQUE index on `email` before it changes anything: is there already an entry for (email) = ('ada@x.org')?", a real descent through the buffer pool, then "the key is already taken, so INSERT will be rejected" or "No entry … the key is free"). A hit throws `UniqueViolation`; `runQuery` turns it into the statement's error — "Duplicate key — the UNIQUE index on `email` already holds (email) = ('ada@x.org')", the row that holds it, "Nothing was changed" — *with the trace it built so far*, closed by a `result` event, and the Playground now shows that trace ("Rejected after 13 steps") instead of "the query did not run" (it says that only when there are no events). NULL never conflicts and is not looked up; the check is per row in visit order, like PostgreSQL's immediate constraints. A lookup of a unique index's whole key stops at the first entry — no run, no sibling leaf — and the plan says "The index is UNIQUE, so … at most one row". The Custom database's *Manage tables* takes `Unique indexes: email, team+role`, persisted and validated, and **refuses to apply rows that already repeat a key** (`uniqueViolation`, naming it). **Checked against SQLite itself:** `oracle/unique.test.ts` runs random INSERT / UPDATE / DELETE sequences over tables with 1–2 unique indexes (single, composite, overlapping) on both engines — they must agree on *whether* each statement is accepted and leave identical rows — restricted to statements whose outcome does not depend on the order rows are visited (a literal `SET a = 5`, not `a + 1`); counters assert both outcomes, NULL keys and mid-statement rejections all occur; mutation-checked (NULLs that conflict, an UPDATE that never checks — both killed). The main oracle also declares unique `id`/`k` on the tables it cannot violate, and coverage asserts writes consult them. **Slice d — bulk-load vs incremental — built, 2026-09-25.** `bulkLoad` (`index/bulk.ts`) sorts the entries, packs the leaves left to right to a **fill factor** (clamped to ≥ 0.5 — a node may never be under-full), then builds each level above from the one below, bottom-up, with no splits; the last two nodes of a level are merged or shared so every node meets the tree's minimum occupancy. Its result is an ordinary tree (`validate` passes, `insert`/`deleteKey` work on it — property-tested at every fan-out and fill factor, including inserts and deletes afterwards). `EngineOptions.indexBuild: {method: 'incremental' | 'bulk', fillFactor}` builds every index of a run either way (also the inner tree of an index join). **Measured (fan-out 4, keys ascending):** inserting one at a time leaves every left leaf **three-quarters full** (3 of 4; the split rule, not a guess — a 75% bulk load reproduces its height and node count at every size measured), so a 400-row index is 5 levels; packed 100% it is 4, and packed 50% it is 6. A point lookup: **5 disk reads** bulk-loaded vs **7** one-at-a-time vs 7 half-full; a 30-id range 20 vs 24 vs 30. `/compare` has a fourth mode, *Index build*, running the same query over 400 `readings` rows the three ways and scoring height, index pages, node reads, disk reads. The oracle varies `indexBuild` in its option sets, so every differential, metamorphic and index-vs-heap property runs over trees of different shapes (and `checkIndexes` validates each after every write); mutation-checked (a bulk loader with wrong separators, one that never rebalances its last node — both killed); 20,000 cases clean. **Slice e — clustered (index-organized) tables — built, 2026-09-28, closing B3.** `Table.clusteredKey: string[]`, one of the table's own `UNIQUE` indexes' columns. `buildHeap` sorts the rows by it before paging (a table's whole reason to be clustered): the clustering key's own index still points at real heap addresses — nothing else changes for it — but every *other* index now stores the row's **clustering key** instead of `(page, slot)` (`EntryKey.clusterKey`; `compareKeys`'s tie-break switches to it, same as the address did), because a clustered leaf splits and moves rows between pages exactly like any other leaf and a physical pointer would go stale. `BPlusTree.clusteredVia` names the clustering index; a secondary lookup (`index/lookup.ts`'s `emitIndexLookup`) skips the heap fetch and hands the caller a `clusterKey` per match instead, and `resolveClustered` — the *same* `emitIndexLookup`, run again — is the second, real descent that finds the row: "This table is clustered on `id`, and `email` is a secondary index … finding the row costs a second descent, through the clustered index itself." Built for `IndexScan` (equality, `operators.ts` and the write path's `writeScan.ts`, so `DELETE`/`UPDATE` can use a clustered table's secondary index too) and free for `IndexOnlyScan` (a covering query never needed the row at all, so it costs one descent whether the table is clustered or not — the plan-stage narration says the clustering fact but leaves "costs a second descent" to execution, since only execution knows whether the query turned out to be covered). A range scan and an index-nested-loop join never choose a clustered table's secondary index (`range-index-selection`'s candidates and `joinIndexFor` both filter on `isClusteringIndex`) — the leaf-chain walk both run wants a row address the entries do not carry, so they fall back to a plan that does not need one; the clustering key's own index is still fully eligible for either. `INSERT`/`DELETE`/`UPDATE`'s per-index maintenance (`index/build.ts`'s `entryFor`, shared by `buildIndex` and all three exec files) and a `UNIQUE` violation's "row that has it" (`exec/unique.ts` resolves the real holder through the clustered index before throwing) are clustering-aware the same way. **Measured:** eight rows inserted in a scrambled order, ranged over — 8 disk reads unclustered, 6 clustered, on a table this small. **Checked by:** `src/engine/__tests__/clusteredTable.test.ts` (17 tests: physical layout, the measured page count, both index kinds' lookups, the range/join fallback, the UNIQUE holder, and `validate()` after every write); a standalone oracle, `oracle/clustered.test.ts` — the same random session of writes and reads run against two databases that start from identical rows and differ only in `clusteredKey`, asserting every acceptance, every result and every write's index soundness agree (this is the stronger property here than bouncing through SQLite: clustering is purely physical, so the *only* correct answer is "no difference at all"), 20,000 cases clean; mutation-checked three ways (the sort, the tie-break, the resolve step — all killed, the resolve step by the oracle itself). **Deliberately deferred:** the Custom database editor has no field for `clusteredKey` yet (built and tested on the engine only), and there is no dedicated `/compare` mode for it — the measured numbers above are the whole demonstration, not a UI. Seams closed: `index/btree.ts`, `index/build.ts`, `Table.indexedColumns` → a richer descriptor, `index-selection`, `index/rangeLookup.ts` (deliberately untouched — see the range-scan fallback above), `planner/cost.ts` (also deliberately untouched: `estPages` is never shown to a user, only propagated to a parent node's own estimate, and no clustered-secondary index ever reaches a `Join` cost case). Closes lecture 8's gap, and B3 itself | 2.5–3 wk (slice a done) |
| **B4** | 2.0 | **Index nested-loop join** | **Built, 2026-09-25.** `EngineOptions.joinStrategy` gains a fourth value, `index-nested-loop`: the inner (`JOIN`ed) table's own B+Tree is probed once per outer row instead of the inner table being rescanned. A new plan node, **`IndexProbe`** (`{table, column, outerTable, outerColumn}`), is the `Join`'s right child — a lookup whose key is *the current outer row's* value, drawn in the same green as `IndexScan`, and just the relation `rel` in relational algebra. The probe reuses the narrated equality lookup B3a built, so a foreign key that repeats (several posts per author) returns every entry, each heap page fetched as its row is pulled — a `LIMIT` above the join stops the probing early; a NULL key is never probed (an index holds no NULLs); every candidate is rechecked against the ON equality, so it can never return a row the other three would not. **It needs the index:** `effectiveJoinAlgorithm` falls back to a plain nested-loop when the inner table has none on the join column — never an error, and the plan stage says so ("has no index on `authorId` for it to probe — so this runs as an ordinary nested-loop"). The inner tree's pages are numbered past every heap page, so no index page shares an id with a heap page (tested). `join-predicate-pushdown` learned the new inner side: a `WHERE` on the outer table is pushed into its scan, one on the inner table stays above the join (there is no scan to filter). The cost model prices a probe per outer row (`levels + extra leaves + a heap page per match`) and the `Join` multiplies it by its outer rows. **`/compare` is four-way.** Its JOIN mode gained `createJoinCompareDatabase` — the demo pair plus `comments`, 120 rows on 30 pages, twelve per post, scattered, indexed on `postId` — and a third preset, *A tiny outer over a big indexed inner*. **Measured (2 frames):** one outer row — index join **23** disk reads vs nested-loop 33, hash 33, sort-merge 183 (and half the trace steps: 159 vs 318); all ten posts — index join 202 vs hash **33**, nested-loop 303: *it loses to hash the moment the outer is big*, and over the ten-row `authors × posts` demo it is the most expensive of all (20 reads vs 5–17) — the page says both, and a test pins each. The summary text stopped naming `posts` and `authors` (it was wrong for any other query). **Checked by:** the oracle forces `index-nested-loop` among the four algorithms (its `u.t_id` index makes about half the sessions eligible, the rest exercise the fallback), coverage asserts index joins with rows, joins whose probe found several entries, and fallbacks are all reached; mutation-checked (a probe that keeps only the first entry, one that drops the last, one that stops at a NULL key — all killed). Also fixed: the plan stage's "nothing to rewrite" note said nested-loop for a sort-merge join | 4–5 days → **built** |
| **B5** | 2.0 | **Plan as relational algebra** | **Built, 2026-09-25.** Every plan node carries an `ra` field (`{symbol, sub, rel}`) *derived from the real `Plan`*, not parsed back out of a label — so a filtered `SeqScan` and an `IndexScan` are both `σ_{id = 5}(users)` while their *physical* label stays underneath: what is computed beside how. σ selection (`Filter`, `Having`, and scans with a predicate), π projection (the `*` case is left unwritten), ⋈ join, γ aggregation (`γ_{age; COUNT(*)}`), τ order with ↑/↓, δ distinct, λ limit (`λ_{2, offset 4}`, an extension). A **notation toggle** on the plan and optimize panels ("Show as: Operators | Relational algebra") redraws the tree — colours follow the physical operator in both, so a switch never changes which node is which — and the SVG export follows it; **Copy as relational algebra** (`π_{name}(σ_{age > 30}(users))`, laid out over lines when wide and re-joinable to the one-liner) and **Copy as LaTeX** (`\sigma_{age \ge 30}`, `\wedge`, `\bowtie`, escaped names) sit beside Mermaid and text. Pure exporters in `src/export/`, tested against the real engine's final plans, including a check that *every* node the engine emits has a form. Fixed on the way: the FAQ still had a section "Why no joins, subqueries, or GROUP BY?" — rewritten as "What SQL is missing?" | 2 days → **built** |
| **B6** | 2.0 | **`EXPLAIN [ANALYZE]` as SQL** | **Built, 2026-09-25.** `EXPLAIN SELECT …` and `EXPLAIN ANALYZE SELECT …` parse in the editor (new `ExplainStatement`; `EXPLAIN`/`ANALYZE` are keywords) and answer with a `QUERY PLAN` result — one PostgreSQL-shaped line per operator with the cost model's `est ~N rows`. **`EXPLAIN` executes nothing** (its trace has no execute, buffer or lock stage — asserted); **`EXPLAIN ANALYZE`** keeps the whole run as the trace you step through, puts the executor's `actual N rows` beside each estimate, and ends with the result size and the buffer pool's hits / misses / evictions — **no timings**, because the engine makes no latency claim (§12). SELECT only: `EXPLAIN ANALYZE DELETE` would perform the delete, and the error says so. It is built on an ordinary run of the inner query (so the plan shown is exactly the one that would execute), with the `EXPLAIN [ANALYZE]` prefix replaced by spaces so every span it reports still indexes the text the user typed — the squiggle on `nope` in `EXPLAIN SELECT nope …` lands on `nope`. An `EXPLAIN ANALYZE` preset chip on the `users` dataset; the panel's *Copy as EXPLAIN* button stays. Grammar data, drift test, SQL reference and a Playwright test updated | ½ day → **built** |

#### C. The optimizer, honestly (RESEARCH.md §41)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **C1** | 2.1 | **`ANALYZE` + statistics objects** | **Built, 2026-09-29.** `ANALYZE table` is a real statement (`AnalyzeStatement`, alongside `SELECT`/`DELETE`/`INSERT`/`UPDATE`/`EXPLAIN`): a real scan of the real table, producing — per column, in `src/engine/stats.ts`'s `analyzeTable` — a distinct count, a null fraction, the most-common values with their real frequencies (a value only counts as "common" if it actually repeats), an equi-depth histogram over whatever the most-common list does not already cover, and correlation (a Pearson correlation between each row's physical position and its value's rank — `1` on an already-clustered column, plan.md §25.4 B3e; `-1` reverse-sorted; near `0` scattered), shaped after PostgreSQL's own `pg_stats`. Stored as `Table.stats`, a **snapshot**: whatever the table looked like the moment `ANALYZE` last ran, unconditionally accurate at that moment and possibly wrong forever after — a table's writes never touch it. `planner/cost.ts`'s `ndistinct`, `equalitySelectivity`, `nullSelectivity`, `rangeSelectivity` and `boundedRangeSelectivity` all read `table.stats` when it is set (an equality on a most-common value gets its real frequency instead of a blanket `1/ndistinct`; any other value gets the average of what the most-common list does not cover; a range reads the histogram's real bucket overlaps instead of interpolating linearly between min and max) and fall back to exactly today's live-scan behaviour — unconditionally accurate, unconditionally unrealistic — when it is absent, so every dataset that has never been `ANALYZE`d is provably untouched (the whole existing suite passed unmodified). **The Stats panel is the Result panel:** `ANALYZE`'s own answer is one row per column (`statsToRows`), rendered the same way any other query's rows are — there is no separate widget to build or keep in sync, and a learner opens the statistics exactly the way they open any other result. **Measured, live in the Playground:** insert 20 rows with a repeated `age` the table's `ANALYZE` never saw, and the stale estimate for that value says ~1 row where 20 actually match — a real q-error over 20× produced by ordinary use, not a staged example; re-running `ANALYZE` corrects it to 20 on the nose. Checked by `src/engine/__tests__/stats.test.ts` (the statistics math itself: nDistinct/nullFraction, MCV capping and ordering, histogram bucket count and coverage, correlation in both directions and at zero), `analyzeStatement.test.ts` (parsing, execution, narration, the "no table called X" error, staleness end to end) and new cases in `cost.test.ts` (MCV-aware equality, histogram-aware range, the stale-vs-fresh q-error itself); mutation-checked three ways (the MCV frequency filter, the MCV lookup, the persistence field — all killed). `EntryKey`'s NULL-first/numeric-or-lexicographic order was pulled out of three separate copies (`index/btree.ts`, `storage/page.ts`) into one shared `value.ts#compareValues`, which `stats.ts` also uses — a small seam this item needed anyway. A live Playwright test confirms `ANALYZE`, its rendered statistics, and the next query's ANALYZE-aware estimate, end to end. `sql.mdx`, `limits.mdx` and `ui/grammar.ts` (plus its drift-tested representative queries) all gained `ANALYZE`. Not built here, and explicitly C1's own boundary: cross-column correlation / the independence assumption breaking (plan.md §25.4 C2's job), and wiring per-column `correlation` into any cost formula (no consumer yet — C1 computes and shows it; nothing prices it) | 1.5 wk |
| **C2** | 2.1 | **Correlated dataset + q-error** | **Built, 2026-09-29.** A fourth preset dataset, `employees` (250 rows, 25 departments × 10 rows): `department` and `office` are **perfectly correlated** — every department occupies exactly one office, so `office` tells the optimizer nothing `department` had not already said — which is exactly the independence assumption every `AND` selectivity in `planner/cost.ts` makes (`left.fraction * right.fraction`, unconditionally, since B1). `WHERE department = 'engineering' AND office = 'building-1'` estimates `~0` rows (25² = 625 distinct pairs assumed, only 250 rows to spread over them) against an actual `10` — every one of the department's own rows, since the second predicate excludes nothing. `explain.ts` gained **q-error** (Leis et al.'s own metric, RESEARCH.md §41: `max(est/act, act/est)`, `+1`-smoothed so a `0` on either side is still a finite number) shown per operator under `EXPLAIN ANALYZE` once it clears 2× — an ordinary, well-estimated query stays uncluttered. The headline case reads **11.0×**, comfortably past the 2.1 checklist's "≥ 10×", produced by ordinary correlated data, not a contrived worst case. A `department` alone / `office` alone estimate is accurate (single-column statistics have nothing wrong with them); only the *pair* fails, because nothing here — not even `ANALYZE`'s own per-column statistics (plan.md §25.4 C1) — records how two columns co-occur. Checked by `explain.test.ts` (q-error's own formula, the ≥10× headline number, silence below 2×, absence under a plain `EXPLAIN`), `datasets.test.ts` (the correlation itself has no exceptions, over enough distinct departments to matter), `datasetCatalogue.test.ts` (the shipped "Correlated AND" preset chip reproduces the ≥10× number) and a live Playwright test (the real running Playground, the real preset chip, the real number); mutation-checked three ways (the display threshold, the `+1` smoothing, the correlation itself — all killed by all three affected test files at once for the last one). **Deliberately out of scope, and explicitly the next item's territory:** nothing here *fixes* the misestimate — no cross-column/"extended" statistics (PostgreSQL's `CREATE STATISTICS`), no correction to the `AND` formula. C2's job is to make the failure real, visible and measured; C4/C5's cost-based join order and plan choice are what would eventually have to *live with* an estimate this wrong, which is the whole point Leis et al.'s paper makes | 3 days |
| **C3** | 2.1 | **Multi-join, `LEFT JOIN`, `IN (subquery)`** | **Slice a — `LEFT JOIN` — built, 2026-09-29.** `[INNER \| LEFT [OUTER]] JOIN` (`JoinClause.joinType`, `Plan`'s `Join.joinType`) — a bare/`INNER JOIN` is exactly today's shape; `LEFT [OUTER] JOIN` keeps every row of the `FROM` table, NULL-padding the joined table's declared columns (`exec/operators.ts`'s new `nullPaddedRow`) when nothing matches it — including a NULL join key, which never matches anything either way. Built for **all four join algorithms**, not just the default: nested-loop and index-nested-loop track whether the current outer row matched anything across the whole inner scan/probe and pad it once at the end; hash join pads immediately on an empty bucket; sort-merge's own two-pointer `sortMergeMatches` generator (the hardest of the four to retrofit) now walks all the way to the end of `left` rather than stopping once either side is exhausted, yielding `[row, null]` for any left row — or run of them — with no run of equal keys on the right at all. **The classic pitfall, closed:** `join-predicate-pushdown` no longer pushes a `WHERE` conjunct on the *inner* side of a `LEFT JOIN` into its own scan — doing so would filter rows out before the join can find out they would not have matched, turning a `LEFT JOIN` back into an inner one with no trace of it (`… LEFT JOIN posts ON … WHERE posts.title IS NULL` — the standard way to ask "which rows had nothing on the other side" — only works if the filter runs *after* the padding); the outer side's own predicates are still pushed, always safe regardless of join type. The cost model's `Join` estimate is now a floor at the outer side's own row count for a `LEFT JOIN`, named as such when the equi-join guess would have undercounted it. `RIGHT`/`FULL`/`CROSS` stay explicitly out of scope (`OUT_OF_SCOPE`'s message for `RIGHT` now points at rewriting it as a `LEFT JOIN` the other way round). **Checked by:** 10 new tests in `join.test.ts` — all four algorithms agree on the exact same LEFT-JOINed rows (the seed's own `authors`/`posts` fixture already has an author, `barbara`, with zero posts, built for exactly this), a NULL join key is kept and padded by every algorithm, the pushdown pitfall is caught directly (the `IS NULL` query above returns exactly `barbara`, not everyone, under the mutated-and-restored rule), the plan/narration say "LEFT JOIN," the cost floor holds, and `RIGHT`/`FULL` still fail to parse; mutation-checked three ways (the pushdown gate, `sortMergeMatches`'s padding, hash join's empty-bucket check — all killed). **Deliberately deferred:** no SQLite-oracle coverage yet (the shared `oracle/generate.ts` query-generation model does not build JOINs beyond today's single inner one; extending it is left for once the rest of C3 — multi-join, the subquery slice — is built, so that shared model is touched once, not three times). **Slice b — multi-join — built, 2026-09-29.** `SelectStatement.join?: JoinClause` becomes `joins?: JoinClause[]` — zero or more, chained left-deep: `FROM a JOIN b ON … JOIN c ON …` builds `Join(Join(SeqScan(a), b), c)`, never a flat three-way node. The parser gained the one real gap a single `JOIN` never had to close: a new `checkJoinChain` (called once per clause, in `parseSelectBody`'s own loop, since only it knows the running set of table names so far) checks that each `ON` names the table its own clause introduces on one side and *some* table already in the query — `FROM`'s, or any earlier `JOIN`'s, not necessarily the one written just before it — on the other, and rejects joining the same table twice outright (no aliasing to tell two `authors`es apart). `buildJoinPlan` folds the whole array with one loop instead of building a single pair, resolving each step's `leftTable`/`leftColumn` against whichever known table the `ON` actually names. Every consumer of "the Join node" that assumed there was only ever one now walks the *whole* chain: `joinsIn` (`plan.ts`, replacing the singular `findSortMergeJoin`/`findIndexNestedLoopJoin` with plural, chain-aware versions) recurses down `left` collecting every step in source order; `emit.ts`'s narration loop rebuilds the plan one join at a time (`buildJoinPlan` on a growing prefix) so each step gets its own sentence naming its *own* outer/inner table, not always `FROM`'s. Execution generalizes two ways: `ExecContext.joinRight` (one slot) becomes `joinPartners` (a map keyed by table name), so a nested `Join` finds its own right-hand partner regardless of nesting depth; and `mergeJoinedRow`/`nullPaddedRow` skip re-qualifying a key that already contains a `.` — a later step's `left` row already carries every earlier table's columns as `table.column`, so only a query's *first* join still needs to qualify a bare key. A new `leftJoinValue`/`leftJoinKeyOf` pair replaces every direct `leftRow[column]` read across all four algorithms with a dual lookup (bare, or `table.column` if a prior step already qualified it) — the one piece every algorithm needed changed identically. **Per-step algorithm fallback, not once per query:** `index-nested-loop` already fell back to `nested-loop` per join when that step's own table had no usable index (`effectiveJoinAlgorithm`); folded into the chain loop, a 3-table query can now run its first step as `index-nested-loop` and its second as plain `nested-loop` in the very same plan, and the plan/narration say so for exactly the step that fell back. **Sort-merge's own scratch-space bookkeeping**, the one piece that could not simply "just recurse" — each sort-merge step needs its own two-block page-id reservation, and a later step's own worst-case left-input size depends on every earlier step's, genuinely sequential — moved out of the operator (which cannot see the whole chain) into `runQuery.ts`, computed once up front in chain order and handed back as `ExecContext.sortMergeBases: Map<Plan, {leftBase, rightBase}>`, keyed by each sort-merge `Join`'s own node identity. **A real pre-existing bug found and fixed as a side effect of this generalization**, not a new one introduced: the single-join code placed a `JOIN`'s right-hand heap right after the `FROM` table's own *heap* page count, not after its own *index* pages too — so a `FROM` table with any declared index (the demo `authors`/`posts` fixture has one on `authors.id`) could have its join partner's heap silently share page-id numbers with the `FROM` table's own index tree, which the buffer pool's LRU/eviction accounting would then treat as the same page; the chain's own strictly-accumulating page counter closes this for every table, not just the first two. **Checked by:** 15 new tests in `join.test.ts` — a 3-table chain's own correctness (a local `comments` table, not added to the shared `authors`/`posts` seed fixture, whose own docstring says it deliberately stays a pair), all four algorithms agreeing on it, the per-step algorithm-fallback case (the second join's table left deliberately unindexed), a chain of `LEFT JOIN`s NULL-padding independently at each level, a mixed inner-then-`LEFT` chain, every existing single-join `GROUP BY`/`ORDER BY`/`HAVING`/aggregate rejection re-verified with two joins, `EXPLAIN`/`EXPLAIN ANALYZE` not crashing on a chain (the regression test for the cost-model bug below), and `DISTINCT` above a chain by both strategies; mutation-checked three ways (`leftJoinValue`'s dual lookup, the self-join parse guard, the cost model's `otherTables` fix — all killed). **A second real bug found while verifying this slice, deliberately left unfixed here and flagged instead:** the cost model's `estimateNode` recursion (`cost.ts`) resolves a `Join`'s own two sides' tables by name against an `otherTables` map built once at the top — which only ever held the join *partners*, not the original `FROM` table — so once the recursion nests two levels deep and needs to resolve the `FROM` table's name again at the bottom of the chain, it crashed; fixed here by including `table.name` in that map at both call sites (`emit.ts`, `exec/run.ts`), since the chain simply could not work without it. **A third, separate, genuinely pre-existing bug, out of scope and flagged via a background-task suggestion rather than fixed in this commit:** `EXPLAIN ANALYZE`'s "actual" row count (`explain.ts`) is keyed by operator *name* ("SeqScan"), not by which specific plan node — so a single `JOIN`'s two `SeqScan` children already showed the identical (wrong) number today, before this slice, and a chain only makes the same latent bug more visible. **Fixed 2026-10-01, out of band from the C-series slices:** `StepEventBody`'s `execute` variant and `PlanNode` both gained an optional `table` (a scan's own table, or a `Join`'s `rightTable`) — always enough to tell two nodes of the same `op` apart, since the parser never lets a query name the same table twice — and `explain.ts`'s actual-row lookup now keys on `op` *and* `table` together; see CHANGELOG.md's "Fixed" entry. **Slice c — `IN (subquery)` — built, 2026-09-29, closing C3.** `x [NOT] IN (SELECT column FROM table [WHERE …])` — the one place a `SELECT` may appear inside another query; a scalar subquery (`x = (SELECT …)`) and `EXISTS` both stay unsupported, `parsePrimary`'s own generic "a subquery is not supported here" rejection unchanged for everywhere else. `Expr`'s `in` variant gains an optional `subquery?: InSubquery` field alongside its existing `items: Expr[]` — no new `Expr` kind, so `childrenOf`/`mapChildren`/`walkExpr` need no changes at all (a subquery's own `WHERE` is a deliberately separate scope, never walked as part of the outer predicate tree). A new `parseInSubquery` (`parser.ts`) parses the small, fixed shape `SELECT column FROM table [WHERE …]` — deliberately not `parseSelectBody` reused-and-restricted: `*`, multiple columns, an aggregate, `DISTINCT`, `JOIN`, `GROUP BY`, `HAVING`, `ORDER BY` and `LIMIT` are all rejected outright with their own named error, since none could ever change *which* values end up in the set `IN` tests against. Uncorrelated by construction, not a special check: the subquery's own `WHERE` columns are validated by the exact same `checkJoinValidity` call (with no `JOIN`) a bare single-table query already gets, so there is no path for a column inside it to ever name a table the outer query knows about. A new module, `subquery.ts`, resolves every `IN (subquery)` in a `WHERE` clause **exactly once**, before the query that names it is planned — `runQuery.ts`'s SELECT, DELETE and UPDATE paths all share it — by running the subquery as its own complete, independent sub-run of the engine (`run: (sql: string) => RunResult`, the exact callback-injection pattern `explain.ts`'s `explainResult` already established, avoiding a circular import back into `runQuery.ts`; the subquery's own source text is recovered from its parsed `span` and padded with leading spaces exactly as `explainResult` already does, so a parse error inside it still points at the right character offset in the outer editor) and rewriting the `in` node's `items` with the resolved, deduplicated values as ordinary literals. Everything downstream — the cost model's existing `in` selectivity formula (`k × equality selectivity`, now using the *real* resolved count), `evaluate.ts`'s existing three-valued `IN`/`NOT IN` truth table (including the classic NULL-in-the-list trap, which a subquery-sourced NULL now triggers identically to a hand-written one), every rewrite rule in `optimize.ts` — needed **zero changes**, since a resolved node is indistinguishable in shape from a literal list. `subquery` itself survives the rewrite (for narration and `exprToSql` only, which always prefers it when present) so the WHERE clause's own plan-stage narration (`emit.ts`/`emitDelete.ts`/`emitUpdate.ts`, sharing a new `subqueryResolutionNotes` in `plan.ts`) can say the subquery already ran and how many distinct values it found, without a new `Plan` node or operator of its own — deliberately: plan.md commits only to "an uncorrelated `IN (subquery)`" (§25.10), never to a semi-join as a first-class visualized operator, and folding the resolution into the existing `Filter` narration reuses the entire cost/optimize/exec pipeline verbatim rather than adding a `SemiJoin` variant to every exhaustive `Plan['op']` switch for a fact that is genuinely just "a value list, resolved once." **Checked by:** 24 new tests in `subquery.test.ts` — parsing (the `subquery` field shape, every rejected clause with its own message, `exprToSql` round-tripping the subquery form rather than resolved values), execution (SELECT/DELETE/UPDATE all resolving correctly, an empty subquery result making IN match nothing and NOT IN match everything, the NULL trap via a subquery-sourced NULL — deliberately using an exclusion crafted so a version that silently dropped the NULL would return 3 rows instead of the correct 0, since a naive "does it return `[]`" assertion couldn't otherwise tell the trap from a same-shaped bug), deduplication (a real foreign-key column with repeats collapses to its distinct values), bad-table/bad-column errors inside the subquery reported as a wrapped "IN subquery failed" rather than a crash, the WHERE-narration message, and the uncorrelated guarantee itself (a qualified reference to the outer query's own table, rejected the same way any unrelated table name would be); mutation-checked two ways (the NULL-inclusive dedup, the uncorrelated `checkJoinValidity` call — both killed). Live-verified in the Playground: the AST tree panel shows the `In` node's subquery detail and no `items` children; the optimizer's predicate-pushdown step correctly reuses the resolved count in its cost basis; the error squiggle for a rejected `SELECT *` inside the subquery lands on the `*` itself, not the whole query. **Deliberately deferred, matching slices a and b:** no SQLite-oracle coverage yet (`oracle/generate.ts`'s query-generation model builds neither a chain nor a subquery yet — extending it for both at once, now that all of C3 has landed, is next). **C3 is now fully built** — `LEFT JOIN`, multi-join, and `IN (subquery)`, each its own commit, closing plan.md's whole "Multi-join, LEFT JOIN, IN (subquery)" line; C4 (DP join order) is the next reachable item, needing both C1 (built) and C3 (now built). | 2 wk |
| **C4** | 2.1 | **Join ordering by dynamic programming** | **Built, 2026-09-29.** Selinger's System R algorithm over the **subset lattice**: for `n` tables there are `2^n - 1` non-empty subsets, and the cheapest left-deep way to join every table in one is built up bottom-up from the cheapest way to join every smaller subset one table down — new module `src/engine/planner/joinOrder.ts`'s `runJoinOrderDP`. Restricted to left-deep on purpose, not as a simplification: the engine's own `Join` operator (C3 slice b) only ever executes a left-deep chain, so a bushy plan the classic algorithm might otherwise consider is one nothing here could actually run — this also means a subset's own DP state only needs "which table was added last," never "which two smaller subsets were merged," so there is no split search, only a per-table one. A cross join is never *forbidden*, only *costed honestly* (`rows(a) × rows(b)`, no selectivity) — real, always available, and it loses the comparison badly enough on its own that nothing has to reason about the join graph's connectivity to avoid it. The cost formula mirrors `cost.ts`'s own nested-loop `Join` case exactly (`pages = left.pages + left.rows × right.pages`), scored on pages, not rows, so two orders with the same output size but different rescan cost are told apart. **A genuine scoping decision, made explicit before building anything** (the user chose it directly when asked, since plan.md's own "Needs C1, C3" line left the question open): this stays **visualization-only** — a real multi-join query still always executes in the order it was written, never reordered by cost. That is also the honest reading of limits.mdx's own "no cost-based query optimization" line, which nothing before this item had actually tested. `/tools/join-order` (new standalone, `JoinOrderToolPage.tsx`) shows the whole lattice, grouped by subset size, every subset clickable to see *every* candidate the DP tried for it (not just the winner) — the recurrence itself, not only its answer — plus an interactive "build your own order" that costs whatever sequence of tables you click, live, against the DP's own number. The Playground gets the same search folded into a query's own plan-stage narration, once a query names two or more `JOIN`s: a new sentence naming what DP would have joined them as and its estimated cost next to the written order's, informational only — the same "estimate beside the real plan, never a decision" stance C1's stats and C2's q-error already established, now extended to join order specifically. A new demo dataset, `createJoinOrderDemoDatabase` (`seed.ts`): four tables as a *tree*, not a chain — `departments` is the hub (connecting to both `employees` and `projects`), `timesheets` hangs off `employees` alone — empirically tuned (the project's own "measure, don't guess" convention) so a natural-looking "hub, then each branch" written order costs **5.2× the DP-optimal order**, a genuine, dramatic, measured gap: visiting `projects` before drilling into `employees` → `timesheets` lets the *other* branch's join land against an already-larger intermediate result, at real cost. **Checked by:** 9 new tests in `joinOrder.test.ts` (a single table needs no ordering; a two-table pair tries both starting points; no edge means an honest cross join, never a forbidden move; a star graph correctly considers every already-joined table, not just the most-recently-added one, when looking for a real edge; every prefix of the winning order is itself that prefix's own best subset plan; the full demo dataset's real 5.2× gap, matching the exact figure `seed.ts`'s own doc comment names; `joinGraphFromAst` correctly extracts a real multi-join AST's tables and edges, including an ON clause naming a non-adjacent earlier table) plus 2 new tests in `join.test.ts` (a chain of two or more JOINs gets the narration note without its rows ever changing; a single JOIN gets none, since there is only one order to have); mutation-checked three ways (the DP's own cost comparison, the star-graph edge search, the Playground note's `>= 2 JOINs` gate — all killed). Live-verified in both the Playground (the note appears, names the real reordering, and the query's own result rows are unaffected either way) and `/tools/join-order` (the lattice renders correctly at every level, clicking a subset shows its real candidate breakdown, the interactive order-builder computes live). | 1.5 wk |
| **C5** | 2.1 | **Cost-based choice + "Why not?"** | **Slice 1 — index vs. scan by cost — built, 2026-09-30.** `indexSelection` and `rangeIndexSelection` (`optimize.ts`) gain a third parameter, `rowsPerPage`, threaded through `optimize()` from every call site — the first time a rule has needed it at all. Once a candidate is chosen by *shape* (the existing leftmost-prefix / most-selective-column logic, unchanged), its own estimated page cost (`rootEstimate`, the exact formula `EXPLAIN` already shows) is compared against the scan it would replace; if the index is not actually cheaper, the rule **declines** — the scan stays, and the step still reports what it considered and why it said no (`"…matches the predicate, but the estimated cost disagrees: the lookup would read about N pages against the scan's M — no cheaper, so the scan stays…"`), reusing the existing `Rewrite` type as a no-op carrier (`plan: input, changed: new Set()`) rather than inventing new plumbing. This is the one thing plan.md §12 always drew a line at — not that a rule could never consult a cost, only that doing so had to be a real comparison, never a rule of thumb pretending to be one — and it explicitly **retires `limits.mdx`'s "no cost-based query optimization"** line for these two rules specifically (every other rule still fires on structural match alone). **`emit.ts`'s `withCostJustification`** (which appends the scan-vs-index page estimate to a step's narration) is now only called for a step that actually changed the plan — it previously ran unconditionally and, for a declined step, re-derived its own "Estimated cost disagrees… so the index is taken anyway" text from the *unchanged* plan, self-contradicting the rule's own new decline message in the same narration. **The scale of the consequence, discovered rather than assumed:** with this engine's deliberately tiny, hand-countable constants (`FANOUT = 4`, default `rowsPerPage = 4`), a B+Tree needs two levels for as few as five rows, so a unique equality lookup's own floor cost (`levels + 1`) already exceeds a one-or-two-page scan of nearly every existing test fixture — an honest finding about the model (a real optimizer also prefers a sequential scan below some table size), not a bug, but one that had never had teeth before nothing compared the two numbers. Sized up **12 test files** to cross the honest break-even point rather than lower the bar: fixture tables grown large enough that the real lesson each one teaches (leftmost-prefix entry, covering, leaf-chaining, clustering, non-unique runs, `ANALYZE`-free selectivity) still holds under real cost accounting, using two recurring techniques — growing a low-cardinality column's true domain until its own selectivity clears the honest threshold (`compositeIndex.test.ts`'s `a` going from 4 to 8 distinct values, `planner.test.ts`'s `things`/`tied`/`spans` fixtures from 3–4 rows to 30–100), and, where a specific column's cardinality could not change without breaking an exact hardcoded ratio, padding with far-away filler values that inflate `ndistinct` or widen a column's own min–max span without ever being matched by the test's own predicate — a legitimate demonstration of the documented, ndistinct-only estimator's blind spot on skewed cardinality, not a number invented for the test. One genuinely user-facing consequence: the **"range leap" challenge**'s hinted solution (`id > 40`) no longer beats the scan on the shipped 48-row `users` table, since 8 of 48 rows (17%) sits right at the honest break-even the old "any range wins" version of the rule never had to clear — the challenge's own brief and hint were rewritten to say a *narrow* range is what pays for itself, matching the new, more honest lesson, and its known-solution test uses `id > 44`. The `oracle/coverage.test.ts` "not vacuous" sampler's `repeatedIndexReads` floor was lowered from 10 to 5 (measured at 7 with the suite's fixed seed) since the generator's typically small random tables now legitimately decline a non-unique equality lookup more often than they accept one — still comfortably non-zero, which is what that suite exists to guarantee. New tests in `planner.test.ts` demonstrate the decline path directly (a `logins`-shaped low-cardinality column loses on cost while a unique column on the *same* table still wins, and a wide range on `users.id` declines the same way); mutation-checked by inverting each gate's `>=` comparison, both caught by the new tests. **Slice 2 — join algorithm by cost — built, 2026-09-30.** A new rule, `join-algorithm-selection` (`optimize.ts`), has no shape step at all: `buildPlan.ts` still always starts a `JOIN` chain out as `nested-loop`, its own cost-oblivious structural default (mirroring a bare `SeqScan`), and the rule prices every algorithm that could actually run each step — nested-loop, hash, sort-merge, and index-nested-loop whenever the inner table has a usable index — with `cost.ts`'s own per-algorithm formulas (unchanged, the same ones `EXPLAIN` already showed) and keeps whichever is cheapest, with no "declines but stays" outcome the way index-selection has: every candidate is a real, working plan, so the rule always ends up choosing one, possibly the one already there. A chain (plan.md §25.4 C3 slice b) is priced bottom-up, one `Join` at a time, since an earlier step's own chosen algorithm changes the estimated cost a later step's own comparison has to use. **This is the new shipped default**, not a second opinion: `EngineOptions.joinStrategy` left unset now means "choose by cost" instead of "always nested-loop," which `runQuery.ts` silently defaulted to for every join in the Playground before this — confirmed via `AskUserQuestion` (the same fork C4's own scoping question was, with the opposite answer this time), since the alternative (opt-in only, C4-style) would have kept the Playground running the naive algorithm even when it is honestly worse. `/compare` and `/tools/planner` are unaffected: both already forced a specific `joinStrategy` explicitly for every one of their own runs, and `emit.ts` leaves `join-algorithm-selection` out of `optimize()`'s `enabled` set whenever `joinStrategy` was requested explicitly, so a forced comparison is never silently overridden by the same rule it exists to be compared against. **A real correctness bug found and fixed during this slice, not a pre-existing one:** the rule's first draft rebuilt each candidate's right-hand scan bare (`{op:'SeqScan', table}`), discarding whatever `join-predicate-pushdown` (the rule immediately before this one in `RULES`) had already pushed into it — caught by `join.test.ts`'s own pushdown tests, which started returning unfiltered rows once the default algorithm silently changed underneath them. Fixed two ways: every non-index candidate now reuses the *existing* right-hand scan (filter and all) instead of rebuilding one, and `index-nested-loop` — whose `IndexProbe` node has nowhere to carry a residual filter at all — is excluded from candidacy outright whenever a filter has already been pushed into that side, the same reasoning `join-predicate-pushdown`'s own `probesInner` check already uses to avoid pushing *into* an `IndexProbe` in the first place. Both fixes are independently mutation-checked (removing either one in isolation is caught by its own dedicated test — the second needed a purpose-built small-outer/large-indexed-inner fixture, since the shipped `authors`/`posts` demo is too small for index-nested-loop to ever look cheap enough to expose that specific gap). `oracle/generate.ts`'s `optionsArb.joinStrategy` gained a fifth possible value, `undefined` (cost-chosen), alongside the four explicit algorithms — the fuzzer's own doc comment already commits to "every physical strategy is checked against SQLite, not just the defaults," and a rule that had just produced a real bug is exactly the kind of thing worth fuzzing rather than trusting to hand-written cases alone; three `oracle/coverage.test.ts` thresholds (`repeatedIndexReads`-adjacent index-join stats) needed lowering since each explicit algorithm is now requested by a fifth of sessions instead of a quarter. The **`hash-beats-loop` challenge** (which reruns the player's own query under an explicitly forced `'hash'` to compare against their unforced baseline) needed its own baseline pinned to `joinStrategy: 'nested-loop'` explicitly too — without it, the "baseline" would now already be cost-chosen to hash, same as the comparison run, making every solution look wrong. Retires `limits.mdx`'s "no choosing a JOIN's algorithm by cost either" line. **Slice 3 — join order by cost — built, 2026-10-01.** `runQuery.ts` now actually reorders a chain of 2+ `JOIN`s to C4's own DP-cheapest left-deep sequence before running it — wiring `joinOrder.ts`'s existing search into real execution for the first time, not just `/tools/join-order` and the Playground's informational note. **Deliberately scoped to plain inner-join chains, confirmed via `AskUserQuestion`** (the third such fork this item alone has needed, after C4's own and slice 2's): `LEFT JOIN` is not commutative or associative in general — flipping one, or moving another join between its two sides, can change which rows get NULL-padded, not just the cost — and generalizing the DP to respect that would mean tracking a partial order among steps, not just their cost, a materially harder problem this slice does not attempt. A chain with any `LEFT JOIN` is simply never reordered, the same way index-nested-loop already falls back silently when no index exists. New `isReorderableChain` (2+ joins, none `LEFT`) gates it. **The reconstruction, `rebuildJoinsForOrder`:** the join graph `joinGraphFromAst` already builds is always a spanning tree (one edge per non-`FROM` table, drawn from that table's own `ON` clause), so rebuilding a valid `{from, joins}` pair for a new order only ever needs, for each step, *some* earlier table sharing a real edge with it — never that it be the immediately preceding one (`leftJoinValue`/`leftJoinKeyOf`, plan.md §25.4 C3 slice b, already resolve a qualified reference against the whole chain so far) — so every original `JoinClause` is reused completely unchanged, just reassigning which table it is considered to introduce; a hub table (multiple edges, like the C4 demo's `departments`) picks whichever of its own edges reaches the tables already placed. Returns `null` — leaving the query to run exactly as written — for the (should-be-unreachable on a connected graph) case where an order would need a cross join, since this grammar has no `JOIN` with no `ON` clause to express one with. **Threaded through three places, not just one:** `runQuery.ts`'s `applyCostOrder` runs this before any table is even looked up for real, so table/column validation, the heap, and the plan all naturally see whichever order will execute; `emitParseEvents` is deliberately still called with the *original*, un-reordered AST (a real bug caught before it shipped — the parse stage must narrate source text, never a planning decision, and initially did not); and `emitPlanEvents` gained a `writtenJoinOrder` parameter so the plan-stage narration can say up front, before the trace starts naming a different `FROM` table than the one typed, what changed and why. C4's own "second opinion" note now only fires when reordering did *not* happen for real — either the chain is already optimal, or it contains a `LEFT JOIN`, in which case the note also says so explicitly, rather than leaving the reader to wonder why this chain never reorders when others do. **Tested directly, not just end-to-end:** new `joinOrder.test.ts` cases cover `isReorderableChain`'s `LEFT JOIN` exclusion, `rebuildJoinsForOrder` on the hub-shaped demo dataset (exercising the "table has several edges" path a plain chain never reaches), moving the `FROM` table itself to a different table entirely, and the defensive cross-join-`null` case; `join.test.ts`'s existing three-table chain test needed updating once reordering made its *own* premise (a forced `index-nested-loop` falling back mid-chain) disappear — reordering had found an order where every step could use the index — fixed by padding the small `comments` fixture (irrelevant filler `postId`s, matching nothing) enough that starting from it stops being cheap enough to outweigh the fallback it would dodge, restoring a genuine mid-chain fallback under the new, real, reordered execution. Mutation-checked three ways (the `LEFT JOIN` exclusion, the cross-join guard, the already-optimal short-circuit — all killed). `/tools/join-order`'s own doc comment and on-page text updated: its exact demo query is a plain inner-join chain, so what it shows *is* what now runs, not a second opinion — the page still earns its keep by showing the whole subset lattice the DP weighed, not just the winner. **Deliberately not attempted:** extending the SQLite oracle's fuzzer to generate multi-join chains at all (needed to fuzz reordering specifically) — its own query model still only ever builds a single two-table join, a gap plan.md has flagged as deferred since C3 slice a; extending it for reordering's sake alone is disproportionate to this slice, and correctness here instead rests on the dedicated unit and mutation tests above. **Slice 4 — the "Why not?" panel — built, 2026-10-01, closing C5.** Every C5 mechanism already computed a chosen option's cost next to the one it beat — `index-selection`'s scan-vs-index comparison, `join-algorithm-selection`'s full priced candidate list, join order's DP-vs-written — but only ever said so in a narration sentence; this slice pulls that same already-computed comparison into a small, structured, visually distinct panel rather than inventing any new cost math. Two new shared types in `types.ts`, `CostAlternative` (`{label, estPages}`) and `WhyNot` (`{chosen, runnerUp}`); `Rewrite` (`optimize.ts`) gained an optional `whyNot`, populated by `indexSelection` and `rangeIndexSelection` (the scan when the index wins, the index when the scan wins — the same one comparison the decline/accept branches already made) and by `joinAlgorithmSelection` (the first changed step's own cheapest `runnersUp` entry — a chain with several changed steps still gets the full comparison in its prose `label`, only the panel itself is scoped to the first step, a documented simplification rather than an unsolved one). `StepEventBody`'s `optimize` and `plan` variants both gained the same optional `whyNot`, threaded through `emit.ts`'s/`emitDelete.ts`'s/`emitUpdate.ts`'s existing per-step event emission with no new control flow. **Join order's own panel lives in `emit.ts`, not `optimize.ts`** (it is a plan-stage decision, never a `Rewrite`): the real-reordering narration pairs the chosen order against the written one it replaced; the LEFT-JOIN/already-optimal "second opinion" narration pairs the written order (`chosen`, since it is what actually ran) against the DP's cheaper suggestion (`runnerUp`) — the same two numbers that sentence already named, only shown when the ratio check already gating that sentence (`≥ 1.05`) says there is a real gap worth naming. New shared `<WhyNotNote>` (`src/ui/WhyNotNote.tsx`) renders `{chosen, runnerUp}` as "Why not {runnerUp.label}? An estimated N pages — against {chosen.label}'s M, the one actually chosen," reused verbatim in two places: the Playground (`PlaygroundPage.tsx`, read off `state.lastEvent`'s own `whyNot` right below the Narration box — present only on the exact step a cost-based rule or the join-order check actually fired) and `/tools/planner` (next to the specific rule's own `label`, since that page already iterates `optimize()`'s raw `Rewrite[]` directly). `/tools/join-order`'s own lattice (`CandidateRow`, built in C4) already shows every candidate the DP tried, not just one runner-up — richer than this panel and untouched here; this slice's narrower, single-runner-up panel is for the Playground/`/tools/planner`'s per-step view, where the full lattice would not fit. **Checked by:** new assertions on 6 existing tests across `planner.test.ts` and `join.test.ts` (both index-selection branches — decline and accept, `chosen`/`runnerUp` swapping sides between them — join-algorithm-selection's cheapest-runner-up pick, and both join-order narration paths, each confirming the exact `{chosen, runnerUp}` pairing and that `chosen.estPages` beats `runnerUp.estPages` the right way round); mutation-checked four ways (swapping `chosen`/`runnerUp` in the index-selection decline branch, in `joinAlgorithmSelection`, and in the join-order reordering block, plus inverting the `ratio` guard on the second-opinion block to show when it should actually be silent) — all four caught by the new assertions. Live-verified in both the Playground and `/tools/planner`: the index-selection panel ("Why not a sequential scan? ... against `id` index lookup's 4 pages"), the join-algorithm panel (correctly naming sort-merge, not nested-loop, as hash's cheapest runner-up), the real-reordering join-order panel, and the LEFT-JOIN second-opinion panel (correctly pairing the written order as `chosen` against the cheaper blocked order as `runnerUp` — the one case where the pairing flips relative to the real-reordering case). Three routes needed a budget bump from the new types/component rippling through the engine chunk and `/tools/planner`'s own direct import: `/progress` 168→171 kB, `/assignments/new` 163→166 kB, `/tools/planner` 165→168 kB (each its own measured size + 3, the usual slack). **C5 is now fully built** — index vs. scan (slice 1), join algorithm (slice 2) and join order (slice 3) all chosen by cost, and the "Why not?" panel (slice 4) explaining all three — closing plan.md's whole "Cost-based choice + 'Why not?'" line; C6 (Worker engine + larger data) is next. | 1.5 wk |
| **C6** | 2.1 | **Worker engine + larger data** | **Slice 1 — the `transactions` preset dataset — built, 2026-10-01.** The "1k–10k-row datasets; taller B+Trees; a genuinely thrashing pool" third of this item, done first since the other two (the Web Worker move, focus+context tree rendering) only make sense once bigger data actually exists to motivate them — building them first would be designing against a guess. New `DatasetId` member `transactions` (`src/engine/datasets.ts`), 3,000 rows (`id`/`account`/`amount`/`status`), only `id` indexed — mirrors `orders`'s existing "deeper tree, harder eviction" shape at a dramatically larger scale, not a new selectivity lesson (that is `logins`'s and `employees`'s job already). **Sized by measurement, not estimation** (a throwaway probe script building the real `BPlusTree` via `buildHeap`/`buildIndex`/`height()` — not the cost model's own log-estimate — across 500 to 10,000 rows): 3,000 was the smallest size that reached height 7, a full two levels past `employees`'s 250-row height 5, the tallest tree any existing preset reached. **A second probe pass measured actual trace length before picking the demo queries**, since a `SeqScan`'s own per-page buffer/lock events scale with heap pages touched regardless of a pushed-down filter's selectivity, while its "row returned" narration events scale with matches only — so an indexed point lookup or a narrow indexed range stays a short trace (53–204 events, measured) at any table size, while an unindexed predicate's trace scales with the whole table (4,343 events measured for the chosen "Eviction storm" preset at 3,000 rows) — deliberately kept as the *one* preset that shows that cost, not the starter query. Four presets: **Deep lookup** (the starter, `id = 1500`, short), **Range lookup** (`id BETWEEN 1500 AND 1520`, an indexed leaf-chain walk — short, but with real eviction, the "focus" case without the "storm"), **Eviction storm** (`amount > 4500`, unindexed, the dramatic one — live-verified in the Playground reaching 339 evictions and a 0% hit rate by step 2000 of 4,343), and **EXPLAIN ANALYZE** on the same storm query. **Checked by:** new dedicated tests in `datasets.test.ts` (the real tree height exceeds both `orders`'s and `employees`'s, measured via the same `buildHeap`/`buildIndex`/`height()` path the dataset's own doc comment cites; eviction count on the storm preset beats `orders`'s comparable scan by more than 5×; the point lookup and narrow range both stay under their measured event-count ceilings) and `datasetCatalogue.test.ts` (the range preset genuinely fires `range-index-selection` rather than falling back to a scan; the storm preset's eviction count clears the point lookup's by a wide, explicit margin) — both files' existing `it.each(DATASET_IDS)` parametrized tests picked up the new id for free, with zero changes needed. TypeScript's own exhaustiveness checking over `Record<DatasetId, …>` (`DATASETS`, `DATASET_CATALOGUE`) was trusted to surface every call site needing a new case — `pnpm typecheck` stayed clean, confirming no other file hardcodes the dataset-id list outside those two. Six routes needed a budget bump, a wider set than a typical engine-only change touches, since the dataset picker itself is shared by several tool/docs demo pages, not just the Playground: `/`, `/stages`, `/tools/buffer-pool`, `/tools/parser`, `/tools/page`, `/docs/concepts/buffer-pool` (each its own measured size + 3). Live-verified in the Playground: the new chip and its blurb render correctly; the B+Tree panel shows a visibly, dramatically taller tree than any other preset — and flowinger's existing pan/zoom/fit controls already handle it with no rendering issues, confirming the "focus+context" tree-rendering sub-item is a later polish pass, not a blocker for this data to ship and be usable today; the Buffer Pool panel genuinely thrashes on the storm preset; no console errors. **Not yet started:** the Web Worker move (`runQuery` behind the §5-designed seam) and focus+context tree rendering — next, once there's reason from real use to believe either is actually needed, not assumed up front. **Measured, 2026-10-01, not guessed — and the measurement is the finding:** before writing either, timed `runQuery` and the UI's own `createTraceProjector` fold (`viewState.ts`) against the worst case this dataset range can construct — a 10,000-row table, a fully unfiltered scan (~32,500 trace events, more than any shipped preset reaches). `runQuery` itself: 2.5–3ms median on the shipped `transactions` presets, 9.5ms median / 13ms max even on the constructed 10k-row worst case. The UI's own cold fold straight to the last step (what a "Scrub to step" slider drag actually triggers, `createTraceProjector`'s `while` loop filling its cache for the first time) — the one place `runQuery`'s own speed doesn't by itself prove the UI stays smooth: 0.5ms on the shipped 4,343-event preset, 4.3ms median / 7.7ms max on the 10k-row worst case. Both comfortably inside §5's own original claim ("execution over toy data is microseconds, so there is no jank to prevent") at the new, larger scale, not just the old one. The B+Tree panel's own rendering was already confirmed clean at the new height in slice 1's own live verification, no new measurement needed there. **Asked the user how to proceed given neither of C6's two remaining triggers (main-thread jank, an unreadable tree) has actually fired: defer both, confirmed.** C6 is **substantially done** for now — slice 1 delivered the one piece with a real, already-reached trigger (bigger tables for C1-style demonstrations); the Web Worker move and focus+context tree rendering stay explicitly un-built, revisited only if real future use (a dataset past 10,000 rows, a query shape this one's probes didn't cover, an actual reported slowdown) gives either one a genuine trigger rather than an assumed one. | 2 wk |

#### D. Transactions — the second subject (lectures 18–21; gated, §25.6)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **D1** | 2.2 | **Schedules + sessions** | `runSchedule([(session, stmt), …], db)` — **the interleaving is an input**, so the engine stays pure; `BEGIN` / `COMMIT` / `ROLLBACK`; Session A / B lanes with a shared timeline; the schedule is a share URL | 2 wk |
| **D2** | 2.2 | **Enforced lock manager** | Graduate `ui/lockSimulation.ts` (FIFO waiters, wait-for graph, deadlock, youngest victim) into `engine/locks/lockManager.ts`; **strict 2PL**; page-vs-row granularity. The Locks stage stops being "visual only" | 1.5 wk |
| **D3** | 2.2 | **Isolation by locking** | READ UNCOMMITTED / COMMITTED / REPEATABLE READ / SERIALIZABLE via lock-duration rules; a toy predicate-lock case for phantoms | 1 wk |
| **D4** | 2.2 | **MVCC / snapshot isolation** | Hidden `xmin` / `xmax` per tuple version; snapshots; the visibility rule as a **predict-then-reveal** ("can T2 see this version?"); first-committer-wins; **write skew**; vacuum and dead-tuple bloat interacting with the buffer pool | 2.5 wk |
| **D5** | 2.2 | **`/tools/isolation` — the Hermitage matrix** | The ten Hermitage anomalies × five levels × {2PL, MVCC}, **computed by running each schedule**; tests assert PostgreSQL's and InnoDB's *documented* outcomes (behaviour, not implementation) | 1 wk |
| **D6** | 2.2 | **Concurrency-control compare** | 2PL vs. timestamp ordering vs. OCC vs. MVCC on one schedule: aborts, waiting, anomalies (lectures 19–21) | 1 wk |

#### E. Durability — the third subject (lectures 22–23)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **E1** | 2.3 | **WAL** | Log records (LSN, prevLSN, txn, page, redo/undo), a log buffer and flush, the **log-before-data rule enforced on the buffer pool** | 1.5 wk |
| **E2** | 2.3 | **Steal/no-steal × force/no-force** | The four combinations with their visible consequence — the payoff of v1's dirty writeback (§22.2: "the buffer pool's other half") | 1 wk |
| **E3** | 2.3 | **Checkpoints, crash, ARIES** | Fuzzy checkpoints; a **crash button** that drops the pool and keeps disk + log; analysis → redo → undo with the dirty-page table, transaction table and CLRs as panels — `/tools/recovery` | 2 wk |
| **E4** | 2.3 | **Recovery in the pipeline** | Run `UPDATE`s in the Playground, crash, recover, compare with the committed state | 1 wk |

#### F. Storage engines & access methods (lectures 5–10, 14; parallelisable; Q6 applies to each)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **F1** | 2.4 | **`/tools/lsm` + Bloom filter** | **Slice 1 — the LSM-tree sandbox, leveled compaction — built, 2026-10-01.** The core of `/tools/lsm`: a new, wholly standalone `src/ui/lsm.ts` driver, the same family as `/tools/sort`'s `externalSort.ts` and `/tools/hash-join`'s `hashJoin.ts` — pure and total, laying out a whole write sequence's resulting structure (every flush, every compaction, the final levels) up front, parameter-driven in the UI rather than animated playback. **The model:** writes buffer in a memtable; once it holds `memtableCapacity` entries it flushes as one new, immutable, sorted SSTable at L0; L0's own SSTables may overlap in key range (each is just whatever the memtable held at flush time) and compact into L1 once L0 holds `l0CompactionTrigger` of them; level *n* ≥ 1 has a capacity of `baseLevelCapacity × levelSizeMultiplier^(n-1)` entries and compacts into the next once exceeded. **Compaction is deliberately simplified**, the same honest simplification the B+Tree's own tiny fan-out already makes (`index/btree.ts`'s own doc comment): a real leveled compaction merges one file at a time, picked by a scheduling policy; this model merges a *whole* level's current SSTables (plus whichever next-level SSTables their key ranges overlap) in one step, keeping only each key's newest write, then re-splits the result into fresh, non-overlapping SSTables — never a file-picking heuristic that would only obscure the real lesson (data cascades downward, each level is geometrically bigger than the last, and write amplification is *why* a key gets physically rewritten every time it moves down). **Write and space amplification are real, computed counters** (entries ever physically written ÷ entries you asked to write; entries currently on disk, stale duplicates included, ÷ distinct live keys) — not estimates. **Read amplification is a worst-case count** (every L0 table, since any of them can hold a given key, plus one per non-empty level below, since each level's own tables never overlap each other) — honest about not yet having a Bloom filter to actually narrow it, which is explicitly this item's own next slice, not pretended at. **A genuinely interesting, non-obvious finding, not a bug:** write amplification can measure *below* 1× — caught by a property-based fuzz test's own counterexample, not assumed away. Two writes to the same key landing in the same memtable batch, before either is ever flushed, coalesce to one physical write — a real write-reduction a memtable provides for free, the exact reason LSM trees can beat naive in-place updates for hot keys, not a flaw in the model; turned into its own dedicated regression test once understood, and live-verified in the browser (write amplification visibly drops to 0.90× under generous capacity settings where every write fits before any flush). **Checked by:** 19 tests in `lsm.test.ts`, including a `fast-check` property test over the whole legal parameter space asserting the on-disk state always matches a naive replay of the write sequence exactly, and every level past L0 stays non-overlapping; mutation-checked two ways (the "newest write wins" dedup rule, the overlap-detection guard driving which next-level tables a compaction merges with — both caught cleanly). Full gate (typecheck/lint/1899 unit tests/98 e2e/build/budget) all green; a new route, `/tools/lsm` (114.7 kB measured + 3, self-contained — no shared engine-chunk impact, so no other route moved), registered in `App.tsx`, `ToolsIndexPage.tsx`, and the course map (`course-map.mdx`'s "Log-structured storage" row, Not covered → Partly — its stale neighboring "Cost models and join ordering" row, never updated when C4/C5 shipped, corrected to Covered in the same pass). Live-verified: the level cascade, the non-overlapping key ranges at L3, the click-to-see-provenance interaction ("compacted from 6 tables"), and the live write-amplification-below-1 demonstration, all exactly matching the numbers a probe script computed beforehand. **Deliberately deferred to later slices, matching this item's own remaining scope:** the Bloom filter (the read path these counters are honest about not yet narrowing), tiered compaction as a second, selectable strategy, and the `/compare` B+Tree-vs-LSM mode.

**Slice 2 — the Bloom filter, and a real read path — built, 2026-10-01.** Every SSTable now carries its own Bloom filter, built from the keys it holds at flush or compaction time, sized by a user-tunable `bitsPerKey` (2–20): `m = n × bitsPerKey` bits, `k = (m/n) × ln(2)` hash functions — the standard space/accuracy optimum, not a fixed guess. All *k* bit positions for a key come from two independently mixed hash values via Kirsch–Mitzenmacher double hashing (`h_i = h1 + i·h2`), one evaluation standing in for *k*. **A hash-quality bug caught empirically, before it ever shipped:** the first validation probe used an all-even insert-key set against an all-odd test-key set, through a bare single-multiply hash — and measured a suspiciously perfect 0% false-positive rate at *every* `bitsPerKey` value, including ones where the textbook formula predicts ~40%. Traced to the real cause: even keys × odd multiplier = even product, even mod an even table size = always even, so even keys only ever set even-indexed bits and odd test keys only ever check odd-indexed ones — a parity artifact of the test methodology, not evidence about the filter. The probe was fixed to use disjoint random key sets either way, and the real hash function was hardened anyway (a full xorshift-and-multiply integer-mixing finalizer, applied twice, in place of the bare multiply) since a user could still explore structured key patterns interactively. **`lookupKey` is a real, traceable read path**, not a narrated approximation: it checks each candidate table's Bloom filter first (skipping any table the filter rules out), physically checks the table only when the filter says "maybe," returns the first real hit, and records every table it checked and which of those were false positives. L0 tables (key ranges may overlap) are checked newest-first, since a key can legitimately sit in more than one, with different values, before compaction catches up; every level below is checked by exact non-overlapping-range membership, same as the B+Tree's own leaf chain. **`readAmplificationAverage` and `measuredFalsePositiveRate` are now measured, not estimated**, closing the honesty gap Slice 1 named explicitly: every distinct key actually written (an expected hit) plus an equal-sized sample of keys strictly past the highest key ever written (guaranteed misses) are each looked up for real through `lookupKey`, and the two rates are read off what actually happened — validated against the textbook formula across the full `bitsPerKey` range before trusting it. The read-amplification worst-case stat stays alongside the measured one, so the Bloom filter's own payoff (worst case vs. what it actually achieves) is visible, not just asserted. **Checked by:** 7 new tests (26 total in `lsm.test.ts`) — Bloom-filter-specific ("no false negative, ever," "a wider filter never raises the measured false-positive rate," "measured read amplification is at most the worst case") and a new `lookupKey` describe block (finds every key with its newest value regardless of cascade depth, a genuine miss is a genuine miss every time, every table actually checked had already passed its own filter); the property-based fuzz test extended with a new `bitsPerKey` parameter and a no-false-negative assertion over the whole legal range. **Mutation-checked two ways:** forcing `bloomMightContain` to always return false (caught cleanly — the no-false-negative dedicated test and the property test's own loop both failed, as expected); flipping L0's newest-first scan to oldest-first (**not caught by any existing test** — every test's `l0CompactionTrigger` was low enough that compaction always drained L0 below 2 tables before a plan was ever queried, so the ordering was structurally unreachable in the existing suite. A genuine coverage gap, not a safe mutation: fixed by adding a dedicated regression test that holds a high trigger so two L0 flushes of the same key, with different values, coexist at rest — confirming the newer one wins). Full gate (typecheck/lint/1906 unit tests/98 e2e/build/budget) all green, no budget ceiling bump needed (`/tools/lsm` measured 115.8 kB against its existing 118 kB ceiling). Live-verified in the browser: a real hit (key 1, value 427, highlighted green with "found here"), a genuine miss (strictly past the max written key, zero false positives), and the `bitsPerKey` selector moving the measured false-positive rate from 67.4% down to 0.0% live, with the URL's own `bits` param following along — all exactly matching a probe script's numbers computed beforehand. **Still deliberately deferred, matching this item's own remaining scope:** tiered compaction as a second, selectable strategy, and the `/compare` B+Tree-vs-LSM mode.

**Slice 3 — tiered compaction, a second selectable strategy — built, 2026-10-02.** `LsmOptions` gained `compactionStrategy: 'leveled' | 'tiered'`, a UI dropdown, and a `?strategy=` URL param. **Leveled's own code and behavior are completely unchanged** — `compact()` is now a two-way dispatcher (`compactLeveled`/`compactTiered`), with every one of Slice 1 and 2's own 31 tests passing byte-for-byte against the untouched `compactLeveled` path, confirmed before writing a single line of the new strategy. **Tiered, the real RocksDB-style alternative** ("universal" compaction, as opposed to leveled's default): once a level — any level, not just L0 — accumulates a shared `filesPerTier` trigger's worth of SSTables (the same field L0's own trigger already used, now reused at every level under this strategy), they merge into ONE new, unsplit table that moves down a level, leaving whatever the next level already holds completely untouched until IT, too, fills up. This is the opposite of leveled's own re-split-and-merge-with-overlapping-neighbors behavior, and genuinely trades one real cost for another, not a cosmetic toggle: **tiered touches less data per compaction** (never rewriting what the next level already has), so it costs measurably **less write amplification** for the same writes — but now any level, not just L0, can hold several overlapping SSTables, so a lookup may have to check every table at every level, costing measurably **more read amplification**. **Both directions of the trade-off were measured via a probe script before writing a single test assertion** (this project's standing discipline): across write counts 60/100/150 with identical parameters, tiered's write amplification measured consistently 0.48–0.59× of leveled's, and its worst-case read amplification measured 1.33–2.5× leveled's — a real, reproducible, bidirectional gap, not assumed from the textbook description. `lookupKey` gained a required `strategy` parameter: L0 is always scanned newest-first in full either way, but below L0, leveled keeps its existing single-range-match lookup while tiered scans every table at a level newest-first, the same way L0 always has. `readAmplificationWorstCase` is now strategy-aware too (every L0 table plus one per non-empty level below, for leveled; every table at every level, for tiered). **Checked by:** 5 new tests — tiered still replays correctly and every one of its compaction events creates exactly one unsplit table (never re-split, the defining structural difference from leveled); a same-writes-same-parameters A/B test asserting tiered's write amplification is measurably lower than leveled's; a second A/B test asserting the opposite for worst-case read amplification; a dedicated regression test holding two overlapping tables in L1 at rest (a `filesPerTier` of 4 lets two separate L0→L1 merges coexist below the trigger) confirming `lookupKey` returns the newer one, not the first range match — the exact same "newest wins across overlapping tables below L0" property Slice 2 proved for L0 itself, now proved one level down; and a SEPARATE `fast-check` property test scoped to tiered (replay-correctness and no-false-negative hold for tiered too, but NOT the non-overlap invariant, which is genuinely false by design under this strategy — kept as its own test rather than bolting a strategy conditional onto the existing leveled-only property test). **Mutation-checked two ways:** making tiered's own next-level merge REPLACE instead of append (silently defeating the overlap the whole strategy exists to allow) — caught by 4 tests at once (the overlap regression test, the plain correctness replay, and the tiered property test's own two assertions); inverting `lookupKey`'s strategy branch (tiered levels wrongly using leveled's single-range-match search) — caught by 2 tests (the overlap regression test returned the stale value; the property test's own no-false-negative loop failed on a case the wrong search path missed entirely). Full gate (typecheck/lint/1911 unit tests/99 e2e/build/budget) all green, no budget ceiling bump needed (`/tools/lsm` measured 116.2 kB against its existing 118 kB ceiling). Live-verified in the browser at the exact probed numbers: switching the existing demo from leveled to tiered visibly dropped write amplification from 3.83× to 2.97× and raised worst-case read amplification from 1 to 2 simultaneously; L1 and L3 rendered with genuinely overlapping key ranges (`keys 6–21` and `keys 1–21`); the leveled-only L1-capacity/level-size controls visibly greyed out and disabled; the shared trigger control's label switched to "Files per tier"; clicking a tiered-compacted table correctly named "compacted from 2 tables." No console errors.

**Slice 4 — the `/compare` B+Tree-vs-LSM mode, closing F1 entirely — built, 2026-10-02.** A new, sixth `/compare` mode feeds the exact same write sequence (`/tools/lsm`'s own `demoWrites`) into a real B+Tree (`engine/index/btree.ts`'s `createTree`/`insert`/`height` — the same code `/tools/btree` already drives, extended here to a second use) and into `planLsm`, side by side. **"Amplification numbers from real counters" on both sides** (this item's own long-standing "not started" checklist line, §25.4's definition-of-done), measured in deliberately DIFFERENT units — a new `src/ui/btreeWriteCost.ts` module counts B+Tree write cost in index PAGES touched per write (a B+Tree updates in place: an insert touches at least its own leaf, and only more when a split cascades upward), against `lsm.ts`'s own existing counter in raw ENTRIES rewritten per write (an LSM tree defers writes into a memtable, then physically rewrites the same entry again and again as compaction sweeps it through deeper levels). **The unit mismatch is not papered over — it IS the lesson**, stated directly in both the page's own explanatory text and `btreeWriteCost.ts`'s doc comment: comparing the two numbers side by side shows *why* they're counted differently, which is the actual structural contrast between the two designs. **Measured the same way `lsm.ts` measures its own counters**: `planBTreeWrites` snapshots every node's serialized content immediately before each `insert`, then diffs against the tree's own `nodes` map afterward — any node that is new, or whose content changed, was a real write for that one logical write; needed no new B+Tree instrumentation, since `nodes: Record<string, BTreeNode>` is already the tree's full, authoritative state. **A genuinely interesting, real contrast, confirmed by measurement before writing any UI text:** at the same 150-write demo, the B+Tree touches 1.44 pages per write and a point lookup always costs exactly 4 page reads — both numbers stay small and roughly constant as data grows. The LSM tree (leveled) physically rewrites 6.21 entries per write — a real, measured, GROWING cost (3.87× at 60 writes, 6.21× at 150, 6.48× at 200 — confirmed via probe script before committing to the demo's default write count) — but a real lookup with the Bloom filter costs only 0.61 table checks on average against a worst case of 3, comparable to or better than the B+Tree's own fixed cost. **This closes the loop on every earlier F1 slice at once**: slice 1's write/space amplification, slice 2's Bloom filter and measured read amplification, and slice 3's leveled-vs-tiered trade-off all feed directly into this one closing comparison. **A second genuinely interesting fact, worth its own dedicated test:** unlike `lsm.ts`'s own write amplification (which can measure *below* 1×, slice 1's own finding, from in-memtable write coalescing), a B+Tree's write amplification can never drop below 1 — there is no buffering stage to coalesce a repeat write into before anything is physically touched; every write touches at least one leaf, full stop. **Checked by:** 6 new dedicated tests in a new `btreeWriteCost.test.ts` — exact node-write counts for a non-splitting insert (1), a splitting insert (3: the rewritten leaf, the new sibling, the new root), and a same-key update (1, no restructuring, confirmed via the tree's own unchanged node count); read cost always equals the tree's own height; an empty sequence still costs nothing beyond the one all-trees-start-with empty root leaf; and a `fast-check` property test over the whole legal parameter space asserting write amplification never crashes, is always finite, and — the direct, measured contrast with `lsm.ts`'s own property test — is never below 1. **Mutation-checked:** changing the node-write counter to count only brand-new nodes (never rewritten existing ones) — caught by 4 of the 6 tests at once (the non-splitting-insert count, the same-key-update count, and both assertions in the property test), confirming the diff genuinely needs to catch in-place content changes, not just allocations. Full gate (typecheck/lint/1917 unit tests/100 e2e/build/budget) all green; `/compare`'s own budget needed a ceiling bump (171 → 175 kB, measured 172.0 — the new mode pulls both `lsm.ts` and `btreeWriteCost.ts`, and transitively the engine's B+Tree module, directly into `ComparePage`'s own lazy chunk). Live-verified in the browser at the exact probed numbers: the default 150-write demo's B+Tree and LSM columns both rendered correctly; the Writes input live-updated both sides to 60 writes' own exact numbers with no Run button needed (matching `/tools/lsm`'s own live-update convention, unlike every other `/compare` mode's SQL-then-Run pattern); the "an LSM tree" link correctly pointed to `/tools/lsm`; switching back to the pre-existing "JOIN algorithms" mode confirmed zero regression from the new mode's addition. No console errors. **F1 is now fully closed** — the LSM-tree sandbox, its Bloom filter, tiered compaction as a second strategy, and the `/compare` mode are all built, tested, mutation-checked, and live-verified. | 2 wk |
| **F2** | 2.4 | **`/tools/hash-index`** | Extendible and linear hashing (directory doubling, local / global depth); why a hash index cannot range-scan | 1 wk |
| **F3** | 2.4 | **`/tools/columnar`** | NSM / DSM / PAX layouts; dictionary / RLE / delta / bit-packing with compressed-size counters; late materialization; a `ColumnScan` operator — which finally gives **projection pushdown** something real to save (§22.9 declined it for lack of that) | 2 wk |
| **F4** | 2.4 | **Vectorized vs. tuple-at-a-time** | Count of `next()` calls per row vs. per batch on the existing operators | 1 wk |
| **F5** | 2.4 | **`/tools/latch-crabbing`** | Safe-node rule; optionally optimistic lock coupling; scripted threads | 1 wk |
| **F6** | 2.4 | **`/tools/vector-index`** | Brute force vs. IVF vs. HNSW on 2-D points; recall vs. distance-computations; HNSW layers rendered with `flowinger`. The syllabus now lists vector indexes with trees and hash tables | 1.5 wk |
| **F7** | 2.4 | **Buffer-pool depth** | LRU-K / 2Q, a scan-resistant ring buffer, sequential prefetch — in the sandbox and `/compare` | 1 wk |

#### G. The learning layer

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **G1** | 2.0 | **Course map + interview roadmap** | **Built, 2026-09-25.** Two docs pages under a new *Study* group (`/docs/study/course-map`, `/docs/study/interview-roadmap`; in the sidebar and the footer). **Course map:** 21 topics of a typical database course, each marked *Covered* / *Partly* / *Not covered* **in words, not just symbols**, with the pages that let you practise it and — as important — what is missing; brought up to date with v2 (relational algebra, SQL tier 2, composite/`UNIQUE`/bulk-loaded indexes, the fourth join, `EXPLAIN ANALYZE`) and honest about the rest (no MVCC, logging, recovery, LSM, columnar, filters, distribution; two-phase locking only as a standalone tool). **Non-affiliation is stated first and plainly**: the public schedule of a well-known course was read for lecture *titles* only; nothing is reproduced or endorsed. **Interview roadmap:** six weeks (pages and the buffer pool → indexes → joins, sorting, aggregation → the optimizer → transactions, flagged as mostly *not here* → put it together), each with *watch* (routes), *explain* (questions to answer out loud) and *check* (the challenges that only pass if the engine did what you said), and an explicit *what this will not prepare you for*. No company's questions are reproduced. A Playwright test visits every internal link on both pages (33 destinations) and fails on the app's 404; the two routes are in the cold-load list. Cost: the shared docs chunk grew ~7 kB gzip (`/docs` ceiling 141 → 149) | 3–4 days → **built** |
| **G2** | 2.5 | **Confidence ratings** | "How sure are you?" with each prediction; a calibration curve in `/progress`. **Verify the hypercorrection literature before building** (RESEARCH.md §39.2) | 2 days |
| **G3** | 2.5 | **Misconception-tagged challenges** | ~6 challenges from the SQL-misconception categories: an index that *hurts*, "LRU is what real engines run", `COUNT(*)` vs `COUNT(col)`, a function on the column defeating the index | 1 wk |
| **G4** | 2.5 | **Generated, graded questions + spaced review** | Seeded generators with engine-computed answers (next clock-sweep victim, split point, chosen index, visible tuple), a Leitner scheduler in `localStorage`. **After §9**, disjoint from `STUDY.md`'s bank; built as an experiment with its own measurement | 1.5 wk |
| **G5** | 2.5 | **Detail levels** | Novice / standard / expert narration and panel set. Needs event-label variants — **do together with H5** | 1 wk |
| **G6** | 2.5 | **Trace diff** | "What changed since my last run", reusing `/compare`'s scoring | 3 days |

#### H. Reach & platform

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **H1** | 2.5 | **PWA / offline** | A hand-written service worker precaching hashed assets, a manifest, `worker-src 'self'` / `manifest-src 'self'` in the CSP, the build stamp driving invalidation. **No new dependency** (Workbox declined for weight). Makes a lecture hall with bad Wi-Fi a non-event. Verify on a preview deploy first (§25.5) | 2–3 days |
| **H2** | 2.5 | **Embeds + essays** | `/embed/:view` routes with `frame-ancestors *` on that path only (a per-path `_headers` block), a documented `postMessage` API; 2–3 interactive essays (B+Tree, buffer pool, isolation anomalies) that double as launch content | 1 wk |
| **H3** | 2.0 | **Publish the CLI and `@querylens/engine` 0.x** | `dist` build, `files` allow-list, npm provenance from a tag-triggered OIDC workflow, a stability disclaimer. The "second consumer" trigger (§22.8) is met — the site and the CLI already are two. **Scope decided, 2026-09-24:** `@querylens/engine` and `@querylens/mcp` under an npm organisation named `querylens`; the CLI unscoped as `querylens` (free, so `npx querylens` works — claim it early, since an unclaimed name can be taken). **Needs you:** create the organisation (free for public packages; I cannot create accounts) and enable trusted publishing (OIDC) for this repository; then I wire the tag-triggered workflow. *Caveat:* "unclaimed" comes from a package search, and a scope can be held by an account with no packages — if creating `querylens` says it is taken, fall back to `@query-lens` | 3–4 days |
| **H4** | 2.0 | **`@querylens/mcp` + `llms.txt`** | **Built, 2026-09-28** (npm publishing still needs H3's organisation). `mcp/server.ts`: three tools over the real `runQuery` — `run_query` (rows, disk reads/hits/evictions, and the full step-by-step narration, JSON), `explain_trace` (PostgreSQL-shaped plan text, `EXPLAIN` or `EXPLAIN ANALYZE`), `compare_policies` (the same query under LRU and clock, side by side) — each grounded in an actual engine run, not a prompt an assistant could hallucinate past, over three preset datasets (`users`/`orders`/`logins`, columns read live so a tool's own description can never drift from the data). Runs locally over stdio (`pnpm mcp`); no hosted service (RESEARCH.md §44 — a toy in-memory engine with no auth is not a thing to expose to the internet). Tested over the SDK's own in-memory transport pair — a real client, a real server, real JSON-RPC, no mocks — covering all three tools, an error surfaced as data rather than a thrown failure, every dataset, and both `EXPLAIN`/`EXPLAIN ANALYZE`; a separate spawn-and-handshake check confirms the stdio entry point itself starts and answers `initialize` for real. `public/llms.txt`: a machine-readable docs index in the https://llmstxt.org shape, generated (`pnpm llms-txt`) from `src/docsNav.ts` and every page's own frontmatter `title`/`description` — never hand-duplicated, so it cannot drift the way a hand-written summary would — and `build-llms-txt.test.ts` fails the build if the committed file disagrees with what regenerating it produces right now, the same "regenerate or the build catches it" discipline `public/og.png` (§19.3) already has. Seams: `@modelcontextprotocol/sdk` + `zod` added as dependencies; `tsconfig.node.json`/`vite.config.ts`'s test `include` gained an `mcp/**` entry, parallel to `bin/`/`scripts/`/`oracle/`. Not yet published — `bin/querylens.ts` (the CLI) is in exactly the same state, working and unpublished, since before this item | 3 days |
| **H5** | 2.5 | **i18n (conditional)** | Engine events carry `{key, params}` beside the English `label`; a catalogue; one locale **only with a named maintainer** (§22.6's standing rule) | 2–3 wk + per locale |
| **H6** | 2.5 | **Accessibility depth** | Arrow-key navigation among diagram nodes; a **manual** NVDA / VoiceOver / TalkBack pass; a published WCAG 2.2 AA conformance statement; a data-table view for every new panel | 1 wk + ongoing |
| **H7** | 2.5 | **Workspaces** | Named custom databases and saved queries in IndexedDB / OPFS with **export / import** (no backend); lifts `localStorage`'s ~5 MB and makes a custom database shareable as a file | 4–5 days |
| **H8** | 2.0 | **Budgets by route** | **Built, 2026-09-25 — pulled ahead of B3 because the shared `trace-ui` ceiling needed raising on nearly every v2 commit (56 → 57 → 60 → 64 → 66 kB in a day).** `scripts/bundle-budget.ts` now prices each of **30 routes — one row per page and per tool** — as the gzip size of the entry chunk + that route's lazy chunk + every static dependency of either, read from Vite's manifest (`build.manifest: true`): what a visitor to `/compare` actually pays, not a chunk-name group. Nothing can borrow another route's room; a chunk no route reaches fails the build (so a new tool must add its row, §25.2 Q8); opt-in chunks (`inp`, `html-to-image`) have their own rows; the entry chunk stays ≤ 24 kB (22.0); the old sum (424 kB) is printed as *informational* — no one downloads all of it. **What it revealed:** the landing page costs **147 kB**, the Playground **296 kB** (CodeMirror is 116 of it), a single challenge **269 kB**, and *every* route pays a **110 kB floor** (React 73 + the app shell 22 + CSS 14) — and the chunk named `flow` is mostly React's core, not flowinger + d3 as the old note said. Logic unit-tested against a fake manifest (closure, shared files counted once, unreached chunks named, one row per tool). Ceilings sit ~3 kB above today's sizes. Not counted: fonts and images | 1 day → **built** |

### 25.5 Engineering rules for v2

1. **Concurrency, crashes and faults are inputs** (§25.2 Q7) — schedules and fault points, never threads.
2. **Budgets by route** (H8) before 2.2. Each tool is its own lazy chunk.
3. **No new runtime dependency without review.** The release-age floor and `allowBuilds` exist for a reason,
   and the first deploy showed `allowBuilds` is a *mapping*, not a list. Prefer none: the oracle uses a
   built-in module and an existing devDependency; the service worker is hand-written.
4. **Exercise platform config on a preview deploy before relying on it.** The first deploy failed three
   ways on config no local check could see (§24.4). Any change to `_headers`, `wrangler.jsonc`, `public/` or
   the CSP — every one of H1, H2 touches them — gets a preview-deploy check.
5. **A text alternative and an axe check for every new panel** (Q6).
6. **Docs move with capability, in the same commit** — `sql.mdx`, `limits.mdx`, `ui/grammar.ts`. v20 found
   three stale reference pages; the drift test on the grammar is the model.
7. **Fuzz is seeded and bounded in CI**; long runs live in a scheduled, read-only workflow.

### 25.6 Gates and kill criteria — the §9 checkpoint

v14 lifted §9's *blocking* of the backlog; v2 keeps building but installs **a checkpoint before 2.2** — the
first release that adds a subject §22.1 called a second product. The study (A2) runs during 2.0. **Decided, 2026-09-24: run it, do not keep building first.** The kit is
built (A2); what remains is people — pilot with two or three (one on a phone), then recruit. Nothing in 2.0's
other items depends on the result, so they proceed in parallel; only 2.2 waits.

| §9 result | Reading | Action |
|---|---|---|
| QueryLens beats the text control on the post-test | The format works | Proceed with 2.2–2.4; fund G4 |
| **No detectable difference** | **Inconclusive, and the likely outcome at 5–10 per arm** — that n detects only d ≳ 1.2; typical animation effects are d ≈ 0.4 (RESEARCH.md §39) | Proceed with 2.2, but fund the learning layer (G2–G4) alongside; seek larger n through a course adoption |
| Text control beats QueryLens | Something is wrong | **Freeze 2.2–2.4.** Diagnose by question and by panel; fix narration and prediction first |

- **Time-box.** If fewer than 10 completed per arm by **2026-12-31**, decide with what exists — and record
  that *no data is not no effect*.
- **Signals without telemetry** are qualitative by decision (§14.4): the study, A3's issues, GitHub
  Discussions, instructor requests. Ship at most **one F-tool per release** until one of those points at it.
- **AI kill criteria** (RESEARCH.md §44): a constrained in-app explainer is considered only after §9, and
  is opt-in, local-only, never answers a pending prediction, and discards any output containing a number
  not present in the event stream.

### 25.7 Risks specific to v2

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Widening** past §9's contrast | Three "second products" in one plan; §12's first risk, compounded | One subject per release; the §25.6 checkpoint; "computed, not drawn" |
| **Model honesty** for MVCC, ARIES, histograms | A toy that looks like Postgres is §12's "plausible but false" | Label every simplification; assert behaviour against Hermitage / SQLite, never claim implementation; name each heuristic |
| **Bundle and complexity growth** | Two groups are already at their ceiling | H8 first; lazy per-tool chunks; the Worker (C6) |
| **Maintainer capacity** | ~31–39 weeks on the main line, solo | 2.4 and 2.5 are self-contained modules — `CONTRIBUTING.md` and the tool template make them contributor-sized |
| **Quiz contaminates §9** | The blocker §22.4 named | *Generated* bank (G4), disjoint from `STUDY.md`, built after the study |
| **Name / brand** | Every backlink raises the price of changing it | Decide in 2.0 (A5), before the launch post |
| **Accessibility debt** from new visual panels | Automated checks catch ~30–57% of failures | Q6; H6's manual pass |
| **i18n blast radius** | The engine emits English strings | H5 is conditional on a named maintainer and shares a refactor with G5 |
| **Oracle flakiness / CI time** | A slow or flaky fuzz job gets disabled | Seeded, bounded counts; long runs scheduled |
| **Unverified platform config** | The first deploy needed three fixes | §25.5 rule 4 |
| **AI scope creep** | Hallucination and answer leakage cut against the core mechanism | Declined for v2 with written kill criteria; MCP instead |

### 25.8 Definition of done

**2.0 — Trust & ceiling**
- [x] `1.0.0` tagged; CHANGELOG cut (T0).
- [x] The oracle runs in CI (seeded, bounded); a divergence ledger and "How we know the answers are right" exist. *(built 2026-09-25; TLP lands with B1)*
- [ ] The study kit is live *(built 2026-09-24; automated tests pass on desktop and a phone-width run was checked by hand)* and at least one **real participant** has completed it end to end on a phone *and* a laptop.
- [ ] A homework-shaped query using `OR`, `IN`, `LIKE`, `DISTINCT`, `HAVING` and a **non-unique** indexed column runs and narrates end to end; `sql.mdx`, `limits.mdx` and `/tools/grammar` all agree.
- [ ] `limits.mdx` no longer says "unique key" or that a join never uses an index.
- [ ] Name decided and recorded *(done: keep, with descriptor)*; custom domain live; the launch post published; CLI, engine and MCP on npm.
- [ ] Per-route budgets replace the single sum.

**2.1 — The optimizer, honestly**
- [x] `ANALYZE` statistics are inspectable; at least one dataset shows a q-error ≥ 10×. *(C1 built 2026-09-29: `ANALYZE table`, `pg_stats`-shaped per-column stats, read by the cost model. C2 built 2026-09-29: the `employees` dataset's correlated `department`/`office` measures 11.0×, shown under `EXPLAIN ANALYZE`.)*
- [ ] A three-table query is ordered by DP with the lattice visible; "Why not?" shows the runner-up.
- [ ] `limits.mdx`'s "cost never decides" is replaced by the true statement.

**2.2 — Transactions**
- [ ] Two sessions interleave in the Playground from a URL; a deadlock resolves live *in the engine*.
- [ ] The isolation matrix's PostgreSQL and InnoDB columns match Hermitage's documented outcomes **in tests**; write skew reproduces under SI and is prevented under SER.

**2.3 — Durability**
- [ ] Crash → recover restores exactly the committed state; all four steal / force combinations are demonstrated; analysis, redo and undo are each a stage in the trace.

**2.4 — Storage engines**
- [ ] Every shipped tool has a lesson, a challenge, a data-table view and its own budget row; B+Tree vs. LSM reports amplification numbers from real counters.

**2.5 — Reach & learning layer**
- [ ] A course map with a non-affiliation note; the generated quiz shipped *after* §9; a published accessibility statement backed by a manual screen-reader pass; the app works offline on a real device.

### 25.9 Decision log

| Item | Verdict | Earliest | Trigger to revisit |
|---|---|---|---|
| SQLite oracle (A1) | **Built, 2026-09-25** — two engine bugs found on the first run; TLP follows B1 | now | — |
| §9 study kit (A2) | **Built, 2026-09-24** — runner + `pnpm study`; the instrument travels in the link, not the bundle | now | Awaiting participants |
| **Run the §9 study during 2.0** | **Decided, 2026-09-24** | now | §25.6 checkpoint before 2.2 |
| Rename before launch (A5) | **Decided: keep the name, paired with a descriptor** | 2026-09-24 | A rival contests it, or launch feedback shows confusion |
| Custom domain (A5) | **Recommended: `querylens.org`** — awaiting purchase | after purchase | — |
| SQL tier 2 (B1, B2) | **Planned, 2.0** | now | — |
| Non-unique indexes (B3a) | **Built, 2026-09-25** — entries carry the row address as a tie-breaker; the oracle validates every tree after every write | now | — |
| Composite indexes (B3b) | **Built, 2026-09-25** — leftmost prefix, a range within it, covering scans, the refusal said aloud; DELETE/UPDATE may walk a range | now | — |
| `UNIQUE` indexes (B3c) | **Built, 2026-09-25** — enforcement is an index lookup; SQLite-checked | now | — |
| Bulk-load vs incremental index build (B3d) | **Built, 2026-09-25** — `/compare`'s Index build mode: 5 vs 7 disk reads on a 400-row lookup | now | — |
| Clustered (index-organized) tables (B3e) | **Built, 2026-09-28** — one index doubles as the table's layout; every other index carries the clustering key instead of an address, one extra descent at a time; 6 vs 8 disk reads measured on a scrambled range | now | — |
| Index nested-loop join (B4) | **Built, 2026-09-25** — a fourth `Join` algorithm with an `IndexProbe` inner side; `/compare` is four-way; it loses to hash with a big outer, and the page says so | now | Cost-based choice among the four: §25.4 C |
| `ANALYZE` + statistics objects (C1) | **Built, 2026-09-29** — a real statement, a real scan, `pg_stats`-shaped per-column statistics the cost model reads when they exist and falls back from when they do not; the Result panel is the Stats panel | now | — |
| Correlated dataset + q-error (C2) | **Built, 2026-09-29** — `employees` dataset, department×office perfectly correlated, a measured 11.0× q-error shown under `EXPLAIN ANALYZE` | now | — |
| `LEFT JOIN` (C3, slice a) | **Built, 2026-09-29** — all four join algorithms, the predicate-pushdown pitfall closed, a cost floor at the outer row count | now | — |
| Multi-join (C3, slice b) | **Built, 2026-09-29** — left-deep chains of any length, per-step algorithm fallback, a real chain-position parse check | now | — |
| `IN (subquery)` (C3, slice c) | **Built, 2026-09-29, closing C3** — always uncorrelated, resolved once via its own sub-run before planning, no new Plan node needed | now | — |
| DP join order (C4) | **Built, 2026-09-29** — visualization-only, `/tools/join-order` + a Playground note; a real query still always runs in the order written | now | — |
| Cost-based choice (C5–C6) | **Planned, 2.1** | after C4 | — |
| Transactions: locks, isolation, MVCC (D) | **Planned, 2.2 — gated** | after 2.1 | §25.6 checkpoint |
| WAL / ARIES recovery (E) | **Planned, 2.3 — gated** | after 2.2 | 2.2 shipped |
| LSM, hash index, columnar, vectorized, latch crabbing, vector index (F) | **Planned, 2.4** | independent | Q6; one per release until a signal |
| Generated quiz (G4) | **Planned, 2.5** | after §9 | The study has run |
| Confidence ratings (G2) | **Planned, 2.5** | any | Verify the literature first |
| PWA / offline (H1) | **Planned, 2.5** | any | Preview-deploy check |
| Embeds + essays (H2) | **Planned, 2.5** | any | — (§20.3's "named author" trigger superseded: the launch needs them) |
| Publish CLI + `@querylens/engine` (H3) | **Planned, 2.0 — scope decided:** org `querylens`; CLI unscoped | after the org exists | You create the org + enable trusted publishing |
| MCP server + `llms.txt` (H4) | **Built, 2026-09-28** — the server and `llms.txt` do not need the npm organisation; only *publishing* `@querylens/mcp` does, same as the CLI | now | — |
| i18n (H5) | **Conditional** | — | A named locale maintainer |
| In-app LLM explainer | **Declined for v2** | post-§9 | Kill criteria in §25.6 |
| Distributed (2PC, Raft, sharding) | **Horizon (v3)** | — | Its own plan |
| Parallel / morsel-driven execution | **Horizon (v3)** | — | Needs scripted threads (Q7) |
| Rust / WASM engine | **Declined** | — | The Worker path cannot reach ~10k rows |

### 25.10 What v2 deliberately does not add

In the discipline of §20 and [RESEARCH.md §21](RESEARCH.md#21-what-i-deliberately-left-out) and Part IV §46:

- **No bundled or local LLM** (§25.6, RESEARCH.md §44). An MCP server instead.
- **No distributed subject, no parallel execution** — separate models; a v3 horizon.
- **No window functions or recursive CTEs** — §4's reasoning stands. v2 adds expressions, `DISTINCT`,
  `HAVING`, outer joins and an uncorrelated `IN (subquery)`, and stops.
- **No Postgres-dialect `EXPLAIN` viewer** (§20.6) and **no APM use case** (§2).
- **No accounts, no graded submission, no telemetry, no real-time collaboration.** The MCP server runs
  where the user runs it; nothing new leaves the browser.
- **No Rust / WASM rewrite.**
- **No claim of affiliation** with any course or institution whose syllabus is used as a checklist (G1).

---

## Appendix: Development Changelog

> **v23 — 2026-09-25.** Work on product v2 begins on branch `version/v2`, one commit per §25 item.
> **A1, the SQLite oracle, is built** — and its first run found two real bugs in an engine that had 1,170
> passing tests: a `NULL` range bound on an indexed column scanned the whole index and returned rows, and
> `constant-folding` treated `col = col` as always true, so `DELETE … WHERE k = k` deleted the rows where `k`
> is `NULL`. Both are fixed with minimal regressions. The lesson worth keeping is not the bugs but how the
> oracle nearly missed them: with purely random predicates it exercised `index-only-scan` five times in 1,500
> sessions and hash / sort-merge joins not at all (a mutation check showed injected bugs in both surviving),
> so the generators now draw literals from the values a column holds, draw the engine options per session,
> and a coverage suite fails the build if any optimizer rule, join algorithm or aggregate strategy goes
> unreached. One existing unit test asserted the `col = col` bug as intended behaviour — a reminder that a
> test written from the implementation preserves its mistakes.

> **v22 — 2026-09-24.** Four §25 decisions taken and carried out. **(1) Name:** keep "QueryLens", always
> with the descriptor — checked first: unscoped npm names free, `@querylens` empty, `querylens.com/.io/.ai/.cc/.tech`
> registered by others, `.org`/`.net` unregistered in WHOIS; recommended domain `querylens.org`, awaiting purchase.
> **(2) Study:** run it during 2.0 — and the kit is **built** (A2). Building it overturned the plan's own design:
> `STUDY.md` forbids the questions and control text from being public, so a `/study` route bundling them would
> have shipped the instrument; the runner is inert and the pack rides in each link's fragment instead, with an
> e2e test that fails the build if study text reaches `dist/`. Viewing it also caught a protocol leak the tests
> had not — the site nav one click from the control arm — so `/study` became a kiosk. A test caught a real bug
> (`Array.some` skips the hole a missing rubric row leaves). **(3) Release:** `v1.0.0` already existed on the remote
> at the deployed commit; the CHANGELOG cut and `package.json` bump landed after it, and the tag was not moved.
> **(4) npm:** scope `@querylens` for the engine and MCP server, unscoped `querylens` for the CLI — needs an org
> only you can create. Still open: participants, the domain purchase, the npm org.

> **v21 — 2026-09-24.** A **retrospective and a plan for product v2** — new **§24** and **§25**, with the
> evidence in a new [RESEARCH.md Part IV](RESEARCH.md#part-iv--v2-research). §24 summarises v1 as
> deployed (23 days from first commit, 1,170 unit + 79 e2e tests, A+ headers) and is candid about what it
> did not prove: the §9 study never ran, the name is shared with at least five unrelated products, and the
> first deploy needed three fixes. §25 plans v2 as six releases (2.0–2.5, M14–M21) after a research pass
> over the competition, the CMU 15-445 Fall 2026 syllabus (v1 covers 6 of 23 content lectures, partly 7,
> misses 10 — including all six on concurrency control through recovery), the learning-science evidence,
> and testing methodology. Its central claim: **v2 is not more SQL.** It is *prove it* (a SQLite
> differential oracle that costs no dependency, and a runnable §9 study kit), *raise the ceiling*
> (expressions, non-unique and composite indexes, an index join), *make the optimizer decide* (statistics,
> q-error, DP join order, "Why not?"), then *transactions* and *recovery* — computed by running schedules
> through the engine and checked against Hermitage — and only then storage engines. The §9 gate is
> replaced by a **checkpoint before 2.2**. An in-app LLM is declined with written kill criteria; an MCP
> server is planned instead. §22.9's rows for MVCC, WAL, the engine package, the quiz and i18n are
> re-pointed at §25. Note: v14–v20 have no entries here — they are the internal build revisions recorded
> in §10's v1 row, all inside product v1.

> **v13 — 2026-09-08.** A **new §22** — the feature-and-tool backlog, counted against `src/` the way
> §20 counted the spin-offs. §13 named *"expand SQL coverage: joins, cost estimates"* in one line and
> §4 has a "deferred to v1+" list; §22 gives each item an address, a cost against the actual code and
> a trigger, and scores it on §20.1's filter plus a fifth question — *does it deepen the §9 contrast
> or widen away from it?* The engine-depth pass (§22.2): JOIN with a join-algorithm comparison as a
> third `/compare` mode, `ORDER BY`/`LIMIT` with an external sort that spills through the buffer pool,
> aggregates, a **cost-based optimizer** that justifies the index choice §9 rests on (the strongest
> v1 engine item, gated on the study), the `INSERT`/`UPDATE`/`DELETE` write path, with MVCC and WAL
> marked explicitly as *second products* sharing a codebase. New tools (§22.3): a planner sandbox, a
> lock/transaction sandbox, an external-sort visualiser, a slotted-**page inspector**, a
> parser-derived grammar diagram. Learning surfaces (§22.4): the six missing `/learn` lessons, a
> client-side challenge mode, a progress dashboard — and an in-app quiz held until *after* the §9
> study, because the study's own question bank shipped in the app would contaminate it. Reach
> (§22.6): an `aria-live` narration track over the `label` every event already carries — the tool is
> not usable by a screen-reader user today and the data to fix that exists. **§22 adds no milestone**
> — §20 added M12 and §21 added M13 because each had a do-it-now core; §22's do-it-now items (an
> ASCII-art trace export beside the Mermaid one, trace JSON import/export, the narration track) fold
> into M12 or land incrementally in v1, and everything else is a backlog behind the one experiment
> that decides whether it is worth building. No MVP change, no §9 change, no §2 non-goal crossed.
>
> **v12 — 2026-09-08.** Cleared most of the §21.6 v2 backlog. **`/tools/parser`** is built: a
> live token ribbon over the existing tokenizer (`tokenize` now re-exported from
> `src/engine/index.ts`), the Playground's AST view (`AstTree`, driven directly from
> `toDisplayTree`), a recursion-depth readout, and the parser's own error messages for both
> tokenize and parse failures — no engine change, since the parse half already existed (§20.4).
> **Four replacement policies** joined the buffer-pool sandbox and Compare: `fifo`,
> `second-chance` (emitting the same `sweep` events clock does), `optimal` (Bélády's MIN —
> `runBufferTrace` now hands `createBufferPool` the whole reference string as lookahead;
> `optimal` degrades to FIFO without one, which is all the SQL path ever sees), and `midpoint`
> (InnoDB midpoint-insertion LRU, §7.5 — an optional `onLoad` hook on `ReplacementPolicy` lets a
> load land in the "old" sublist so a one-pass scan cannot flush the hot set). `ReplacementPolicyName`
> widened to six; the Playground `<select>`, `urlState` and `/settings` still allow-list
> `lru`/`clock` only, so the pipeline's contrast (§9) and every shared link are unchanged.
> `ComparePage` now picks either side from the six rather than being fixed on LRU-vs-clock.
> **`/tools/btree`** shipped in the same push — the last of the three §21.3 tool routes, and the
> only one gated on an engine build. **B+Tree deletion** now exists (`deleteKey` in
> `src/engine/index/btree.ts`): leaf underflow → borrow from a sibling or merge; internal underflow
> → the same, pulling the parent separator down; root-collapse when the root thins to one child;
> and a separator rewrite up the descent path so `validate`'s "every internal key is a real leaf
> key" invariant survives any delete sequence. Strict, not lazy — the property tests
> (`btreeDelete.test.ts`, five of them, `validate` asserted clean after *every* op against a `Set`
> oracle, per §7.6) would catch a stale separator. The sandbox itself is small (§20.4 said it would
> be): a number pad over `insert` / `deleteKey` / `search`, the tree re-rendered whole after each
> edit through the Playground's own `BTreePanel`, a fan-out slider, `deleteKey`'s step log narrated,
> and the invariant check shown as a badge. Stepping the restructure event-by-event (new `index`
> event kinds) is left for later, the same line drawn for the parser cursor.
>
> **`/trace`** shipped alongside them — the raw `StepEvent[]` for a query as a filterable table
> (per-stage toggles, a narration text filter) with per-row JSON and a Copy-JSON of the filtered
> set. It runs the same `runQuery` the Playground does, so what you inspect is exactly what the
> panels fold; each row's `#` opens the Playground at that step. Reads the Playground's `q`/`p`/`d`
> keys (its `p` also takes the four buffer-pool-only policies); footer-only nav, next to Settings
> and Assignments per §21.2. No engine change.
>
> **The assignment reveal-lock** shipped too — the last gap in a v10 feature. `/assignments/new`
> gained a "lock the reveal" toggle that adds `&l=1`; the Playground then forces prediction on,
> removes the prompt's "skip", and — via a new `ceiling` on `usePlayback` — stops the scrubber
> (which `gates` deliberately never blocked) from crossing an unanswered prompt. The lock lifts one
> prompt at a time, and the author is warned when the chosen step has no prompt to lock on.
>
> **`/compare` gained its full-pipeline half** (§13, §21.3's "not built" note). A mode toggle sits
> above the existing policy comparison; the new "index vs. sequential scan" mode runs the same SQL
> twice — once against the seed table, once against a copy with `indexedColumn` dropped, which is
> all it takes to force a `SeqScan` — and scores them side by side (trace steps, disk reads,
> evictions, B+Tree node reads, locks, rows). Scorecards, not two stepped panels: the contrast §13
> is about is the *aggregate* work, and the Playground is where you step. A range query that cannot
> use the index says so instead of scoring twins.
>
> **`/learn` shipped** — the last named v2 route. Four of §17.2's tasks as an ordered track: an
> index with a `localStorage` completion mark, and `/learn/:lessonId` rendering the task as
> numbered steps. Each step's "open in the Playground" button is a deep link whose step number is
> *computed* from a real engine run — `GalleryPage`'s discipline — so a lesson going out of sync
> with the pipeline fails a test rather than shipping a dead link. Primary nav (eight items now).
> The docs stay the reference; this is the walked-through version.
>
> **M12 is complete (§20.8).** `src/export/toMermaid.ts` — a pure, unit-tested
> `astToMermaid` / `planToMermaid` over the display trees (sequential `nN` ids, so no Mermaid
> id-escaping) — behind a **Copy as Mermaid** button in `StageDetail`'s header, on the AST and plan
> panels (not the B+Tree; §20.3). **Download PNG** on every implemented stage's panel:
> `html-to-image@1.11.13` — the app's one runtime dependency past React / Router / CodeMirror —
> `import()`ed on first use, into its own lazy chunk. Font inlining and `oklch()` verified in
> Chromium (an e2e checks the PNG magic bytes); Safari's `foreignObject`→canvas colour bugs are
> noted in the FAQ, not fought. And **`pnpm record`** (`scripts/record.ts`) — Playwright frame-steps
> the built app over a `--from`/`--to` range and muxes a GIF + WebM, screenshotting the same live
> panel DOM the PNG button uses; ffmpeg is `$FFMPEG_PATH` → `PATH` → Playwright's bundled copy, the
> GIF degrading to "WebM + frames + the two commands" when only the bundled build is present.
>
> Gate: typecheck, lint, 381 unit tests (+43: 13 policy, 12 B+Tree delete incl. 5 property tests,
> 5 reveal-lock, 8 learn, 5 toMermaid), build, bundle budget (`standalone-tools` 18→24 kB, new
> `learn` and `html-to-image` groups, total 335→354 — the parser/B+Tree/trace/learn routes plus the
> shared `FlowTree`/`BTreePanel`/`display` chunks that split out
> once a second route imported them; `ComparePage` grew ~1.4 kB gzip for `runQuery`; `html-to-image`
> is a 5 kB gzip lazy chunk), 37 e2e (+11),
> zero axe violations on `/tools/parser`, `/tools/btree`, `/trace`, `/compare` (both modes),
> `/tools`, `/tools/buffer-pool` (incl. midpoint), `/learn` and a lesson page, `/stages/*` with the
> copy-as-Mermaid and download-PNG buttons, and the Playground in assignment mode, in both themes
> (fixed a
> pre-existing `opacity-70` contrast failure on the Tools index card, and swapped the trace
> inspector's stage colours off the
> text — some `--color-stage-*` fall under 4.5:1 as 13px body text — onto a swatch).
>
> **v11 — 2026-09-05.** A footer and docs-structure pass, prompted by a reference layout the user
> shared. `Footer.tsx` is now four blocks — a brand block (mark, one-line description, a
> licence/privacy badge) plus Explore / Documentation / Project columns — reading from
> `src/routes.ts` and a new `src/docsNav.ts` rather than a hand-typed row of links, so nothing in it
> can name a destination that has moved. It sits *outside* `Layout.tsx`'s fixed-height desktop shell
> now, not inside it: a footer with real content is tall enough that folding it into the one-viewport
> block would have shrunk the Playground's usable height on every load, which is exactly the
> "stealing space from the app" failure §19 warns against — "below the fold" is no longer a
> metaphor. `e2e/regressions.spec.ts`'s overflow test was rewritten to check that the page is at most
> one viewport plus the footer's own height, not that it never exceeds one viewport.
>
> Restructuring the docs pages to have real hierarchy — a title, an audience/version-style meta
> line, an on-this-page contents block, a callout for the one thing not to skim past — surfaced a
> bug that had been live since the docs migration (`6eca5ac`) and touched every one of the eight
> `.md` pages: **left at its default, `@mdx-js/rollup` compiles a `.md` file as plain CommonMark**,
> with no JSX or `{expression}` support, and only a literal `.mdx` extension gets the real MDX
> processor. Every doc page `import`s and uses a component — `<Steps>`, `<Card>`, and the three new
> ones — so every one of them was silently rendering as escaped text
> (`&lt;DocMeta items={...} /&gt;`) instead of a component, invisible until something asked more of
> the page than a paragraph of prose. Forcing `format: 'mdx'` globally turns JSX on but breaks
> `remark-frontmatter`'s recognition of a `.md`-extensioned file's leading `---` block — so the fix
> that shipped is renaming all eight to `.mdx`, which sidesteps the interaction entirely. Discovering
> that also surfaced a second, adjacent bug: three reference pages use markdown tables, which plain
> `remark-parse` renders as a literal paragraph of pipe characters — `remark-gfm` is now in the
> pipeline. And `@tailwindcss/typography` had been a dependency since the same migration commit
> without ever being registered (no `@plugin` line in `index.css`), so `.prose` did nothing and
> every doc page had no heading hierarchy at all; it is now registered and themed onto the app's own
> semantic tokens rather than the plugin's default palette, and `prose-invert` — which hardcoded a
> dark palette regardless of the viewer's chosen theme — is gone with it. Three flagship pages
> (index, FAQ, getting started) carry the new `DocMeta`/`Contents`/`Callout` structure; the other six
> got the extension fix, the link fix (see below), and the typography/table fixes for free but not
> the new components — a deliberate scope line, not an oversight.
>
> Also fixed while in this code, because the docs restructure made them impossible not to notice:
> 18 internal doc links across six pages still used Astro Starlight's trailing-slash form
> (`/faq/`) from before `6eca5ac`, none of which resolve under this app's routes (`/docs/faq`) —
> all corrected. Gate: typecheck, lint, 338 unit tests, build, bundle budget (raised for the
> typography plugin's CSS), 26 e2e, zero axe violations across the footer and five checked docs
> pages.
>
> **v10 — 2026-09-05.** §21.3's v1 tranche shipped: `/gallery`, `/tools`, `/tools/buffer-pool`,
> `/compare`, `/settings` and `/assignments/new` are built, routed, in the nav manifest (seven
> primary items now, plus two footer-only), and covered by a new `e2e/features.spec.ts`. The build
> produced `src/engine/bufferTrace.ts` — a page-reference-string driver over the same
> `createBufferPool` the SQL path uses — a milestone earlier than §20.2 #2 called for, because
> Compare needed the same seam the buffer-pool tool did. §21.3's table now records three shipped
> gaps rather than smoothing them over: Gallery has no B+Tree-split or index-dropped moment (the
> engine cannot produce either yet), Compare covers only the buffer-pool half of §13's idea, and
> assignment links default prediction on without yet withholding the reveal until commit. Full
> status note under §21.3; §21.6 struck through as each item landed. Gate: typecheck, lint, 338
> unit tests, build, budget (two new groups), 26 e2e, zero axe violations across all six new routes.
>
> **v9 — 2026-09-04.** **M13 executed** (§21.5, §21.8): the SPA rewrite (`public/_redirects`), the
> dead `src/router.tsx` removed, the "single page" 404 and the stale `index.html` title corrected,
> every route `React.lazy` behind `<Suspense>`, a `src/routes.ts` nav manifest feeding top nav and
> footer, and `react-router-dom` pinned. The work surfaced three regressions the P0 list had not
> named — the desktop fixed-height shell and the mobile scroll-snap both lost when `5c7ef5d` moved
> the layout into `Layout.tsx` (two e2e tests red since), and a bundle budget whose 34 kB entry
> line had been failing just as long — all now fixed, entry down to ~18 kB with the docs and the
> trace UI split out. Commit `6eca5ac` (landed mid-work) reversed §17.1's Astro-Starlight decision
> in favour of integrated MDX routes; §17.1 and §21 are updated to match, and the change removed
> the docs/app build seam rather than adding to it. Gate is green: typecheck, lint, 326 unit tests,
> build, bundle budget, 21 e2e.
>
> **v8 — 2026-09-04.** Reframes the plan around the app it has actually become: a **client-side
> multi-page application**, not a single playground. A **new §21** is the route map and the feature
> catalogue — the Playground hub plus stage explainers, standalone tools, a query gallery, a
> comparison view, a classroom track, settings and a trace inspector — with each feature given an
> address, a URL-state schema and a build status. §21.1 is a count of what routing already exists
> and the five things a count finds wrong with it (no SPA rewrite, so every deep link 404s on a
> hard load; a dead `src/router.tsx`; a 404 page that still says "QueryLens is a single page"; a
> stale `index.html` title; routes that are not actually code-split). §21.5 is a one-day P0 to fix
> those, added to §10 as **M13**. §5 gains the shell layer, §6 gains the routing row, §19 and §20
> gain pointers. No feature here is new scope — §21 gives the work already in §13 and §20 a
> navigation model.
>
> **v7 — 2026-09-04.** A **new §20**, from a list of ~12 feature and spin-off ideas across four
> audiences — slide-makers, three different CS courses, EdTech graders, and DBAs. §20 is that list
> **counted against `src/` rather than against the architecture diagram**: three items are cheap,
> need no backend, and produce the launch artefacts §18.2 already wants, so they become **M12** in
> §10; the rest is v1 or its own plan, each with a written trigger, because a solo part-time project
> that adds four audiences before running the §9 study is §12's first risk played straight. Two
> edits fall out of it — §2's "production query debugging" non-goal now points at §20.6 (a paste-in
> `EXPLAIN` viewer was considered and kept separate, not missed), and §13's one-line futures point
> at §20 for the worked version.
>
> **v6 — 2026-09-03.** A research pass over §16–§18, plus a new §19. §16 is **rewritten against a
> count of `src/` rather than an impression of it** — three of its four v5 claims were overstated or
> backwards, and the largest tell in the app (a typeface named in CSS that is never actually served,
> under a CSP that forbids loading it from anywhere but here) was missing entirely; a written design
> direction is added ahead of the task list. §17 **reopens the docs-tool choice** — v5 picked a Vue
> framework for a React app — restructures the user manual around task-shaped minimalism, and grows
> licensing to the two obligations the project has actually incurred: prose is not code (CC BY 4.0),
> and a bundled OFL font is not either. §18 is marked to its true status: every P0/P1 governance file
> now exists. **New §19** is the landing page, which v5 had as one row in a table — including the
> decision that the app *is* the landing page, and why. §10's M10 splits into M10 and M11.
>
> **v5 — 2026-09-03.** Updated to add three new sections: §16, the visual design maturity gate
> ("not AI-generated"); §17, documentation, user manual and licensing (VitePress, Diátaxis
> structure, user manual chapter plan); §18, community and governance (CONTRIBUTING.md,
> CODE_OF_CONDUCT.md, SECURITY.md, CHANGELOG.md, GitHub templates, README badges, social
> presence strategy — socials deferred until deployed). New milestone M10 added to §10.
>
> **v4 — 2026-09-02.** Updated to incorporate [RESEARCH.md Part III](RESEARCH.md#part-iii--uiux-production-readiness),
> the UI/UX pass done by driving the running app. Changed since v3: **new §15, the UX gate**; M9 added to
> the milestone table (§10); first-run behaviour, prompt placement and a shareable URL added to §8; the
> first-thirty-seconds risk added (§12).
>
> **v3 — 2026-09-02.** Updated to incorporate [RESEARCH.md Part II](RESEARCH.md#part-ii--production-readiness),
> the production-readiness pass done after M0–M7 shipped. Changed since v2: **new §14, the deploy gate**
> (P0/P1/P2); M8 added to the milestone table (§10); hosting revisit trigger noted (§6); a11y regression
> testing added (§8); two operational risks added (§12); cost forks named (§11).
>
> **v2 — 2026-09-01.** Updated to incorporate the pre-build research in [RESEARCH.md](RESEARCH.md).
> Changed since v1: engagement features promoted into the MVP (§4, §8); Web Worker dropped for v0 (§5);
> buffer replacement policy made pluggable (§7.5); stack corrections — TypeScript 6.0.3, CodeMirror 6,
> Cloudflare Pages (§6); validation changed to a post-test against a text control (§9).
