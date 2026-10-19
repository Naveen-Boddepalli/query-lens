# Project Plan: QueryLens — Interactive Database Internals Visualizer

**Document Status**: v1 shipped and live (first deploy 2026-09-23) · v2 built — retrospective §24, plan §25, after the merge §26 · **v3 planned** — §27, on `version/v3`
**Last Updated**: 2026-10-18

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
- [x] No docs page mixes two Diátaxis modes. *(Accepted as house style for four pages, 2026-10-14 — see below.) Audited all eleven pages against a live build. Nine
      are clean. Two pairs still mix: both Manual pages carry a paragraph-length mechanism
      explanation after their steps — `manual/eviction.mdx`'s "Where they actually disagree" and
      `manual/btree-split.mdx`'s "Why the two rules can't swap" — which is exactly the theory
      §17.2's own rule says "lives in Concepts and is linked, not inlined"; and both Concepts pages
      (`concepts/btree.mdx`, `concepts/buffer-pool.mdx`) carry a "Try this" section giving explicit
      run-this-query, step-through instructions, which is How-to content inside an Explanation page.
      (Architecture's Reference-plus-Explanation blend is §17.1's own deliberate classification, not
      counted here.) Left unchecked rather than deciding unilaterally whether that's worth
      rewriting or accepting as the project's house style. **Decided, 2026-10-14, by the user: accepted
      as house style.** The four pages deliberately blend modes — a short "why" after the steps of a
      Manual page, a "try this" beside an explanation — because in a tool that is itself the how-to,
      the sentence that says why a step went as it did teaches better where the step is than a link away.

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
| More optimizer rules | **`constant-folding` done (v14)** | v1 | Projection pushdown out of scope (no real I/O to save in a row-oriented heap) — was re-opened by §25.4 F3, which **decided not to build a `ColumnScan`** (2026-10-05), so it has nothing to save and stays out; `OR`→`IN` needs `OR` in the grammar first — **`OR` lands in §25.4 B1** |
| In-app `EXPLAIN` | **Done, v14** (**Copy as EXPLAIN** on the result stage — `explainToText`, estimate next to actual per operator) | v1 | — |
| `ORDER BY` / `LIMIT` + external sort | **Done, v14** (`Limit` — a real Volcano short-circuit; `Sort` — `exec/sort.ts`, a real external merge sort spilling through the actual buffer pool, `BufferPool.write()`) | v1 | — |
| Aggregates / `GROUP BY` | **Done, v14** — hash aggregate, sort aggregate, and the `/compare` mode naming both | v1 | — |
| Write path (`INSERT`/`UPDATE`/`DELETE`) | **Done, v14** (all three statements — `exec/delete.ts`, `exec/insert.ts`, `exec/update.ts`; `BufferPool.markDirty()`/`write()`) | v1 | — |
| Composite / covering indexes | **Index-only scan done (v14); a second candidate index, chosen by selectivity, done (v15)** | v1 | Non-unique indexes (B3a), composite/leftmost-prefix (B3b), `UNIQUE` (B3c), bulk-load (B3d) and clustered (B3e): **done, v2.0 — §25.4 B3 complete** |
| JOIN + join-algorithm compare | **All three algorithms and predicate pushdown into a `Join` done (v14–v15)**, plus `/compare`'s join mode naming all three | v1 | Join order: **built, v2.1 (§25.4 C3–C4)** — multi-join grammar, then Selinger's search. An index nested-loop join is **done, v2.0 (B4)** |
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
| In-app quiz / self-check | **Built, 2026-10-10 (§25.4 G4, `/practice`) — as *generated* questions**, disjoint from the study's fixed bank | post-§9 | — |
| Enforced concurrency + deadlocks | **Done (v14)**, as `/tools/locks`'s own driver (`src/ui/lockSimulation.ts`) | v1–v2 | — |
| `npx querylens` CLI | **Built, v13; unpublished** (`bin/querylens.ts` — query + `--policy` / `--dataset` / `--json`, pure render + arg-parse unit-tested; `npm publish` is the deliberate remaining step) — **publish planned, v2.0 (§25.4 H3)**, with an MCP wrapper (H4) | v1–v2 | — |
| `@querylens/engine` package | **Built, unpublished (§25.4 H3, 2026-10-05), as 0.x** — the trigger was met: the site and the CLI already are two consumers | v2 | The npm organisation exists |
| Operator / stage plugin seam | Deferred | v2+ | The package and CLI find users |
| MVCC / snapshot isolation | **Built, 2026-10-10 (§25.4 D4)** — after the §9 pilot cleared the gate | v2 | — |
| WAL / crash recovery | **Built, 2026-10-10 (§25.4 E1–E4)** | v2 | — |
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
| **A1** | 2.0 | **SQLite oracle + metamorphic tests** | **Built, 2026-09-25 — and it paid for itself on its first run.** `oracle/` (top-level, Node-only; never imported by `src/`): (a) **metamorphic** — buffer size, page size, policy, join algorithm, aggregate strategy and index presence never change the rows; the optimized plan agrees with a direct evaluation of the predicate over the raw rows (NoREC-shaped); after writes an index lookup finds what a scan does; the trace is deterministic. (b) **Differential vs `node:sqlite`** (no dependency, no bundle bytes) with `fast-check` over generated typed tables (few distinct values, many NULLs, keys that overlap across two tables) and grammar-derived statements — `SELECT`/`WHERE`/`ORDER BY`/`LIMIT`, aggregates + `GROUP BY`, `JOIN`, and sessions of up to three writes followed by a read — with the engine options drawn per session so every join algorithm and both aggregate strategies are checked; multisets compare unordered, `ORDER BY … LIMIT` compares the *keys* of the first n rows (ties make the rows undefined). (c) TLP moves to B1, which is what introduces `NOT` and `IS NULL`. **A coverage suite fails the build if the generators stop reaching every optimizer rule, join algorithm, aggregate strategy, empty tables, NULLs or row-changing writes** — first-cut generators fired `index-only-scan` 5 times in 1,500 sessions, which is how a vacuous oracle looks; and injected bugs (`<` as `<=`, a `SUM` that drops a value, a hash join that indexes NULL keys, a sort-merge join that skips equal keys) are each caught. **A divergence ledger** (`oracle/ledger.ts`): seven runnable entries, each asserting both engines' recorded answers *and that they still differ*, so a fixed gap makes its own entry fail. CI runs seeded and bounded (1,000 cases/property — raised from 200 after injected bugs in rare query shapes survived 200 and 400 and die at 800 — part of `pnpm test`); `.github/workflows/oracle.yml` runs 20,000 with a fresh printed seed weekly, read-only, SHA-pinned. Docs page **"How we know the answers are right"**, its ledger table drift-tested against the ledger. **Bugs found and fixed:** `WHERE id > NULL` on an indexed column returned rows (a NULL bound read as "no bound"); `DELETE FROM t WHERE k = k` deleted the NULL-`k` rows (`constant-folding` called a column compared with itself always true — under three-valued logic it is UNKNOWN). Both have minimal regressions in `src/engine/__tests__/oracleFindings.test.ts`, verified to fail on the old code. **Extended 2026-10-15 to C3's shapes** (`LEFT JOIN`, chains over a third table `w`, `[NOT] IN (subquery)` — a quarter of them empty — and `(P) IS [NOT] NULL`; the NoREC reference resolves subqueries itself; coverage asserts LEFT joins, chains and empty subqueries): **two more bugs found and fixed** — `NULL NOT IN (empty subquery)` was UNKNOWN instead of TRUE, and an `IN (subquery)` anywhere but under `AND`/`OR`/`NOT` in a WHERE clause (under `IS NULL`, in a comparison, a computed column, `HAVING`, `SET`) was never run and read as an empty list. Regressions in the same file; the oracle catches each with its fix reverted | 1–1.5 wk → **built in a day** |
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
| **C3** | 2.1 | **Multi-join, `LEFT JOIN`, `IN (subquery)`** | **Slice a — `LEFT JOIN` — built, 2026-09-29.** `[INNER \| LEFT [OUTER]] JOIN` (`JoinClause.joinType`, `Plan`'s `Join.joinType`) — a bare/`INNER JOIN` is exactly today's shape; `LEFT [OUTER] JOIN` keeps every row of the `FROM` table, NULL-padding the joined table's declared columns (`exec/operators.ts`'s new `nullPaddedRow`) when nothing matches it — including a NULL join key, which never matches anything either way. Built for **all four join algorithms**, not just the default: nested-loop and index-nested-loop track whether the current outer row matched anything across the whole inner scan/probe and pad it once at the end; hash join pads immediately on an empty bucket; sort-merge's own two-pointer `sortMergeMatches` generator (the hardest of the four to retrofit) now walks all the way to the end of `left` rather than stopping once either side is exhausted, yielding `[row, null]` for any left row — or run of them — with no run of equal keys on the right at all. **The classic pitfall, closed:** `join-predicate-pushdown` no longer pushes a `WHERE` conjunct on the *inner* side of a `LEFT JOIN` into its own scan — doing so would filter rows out before the join can find out they would not have matched, turning a `LEFT JOIN` back into an inner one with no trace of it (`… LEFT JOIN posts ON … WHERE posts.title IS NULL` — the standard way to ask "which rows had nothing on the other side" — only works if the filter runs *after* the padding); the outer side's own predicates are still pushed, always safe regardless of join type. The cost model's `Join` estimate is now a floor at the outer side's own row count for a `LEFT JOIN`, named as such when the equi-join guess would have undercounted it. `RIGHT`/`FULL`/`CROSS` stay explicitly out of scope (`OUT_OF_SCOPE`'s message for `RIGHT` now points at rewriting it as a `LEFT JOIN` the other way round). **Checked by:** 10 new tests in `join.test.ts` — all four algorithms agree on the exact same LEFT-JOINed rows (the seed's own `authors`/`posts` fixture already has an author, `barbara`, with zero posts, built for exactly this), a NULL join key is kept and padded by every algorithm, the pushdown pitfall is caught directly (the `IS NULL` query above returns exactly `barbara`, not everyone, under the mutated-and-restored rule), the plan/narration say "LEFT JOIN," the cost floor holds, and `RIGHT`/`FULL` still fail to parse; mutation-checked three ways (the pushdown gate, `sortMergeMatches`'s padding, hash join's empty-bucket check — all killed). **Deliberately deferred:** no SQLite-oracle coverage yet (the shared `oracle/generate.ts` query-generation model does not build JOINs beyond today's single inner one; extending it is left for once the rest of C3 — multi-join, the subquery slice — is built, so that shared model is touched once, not three times). **Slice b — multi-join — built, 2026-09-29.** `SelectStatement.join?: JoinClause` becomes `joins?: JoinClause[]` — zero or more, chained left-deep: `FROM a JOIN b ON … JOIN c ON …` builds `Join(Join(SeqScan(a), b), c)`, never a flat three-way node. The parser gained the one real gap a single `JOIN` never had to close: a new `checkJoinChain` (called once per clause, in `parseSelectBody`'s own loop, since only it knows the running set of table names so far) checks that each `ON` names the table its own clause introduces on one side and *some* table already in the query — `FROM`'s, or any earlier `JOIN`'s, not necessarily the one written just before it — on the other, and rejects joining the same table twice outright (no aliasing to tell two `authors`es apart). `buildJoinPlan` folds the whole array with one loop instead of building a single pair, resolving each step's `leftTable`/`leftColumn` against whichever known table the `ON` actually names. Every consumer of "the Join node" that assumed there was only ever one now walks the *whole* chain: `joinsIn` (`plan.ts`, replacing the singular `findSortMergeJoin`/`findIndexNestedLoopJoin` with plural, chain-aware versions) recurses down `left` collecting every step in source order; `emit.ts`'s narration loop rebuilds the plan one join at a time (`buildJoinPlan` on a growing prefix) so each step gets its own sentence naming its *own* outer/inner table, not always `FROM`'s. Execution generalizes two ways: `ExecContext.joinRight` (one slot) becomes `joinPartners` (a map keyed by table name), so a nested `Join` finds its own right-hand partner regardless of nesting depth; and `mergeJoinedRow`/`nullPaddedRow` skip re-qualifying a key that already contains a `.` — a later step's `left` row already carries every earlier table's columns as `table.column`, so only a query's *first* join still needs to qualify a bare key. A new `leftJoinValue`/`leftJoinKeyOf` pair replaces every direct `leftRow[column]` read across all four algorithms with a dual lookup (bare, or `table.column` if a prior step already qualified it) — the one piece every algorithm needed changed identically. **Per-step algorithm fallback, not once per query:** `index-nested-loop` already fell back to `nested-loop` per join when that step's own table had no usable index (`effectiveJoinAlgorithm`); folded into the chain loop, a 3-table query can now run its first step as `index-nested-loop` and its second as plain `nested-loop` in the very same plan, and the plan/narration say so for exactly the step that fell back. **Sort-merge's own scratch-space bookkeeping**, the one piece that could not simply "just recurse" — each sort-merge step needs its own two-block page-id reservation, and a later step's own worst-case left-input size depends on every earlier step's, genuinely sequential — moved out of the operator (which cannot see the whole chain) into `runQuery.ts`, computed once up front in chain order and handed back as `ExecContext.sortMergeBases: Map<Plan, {leftBase, rightBase}>`, keyed by each sort-merge `Join`'s own node identity. **A real pre-existing bug found and fixed as a side effect of this generalization**, not a new one introduced: the single-join code placed a `JOIN`'s right-hand heap right after the `FROM` table's own *heap* page count, not after its own *index* pages too — so a `FROM` table with any declared index (the demo `authors`/`posts` fixture has one on `authors.id`) could have its join partner's heap silently share page-id numbers with the `FROM` table's own index tree, which the buffer pool's LRU/eviction accounting would then treat as the same page; the chain's own strictly-accumulating page counter closes this for every table, not just the first two. **Checked by:** 15 new tests in `join.test.ts` — a 3-table chain's own correctness (a local `comments` table, not added to the shared `authors`/`posts` seed fixture, whose own docstring says it deliberately stays a pair), all four algorithms agreeing on it, the per-step algorithm-fallback case (the second join's table left deliberately unindexed), a chain of `LEFT JOIN`s NULL-padding independently at each level, a mixed inner-then-`LEFT` chain, every existing single-join `GROUP BY`/`ORDER BY`/`HAVING`/aggregate rejection re-verified with two joins, `EXPLAIN`/`EXPLAIN ANALYZE` not crashing on a chain (the regression test for the cost-model bug below), and `DISTINCT` above a chain by both strategies; mutation-checked three ways (`leftJoinValue`'s dual lookup, the self-join parse guard, the cost model's `otherTables` fix — all killed). **A second real bug found while verifying this slice, deliberately left unfixed here and flagged instead:** the cost model's `estimateNode` recursion (`cost.ts`) resolves a `Join`'s own two sides' tables by name against an `otherTables` map built once at the top — which only ever held the join *partners*, not the original `FROM` table — so once the recursion nests two levels deep and needs to resolve the `FROM` table's name again at the bottom of the chain, it crashed; fixed here by including `table.name` in that map at both call sites (`emit.ts`, `exec/run.ts`), since the chain simply could not work without it. **A third, separate, genuinely pre-existing bug, out of scope and flagged via a background-task suggestion rather than fixed in this commit:** `EXPLAIN ANALYZE`'s "actual" row count (`explain.ts`) is keyed by operator *name* ("SeqScan"), not by which specific plan node — so a single `JOIN`'s two `SeqScan` children already showed the identical (wrong) number today, before this slice, and a chain only makes the same latent bug more visible. **Fixed 2026-10-01, out of band from the C-series slices:** `StepEventBody`'s `execute` variant and `PlanNode` both gained an optional `table` (a scan's own table, or a `Join`'s `rightTable`) — always enough to tell two nodes of the same `op` apart, since the parser never lets a query name the same table twice — and `explain.ts`'s actual-row lookup now keys on `op` *and* `table` together; see CHANGELOG.md's "Fixed" entry. **Slice c — `IN (subquery)` — built, 2026-09-29, closing C3.** `x [NOT] IN (SELECT column FROM table [WHERE …])` — the one place a `SELECT` may appear inside another query; a scalar subquery (`x = (SELECT …)`) and `EXISTS` both stay unsupported, `parsePrimary`'s own generic "a subquery is not supported here" rejection unchanged for everywhere else. `Expr`'s `in` variant gains an optional `subquery?: InSubquery` field alongside its existing `items: Expr[]` — no new `Expr` kind, so `childrenOf`/`mapChildren`/`walkExpr` need no changes at all (a subquery's own `WHERE` is a deliberately separate scope, never walked as part of the outer predicate tree). A new `parseInSubquery` (`parser.ts`) parses the small, fixed shape `SELECT column FROM table [WHERE …]` — deliberately not `parseSelectBody` reused-and-restricted: `*`, multiple columns, an aggregate, `DISTINCT`, `JOIN`, `GROUP BY`, `HAVING`, `ORDER BY` and `LIMIT` are all rejected outright with their own named error, since none could ever change *which* values end up in the set `IN` tests against. Uncorrelated by construction, not a special check: the subquery's own `WHERE` columns are validated by the exact same `checkJoinValidity` call (with no `JOIN`) a bare single-table query already gets, so there is no path for a column inside it to ever name a table the outer query knows about. A new module, `subquery.ts`, resolves every `IN (subquery)` in a `WHERE` clause **exactly once**, before the query that names it is planned — `runQuery.ts`'s SELECT, DELETE and UPDATE paths all share it — by running the subquery as its own complete, independent sub-run of the engine (`run: (sql: string) => RunResult`, the exact callback-injection pattern `explain.ts`'s `explainResult` already established, avoiding a circular import back into `runQuery.ts`; the subquery's own source text is recovered from its parsed `span` and padded with leading spaces exactly as `explainResult` already does, so a parse error inside it still points at the right character offset in the outer editor) and rewriting the `in` node's `items` with the resolved, deduplicated values as ordinary literals. Everything downstream — the cost model's existing `in` selectivity formula (`k × equality selectivity`, now using the *real* resolved count), `evaluate.ts`'s existing three-valued `IN`/`NOT IN` truth table (including the classic NULL-in-the-list trap, which a subquery-sourced NULL now triggers identically to a hand-written one), every rewrite rule in `optimize.ts` — needed **zero changes**, since a resolved node is indistinguishable in shape from a literal list. `subquery` itself survives the rewrite (for narration and `exprToSql` only, which always prefers it when present) so the WHERE clause's own plan-stage narration (`emit.ts`/`emitDelete.ts`/`emitUpdate.ts`, sharing a new `subqueryResolutionNotes` in `plan.ts`) can say the subquery already ran and how many distinct values it found, without a new `Plan` node or operator of its own — deliberately: plan.md commits only to "an uncorrelated `IN (subquery)`" (§25.10), never to a semi-join as a first-class visualized operator, and folding the resolution into the existing `Filter` narration reuses the entire cost/optimize/exec pipeline verbatim rather than adding a `SemiJoin` variant to every exhaustive `Plan['op']` switch for a fact that is genuinely just "a value list, resolved once." **Checked by:** 24 new tests in `subquery.test.ts` — parsing (the `subquery` field shape, every rejected clause with its own message, `exprToSql` round-tripping the subquery form rather than resolved values), execution (SELECT/DELETE/UPDATE all resolving correctly, an empty subquery result making IN match nothing and NOT IN match everything, the NULL trap via a subquery-sourced NULL — deliberately using an exclusion crafted so a version that silently dropped the NULL would return 3 rows instead of the correct 0, since a naive "does it return `[]`" assertion couldn't otherwise tell the trap from a same-shaped bug), deduplication (a real foreign-key column with repeats collapses to its distinct values), bad-table/bad-column errors inside the subquery reported as a wrapped "IN subquery failed" rather than a crash, the WHERE-narration message, and the uncorrelated guarantee itself (a qualified reference to the outer query's own table, rejected the same way any unrelated table name would be); mutation-checked two ways (the NULL-inclusive dedup, the uncorrelated `checkJoinValidity` call — both killed). Live-verified in the Playground: the AST tree panel shows the `In` node's subquery detail and no `items` children; the optimizer's predicate-pushdown step correctly reuses the resolved count in its cost basis; the error squiggle for a rejected `SELECT *` inside the subquery lands on the `*` itself, not the whole query. **SQLite-oracle coverage for all three slices added 2026-10-15** (see A1): `LEFT JOIN`, two-step chains over a third table and `IN (subquery)` in every predicate position — which found that `NULL NOT IN (∅)` was UNKNOWN instead of TRUE, and that a subquery under `IS NULL`, in a comparison, a computed column, `HAVING` or `SET` was never resolved; both fixed. **C3 is now fully built** — `LEFT JOIN`, multi-join, and `IN (subquery)`, each its own commit, closing plan.md's whole "Multi-join, LEFT JOIN, IN (subquery)" line; C4 (DP join order) is the next reachable item, needing both C1 (built) and C3 (now built). | 2 wk |
| **C4** | 2.1 | **Join ordering by dynamic programming** | **Built, 2026-09-29.** Selinger's System R algorithm over the **subset lattice**: for `n` tables there are `2^n - 1` non-empty subsets, and the cheapest left-deep way to join every table in one is built up bottom-up from the cheapest way to join every smaller subset one table down — new module `src/engine/planner/joinOrder.ts`'s `runJoinOrderDP`. Restricted to left-deep on purpose, not as a simplification: the engine's own `Join` operator (C3 slice b) only ever executes a left-deep chain, so a bushy plan the classic algorithm might otherwise consider is one nothing here could actually run — this also means a subset's own DP state only needs "which table was added last," never "which two smaller subsets were merged," so there is no split search, only a per-table one. A cross join is never *forbidden*, only *costed honestly* (`rows(a) × rows(b)`, no selectivity) — real, always available, and it loses the comparison badly enough on its own that nothing has to reason about the join graph's connectivity to avoid it. The cost formula mirrors `cost.ts`'s own nested-loop `Join` case exactly (`pages = left.pages + left.rows × right.pages`), scored on pages, not rows, so two orders with the same output size but different rescan cost are told apart. **A genuine scoping decision, made explicit before building anything** (the user chose it directly when asked, since plan.md's own "Needs C1, C3" line left the question open): this stays **visualization-only** — a real multi-join query still always executes in the order it was written, never reordered by cost. That is also the honest reading of limits.mdx's own "no cost-based query optimization" line, which nothing before this item had actually tested. `/tools/join-order` (new standalone, `JoinOrderToolPage.tsx`) shows the whole lattice, grouped by subset size, every subset clickable to see *every* candidate the DP tried for it (not just the winner) — the recurrence itself, not only its answer — plus an interactive "build your own order" that costs whatever sequence of tables you click, live, against the DP's own number. The Playground gets the same search folded into a query's own plan-stage narration, once a query names two or more `JOIN`s: a new sentence naming what DP would have joined them as and its estimated cost next to the written order's, informational only — the same "estimate beside the real plan, never a decision" stance C1's stats and C2's q-error already established, now extended to join order specifically. A new demo dataset, `createJoinOrderDemoDatabase` (`seed.ts`): four tables as a *tree*, not a chain — `departments` is the hub (connecting to both `employees` and `projects`), `timesheets` hangs off `employees` alone — empirically tuned (the project's own "measure, don't guess" convention) so a natural-looking "hub, then each branch" written order costs **5.2× the DP-optimal order**, a genuine, dramatic, measured gap: visiting `projects` before drilling into `employees` → `timesheets` lets the *other* branch's join land against an already-larger intermediate result, at real cost. **Checked by:** 9 new tests in `joinOrder.test.ts` (a single table needs no ordering; a two-table pair tries both starting points; no edge means an honest cross join, never a forbidden move; a star graph correctly considers every already-joined table, not just the most-recently-added one, when looking for a real edge; every prefix of the winning order is itself that prefix's own best subset plan; the full demo dataset's real 5.2× gap, matching the exact figure `seed.ts`'s own doc comment names; `joinGraphFromAst` correctly extracts a real multi-join AST's tables and edges, including an ON clause naming a non-adjacent earlier table) plus 2 new tests in `join.test.ts` (a chain of two or more JOINs gets the narration note without its rows ever changing; a single JOIN gets none, since there is only one order to have); mutation-checked three ways (the DP's own cost comparison, the star-graph edge search, the Playground note's `>= 2 JOINs` gate — all killed). Live-verified in both the Playground (the note appears, names the real reordering, and the query's own result rows are unaffected either way) and `/tools/join-order` (the lattice renders correctly at every level, clicking a subset shows its real candidate breakdown, the interactive order-builder computes live). | 1.5 wk |
| **C5** | 2.1 | **Cost-based choice + "Why not?"** | **Slice 1 — index vs. scan by cost — built, 2026-09-30.** `indexSelection` and `rangeIndexSelection` (`optimize.ts`) gain a third parameter, `rowsPerPage`, threaded through `optimize()` from every call site — the first time a rule has needed it at all. Once a candidate is chosen by *shape* (the existing leftmost-prefix / most-selective-column logic, unchanged), its own estimated page cost (`rootEstimate`, the exact formula `EXPLAIN` already shows) is compared against the scan it would replace; if the index is not actually cheaper, the rule **declines** — the scan stays, and the step still reports what it considered and why it said no (`"…matches the predicate, but the estimated cost disagrees: the lookup would read about N pages against the scan's M — no cheaper, so the scan stays…"`), reusing the existing `Rewrite` type as a no-op carrier (`plan: input, changed: new Set()`) rather than inventing new plumbing. This is the one thing plan.md §12 always drew a line at — not that a rule could never consult a cost, only that doing so had to be a real comparison, never a rule of thumb pretending to be one — and it explicitly **retires `limits.mdx`'s "no cost-based query optimization"** line for these two rules specifically (every other rule still fires on structural match alone). **`emit.ts`'s `withCostJustification`** (which appends the scan-vs-index page estimate to a step's narration) is now only called for a step that actually changed the plan — it previously ran unconditionally and, for a declined step, re-derived its own "Estimated cost disagrees… so the index is taken anyway" text from the *unchanged* plan, self-contradicting the rule's own new decline message in the same narration. **The scale of the consequence, discovered rather than assumed:** with this engine's deliberately tiny, hand-countable constants (`FANOUT = 4`, default `rowsPerPage = 4`), a B+Tree needs two levels for as few as five rows, so a unique equality lookup's own floor cost (`levels + 1`) already exceeds a one-or-two-page scan of nearly every existing test fixture — an honest finding about the model (a real optimizer also prefers a sequential scan below some table size), not a bug, but one that had never had teeth before nothing compared the two numbers. Sized up **12 test files** to cross the honest break-even point rather than lower the bar: fixture tables grown large enough that the real lesson each one teaches (leftmost-prefix entry, covering, leaf-chaining, clustering, non-unique runs, `ANALYZE`-free selectivity) still holds under real cost accounting, using two recurring techniques — growing a low-cardinality column's true domain until its own selectivity clears the honest threshold (`compositeIndex.test.ts`'s `a` going from 4 to 8 distinct values, `planner.test.ts`'s `things`/`tied`/`spans` fixtures from 3–4 rows to 30–100), and, where a specific column's cardinality could not change without breaking an exact hardcoded ratio, padding with far-away filler values that inflate `ndistinct` or widen a column's own min–max span without ever being matched by the test's own predicate — a legitimate demonstration of the documented, ndistinct-only estimator's blind spot on skewed cardinality, not a number invented for the test. One genuinely user-facing consequence: the **"range leap" challenge**'s hinted solution (`id > 40`) no longer beats the scan on the shipped 48-row `users` table, since 8 of 48 rows (17%) sits right at the honest break-even the old "any range wins" version of the rule never had to clear — the challenge's own brief and hint were rewritten to say a *narrow* range is what pays for itself, matching the new, more honest lesson, and its known-solution test uses `id > 44`. The `oracle/coverage.test.ts` "not vacuous" sampler's `repeatedIndexReads` floor was lowered from 10 to 5 (measured at 7 with the suite's fixed seed) since the generator's typically small random tables now legitimately decline a non-unique equality lookup more often than they accept one — still comfortably non-zero, which is what that suite exists to guarantee. New tests in `planner.test.ts` demonstrate the decline path directly (a `logins`-shaped low-cardinality column loses on cost while a unique column on the *same* table still wins, and a wide range on `users.id` declines the same way); mutation-checked by inverting each gate's `>=` comparison, both caught by the new tests. **Slice 2 — join algorithm by cost — built, 2026-09-30.** A new rule, `join-algorithm-selection` (`optimize.ts`), has no shape step at all: `buildPlan.ts` still always starts a `JOIN` chain out as `nested-loop`, its own cost-oblivious structural default (mirroring a bare `SeqScan`), and the rule prices every algorithm that could actually run each step — nested-loop, hash, sort-merge, and index-nested-loop whenever the inner table has a usable index — with `cost.ts`'s own per-algorithm formulas (unchanged, the same ones `EXPLAIN` already showed) and keeps whichever is cheapest, with no "declines but stays" outcome the way index-selection has: every candidate is a real, working plan, so the rule always ends up choosing one, possibly the one already there. A chain (plan.md §25.4 C3 slice b) is priced bottom-up, one `Join` at a time, since an earlier step's own chosen algorithm changes the estimated cost a later step's own comparison has to use. **This is the new shipped default**, not a second opinion: `EngineOptions.joinStrategy` left unset now means "choose by cost" instead of "always nested-loop," which `runQuery.ts` silently defaulted to for every join in the Playground before this — confirmed via `AskUserQuestion` (the same fork C4's own scoping question was, with the opposite answer this time), since the alternative (opt-in only, C4-style) would have kept the Playground running the naive algorithm even when it is honestly worse. `/compare` and `/tools/planner` are unaffected: both already forced a specific `joinStrategy` explicitly for every one of their own runs, and `emit.ts` leaves `join-algorithm-selection` out of `optimize()`'s `enabled` set whenever `joinStrategy` was requested explicitly, so a forced comparison is never silently overridden by the same rule it exists to be compared against. **A real correctness bug found and fixed during this slice, not a pre-existing one:** the rule's first draft rebuilt each candidate's right-hand scan bare (`{op:'SeqScan', table}`), discarding whatever `join-predicate-pushdown` (the rule immediately before this one in `RULES`) had already pushed into it — caught by `join.test.ts`'s own pushdown tests, which started returning unfiltered rows once the default algorithm silently changed underneath them. Fixed two ways: every non-index candidate now reuses the *existing* right-hand scan (filter and all) instead of rebuilding one, and `index-nested-loop` — whose `IndexProbe` node has nowhere to carry a residual filter at all — is excluded from candidacy outright whenever a filter has already been pushed into that side, the same reasoning `join-predicate-pushdown`'s own `probesInner` check already uses to avoid pushing *into* an `IndexProbe` in the first place. Both fixes are independently mutation-checked (removing either one in isolation is caught by its own dedicated test — the second needed a purpose-built small-outer/large-indexed-inner fixture, since the shipped `authors`/`posts` demo is too small for index-nested-loop to ever look cheap enough to expose that specific gap). `oracle/generate.ts`'s `optionsArb.joinStrategy` gained a fifth possible value, `undefined` (cost-chosen), alongside the four explicit algorithms — the fuzzer's own doc comment already commits to "every physical strategy is checked against SQLite, not just the defaults," and a rule that had just produced a real bug is exactly the kind of thing worth fuzzing rather than trusting to hand-written cases alone; three `oracle/coverage.test.ts` thresholds (`repeatedIndexReads`-adjacent index-join stats) needed lowering since each explicit algorithm is now requested by a fifth of sessions instead of a quarter. The **`hash-beats-loop` challenge** (which reruns the player's own query under an explicitly forced `'hash'` to compare against their unforced baseline) needed its own baseline pinned to `joinStrategy: 'nested-loop'` explicitly too — without it, the "baseline" would now already be cost-chosen to hash, same as the comparison run, making every solution look wrong. Retires `limits.mdx`'s "no choosing a JOIN's algorithm by cost either" line. **Slice 3 — join order by cost — built, 2026-10-01.** `runQuery.ts` now actually reorders a chain of 2+ `JOIN`s to C4's own DP-cheapest left-deep sequence before running it — wiring `joinOrder.ts`'s existing search into real execution for the first time, not just `/tools/join-order` and the Playground's informational note. **Deliberately scoped to plain inner-join chains, confirmed via `AskUserQuestion`** (the third such fork this item alone has needed, after C4's own and slice 2's): `LEFT JOIN` is not commutative or associative in general — flipping one, or moving another join between its two sides, can change which rows get NULL-padded, not just the cost — and generalizing the DP to respect that would mean tracking a partial order among steps, not just their cost, a materially harder problem this slice does not attempt. A chain with any `LEFT JOIN` is simply never reordered, the same way index-nested-loop already falls back silently when no index exists. New `isReorderableChain` (2+ joins, none `LEFT`) gates it. **The reconstruction, `rebuildJoinsForOrder`:** the join graph `joinGraphFromAst` already builds is always a spanning tree (one edge per non-`FROM` table, drawn from that table's own `ON` clause), so rebuilding a valid `{from, joins}` pair for a new order only ever needs, for each step, *some* earlier table sharing a real edge with it — never that it be the immediately preceding one (`leftJoinValue`/`leftJoinKeyOf`, plan.md §25.4 C3 slice b, already resolve a qualified reference against the whole chain so far) — so every original `JoinClause` is reused completely unchanged, just reassigning which table it is considered to introduce; a hub table (multiple edges, like the C4 demo's `departments`) picks whichever of its own edges reaches the tables already placed. Returns `null` — leaving the query to run exactly as written — for the (should-be-unreachable on a connected graph) case where an order would need a cross join, since this grammar has no `JOIN` with no `ON` clause to express one with. **Threaded through three places, not just one:** `runQuery.ts`'s `applyCostOrder` runs this before any table is even looked up for real, so table/column validation, the heap, and the plan all naturally see whichever order will execute; `emitParseEvents` is deliberately still called with the *original*, un-reordered AST (a real bug caught before it shipped — the parse stage must narrate source text, never a planning decision, and initially did not); and `emitPlanEvents` gained a `writtenJoinOrder` parameter so the plan-stage narration can say up front, before the trace starts naming a different `FROM` table than the one typed, what changed and why. C4's own "second opinion" note now only fires when reordering did *not* happen for real — either the chain is already optimal, or it contains a `LEFT JOIN`, in which case the note also says so explicitly, rather than leaving the reader to wonder why this chain never reorders when others do. **Tested directly, not just end-to-end:** new `joinOrder.test.ts` cases cover `isReorderableChain`'s `LEFT JOIN` exclusion, `rebuildJoinsForOrder` on the hub-shaped demo dataset (exercising the "table has several edges" path a plain chain never reaches), moving the `FROM` table itself to a different table entirely, and the defensive cross-join-`null` case; `join.test.ts`'s existing three-table chain test needed updating once reordering made its *own* premise (a forced `index-nested-loop` falling back mid-chain) disappear — reordering had found an order where every step could use the index — fixed by padding the small `comments` fixture (irrelevant filler `postId`s, matching nothing) enough that starting from it stops being cheap enough to outweigh the fallback it would dodge, restoring a genuine mid-chain fallback under the new, real, reordered execution. Mutation-checked three ways (the `LEFT JOIN` exclusion, the cross-join guard, the already-optimal short-circuit — all killed). `/tools/join-order`'s own doc comment and on-page text updated: its exact demo query is a plain inner-join chain, so what it shows *is* what now runs, not a second opinion — the page still earns its keep by showing the whole subset lattice the DP weighed, not just the winner. **Deliberately not attempted:** extending the SQLite oracle's fuzzer to generate multi-join chains at all (needed to fuzz reordering specifically) — its own query model still only ever builds a single two-table join, a gap plan.md has flagged as deferred since C3 slice a; extending it for reordering's sake alone is disproportionate to this slice, and correctness here instead rests on the dedicated unit and mutation tests above. **Slice 4 — the "Why not?" panel — built, 2026-10-01, closing C5.** Every C5 mechanism already computed a chosen option's cost next to the one it beat — `index-selection`'s scan-vs-index comparison, `join-algorithm-selection`'s full priced candidate list, join order's DP-vs-written — but only ever said so in a narration sentence; this slice pulls that same already-computed comparison into a small, structured, visually distinct panel rather than inventing any new cost math. Two new shared types in `types.ts`, `CostAlternative` (`{label, estPages}`) and `WhyNot` (`{chosen, runnerUp}`); `Rewrite` (`optimize.ts`) gained an optional `whyNot`, populated by `indexSelection` and `rangeIndexSelection` (the scan when the index wins, the index when the scan wins — the same one comparison the decline/accept branches already made) and by `joinAlgorithmSelection` (the first changed step's own cheapest `runnersUp` entry — a chain with several changed steps still gets the full comparison in its prose `label`, only the panel itself is scoped to the first step, a documented simplification rather than an unsolved one). `StepEventBody`'s `optimize` and `plan` variants both gained the same optional `whyNot`, threaded through `emit.ts`'s/`emitDelete.ts`'s/`emitUpdate.ts`'s existing per-step event emission with no new control flow. **Join order's own panel lives in `emit.ts`, not `optimize.ts`** (it is a plan-stage decision, never a `Rewrite`): the real-reordering narration pairs the chosen order against the written one it replaced; the LEFT-JOIN/already-optimal "second opinion" narration pairs the written order (`chosen`, since it is what actually ran) against the DP's cheaper suggestion (`runnerUp`) — the same two numbers that sentence already named, only shown when the ratio check already gating that sentence (`≥ 1.05`) says there is a real gap worth naming. New shared `<WhyNotNote>` (`src/ui/WhyNotNote.tsx`) renders `{chosen, runnerUp}` as "Why not {runnerUp.label}? An estimated N pages — against {chosen.label}'s M, the one actually chosen," reused verbatim in two places: the Playground (`PlaygroundPage.tsx`, read off `state.lastEvent`'s own `whyNot` right below the Narration box — present only on the exact step a cost-based rule or the join-order check actually fired) and `/tools/planner` (next to the specific rule's own `label`, since that page already iterates `optimize()`'s raw `Rewrite[]` directly). `/tools/join-order`'s own lattice (`CandidateRow`, built in C4) already shows every candidate the DP tried, not just one runner-up — richer than this panel and untouched here; this slice's narrower, single-runner-up panel is for the Playground/`/tools/planner`'s per-step view, where the full lattice would not fit. **Checked by:** new assertions on 6 existing tests across `planner.test.ts` and `join.test.ts` (both index-selection branches — decline and accept, `chosen`/`runnerUp` swapping sides between them — join-algorithm-selection's cheapest-runner-up pick, and both join-order narration paths, each confirming the exact `{chosen, runnerUp}` pairing and that `chosen.estPages` beats `runnerUp.estPages` the right way round); mutation-checked four ways (swapping `chosen`/`runnerUp` in the index-selection decline branch, in `joinAlgorithmSelection`, and in the join-order reordering block, plus inverting the `ratio` guard on the second-opinion block to show when it should actually be silent) — all four caught by the new assertions. Live-verified in both the Playground and `/tools/planner`: the index-selection panel ("Why not a sequential scan? ... against `id` index lookup's 4 pages"), the join-algorithm panel (correctly naming sort-merge, not nested-loop, as hash's cheapest runner-up), the real-reordering join-order panel, and the LEFT-JOIN second-opinion panel (correctly pairing the written order as `chosen` against the cheaper blocked order as `runnerUp` — the one case where the pairing flips relative to the real-reordering case). Three routes needed a budget bump from the new types/component rippling through the engine chunk and `/tools/planner`'s own direct import: `/progress` 168→171 kB, `/assignments/new` 163→166 kB, `/tools/planner` 165→168 kB (each its own measured size + 3, the usual slack). **C5 is now fully built** — index vs. scan (slice 1), join algorithm (slice 2) and join order (slice 3) all chosen by cost, and the "Why not?" panel (slice 4) explaining all three — closing plan.md's whole "Cost-based choice + 'Why not?'" line; C6 (Worker engine + larger data) is next. | 1.5 wk |
| **C6** | 2.1 | **Worker engine + larger data** | **Slice 1 — the `transactions` preset dataset — built, 2026-10-01.** The "1k–10k-row datasets; taller B+Trees; a genuinely thrashing pool" third of this item, done first since the other two (the Web Worker move, focus+context tree rendering) only make sense once bigger data actually exists to motivate them — building them first would be designing against a guess. New `DatasetId` member `transactions` (`src/engine/datasets.ts`), 3,000 rows (`id`/`account`/`amount`/`status`), only `id` indexed — mirrors `orders`'s existing "deeper tree, harder eviction" shape at a dramatically larger scale, not a new selectivity lesson (that is `logins`'s and `employees`'s job already). **Sized by measurement, not estimation** (a throwaway probe script building the real `BPlusTree` via `buildHeap`/`buildIndex`/`height()` — not the cost model's own log-estimate — across 500 to 10,000 rows): 3,000 was the smallest size that reached height 7, a full two levels past `employees`'s 250-row height 5, the tallest tree any existing preset reached. **A second probe pass measured actual trace length before picking the demo queries**, since a `SeqScan`'s own per-page buffer/lock events scale with heap pages touched regardless of a pushed-down filter's selectivity, while its "row returned" narration events scale with matches only — so an indexed point lookup or a narrow indexed range stays a short trace (53–204 events, measured) at any table size, while an unindexed predicate's trace scales with the whole table (4,343 events measured for the chosen "Eviction storm" preset at 3,000 rows) — deliberately kept as the *one* preset that shows that cost, not the starter query. Four presets: **Deep lookup** (the starter, `id = 1500`, short), **Range lookup** (`id BETWEEN 1500 AND 1520`, an indexed leaf-chain walk — short, but with real eviction, the "focus" case without the "storm"), **Eviction storm** (`amount > 4500`, unindexed, the dramatic one — live-verified in the Playground reaching 339 evictions and a 0% hit rate by step 2000 of 4,343), and **EXPLAIN ANALYZE** on the same storm query. **Checked by:** new dedicated tests in `datasets.test.ts` (the real tree height exceeds both `orders`'s and `employees`'s, measured via the same `buildHeap`/`buildIndex`/`height()` path the dataset's own doc comment cites; eviction count on the storm preset beats `orders`'s comparable scan by more than 5×; the point lookup and narrow range both stay under their measured event-count ceilings) and `datasetCatalogue.test.ts` (the range preset genuinely fires `range-index-selection` rather than falling back to a scan; the storm preset's eviction count clears the point lookup's by a wide, explicit margin) — both files' existing `it.each(DATASET_IDS)` parametrized tests picked up the new id for free, with zero changes needed. TypeScript's own exhaustiveness checking over `Record<DatasetId, …>` (`DATASETS`, `DATASET_CATALOGUE`) was trusted to surface every call site needing a new case — `pnpm typecheck` stayed clean, confirming no other file hardcodes the dataset-id list outside those two. Six routes needed a budget bump, a wider set than a typical engine-only change touches, since the dataset picker itself is shared by several tool/docs demo pages, not just the Playground: `/`, `/stages`, `/tools/buffer-pool`, `/tools/parser`, `/tools/page`, `/docs/concepts/buffer-pool` (each its own measured size + 3). Live-verified in the Playground: the new chip and its blurb render correctly; the B+Tree panel shows a visibly, dramatically taller tree than any other preset — and flowinger's existing pan/zoom/fit controls already handle it with no rendering issues, confirming the "focus+context" tree-rendering sub-item is a later polish pass, not a blocker for this data to ship and be usable today; the Buffer Pool panel genuinely thrashes on the storm preset; no console errors. **Not yet started:** the Web Worker move (`runQuery` behind the §5-designed seam) and focus+context tree rendering — next, once there's reason from real use to believe either is actually needed, not assumed up front. **Measured, 2026-10-01, not guessed — and the measurement is the finding:** before writing either, timed `runQuery` and the UI's own `createTraceProjector` fold (`viewState.ts`) against the worst case this dataset range can construct — a 10,000-row table, a fully unfiltered scan (~32,500 trace events, more than any shipped preset reaches). `runQuery` itself: 2.5–3ms median on the shipped `transactions` presets, 9.5ms median / 13ms max even on the constructed 10k-row worst case. The UI's own cold fold straight to the last step (what a "Scrub to step" slider drag actually triggers, `createTraceProjector`'s `while` loop filling its cache for the first time) — the one place `runQuery`'s own speed doesn't by itself prove the UI stays smooth: 0.5ms on the shipped 4,343-event preset, 4.3ms median / 7.7ms max on the 10k-row worst case. Both comfortably inside §5's own original claim ("execution over toy data is microseconds, so there is no jank to prevent") at the new, larger scale, not just the old one. The B+Tree panel's own rendering was already confirmed clean at the new height in slice 1's own live verification, no new measurement needed there. **Asked the user how to proceed given neither of C6's two remaining triggers (main-thread jank, an unreadable tree) has actually fired: defer both, confirmed.** C6 is **substantially done** for now — slice 1 delivered the one piece with a real, already-reached trigger (bigger tables for C1-style demonstrations); the Web Worker move and focus+context tree rendering stay explicitly un-built, revisited only if real future use (a dataset past 10,000 rows, a query shape this one's probes didn't cover, an actual reported slowdown) gives either one a genuine trigger rather than an assumed one. | 2 wk |

#### D. Transactions — the second subject (lectures 18–21; gated, §25.6)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **D1** | 2.2 | **Schedules + sessions** | `runSchedule([(session, stmt), …], db)` — **the interleaving is an input**, so the engine stays pure; `BEGIN` / `COMMIT` / `ROLLBACK`; Session A / B lanes with a shared timeline; the schedule is a share URL. **Built, 2026-10-10 (the baseline, with no concurrency control).** `runSchedule(steps, db)` in `src/engine/schedule.ts` is pure: the same schedule gives the same result, and the input database is untouched. Statements from sessions `A` and `B` run one at a time against one shared database; `BEGIN`, `COMMIT` and `ROLLBACK` are recognised by shape ahead of the parser (`transactionControl.ts`), and `runQuery` refuses them with a pointer to the tool, since they mean nothing to one statement. Each transaction keeps an undo log of the rows it changed, identified by reference, and `ROLLBACK` replays it newest first. **What it names rather than prevents:** a dirty read (the same `SELECT`, re-run on the database with every other session's open changes undone, returns something else) and a dirty write (a write over a row another open transaction produced), and a rollback that finds its row changed again says it could not restore it. A failed statement changes nothing and leaves the transaction open (MySQL's rule; PostgreSQL would abort it until `ROLLBACK`). `/tools/schedule` has Session A and B lanes on one timeline, three examples, and the schedule in the URL (`s`). **Checked by:** `src/engine/__tests__/schedule.test.ts` (including a property test that a single session which rolls back leaves the database as it found it), `src/ui/__tests__/scheduleUrl.test.ts` and `e2e/schedule.spec.ts`; seven mutations (oldest-first undo, dirty reads never checked, dirty writes never found, a delete restored at the front, a statement's writes never logged, a session's own changes counted as another's, and a transaction left open after `ROLLBACK`) each fail a test, and the last was first caught by nothing, a gap closed with a test. **Kept out of the engine barrel on purpose:** re-exporting `schedule.ts` added 4.7 kB (1.7 kB gzip) to the shared engine chunk of every route, for one tool, so the tool imports it directly and the npm package does not export `runSchedule` yet; it can once there is a subpath export for the transactions work. **Not built:** locks that block (D2), isolation levels (D3) and visibility rules (D4). Each statement is its own run with its own buffer pool, so a schedule shows what the data does, not what the pool does between statements. | 2 wk |
| **D2** | 2.2 | **Enforced lock manager** | Graduate `ui/lockSimulation.ts` (FIFO waiters, wait-for graph, deadlock, youngest victim) into `engine/locks/lockManager.ts`; **strict 2PL**; page-vs-row granularity. The Locks stage stops being "visual only". **Built, 2026-10-10.** `ui/lockSimulation.ts` graduated into the engine as `engine/locks/lockTable.ts`, generic over what a resource is; the sandbox is now a thin page-numbered adapter over it and its 24 tests pass unchanged. **A bug found in the graduation, present since v14:** a waiter that already held a shared lock (an upgrade) could never be promoted, because its own lock counted against it; fixed in the shared module, with its own test. `runSchedule` takes `locking: { granularity: 'page' | 'row' }` and then runs the schedule under **strict 2PL**: a statement takes the locks for what it touches before it runs (its page footprint is read from the engine's own `lock` events, data pages only since index pages are latched; at row granularity a scan locks every row it examines and an index lookup only the rows it fetches) and holds them to `COMMIT` or `ROLLBACK`. A statement that cannot get a lock **blocks**: nothing runs, the session's later steps are `queued` behind it, and it is `resumed` when the holder lets go, recomputed against what the holder committed. A cycle in the wait-for graph is a deadlock; the youngest transaction (first request last) is rolled back and its session carries on in a new one. A row another open transaction has deleted stays locked, and an inserted row is locked by its inserter from the first moment. **What table size teaches:** at three accounts the planner scans, so a row lock covers all three and gains nothing over a page lock; at twenty an `id` lookup uses the index, so row locks leave neighbours alone. **Checked by:** `lockTable.test.ts`, `lockSimulation.test.ts` (unchanged), and the locking tests in `schedule.test.ts`, including a property test that no interleaving produces a dirty read or write under either granularity. Eleven mutations (locks released per statement, blocked statements never resumed, deleted rows unlocked, inserted rows unlocked, a scan locking only its matches, later steps not queued, an upgrade that cannot be promoted, a victim left aborted in each of two paths, the victim always the requester, writes locking shared) each fail a test, and one (a victim left aborted) was first caught by nothing. **Not built:** isolation levels that release locks early (D3), predicate locks (phantoms remain), and waiting on another session's uncommitted `UNIQUE` key, which is rejected at once. | 1.5 wk |
| **D3** | 2.2 | **Isolation by locking** | READ UNCOMMITTED / COMMITTED / REPEATABLE READ / SERIALIZABLE via lock-duration rules; a toy predicate-lock case for phantoms. **Built, 2026-10-10.** A level is a lock-duration rule: `READ UNCOMMITTED` asks for no read locks, `READ COMMITTED` takes them and gives each back as the statement ends, `REPEATABLE READ` (the default, and D2's behaviour) holds them to the end, and `SERIALIZABLE` also holds each read's `WHERE` as a **predicate lock**; write locks are held to the end at every level. The schedule has a default level (`locking.isolation`) and a transaction may ask for its own with `BEGIN ISOLATION LEVEL …`. **The predicate lock is a resource in the same lock table:** the reader holds it exclusive, and a write that would add or re-key a row matching it asks for it shared, so writers never wait on each other, only on the readers whose answer they would change; it ends with its transaction and binds a writer at any level. **Anomalies named when they happen:** non-repeatable read and phantom (the same `SELECT` run twice in one transaction answers differently, told apart by whether the row count moved; a transaction's own writes reset that memory so its own change is never reported) and lost update (a write over a row this transaction read that someone else has since changed). **A hole a fuzz found:** a lookup for a row another open transaction had deleted or re-keyed found nothing, touched no page and took no lock, so it read an uncommitted deletion; the old image of such a row now stays locked until that transaction ends, at both granularities. **Checked by:** `schedule.test.ts` (each level's own anomaly and its absence one level up, the predicate lock's scope and lifetime, per-transaction levels, and a property test that SERIALIZABLE lets no anomaly through and REPEATABLE READ only phantoms, over both granularities and both table sizes) and `e2e/schedule.spec.ts`. Twelve mutations (a level taking or keeping the wrong locks, no predicate registered, predicates stopping every write, either tombstone missing, own writes not resetting repeated reads, lost updates undetected, a requested level ignored, predicates outliving their transaction, phantoms classed as non-repeatable) each fail a test; one (predicates stopping every write) was first caught by nothing, because an autocommit write skipped the predicate check altogether, which was itself a bug. **Not built:** MVCC and snapshot reads (D4), so a read waits or reads the one current version; index-range and next-key locks, which the toy predicate stands in for; and a wait on another session's uncommitted `UNIQUE` key. | 1 wk |
| **D4** | 2.2 | **MVCC / snapshot isolation** | Hidden `xmin` / `xmax` per tuple version; snapshots; the visibility rule as a **predict-then-reveal** ("can T2 see this version?"); first-committer-wins; **write skew**; vacuum and dead-tuple bloat interacting with the buffer pool. **Slice 1 built, 2026-10-10: versions, snapshots and vacuum.** `engine/mvcc.ts` holds the version store and the visibility rule (a version is visible when its creator was committed at the snapshot, or is the reader, and its remover was not); `runSchedule` takes `locking.mvcc`. Readers take **no lock**; writers still take an exclusive lock on each row they change, so two writers wait for each other and a deadlock is still a deadlock. `READ COMMITTED` takes a snapshot per statement; `REPEATABLE READ` takes one per transaction at its first statement, which is snapshot isolation: reads repeat, no phantom can appear, and a write to a row committed since the snapshot fails as **first committer wins**, while **write skew** gets through. `SERIALIZABLE` re-checks every read's predicate at `COMMIT` and refuses a transaction whose reads have been changed since its snapshot, which stops write skew and aborts more than PostgreSQL's SSI would; `READ UNCOMMITTED` behaves as `READ COMMITTED`, as it does there. A rollback undoes nothing: its versions are marked aborted and stay in the heap as dead tuples until `VACUUM`, which keeps any version an open snapshot can still see. The page shows each version's `xmin` and `xmax`, the dead count, and the heap's pages with and without them. **Checked by:** the MVCC tests in `schedule.test.ts`, including a property test that REPEATABLE READ and SERIALIZABLE let no anomaly through and READ COMMITTED only its own three; twelve mutations (readers still locking, a snapshot per statement, first committer not winning, no commit-time check, a commit not recorded, a rollback not hiding versions, vacuum taking what a snapshot needs, a transaction blind to its own changes, an update not stamping the old version, an updated row losing its place, an autocommit never committing, aborted creators counted live) each fail a test, all on the first pass. **Slice 2 built, 2026-10-10: predict, then reveal, and the cost through the real pool.** *Can they see it?* asks, for a chosen version and session, whether a statement run now would see it; the answer is `explainVisibility` applied to that session's snapshot (`ScheduleResult.snapshots`: its own, from its first statement, inside a snapshot transaction; everything committed otherwise), and the reveal names which half of the rule decided it, with both halves checked against `isVisible` by a property test. *What the dead versions cost* lays the versions out four to a page and runs three scans through `runBufferTrace` with the chosen number of LRU frames, as the heap is and after a VACUUM: at five frames, 24 versions (6 pages) read 18 pages from disk and 20 (5 pages) read 5, because a heap one page past the pool is read from disk on every pass. **Not built:** the scan is a reference string of the versions' pages, not the executor reading them, which would need it to skip invisible tuples and the index to carry entries for dead versions. | 2.5 wk |
| **D5** | 2.2 | **`/tools/isolation` — the Hermitage matrix** | The ten Hermitage anomalies × five levels × {2PL, MVCC}, **computed by running each schedule**; tests assert PostgreSQL's and InnoDB's *documented* outcomes (behaviour, not implementation). **Built, 2026-10-10.** `engine/hermitage.ts` holds the ten schedules (G0, G1a, G1b, G1c, OTV, PMP, P4, G-single, G2-item and G2, on Hermitage's own two rows plus eighteen filler rows so that an `id` lookup uses the index as it does in the databases the published results come from) and a detector for each, judged by what the transactions saw and wrote rather than by the engine's own anomaly flags. The matrix runs each at four levels on both engines: 80 schedules. **Held against the published results in a test:** PostgreSQL's for the versions engine (its READ UNCOMMITTED is READ COMMITTED, its REPEATABLE READ is snapshot isolation) and SQL Server's locking levels for the locks engine; 79 of 80 cells agree. The one that does not, OTV at READ UNCOMMITTED on locks, is declared in `KNOWN_DIFFERENCES` with its reason, and the test fails on any difference not listed. MySQL/InnoDB's REPEATABLE READ is a hybrid neither engine models, so it is not held against either. **Also checked:** a stricter level never allows what a weaker one prevents; SERIALIZABLE lets none through on either engine; with no control at all nine of the ten happen (OTV, which needs a reader to see part of a transaction, does not). **Found while building it:** the P4 detector first relied on the engine's `lost-update` flag, which a broken engine could fail to raise, so a mutation of first-committer-wins was caught by one narrow test and not by the matrix; it now judges by outcome (both transactions committed) and the matrix catches it too. Six mutations of the engine or the detectors each fail the matrix test. `/tools/isolation` shows both tables, marks a cell that differs from the published result, and opens the schedule behind any cell. **Not built:** PMP for write predicates, which the published page lists apart from the ten; Oracle's column. **InnoDB column, built 2026-10-14** (replacing 'MySQL/InnoDB's REPEATABLE READ is a hybrid neither engine models' above): a third column, composed level by level from what InnoDB does — READ UNCOMMITTED is the locking engine (a reader sees the latest version; writes take row locks); READ COMMITTED a snapshot for each statement; REPEATABLE READ one snapshot for plain reads and a *current read* for writes, `LockingOptions.currentWrites` (a write works from the latest committed row, waits on the row lock and goes on top, where PostgreSQL's first committer wins, so a lost update gets through); SERIALIZABLE turns plain reads into locking reads, which is the locking engine again. The option needed one change to the visibility rule: a transaction that has written a row sees its own version of it and no other, or the stale version its snapshot still counts would appear beside it. **Held against MySQL's published results** (Hermitage's `mysql.md`, MySQL 5.6.21): the page ran 19 of the 40 cells, and `PMP` and `G-single` in a read and a write-predicate variant; the matrix's schedules are the read variants, so those are what is compared. All 19 agree but one, OTV at READ UNCOMMITTED, declared in `KNOWN_DIFFERENCES` as the locking engine's is; the other 21 are computed and shown with no claim (`DOCUMENTED` is `null` there, and `/tools/isolation` and its table say 'not published'). **Mutations:** ten of the option, the visibility rule and the level mapping; four survived at first — a guard that, with a current read, nothing could reach (removed), the level condition (pinned by a test that SERIALIZABLE still refuses a stale write *at the write*), the own-version rule on a row written twice or inserted and deleted (pinned), and READ COMMITTED reading under locks (pinned by G1c's readers not deadlocking) — and all ten now fail a test. | 1 wk |
| **D6** | 2.2 | **Concurrency-control compare** | 2PL vs. timestamp ordering vs. OCC vs. MVCC on one schedule: aborts, waiting, anomalies (lectures 19–21). **Built, 2026-10-10.** `runSchedule` gained two protocols that never wait, `protocol: 'timestamp'` (basic timestamp ordering: a stamp per row for the newest read and write, an operation that arrives after a younger transaction's is aborted on the spot) and `protocol: 'optimistic'` (reads what is committed, writes into a private workspace, backward-validated at `COMMIT` against everything committed since it began, predicates and unique keys included). `engine/concurrencyCompare.ts` runs one schedule under five protocols (two-phase locking, timestamp ordering, optimistic validation, snapshots, serializable snapshots) and reads each run back as a bill: committed, aborted and why, waits, statements lost to an abort, the anomalies that reached a transaction that was *not* aborted, and a verdict. `/tools/concurrency` shows the table, seven presets, and the run behind any row. **The verdict is computed, not asserted** (`engine/serialCheck.ts`): the committed transactions are replayed one after another on a fresh database, in some order that gives every statement the rows it returned or affected in the run and leaves the table that survived. The commit order is tried first, then the begin order, then a pruned, memoised search with a budget; the page says *None found* if the budget runs out and *No* only when it covered every order. The reads matter: write skew leaves a table a serial run could leave, and is caught only because each transaction read something no order would show it. **Held in tests over fuzzed schedules** (three sessions, up to 28 steps, both table sizes, 8,000 runs each): strict two-phase locking at rows and at pages, optimistic validation and serializable snapshots produced no run that fails the check; timestamp ordering produced about one run in a hundred that does, and every one carries a flagged dirty read or write (none unexplained in 16,000), because it is not strict. **Found while building it, each by a fuzz and each now a test:** an undo put a deleted row back by position, so rows deleted and updated around it shifted it; under snapshots two transactions could both add one unique key; after a deadlock victim's waiting steps ran, the statement that closed the cycle used a stale run; a page lock followed a row's position instead of the page it was made on; an optimistic commit did not refresh the state it validated the next one against; timestamp ordering had no answer for a row a younger transaction had *removed* or re-keyed, nor for a phantom a younger transaction's scan would have picked up (both now covered by predicate, from images kept for the purpose); the dirty-read detector looked only at `SELECT`s, so a write whose `WHERE` was answered from another session's uncommitted change was not flagged; and the first version of the verdict replayed only in commit order and called two serializable snapshot runs *No*, which is why it searches. **Mutation-checked:** about thirty mutations of the engine, the protocol rules and the check each fail a test; two changed nothing (a rewrite that was a no-op, and skipping the second natural order, which the search subsumes). The row-set half of optimistic validation survived four mutations at first because the commit-time predicate re-check covers the same cases; the tests now pin which rule's reason is shown. **Not built:** a precedence-graph drawing (the check replays, it does not draw), PostgreSQL's SSI (the serializable-snapshot check is simpler and refuses more), strict or multi-version timestamp ordering and Thomas's write rule, and a protocol selector inside `/tools/schedule` itself (the compare page links there for editing). | 1 wk |

#### E. Durability — the third subject (lectures 22–23)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **E1** | 2.3 | **WAL** | Log records (LSN, prevLSN, txn, page, redo/undo), a log buffer and flush, the **log-before-data rule enforced on the buffer pool**. **Built, 2026-10-10.** `engine/recovery/wal.ts` is a pure, standalone model in the family of the lock table: a disk of four pages (a page is a few named integer cells), a buffer pool of two to four frames, a log buffer and a durable log, and a transaction table; `runWal(steps, {frames, enforce})` folds a script over it and returns, per step, typed effects, the same in words, and the state after. Records are `update` (page, key, before, after), `commit`, `abort`, `clr` (the redo-only compensation record, with `undoNextLSN`) and `end`, each with a strictly increasing **LSN** and a **prevLSN** chaining a transaction's records. A page carries **pageLSN** (last record applied) and **recLSN** (first record since it was last written). **Commit forces the log through its commit record and writes no data page.** **Rolling back** undoes newest first, writing a CLR for each undo. **The rule is enforced on the pool:** before a dirty page is written, on request or by eviction, the log is flushed through its pageLSN, and only that far; with `enforce` off the page goes out ahead of its log and the run names the violation (`walViolations`: any page on disk with pageLSN beyond `flushedLSN`). A cell changed by a transaction that has not ended is its alone, so rollback never undoes over another's change. `/tools/wal` has a step builder, five presets (commit forces the log; the page needs its log first; eviction pays the same price; rollback is logged too; break the rule), a frame count, the rule toggle, and the state (pool with pageLSN/recLSN, disk, durable log, log buffer) after any chosen step; the script is the URL. **Held in tests:** properties over random scripts and pool sizes (no page on disk is ever ahead of the durable log; the durable log is a gapless prefix and the buffer carries on from it; a commit is durable when it returns; each transaction's records chain back through prevLSN strictly downwards to its first; what the database holds is what the newest record for each cell says, rollbacks included) and a witness that with the rule off the first of those fails. Fourteen mutations of the machine each fail a test; three survived at first (commit not releasing its cells, recLSN overwritten on every change, a written page left dirty) and now have one. **Honest limits:** the pool here is this model's own, not the SQL engine's read-cache pool, which has no page contents or LSNs; joining the two is E4. No crash, checkpoint or recovery yet (E3), and steal/no-steal and force/no-force are not yet choices (E2): as it stands the model steals (a dirty page of an uncommitted transaction may be written) and does not force, which is what ARIES is built for. Only changes to existing cells; no inserts, deletes or savepoints. | 1.5 wk |
| **E2** | 2.3 | **Steal/no-steal × force/no-force** | The four combinations with their visible consequence — the payoff of v1's dirty writeback (§22.2: "the buffer pool's other half"). **Built, 2026-10-10.** `WalOptions.steal` (default on) and `.force` (default off) on E1's machine, with E1's behaviour unchanged at the defaults. **No-steal** pins a page that holds an uncommitted change (each frame records its `holders`): it is not evicted, a `write page` of it is refused, and a step that would need a frame when every one is held is refused with nothing done. **Force** writes every page a transaction changed inside its commit, after the log is forced; under no-steal a page another running transaction has also changed is *deferred* and written when that transaction ends (page-grained logging makes force and no-steal collide, which record-level logging avoids). **The consequence is computed, not narrated:** `crashImage(state)` is what a crash at that moment would find — the recovered database is the initial one plus every committed transaction's changes (committed = commit record durable), and each cell on disk is right, or holds a value an uncommitted transaction wrote (**undo**, which steal causes; `logged` says whether the record that could undo it is durable, so the rule off shows an unrecoverable one) or is behind a committed change that never reached disk (**redo**, which no-force causes). `comparePolicies` runs a script under all four and reports commit page writes, other writes, log forces, refused steps, and the worst and final undo/redo counts. `/tools/wal` gained the two toggles, five more presets, an *If the machine stopped here* panel for the chosen step, the uncommitted-by column in the pool, and the four-way table. **Held by properties** over random scripts, pool sizes and the rule on and off: under no-steal no uncommitted value is ever on disk; under steal with force no committed value is ever missing from disk; a refused step changes nothing; the policies change when pages are written, never what is logged; and E1's invariants still hold under all four. **Mutation-checked:** ten mutations (no-steal evicting held frames, force writing nothing, deferral lost, deferral never written, no-steal write allowed, undo and redo swapped, `logged` always true, holders not cleared or not added, force applied under no-force) each fail a test; one survived at first (a deferred page never written when the other transaction rolls back rather than commits) and now has a test. **Found while verifying in the browser:** the pool table grew a column and became a scrollable region with nothing focusable in it, which axe reported (WCAG 2.1.1); tables on this page now take focus as labelled regions. | 1 wk |
| **E3** | 2.3 | **Checkpoints, crash, ARIES** | Fuzzy checkpoints; a **crash button** that drops the pool and keeps disk + log; analysis → redo → undo with the dirty-page table, transaction table and CLRs as panels — `/tools/recovery`. **Built, 2026-10-10.** On the same machine as E1 and E2. **Checkpoints:** `checkpoint-begin` writes a begin record and copies the dirty page table and the transaction table as they are then, `checkpoint-end` writes an end record holding them, forces the log and moves the master record; `checkpoint` does both at once. No page is written and nothing waits, so work between the two is not in the tables (the restart scans forward from the begin record). **Crash:** drops the pool, the log buffer and every transaction (and any open checkpoint); keeps the disk, the durable log and the master record; the next LSN is numbered from the end of the *durable* log; nothing else runs until recovery. **Recovery** (`restart`) is ARIES in three passes, each reported: *analysis* from the master's begin record with the end record's tables, scanning forward and naming the losers (no commit record), with the redo start the oldest recLSN; *redo* repeats history, and says per record whether it was skipped (page not in the dirty page table, LSN before the page's recLSN, or the page on disk already has it) or redone; a committed transaction whose end record was lost gets one; *undo* takes the losers' last records, always the newest next, writing a redo-only CLR (with `undoNextLSN`) for each undone update and an end record for a finished transaction, **forcing each as it goes**, so `recover crash after N` (a stop after N undo records) is resumed by the next restart, which follows the CLR it finds and undoes nothing twice. `/tools/recovery` has the checkpoint, crash and recover buttons (and *recover, then crash*), six presets (redo, undo, both, a checkpoint shortening the work, a crash during recovery, the rule off), the three passes as panels with both tables, the state after any step, and *Is the database right?*, which compares the pool over the disk to the committed state. **Held by properties** (600 random scripts of up to 30 steps with checkpoints, any pool size and policy, then a crash and a recovery): the database is exactly the committed state; also after up to three interrupted recoveries; analysis names as losers exactly the transactions that wrote and neither committed nor ended; no transaction has more CLRs than changes; the recovered state is the same with or without checkpoints; and the crash image of E2 predicted exactly the cells recovery then had to fix. **Mutation-checked:** fifteen mutations of analysis, redo, undo, the crash and the checkpoint each fail a test; two gave the same final state by another route (skipping on the page's recLSN, and `end` not clearing the transaction table) and now have tests that pin the reason and the records. **Found by the tests:** `begin checkpoint` parsed as a transaction named "checkpoint". With the rule off the model's recovery is *wrong* — the uncommitted value stays — and the page says why. **Not built:** the SQL engine's own pages (E4), log truncation, concurrent work during recovery, and savepoints. **Recovery as a trace, 2026-10-14:** the report's rows (`recoveryRows`, already in the order the passes ran) are now walked: a strip of the three stages, `recoveryStages(rows, at)` saying which are pending, current, done or empty, and a slider and buttons that take the report one row at a time, narrating the step and marking the redo or undo line it names (`RecoveryStepper` in `walPanels.tsx`, so `/tools/recovery` and the Durability dialog both have it). It rests at the end, as the panels always were. Five mutations of the stage function fail the unit test; `/tools/recovery` and `/tools/wal` 129 → 133 kB (+0.8, shared panels). | 2 wk |
| **E4** | 2.3 | **Recovery in the pipeline** | Run `UPDATE`s in the Playground, crash, recover, compare with the committed state. **Built, 2026-10-10.** `engine/recovery/heap.ts` is the bridge from the engine's tables to the machine's pages: a table's rows laid out as the engine lays out its heap (`rowsPerPage` to a page, table order), each row one cell as its JSON text, a slot with no row `null`; a row keeps its slot (*rid*) so a delete leaves a tombstone and an update changes one cell; eight spare slots per table take inserts, because the machine's pages are fixed when it starts. `writeSteps` turns a statement's `before` and `after` rows (all the engine reports of a write) into `begin` + one `set` per changed row, matching deleted rows by identity then by value, and refuses a statement that is out of step with the heap, that has no spare slot, or that changes more than 60 rows. `Cell` widened from `number` to `number | string | null`, and `runWal` takes `maxSteps`. The Playground keeps a `DurableLog` (`ui/durableLog.ts`; `recordWrite` is called where the write is persisted) and notices a database changed any other way by comparing the rows it expects, starting again from the new one. **The *Durability* button** opens a lazy dialog (`ui/DurabilityDialog.tsx`, an opt-in chunk of 12 kB): the statements as open transactions with Commit/Roll back; frames, steal and force; write page, flush log, checkpoint, **crash**, **recover** (and *recover, then crash*); the three passes of recovery; a table of every row that differs between *the Playground before the crash*, *after recovery* and *what committed*; and *Use the recovered database in the Playground*, which replaces the table and carries the log on. The statements' effect stays visible in the Playground at once, as a session sees its own uncommitted work. **Held in tests:** the heap layout, each kind of write as steps, refusals, and a table taken through a commit, a lost uncommitted delete and a committed insert, crash and recovery, which gives back exactly the committed rows and a heap that carries on; and the log's own functions (stale detection, restart, limits). **Not built:** logging of indexes (they are rebuilt from the rows), the engine's own buffer pool as the pool the rule is enforced on, more than eight inserts per table, and statements that change more than 60 rows. | 1 wk |

#### F. Storage engines & access methods (lectures 5–10, 14; parallelisable; Q6 applies to each)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **F1** | 2.4 | **`/tools/lsm` + Bloom filter** | **Slice 1 — the LSM-tree sandbox, leveled compaction — built, 2026-10-01.** The core of `/tools/lsm`: a new, wholly standalone `src/ui/lsm.ts` driver, the same family as `/tools/sort`'s `externalSort.ts` and `/tools/hash-join`'s `hashJoin.ts` — pure and total, laying out a whole write sequence's resulting structure (every flush, every compaction, the final levels) up front, parameter-driven in the UI rather than animated playback. **The model:** writes buffer in a memtable; once it holds `memtableCapacity` entries it flushes as one new, immutable, sorted SSTable at L0; L0's own SSTables may overlap in key range (each is just whatever the memtable held at flush time) and compact into L1 once L0 holds `l0CompactionTrigger` of them; level *n* ≥ 1 has a capacity of `baseLevelCapacity × levelSizeMultiplier^(n-1)` entries and compacts into the next once exceeded. **Compaction is deliberately simplified**, the same honest simplification the B+Tree's own tiny fan-out already makes (`index/btree.ts`'s own doc comment): a real leveled compaction merges one file at a time, picked by a scheduling policy; this model merges a *whole* level's current SSTables (plus whichever next-level SSTables their key ranges overlap) in one step, keeping only each key's newest write, then re-splits the result into fresh, non-overlapping SSTables — never a file-picking heuristic that would only obscure the real lesson (data cascades downward, each level is geometrically bigger than the last, and write amplification is *why* a key gets physically rewritten every time it moves down). **Write and space amplification are real, computed counters** (entries ever physically written ÷ entries you asked to write; entries currently on disk, stale duplicates included, ÷ distinct live keys) — not estimates. **Read amplification is a worst-case count** (every L0 table, since any of them can hold a given key, plus one per non-empty level below, since each level's own tables never overlap each other) — honest about not yet having a Bloom filter to actually narrow it, which is explicitly this item's own next slice, not pretended at. **A genuinely interesting, non-obvious finding, not a bug:** write amplification can measure *below* 1× — caught by a property-based fuzz test's own counterexample, not assumed away. Two writes to the same key landing in the same memtable batch, before either is ever flushed, coalesce to one physical write — a real write-reduction a memtable provides for free, the exact reason LSM trees can beat naive in-place updates for hot keys, not a flaw in the model; turned into its own dedicated regression test once understood, and live-verified in the browser (write amplification visibly drops to 0.90× under generous capacity settings where every write fits before any flush). **Checked by:** 19 tests in `lsm.test.ts`, including a `fast-check` property test over the whole legal parameter space asserting the on-disk state always matches a naive replay of the write sequence exactly, and every level past L0 stays non-overlapping; mutation-checked two ways (the "newest write wins" dedup rule, the overlap-detection guard driving which next-level tables a compaction merges with — both caught cleanly). Full gate (typecheck/lint/1899 unit tests/98 e2e/build/budget) all green; a new route, `/tools/lsm` (114.7 kB measured + 3, self-contained — no shared engine-chunk impact, so no other route moved), registered in `App.tsx`, `ToolsIndexPage.tsx`, and the course map (`course-map.mdx`'s "Log-structured storage" row, Not covered → Partly — its stale neighboring "Cost models and join ordering" row, never updated when C4/C5 shipped, corrected to Covered in the same pass). Live-verified: the level cascade, the non-overlapping key ranges at L3, the click-to-see-provenance interaction ("compacted from 6 tables"), and the live write-amplification-below-1 demonstration, all exactly matching the numbers a probe script computed beforehand. **Deliberately deferred to later slices, matching this item's own remaining scope:** the Bloom filter (the read path these counters are honest about not yet narrowing), tiered compaction as a second, selectable strategy, and the `/compare` B+Tree-vs-LSM mode.

**Slice 2 — the Bloom filter, and a real read path — built, 2026-10-01.** Every SSTable now carries its own Bloom filter, built from the keys it holds at flush or compaction time, sized by a user-tunable `bitsPerKey` (2–20): `m = n × bitsPerKey` bits, `k = (m/n) × ln(2)` hash functions — the standard space/accuracy optimum, not a fixed guess. All *k* bit positions for a key come from two independently mixed hash values via Kirsch–Mitzenmacher double hashing (`h_i = h1 + i·h2`), one evaluation standing in for *k*. **A hash-quality bug caught empirically, before it ever shipped:** the first validation probe used an all-even insert-key set against an all-odd test-key set, through a bare single-multiply hash — and measured a suspiciously perfect 0% false-positive rate at *every* `bitsPerKey` value, including ones where the textbook formula predicts ~40%. Traced to the real cause: even keys × odd multiplier = even product, even mod an even table size = always even, so even keys only ever set even-indexed bits and odd test keys only ever check odd-indexed ones — a parity artifact of the test methodology, not evidence about the filter. The probe was fixed to use disjoint random key sets either way, and the real hash function was hardened anyway (a full xorshift-and-multiply integer-mixing finalizer, applied twice, in place of the bare multiply) since a user could still explore structured key patterns interactively. **`lookupKey` is a real, traceable read path**, not a narrated approximation: it checks each candidate table's Bloom filter first (skipping any table the filter rules out), physically checks the table only when the filter says "maybe," returns the first real hit, and records every table it checked and which of those were false positives. L0 tables (key ranges may overlap) are checked newest-first, since a key can legitimately sit in more than one, with different values, before compaction catches up; every level below is checked by exact non-overlapping-range membership, same as the B+Tree's own leaf chain. **`readAmplificationAverage` and `measuredFalsePositiveRate` are now measured, not estimated**, closing the honesty gap Slice 1 named explicitly: every distinct key actually written (an expected hit) plus an equal-sized sample of keys strictly past the highest key ever written (guaranteed misses) are each looked up for real through `lookupKey`, and the two rates are read off what actually happened — validated against the textbook formula across the full `bitsPerKey` range before trusting it. The read-amplification worst-case stat stays alongside the measured one, so the Bloom filter's own payoff (worst case vs. what it actually achieves) is visible, not just asserted. **Checked by:** 7 new tests (26 total in `lsm.test.ts`) — Bloom-filter-specific ("no false negative, ever," "a wider filter never raises the measured false-positive rate," "measured read amplification is at most the worst case") and a new `lookupKey` describe block (finds every key with its newest value regardless of cascade depth, a genuine miss is a genuine miss every time, every table actually checked had already passed its own filter); the property-based fuzz test extended with a new `bitsPerKey` parameter and a no-false-negative assertion over the whole legal range. **Mutation-checked two ways:** forcing `bloomMightContain` to always return false (caught cleanly — the no-false-negative dedicated test and the property test's own loop both failed, as expected); flipping L0's newest-first scan to oldest-first (**not caught by any existing test** — every test's `l0CompactionTrigger` was low enough that compaction always drained L0 below 2 tables before a plan was ever queried, so the ordering was structurally unreachable in the existing suite. A genuine coverage gap, not a safe mutation: fixed by adding a dedicated regression test that holds a high trigger so two L0 flushes of the same key, with different values, coexist at rest — confirming the newer one wins). Full gate (typecheck/lint/1906 unit tests/98 e2e/build/budget) all green, no budget ceiling bump needed (`/tools/lsm` measured 115.8 kB against its existing 118 kB ceiling). Live-verified in the browser: a real hit (key 1, value 427, highlighted green with "found here"), a genuine miss (strictly past the max written key, zero false positives), and the `bitsPerKey` selector moving the measured false-positive rate from 67.4% down to 0.0% live, with the URL's own `bits` param following along — all exactly matching a probe script's numbers computed beforehand. **Still deliberately deferred, matching this item's own remaining scope:** tiered compaction as a second, selectable strategy, and the `/compare` B+Tree-vs-LSM mode.

**Slice 3 — tiered compaction, a second selectable strategy — built, 2026-10-02.** `LsmOptions` gained `compactionStrategy: 'leveled' | 'tiered'`, a UI dropdown, and a `?strategy=` URL param. **Leveled's own code and behavior are completely unchanged** — `compact()` is now a two-way dispatcher (`compactLeveled`/`compactTiered`), with every one of Slice 1 and 2's own 31 tests passing byte-for-byte against the untouched `compactLeveled` path, confirmed before writing a single line of the new strategy. **Tiered, the real RocksDB-style alternative** ("universal" compaction, as opposed to leveled's default): once a level — any level, not just L0 — accumulates a shared `filesPerTier` trigger's worth of SSTables (the same field L0's own trigger already used, now reused at every level under this strategy), they merge into ONE new, unsplit table that moves down a level, leaving whatever the next level already holds completely untouched until IT, too, fills up. This is the opposite of leveled's own re-split-and-merge-with-overlapping-neighbors behavior, and genuinely trades one real cost for another, not a cosmetic toggle: **tiered touches less data per compaction** (never rewriting what the next level already has), so it costs measurably **less write amplification** for the same writes — but now any level, not just L0, can hold several overlapping SSTables, so a lookup may have to check every table at every level, costing measurably **more read amplification**. **Both directions of the trade-off were measured via a probe script before writing a single test assertion** (this project's standing discipline): across write counts 60/100/150 with identical parameters, tiered's write amplification measured consistently 0.48–0.59× of leveled's, and its worst-case read amplification measured 1.33–2.5× leveled's — a real, reproducible, bidirectional gap, not assumed from the textbook description. `lookupKey` gained a required `strategy` parameter: L0 is always scanned newest-first in full either way, but below L0, leveled keeps its existing single-range-match lookup while tiered scans every table at a level newest-first, the same way L0 always has. `readAmplificationWorstCase` is now strategy-aware too (every L0 table plus one per non-empty level below, for leveled; every table at every level, for tiered). **Checked by:** 5 new tests — tiered still replays correctly and every one of its compaction events creates exactly one unsplit table (never re-split, the defining structural difference from leveled); a same-writes-same-parameters A/B test asserting tiered's write amplification is measurably lower than leveled's; a second A/B test asserting the opposite for worst-case read amplification; a dedicated regression test holding two overlapping tables in L1 at rest (a `filesPerTier` of 4 lets two separate L0→L1 merges coexist below the trigger) confirming `lookupKey` returns the newer one, not the first range match — the exact same "newest wins across overlapping tables below L0" property Slice 2 proved for L0 itself, now proved one level down; and a SEPARATE `fast-check` property test scoped to tiered (replay-correctness and no-false-negative hold for tiered too, but NOT the non-overlap invariant, which is genuinely false by design under this strategy — kept as its own test rather than bolting a strategy conditional onto the existing leveled-only property test). **Mutation-checked two ways:** making tiered's own next-level merge REPLACE instead of append (silently defeating the overlap the whole strategy exists to allow) — caught by 4 tests at once (the overlap regression test, the plain correctness replay, and the tiered property test's own two assertions); inverting `lookupKey`'s strategy branch (tiered levels wrongly using leveled's single-range-match search) — caught by 2 tests (the overlap regression test returned the stale value; the property test's own no-false-negative loop failed on a case the wrong search path missed entirely). Full gate (typecheck/lint/1911 unit tests/99 e2e/build/budget) all green, no budget ceiling bump needed (`/tools/lsm` measured 116.2 kB against its existing 118 kB ceiling). Live-verified in the browser at the exact probed numbers: switching the existing demo from leveled to tiered visibly dropped write amplification from 3.83× to 2.97× and raised worst-case read amplification from 1 to 2 simultaneously; L1 and L3 rendered with genuinely overlapping key ranges (`keys 6–21` and `keys 1–21`); the leveled-only L1-capacity/level-size controls visibly greyed out and disabled; the shared trigger control's label switched to "Files per tier"; clicking a tiered-compacted table correctly named "compacted from 2 tables." No console errors.

**Slice 4 — the `/compare` B+Tree-vs-LSM mode, closing F1 entirely — built, 2026-10-02.** A new, sixth `/compare` mode feeds the exact same write sequence (`/tools/lsm`'s own `demoWrites`) into a real B+Tree (`engine/index/btree.ts`'s `createTree`/`insert`/`height` — the same code `/tools/btree` already drives, extended here to a second use) and into `planLsm`, side by side. **"Amplification numbers from real counters" on both sides** (this item's own long-standing "not started" checklist line, §25.4's definition-of-done), measured in deliberately DIFFERENT units — a new `src/ui/btreeWriteCost.ts` module counts B+Tree write cost in index PAGES touched per write (a B+Tree updates in place: an insert touches at least its own leaf, and only more when a split cascades upward), against `lsm.ts`'s own existing counter in raw ENTRIES rewritten per write (an LSM tree defers writes into a memtable, then physically rewrites the same entry again and again as compaction sweeps it through deeper levels). **The unit mismatch is not papered over — it IS the lesson**, stated directly in both the page's own explanatory text and `btreeWriteCost.ts`'s doc comment: comparing the two numbers side by side shows *why* they're counted differently, which is the actual structural contrast between the two designs. **Measured the same way `lsm.ts` measures its own counters**: `planBTreeWrites` snapshots every node's serialized content immediately before each `insert`, then diffs against the tree's own `nodes` map afterward — any node that is new, or whose content changed, was a real write for that one logical write; needed no new B+Tree instrumentation, since `nodes: Record<string, BTreeNode>` is already the tree's full, authoritative state. **A genuinely interesting, real contrast, confirmed by measurement before writing any UI text:** at the same 150-write demo, the B+Tree touches 1.44 pages per write and a point lookup always costs exactly 4 page reads — both numbers stay small and roughly constant as data grows. The LSM tree (leveled) physically rewrites 6.21 entries per write — a real, measured, GROWING cost (3.87× at 60 writes, 6.21× at 150, 6.48× at 200 — confirmed via probe script before committing to the demo's default write count) — but a real lookup with the Bloom filter costs only 0.61 table checks on average against a worst case of 3, comparable to or better than the B+Tree's own fixed cost. **This closes the loop on every earlier F1 slice at once**: slice 1's write/space amplification, slice 2's Bloom filter and measured read amplification, and slice 3's leveled-vs-tiered trade-off all feed directly into this one closing comparison. **A second genuinely interesting fact, worth its own dedicated test:** unlike `lsm.ts`'s own write amplification (which can measure *below* 1×, slice 1's own finding, from in-memtable write coalescing), a B+Tree's write amplification can never drop below 1 — there is no buffering stage to coalesce a repeat write into before anything is physically touched; every write touches at least one leaf, full stop. **Checked by:** 6 new dedicated tests in a new `btreeWriteCost.test.ts` — exact node-write counts for a non-splitting insert (1), a splitting insert (3: the rewritten leaf, the new sibling, the new root), and a same-key update (1, no restructuring, confirmed via the tree's own unchanged node count); read cost always equals the tree's own height; an empty sequence still costs nothing beyond the one all-trees-start-with empty root leaf; and a `fast-check` property test over the whole legal parameter space asserting write amplification never crashes, is always finite, and — the direct, measured contrast with `lsm.ts`'s own property test — is never below 1. **Mutation-checked:** changing the node-write counter to count only brand-new nodes (never rewritten existing ones) — caught by 4 of the 6 tests at once (the non-splitting-insert count, the same-key-update count, and both assertions in the property test), confirming the diff genuinely needs to catch in-place content changes, not just allocations. Full gate (typecheck/lint/1917 unit tests/100 e2e/build/budget) all green; `/compare`'s own budget needed a ceiling bump (171 → 175 kB, measured 172.0 — the new mode pulls both `lsm.ts` and `btreeWriteCost.ts`, and transitively the engine's B+Tree module, directly into `ComparePage`'s own lazy chunk). Live-verified in the browser at the exact probed numbers: the default 150-write demo's B+Tree and LSM columns both rendered correctly; the Writes input live-updated both sides to 60 writes' own exact numbers with no Run button needed (matching `/tools/lsm`'s own live-update convention, unlike every other `/compare` mode's SQL-then-Run pattern); the "an LSM tree" link correctly pointed to `/tools/lsm`; switching back to the pre-existing "JOIN algorithms" mode confirmed zero regression from the new mode's addition. No console errors. **F1 is now fully closed** — the LSM-tree sandbox, its Bloom filter, tiered compaction as a second strategy, and the `/compare` mode are all built, tested, mutation-checked, and live-verified. | 2 wk |
| **F2** | 2.4 | **`/tools/hash-index`** | **Built, 2026-10-02.** A new, wholly standalone `src/ui/hashIndex.ts` driver, the same family as `/tools/lsm`'s `lsm.ts` — pure and total, laying out a whole write sequence's resulting structure up front, strategy-selectable between extendible and linear hashing on the same page (the same two-strategies-one-tool shape F1's own tiered-vs-leveled slice already established). **Extendible hashing** (Fagin et al.): a directory of `2^globalDepth` slots, each bucket carrying its own `localDepth <= globalDepth`; inserting into a full bucket splits it — doubling the whole directory first only when the bucket has no spare depth to split into (`localDepth === globalDepth`), otherwise just adding a sibling and repointing the directory slots that already had room for one. **Linear hashing** (Litwin): no directory — a plain bucket array, a `level` (completed doubling rounds) and a `splitPointer` (which bucket is next to split, this round) together address a key; splitting is **decoupled from which bucket overflowed** — any overflow anywhere triggers the bucket the round-robin split pointer currently names, never necessarily the one that just overflowed, the scheme's own defining trait (bounded, predictable growth, never a cascade from one hot bucket). **Why a hash index cannot range-scan is shown directly, not just asserted**: a `scatter` field reports where N keys immediately following the highest one ever written would actually land — consecutive keys land across several unrelated buckets, with no sorted chain to walk the way a B+Tree's own leaf chain provides. **The hash function**: the same full integer-mixing finalizer (xorshift + multiply, twice) F1's own Bloom filter already proved necessary — applied here from the start, not rediscovered a second time, since extendible hashing reads the hash's own low bits directly as a directory index and is even more exposed to a bare multiply's structured-key correlation than a Bloom filter's multi-bit sampling ever was. **Two real, substantive bugs caught during validation, before either scheme ever shipped — not safe mutations, genuine defects:** (1) linear hashing's own round-completion check compared `splitPointer` against `addressSpace() / 2` instead of `addressSpace()` — a round should close only once EVERY original bucket has split once, not half of them; the bug silently advanced to the next doubling round a full round early, scrambling every subsequent address computation. Caught by a correctness probe script (not a hand-derived test) showing `totalEntries` exceeding `distinctKeysWritten` — an impossible state for a hash index that updates a repeated key in place. (2) a split that rebuilds a chain's own primary bucket left its OLD overflow pages sitting, unreferenced, in the plan's own bucket record — never deleted, so their stale entries kept getting counted as if still live, producing phantom duplicate keys reachable only by naive iteration, never by an actual lookup (which only ever walks reachable chains). Both root-caused via targeted trace scripts tracking one specific key's entire history (not guessed at), each fixed with a one-line change (`addressSpace() / 2` → `addressSpace()`; a `delete buckets[id]` for discarded overflow pages) once correctly diagnosed. **Checked by:** 28 tests in `hashIndex.test.ts`, covering both strategies' own replay-correctness, a dedicated "never leaves a stale, unreachable duplicate" regression test (the exact shape of bug 2, so it can never silently return), extendible's own core invariant (every directory slot pointing at a bucket agrees with that bucket's low bits — the one thing that silently going out of sync would mean the whole scheme is broken), linear's own structural invariants (split pointer always inside its round; primary-bucket count always equals address space plus how far the pointer has swept it), the scatter demonstration itself, and two separate `fast-check` property tests (one per strategy, since their own invariants differ) over the whole legal parameter space. Mutation-checked three ways — the orphan-cleanup line removed (caught by 3 tests), the round-completion threshold reverted to `/2` (caught catastrophically, 10 of 28 tests, several as outright crashes), and extendible's own directory-doubling trigger condition broken (caught by 8 of 28 tests, each crashing with an invalid-array-length error from the resulting negative bit shift) — all three caught cleanly, none silent. Full gate (typecheck/lint/1945 unit tests/101 e2e/build/budget) all green; a new route, `/tools/hash-index` (115.5 kB measured + 3, self-contained — no shared engine-chunk impact, so no other route moved), registered in `App.tsx`, `ToolsIndexPage.tsx`, and the course map (`course-map.mdx`'s "Hash tables" row, Partly → Covered, since both static hashing (`/tools/hash-join`) and dynamic hashing (extendible/linear, this item) are now built). Live-verified in the browser: the directory's grouped-slot rendering (several slots correctly collapsing into one chip when they share a bucket), a real hit and a genuine miss through the "Look up a key" panel with the checked bucket highlighted green, switching schemes live-updating every stat (bucket count, global depth vs. level/split-pointer/max-chain-length) and the whole structural view beneath it, and the scatter panel showing 10 consecutive keys landing in 5 genuinely different buckets under both schemes — all exactly matching a probe script's numbers computed beforehand. No console errors. | 1 wk |
| **F3** | 2.4 | **`/tools/columnar`** | **Slice 1 — the standalone sandbox (layouts, compression, materialization) — built, 2026-10-02.** A new, wholly standalone `src/ui/columnar.ts` driver, the same family as `/tools/lsm`'s and `/tools/hash-index`'s — pure and total, computing every number for a synthetic table up front. **Three layouts**: NSM (row store, no column-skipping possible within a page), DSM (column store, each column its own separate region), PAX (the hybrid — column-major WITHIN a row group, but a group's own pages stay physically adjacent). Three honestly different metrics per layout, not one blended score: pages for a full scan, pages scanning just one column, and storage REGIONS a single row's reconstruction must visit (1 for NSM/PAX, one per column for DSM) — the number a raw page count alone cannot show, and the actual reason PAX exists rather than everyone just using DSM. **Four real compression schemes** (dictionary, RLE, delta, bit-packing), each sized by what it would ACTUALLY occupy — `bestEncodingFor` computes every scheme's real size on the real column and returns whichever is genuinely smallest, never guessed. The demo dataset is deliberately engineered, not arbitrary: an `id` column (sorted ascending) wins big with delta; a `status_grouped` column (real runs) wins with RLE; a `status_shuffled` column (the SAME values, no runs left) loses RLE badly, the direct, measured contrast; an `amount` column (near-full-int32 range) is the honest case where nothing compresses well. **Late vs. early materialization**, the one thing that actually earns a column store its keep: early materialization reconstructs whole rows first, throwing away any layout's own columnar advantage; late materialization filters on the WHERE column alone, then fetches the SELECT column only at the rows that matched — the gap between the two is measured by running the filter for real over the actual demo data, never assumed from a textbook selectivity. **Two real bugs caught during validation, before either number ever shipped:** (1) the PAX page-count model initially gave each column its OWN independently-rounded page per row group even when a group's total data fit comfortably in one shared page — inflating PAX's full-scan cost to 4× NSM/DSM's, the opposite of PAX's own selling point. Caught by eyeballing an implausible result (PAX should never cost MORE than NSM for a full scan) before trusting it; fixed by deriving the group size from the page size itself (`rowsPerGroup >= pageSize / 4`, guaranteeing one column's own minipage spans at least a full page — otherwise PAX degenerates to NSM's own locality with none of DSM's read savings, a real, non-obvious property of the scheme, not a demo convenience) and computing a group's full-scan cost from its own COMBINED bytes rather than summing each column's independently-rounded share. (2) the first `amount` column design used a value range narrow enough (0–100,000) that bit-packing compressed it to roughly half its raw size — contradicting the intended "nothing compresses this well" lesson; fixed by widening the range to span almost the full int32 range, where even bit-packing saves only ~3%. Also caught, separately, that the initial `status_grouped` block size made its own "RLE wins" claim true only at ONE specific row count (a narrow, unverified coincidence, not a real property) — fixed by deriving block count from a tuning probe that confirmed RLE wins robustly across the tool's whole row-count range, not just the row count a test happened to use. **Checked by:** 20 tests in `columnar.test.ts` — each demo column's own encoding sweet spot (and status_shuffled's own RLE failure, the direct contrast), exact formula checks (a constant column bit-packs to the true minimum; a column with real runs costs exactly `runs × (value + run-length)` under RLE), `bestEncodingFor` always returning the genuine minimum, layout structural invariants (NSM's single-column cost always equals its full-scan cost; DSM's per-column costs always sum exactly to its own full-scan total; DSM and PAX always read fewer pages than NSM for one column, at a group size that gives PAX room to skip), materialization invariants (late never exceeds early; a threshold below everything matches everything; filtering and projecting the same column never double-counts it), and two `fast-check` property tests over the whole legal parameter space (layouts; materialization). **Mutation-checked two ways:** the block-count fix reverted (caught by the dedicated status_grouped test); the PAX group-size fix reverted to a fixed small constant (caught by 2 tests, including the property test). Full gate (typecheck/lint/1965 unit tests/102 e2e/build/budget) all green; a new route, `/tools/columnar` (114.9 kB measured + 3, self-contained — no shared engine-chunk impact, so no other route moved), registered in `App.tsx`, `ToolsIndexPage.tsx`, and the course map (`course-map.mdx`'s "Storage models and compression" row, Not covered → Partly, with its own "Not covered" column now naming precisely what remains — the query engine itself still only stores rows; the "biggest holes" summary sentence corrected to stop calling column stores absent). Live-verified in the browser at the exact probed numbers: each column's compression bar and ratio; switching NSM → DSM → PAX live-updating every layout stat (NSM's single-column costs correctly tying its full-scan cost; PAX correctly matching DSM's per-column savings while matching NSM's single-region locality); the materialization panel's early/late byte counts. No console errors. **Deliberately deferred to a later slice, requiring its own scoping discussion first (a genuine engine-behavior fork, the same shape C5's own slices each needed):** a real `ColumnScan` operator wired into the actual query engine, and `projection pushdown` (declined at §22.9 for lack of anything to save) finally given something real to save. **Decided 2026-10-05: do not build the real ColumnScan operator.** The standalone `/tools/columnar` sandbox is the whole of F3. A column layout is not added to the engine, and projection pushdown stays declined (§22.9). | 2 wk |
| **F4** | 2.4 | **Vectorized vs. tuple-at-a-time** | **Built, 2026-10-04, as a `/compare` mode.** Count of `next()` calls per row vs. per batch on the existing operators | 1 wk |

**F4 — built, 2026-10-04.** A seventh `/compare` mode, "Tuple-at-a-time vs. batched". It runs one real query on the engine and reads the per-operator row counts from that run's own `execute` trace events. The tuple-at-a-time count is the engine's measured one: each operator makes one `next()` call per row it returns. The batched count is the same rows divided into batches of a chosen size, `ceil(rows / batch)` per operator. Nothing is re-executed and the rows out are identical either way. **Why this is a `/compare` mode and not a new engine:** the engine already emits one `execute` event per row each operator produces, so the vectorized side is pure arithmetic over measured data. No operator changed. **A trap found while building it, shared with EXPLAIN ANALYZE and reported separately:** several operators emit extra `execute` events with `rowsProduced: 0` (a residual check that failed, a hash-build announcement). Taking the last event per operator undercounts whenever one of those lands after the real count has grown. This page takes the running max instead. It is the same trap `explain.ts` falls into, confirmed live on an index scan whose last candidate failed its residual check: EXPLAIN ANALYZE reports 0 rows for it, where 2 were returned. That bug is flagged as its own task, not fixed here. **Honest limit of the checks:** neither preset exercises the trap, so the e2e tests do not guard the running-max choice; a non-unique indexed query where the last candidate fails its residual would. **Checked by:** one e2e test with probed exact numbers (a 3,000-row scan gives 592 tuple-at-a-time calls against 4 batched at batch 256, a 148.0× reduction; a join across tables of 10 and 120 rows gives 370 against 4, 92.5×; batch 1 gives exactly 1.0×). A mutation changing `ceil` to `floor` in the batched count was caught by that test. Full gate green; `/compare` at 173.2 kB, within its existing 175 kB ceiling, no bump needed. Live-verified in the browser at the probed numbers, no console errors. | 1 wk |
| **F5** | 2.4 | **`/tools/latch-crabbing`** | **Built, 2026-10-04 — the safe-node rule and scripted threads; optimistic lock coupling built 2026-10-14.** Safe-node rule; optionally optimistic lock coupling; scripted threads | 1 wk |

**F5 — built, 2026-10-04.** A standalone sandbox over the REAL engine B+Tree (the `/tools/btree` precedent). Its driver is `src/ui/latchCrabbing.ts`. The same scripted inserts run under two protocols. **Naive** takes an exclusive latch on every page on the root-to-leaf path and holds all of them until the leaf is written. **Crabbing** latches the child before releasing the parent, and releases the ancestors once the child is *safe*, meaning it has room for one more key so a split from below cannot reach it. Threads take turns, one latch action per tick, in a fixed order, so every run is reproducible. A thread that asks for a page another holds is counted as blocked for that tick. Paths come from the engine's own `descend`, and each run's final tree is checked by the engine's own `validate`. **Honest limits:** paths are those of one serial order of the same inserts, not a true concurrent interleaving; optimistic lock coupling was added afterwards, below. **Measured on the default workload** (fanout 4, three threads, two inserts each): naive finishes in 28 ticks with 30 blocked, crabbing in 24 with 20 blocked. The per-thread latch peak stays at 3 under both, because paths are short at this size. Crabbing's advantage shows up as blocked time. A second workload gives 2 against 3 per thread, shown in the unit tests. **Checked by:** seven tests — the naive-versus-crabbing blocking gap and per-thread peaks, single-thread zero blocking, a valid final tree holding every key, determinism, every acquired latch released, fanout clamping, and a `fast-check` property over legal workloads that never deadlocks and never has crabbing hold more per thread than naive. A mutation that stopped crabbing releasing ancestors was caught by the targeted test. **Weak spot named honestly:** the fuzz property's assertion (crabbing ≤ naive) still passes under that mutation, since a crabbing that degenerates to naive satisfies it. Full gate green, one e2e with the probed numbers (30/28 and 20/24), live-verified with no console errors. `/tools/latch-crabbing` sits at 163.5 kB against a 167 kB ceiling; it pays the engine chunk the same way `/tools/btree` does. | 1 wk |

**F5, optimistic lock coupling — built, 2026-10-14.** A third protocol in the same driver (`LatchProtocol` gains `optimistic`), run on the same scripted inserts, the same real tree and the same one-action-per-tick scheduler. A thread *reads* each page on the way down with no latch, remembering the page's version, and after each read checks that the page it came through is unchanged — lock coupling's hand-over-hand, with a version check where crabbing has a latch. It then latches only the pages it will change (the leaf, and the ancestors a split reaches, which are the pages crabbing is left holding when it writes), checks that each is as it read it, writes, and releases. A check that fails sends the insert back to the root: a **restart**, with its reason on the timeline — a parent changed under the descent, the page changed since it was read, or the page was held. An optimistic latch is a compare-and-swap on the version it read, so a held page restarts the insert rather than blocking it, and the insert's next read of that page waits for the holder, which is the spin. A write moves the versions of the pages it changed. Naive and crabbing are unchanged by all this (their numbers, in the lesson and the challenge, are held by tests that did not move). The tool shows three columns with an *inserts restarted* row, and a third timeline (`timeline` in the address). **Measured:** four threads of six inserts at fan-out 4, crabbing takes 82 ticks with 148 blocked and optimistic coupling 78 with 18 blocked and 8 restarts; at fan-out 6 it is 72 against 59, for 10 restarts. With two threads at fan-out 5 it loses, 15 against 19, because a restart is a whole descent. Across the tool's whole range at seed 1 (72 workloads) it is faster than crabbing in 26, ties in 9 and is slower in 37, so the page does not show an optimism that always pays, and the lesson says so. **Honest limits:** as before, an insert's path is that of one serial order, so a restart re-reads the same pages rather than finding a different leaf; a version moves only on the pages an insert changed, not on the siblings a split creates; and there is no backoff. **A first draft was too pessimistic, and the fix is the finding:** validating every page read at the moment of the latch made two inserts into *different* leaves restart whenever either split a shared parent; real optimistic coupling checks only the parent it came through, hand over hand, and the model now does. **Checked by:** sixteen driver tests (no latch taken on the way down; different leaves with room neither wait nor restart; two into one leaf restart once; a restart begins again at the root and re-reads what the first left; a held page is restarted at, and waited for at the read; the reasons, with a seed that has all three; naive and crabbing never read or restart; the crowded and quiet workloads' numbers) and the `fast-check` property, which now also has optimistic latch no more than crabbing per thread. Fifteen mutations of the scheduler were run; the one that survived (the parent check) was pinned by finding a workload where it matters — seed 7, not the default one — and the one that was shadowed (clearing what a thread had read) was dead code and is gone. The lesson gained two steps and the storage group a challenge, *Win despite the restarts*, whose six guards were mutation-checked. **Budget:** `/tools/latch-crabbing` 167.7 → 168.4 of 170, `/learn/:id` 186.6 → 187.1 of 190, `/challenges` 182.3 → 182.6 of 186; no ceiling moved.
| **F6** | 2.4 | **`/tools/vector-index`** | **Built, 2026-10-04. HNSW layers are drawn as plain bars, not with `flowinger`: flowinger is a separate project that QueryLens imports only once it is complete, and this slice does not depend on it.** Brute force vs. IVF vs. HNSW on 2-D points; recall vs. distance-computations. The syllabus now lists vector indexes with trees and hash tables | 1.5 wk |

**A connectivity defect, found and fixed 2026-10-05.** A property test (full-width HNSW search must reach recall 1 for every legal input) failed on 160 points with seed 1583: 28 points were unreachable from the entry point at layer 0, because pruning a neighbour's list dropped its link back to a later point. Layer 0 is now made undirected, and any component the entry cannot reach is joined to it by its nearest pair. The property holds across 3,000 random cases. The cost of this is visible on `/tools/vector-index`: at 200 points HNSW at beam 10 now costs 55.3 distances (was 53.0), and it is still cheaper than IVF's 69.3; at 400 points IVF is still cheaper, 99.3 against 116.6. The page copy stays true.

**F6 — built, 2026-10-04.** Standalone sandbox, driver `src/ui/vectorIndex.ts`. Brute force computes every distance and is the exact baseline. IVF clusters the points around centroids (k-means-style, seeded) and probes the nearest `nprobe` clusters. HNSW is a real layered proximity graph, built by insertion with random layers, greedy descent above layer 0 and a beam search on it. Every distance computation goes through a counter, so cost is measured, not estimated. **A real bug caught in validation.** The first HNSW linked each new point to its M nearest candidates. That wired each of the six clusters to itself and left layer 0 disconnected: only 56 of 200 points were reachable from the entry point. Fixed with the HNSW neighbour-selection heuristic (keep a candidate only if it is closer to the base point than to any neighbour already kept), so bridging edges survive. Layer 0 is now fully connected. **A plateau that turned out to be real search behaviour, not a metric artefact.** At 400 points HNSW recall stayed at 0.95 across beam widths 10 to 64. Checked for coordinate ties (none) and for a full-width beam (recovers it). Only one of 20 queries misses, and only a beam covering the whole graph reaches it, so its neighbours sit in a region the entry point is thinly bridged to. The sweep now runs to beam width N so the curve shows where full recall actually arrives. **The honest result does not favour HNSW at this scale.** At 200 points HNSW reaches full recall for 53 distances against IVF's 69 at four probes. At 400 points IVF reaches it for 99 against HNSW's 183. The copy on the page says this and does not claim a crossover. **Checked by:** 12 tests, including a connectivity regression that fails if the heuristic is reverted (a mutation to closest-M selection failed four tests), exhaustive-recall tests (IVF over all clusters and HNSW over the whole graph both give exactly 1.0), IVF cost monotone in probes, every point in exactly one cluster, HNSW recall non-decreasing in beam width, determinism, clamping, and a fast-check property. Full gate green (1984 unit tests, 105 e2e). The page is at 115.8 kB against 118 kB. Live-verified at the probed numbers. | 1.5 wk |
| **F7** | 2.4 | **Buffer-pool depth** | **Slices 1 and 2 built, 2026-10-04 and 2026-10-05: LRU-2 (LRU-K, K = 2), then 2Q.** **2Q** (Johnson and Shasha, 1994) is in the sandbox, the pipeline and `/compare` through the shared policy registry: a page read once waits in a small FIFO (a quarter of the frames), and a page is promoted only when it is read again after leaving that FIFO, which the ghost list remembers. **The limit, measured and pinned in a test:** 2Q follows the paper's correlated-reference rule, so a page read twice in a burst, while still in the FIFO, is not promoted. On the essay's scan trace 2Q misses the hot set's final re-read four times, the same as LRU, where LRU-2 misses none. **The midpoint observation, resolved 2026-10-05:** midpoint LRU showed 90 misses on a hot set between one-pass scans. That is the policy's own rule, not a fault: it protects a page only when the page is re-accessed while resident, and in that workload each hot page is reloaded and never re-accessed in time (on a re-read variant midpoint misses 44 against LRU's 52). Checking it found a real gap instead: midpoint had no cap on its young sublist, so on long traces re-used pages filled the pool and it degenerated to LRU. InnoDB caps the young sublist at five-eighths of the pool, and so does the policy now, with a test that fails without the cap. **Built since:** sequential prefetch and the scan-resistant ring buffer, both described below. **Checked by:** `src/engine/__tests__/twoQ.test.ts` (promotion after a ghost hit, the correlated-reference rule, a fitting working set, determinism); mutating the ghost promotion fails the promotion test. | 1 wk

**Sequential read-ahead, built 2026-10-05, per your decision.** A prefetched page is shown as `prefetch`, an I/O the query has not asked for yet, and a later request for it is a `hit`. The pool detects a sequential scan (a request for the page after the last one), and reads up to `readAhead` pages ahead of it that are not resident. Each prefetch counts as a disk read, so the scorecard's disk reads are misses plus prefetches. The sandbox has a Read-ahead control (off, 1, 2 or 4 pages; `ra` in the URL). `readAhead` defaults to 0, so every existing run is unchanged. **Exposed in `/compare`, 2026-10-10:** `/compare` policy comparison exposes the Read-ahead control (off, 1, 2, 4), allowing direct comparison of replacement policies under read-ahead pressure. **Checked by:** `src/engine/__tests__/readAhead.test.ts` (each page read from disk exactly once; a prefetched page is a hit when asked for; random access prefetches nothing; read-ahead stops at the last page), a mutation that disables read-ahead fails three of those tests, and `e2e/readAhead.spec.ts`. **Scan-resistant ring buffer, built 2026-10-10.** The design is PostgreSQL's `BufferAccessStrategy` for a bulk read, as an operator bracket: the executor's `SeqScan` begins a scan on its first `open()` and ends it on `close()`, and the pool hands back a ring that the scan passes to every `fetch`, so overlapping scans (a nested-loop join's outer and inner) each keep their own. `scanRing` is the ring's size and defaults to 0, so every existing run is unchanged. A scan of a table larger than a quarter of the pool (PostgreSQL's own threshold) takes frames the ordinary way for its first `scanRing` misses and then reuses its own oldest frame for every page after, evicting nothing else; the ring is kept across a nested-loop join's rescans, and a scan's read-ahead stays inside it. A ring eviction is flagged `ring` and is not a policy decision, so it neither asks the eviction question nor uses it up. **A bare reference string cannot say which accesses are a scan**, so the sandbox reads a range, `10-50`, as one marked scan and has a Scan ring control (off, 2, 3 or 4; `sr` in the URL). **What it measured, honestly.** In one query it changes little, because every run starts with an empty pool and a join's hot inner table is already protected by recency: on `comments` joined to `posts` at eight frames it takes FIFO from 45 disk reads to 33 and 2Q from 36 to 33, while LRU, clock, second-chance and LRU-2 are at 33 either way. A ring smaller than a re-scanned table is a real cost: a ring of 2 on the three-page inner table read every page from disk on every rescan (390 of 390 accesses), which is why the quarter-of-the-pool rule matters. The case it is for, a long scan arriving between two uses of a hot set, needs a hot set that a single statement with a fresh pool cannot build; in the sandbox, `0 1 2 3 4 10-50 0 1 2 3 4` at eight frames under LRU is 51 disk reads without a ring and 46 with one. **Checked by:** `src/engine/__tests__/ringBuffer.test.ts` (the hot set stays resident, the ring holds only its own size, its evictions are flagged and are the scan's own, a full pool loses at most the ring's size, a pinned frame or one given to another page is never reused, an ended ring is an ordinary fetch, read-ahead stays inside, one ring across a nested-loop join's rescans, the FIFO figure, no change when the option is off) and `e2e/scanRing.spec.ts`. Seven mutations (ring bypassed, pinned slot reused, foreign page reused, a ring eviction using up the question, a fresh ring per rescan, uncapped read-ahead, no size threshold) each fail a test; the fresh-ring one was first caught by nothing, a gap closed by the nested-loop test. **Not built:** a ring for `DELETE`/`UPDATE`'s own full scans, and a ring-size control for the Playground, the CLI or the MCP server (the option is in `EngineOptions`, so each is a flag away). **A read-ahead defect found 2026-10-10 is fixed 2026-10-10:** in a *query* (not a reference string) read-ahead had been bounded by the pool's whole page space, not by the scan's extent, so a scan's last heap page prefetched the pages numbered after it, which are index pages (`SELECT * FROM users` with `readAhead: 2` read 14 pages for a 12-page heap). `fetch` now takes the scan's extent, the first page that is not one of its pages; the executor's `SeqScan` passes the heap's last page plus one, a reference string still reads ahead through its whole page space, and a query's fetch that names no extent reads nothing ahead, so an index range scan whose heap pages merely come in order does not prefetch either. `SELECT * FROM users` at any `readAhead` now reads exactly its 12 heap pages. Three new tests and three mutations (extent ignored, off by one, no extent required) hold it.

**F7 — slice 1 (LRU-2), built 2026-10-04.** A new replacement policy, `lru-k`, in the engine's existing pluggable policy registry. It evicts by each page's second-most-recent reference, not its most recent one. A page touched only once has no second reference, so it goes first. A page touched twice survives a one-pass scan. The per-page history lives in an optional `history` field on `BufferState`, keyed by page rather than frame, because LRU-K has to remember a page's history across eviction and reload. Pools that never run LRU-2 carry nothing extra, and the default stays `lru`. **Measured, not asserted:** on a hot set of three pages referenced between long one-pass scans, with four frames, LRU and clock and FIFO all miss all 90 references, because the scan floods the cache before a hot page returns. LRU-2 misses 78, keeping the hot set resident for the twelve repeats that would otherwise miss. **Deferred, honestly:** 2Q needs a ghost list of recently evicted pages, which `BufferState` does not carry, so it is a larger change than this slice. The scan-resistant ring buffer needs a scan hint, which the reference string does not provide. Sequential prefetch changes the I/O counts of real queries, so it needs its own decision about defaults before it is built. **Open observation, not investigated here:** midpoint LRU showed 90 misses on the same workload where it might be expected to protect the hot set, which is worth a look on its own. Checked by: five unit tests, including a scan-resistance test and a determinism test; a mutation that reverted LRU-2 to plain recency was caught by two of them. One short e2e checks the option is selectable on the sandbox. The new policy appears in the buffer-pool sandbox and the `/compare` policy picker through the shared name list. Four routes just over their ceilings had them raised with a dated note, since the policy text lives in the engine chunk they already load. Live-verified: the option selects, its footnote renders, and the sandbox steps through with no console errors. | 1 wk |

#### G. The learning layer

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **G1** | 2.0 | **Course map + interview roadmap** | **Built, 2026-09-25.** Two docs pages under a new *Study* group (`/docs/study/course-map`, `/docs/study/interview-roadmap`; in the sidebar and the footer). **Course map:** 21 topics of a typical database course, each marked *Covered* / *Partly* / *Not covered* **in words, not just symbols**, with the pages that let you practise it and — as important — what is missing; brought up to date with v2 (relational algebra, SQL tier 2, composite/`UNIQUE`/bulk-loaded indexes, the fourth join, `EXPLAIN ANALYZE`) and honest about the rest (no MVCC, logging, recovery, LSM, columnar, filters, distribution; two-phase locking only as a standalone tool). **Non-affiliation is stated first and plainly**: the public schedule of a well-known course was read for lecture *titles* only; nothing is reproduced or endorsed. **Interview roadmap:** six weeks (pages and the buffer pool → indexes → joins, sorting, aggregation → the optimizer → transactions, flagged as mostly *not here* → put it together), each with *watch* (routes), *explain* (questions to answer out loud) and *check* (the challenges that only pass if the engine did what you said), and an explicit *what this will not prepare you for*. No company's questions are reproduced. A Playwright test visits every internal link on both pages (33 destinations) and fails on the app's 404; the two routes are in the cold-load list. Cost: the shared docs chunk grew ~7 kB gzip (`/docs` ceiling 141 → 149) | 3–4 days → **built** |
| **G2** | 2.5 | **Confidence ratings** | **Built, 2026-10-04, with one departure: the rating is optional.** "How sure?" chips (Guessing / Fairly sure / Certain) sit above each prediction's options and are recorded with the commit. `/progress` gets a Calibration section, per level, of how many rated predictions came true. Verified before building (RESEARCH.md §39.2): Butterfield & Metcalfe (2001) on hypercorrection, and Butler et al. (2011) on the effect's decay. **The departure:** answering without a rating still reveals and still counts toward the overall record; it only stays out of the calibration. Making the rating required would change every prediction flow and the e2e tests that answer predictions, so that is left for a deliberate change. **Checked by:** unit tests on the per-level split, on predictions with no rating, and on old and malformed records; a mutation that dropped the per-level tally was caught; an e2e from rating to calibration bar. The calibration bars from a few predictions are noise, and the page says so. | 2 days |
| **G3** | 2.5 | **Misconception-tagged challenges** | **Built, 2026-10-04 — six challenges; the "LRU is what real engines run" category is not built.** ~6 challenges from the SQL-misconception categories: an index that *hurts*, "LRU is what real engines run", `COUNT(*)` vs `COUNT(col)`, a function on the column defeating the index | 1 wk |

**G3 — built, 2026-10-04.** Six challenges, each with a `misconception` that is revealed only once the challenge is solved. They cover: a filter on the indexed column that the index cannot serve (`id <> 5`); an expression wrapped around the indexed column (`id + 0 = 5`); `= NULL` versus `IS NULL`; `COUNT(*)` versus `COUNT(col)` over a NULL; `NOT IN` against a list holding a NULL; and a WHERE clause on a LEFT JOIN's inner side. Each check reads the predicate from the parse tree, not just the row count, so a query that returns the right rows the wrong way does not pass. **Two categories changed from the plan's wording.** "An index that *hurts*" became "an index does not serve every filter on its column", because this planner declines a bad index rather than running one, so a hurting index cannot be shown honestly. "LRU is what real engines run" is not built: a RunResult check cannot show which page a policy evicted, and that category needs a different kind of check. **Checked by:** each starter must not pass and each known solution must pass, and six nearby cheats are rejected (for example `age <> 5` for the index challenge, and `id = 2` for `equals-null`). A mutation that dropped the IS NULL and column guards together was caught by the cheat test; dropping only one is covered by the other, which is why the mutation had to remove both. Full gate green, with three e2es added or updated (the solved counts now read 18). `/challenges/:id` is at 285.5 of its 286 kB ceiling, so the next challenge there will need a bump. | 1 wk |

**Lessons and challenges for the transaction and durability tools — built, 2026-10-13.** Seven lessons (`/learn/dirty-read`, `isolation-levels`, `snapshots`, `protocols`, `log-first`, `steal-and-force`, `recovery`) and thirteen challenges, each with a `misconception`, in a *Transactions and durability* group on both index pages. A lesson step's link is a scenario in `transactionScenarios.ts` — plain data, so `/learn/:id` carries no engine — and `transactionLessons.test.ts` runs every scenario on the real engine against the sentence its lesson says about it: the matrix has eighty cells and exactly one disagrees with the published runs; a deadlock's victim is the transaction whose first lock request is newest, and `BEGIN` does not count; three of the five protocols end A in the non-repeatable-read schedule, and all five leave a serializable result; four dead versions cost six pages where five would do. A challenge is a script, not a query: one step to a line in a text box — `A: UPDATE …` for a schedule, the log tool's own words for a write-ahead-log script — run on the engine and checked by a predicate over what it did (`scriptRunner.ts`; the list is `scriptChallenges.tsx`, with no engine import). **Found while building them:** a row-level lock demo has to run on the 20-row table — on 3 rows a statement scans and takes a shared lock on every row, so the usual two-session deadlock never forms; the deadlock victim is chosen by *first lock request*, not by who closed the circle, which a run where the older transaction closes it shows; a checkpoint alone does not move redo's starting point, the pages written before it do — which is what `start-redo-late` turns on; and a first draft of an `undo-a-steal` near-miss ("a change rolled back before the crash") was itself a valid solution, caught by running it. **Checked by:** each starter must run and not pass, each known solution must pass, and 23 near-misses are rejected. Thirteen mutations of the checks were run; three survived at first — two guards that another guard shadowed, pinned by adding the near-miss that needs each, and one that was redundant, which was removed. A mutation of the scenarios (a loser's record moved onto a written page, force turned off) fails two lesson tests. Full gate green; a seventeen-case e2e spec walks every lesson's links through to the tool, solves a schedule, a log and a protocol challenge, and runs axe over a solved result. **Budget:** the five routes that list lessons or challenges rose by five to seven kB (to measured + 3); the schedule runner, the protocol comparison and the log machine sit in a new lazy chunk (27.4 kB) that only a script challenge opens. **Not done:** the storage-engine and access-method sandboxes still have no lesson of their own, so the release-checklist item stays open; and the lesson list carries every lesson's prose into `/learn` and `/progress`, which a split of the list from its steps would take back.

**Lessons for the sort, the hash join, the join order and the storage structures — built, 2026-10-13.** Nine lessons: `/learn/external-sort`, `hash-join` and `join-order` join the pipeline group (a sort's cost is a number of passes; a hash join that spills costs three times one that fits; the same four tables cost 1,501,542 estimated pages in the order written and 290,252 in the cheapest), and a new *Storage engines and access methods* group holds `slotted-page`, `hash-index`, `lsm-tree`, `row-vs-column`, `latch-crabbing` and `vector-index`. A step's link is a scenario in `storageScenarios.ts` — plain data again — and `storageLessons.test.ts` runs every one on the tool's own driver against the figures its lesson quotes (thirty tests). **Found while building them:** a link whose setting is outside a tool's range does not open clamped but at the tool's *default* (`clampInt` falls back), and a probe at one bit per key had been silently clamped to the driver's minimum of two — so the first draft quoted two-bit numbers under a one-bit link; the test that holds every link's settings inside the tool's limits caught it. A wider tree does not make crabbing save more: it saved 27, 22 and 15 ticks at fan-out 3, 4 and 6 on the same workload, while the most latches one thread holds fell from 3 to 2 — the saving is in how long the root is held, and a shallower tree has less path to hold. IVF probing every cluster costs 420 distance computations against brute force's 400, the twenty centroid comparisons on top. Run-length encoding the shuffled status column would take 2,166 bytes, more than the 2,000 it started as. Two of seven linear-hashing overflows were followed by the split of a *different* bucket — the point of the scheme, which the default settings show. The latch-crabbing demo workload (`demoScripts`, `DEMO_INITIAL_KEYS`) moved from the page file into its driver so that a test can run what the page runs. **Checked by:** every link's settings are within its tool's limits; each scenario is run and its numbers asserted; four mutations of the scenarios (a buffer page more, a smaller bucket, a different fan-out) failed seven tests. Full gate green. **Budget:** `/learn`, `/learn/:id` and `/progress` rose again, by about six kB each, to measured + 3 — the second time, and the note in `bundle-budget.ts` says that splitting the lesson index from the lesson steps is the next thing to do, not another bump. **Not done:** challenges for these tools; lessons for the planner, parser, grammar, locks and buffer-pool sandboxes; so the release-checklist item stays open.

**The lesson index, apart from the lesson steps — built, 2026-10-13.** `src/pages/learn/lessonIndex.ts` is the track's manifest: each lesson's id, title, length and summary, and the three groups, in order, with no import of the engine, a lesson's JSX or a tool driver. `/learn` and `/progress` list from it; the three content modules (`lessons.tsx`, `storageLessons.tsx`, `transactionLessons.tsx`) now hold steps only, keyed by id, and `lessons.tsx` joins the two and refuses to load if the manifest names a lesson with no steps — so the title and summary are written in one place and cannot drift, and `lessonIndex.test.ts` holds the other direction (no steps without a lesson). **Checked by:** a throwaway test rendered every lesson — title, length, summary, and each step's heading, body, try-this, link and computed Playground link — before and after, and the two dumps were byte-identical (25 lessons, 78 steps). **Measured:** `/learn` 181.9 → 115.9 kB gzip, `/progress` 183.9 → 118.3, both ceilings lowered to measured + 3 (119 and 122). Three quarters of `/progress`'s drop (50 of 66 kB) was not the manifest: it took `STAGES`, a constant, from the engine barrel, which brought `runQuery` and its 50 kB with it, and now takes it from `engine/types.ts`. **Not done:** `/learn/:id` is unchanged at 182.4 kB — a lesson page needs the steps, and loading them by group (with `stepLink` out of `lessons.tsx` and loaded only for a step that opens the Playground) would take the engine and two thirds of the prose off a storage or transactions lesson; it needs an async lesson page and a loader per group, and is a separate piece.

**Challenges for the storage and execution tools — built, 2026-10-13.** Ten challenges in a *Storage and execution* group on `/challenges`: sort in a single merge pass; give a hash join more memory and make it slower; pick the join order; find the smallest page that holds the rows; split a bucket that did not overflow; cheap writes and cheap reads; write less than you were asked to (write amplification below 1); make the column store pay off; make crabbing save a fifth of the time; beat brute force four to one. The player sets the same few numbers the tool takes, in a form (`SettingsChallengeView`), and the check is a predicate over what the tool's own driver makes of them (`settingsRunner.ts`). The list (`settingsChallenges.tsx`) imports no driver; the view and the runner are an 18 kB opt-in chunk. The query, script and settings views now share `ChallengeFrame.tsx`: the header and hint, the verdict, the facts and tables, and the box that says what the challenge was for. **Found while building them:** `more-memory-more-io` is real, not a rounding bug — partitioning reads and writes every page whatever the number of partitions, one more buffer page is one more partition, and each partition is read back in whole pages: 12 build keys, 20 probe keys, two to a page, cost 48 page I/Os at 3 buffer pages and 50 at 4, while at 5 the extra page takes 50 down to 16 (which is why the starter is not a solution). The axe pass over a *solved* result found what no earlier test had looked at: the "Solved" banner's green text on its tint measured 4.28:1 in the light theme, short of 4.5, and it was the same class on the query, script and settings challenge pages — now `text-ink` on the green border and tint. Four orders of the four tables are within 5% of the cheapest (290,252 to 301,250 estimated pages) and every one ends on `projects`, which the written order joins second. Below 8 pages a column layout has nothing to save, and a one-column scan reads a page or two in every layout. On 100 points no IVF probe count or HNSW beam reaches 95% recall at a quarter of brute force's work, for k of 10 or 20, while at 400 points two of twenty clusters do it at 63 computations and 98%. **Checked by:** each starter runs and does not pass; each control spans exactly its tool's own range (a value outside it opens the tool at its default, not at the nearest edge); 20 known solutions pass and 35 near-misses are rejected; and the numbers a player reads are held against the tool's own plan — the vector averages against `planVectorIndex`'s curve to the digit. Twenty mutations of the checks were run and three survived at first — a minimum-length guard, a below-two bound and a table-size guard, each shadowed by another condition — and each was pinned by adding the near-miss that needs it. **Budget:** `/challenges` 176 → 181 and `/challenges/:id` 296 → 301 (measured + 3). A driver that a tool's page and the lazy runner both import became a chunk of its own, which put `/tools/hash-index` 0.5 kB up and the entry chunk's dependency map 0.1 kB, tipping `/docs` and the three essays that sat within 0.1 kB of their ceiling (170 → 174). **Not done:** the planner, parser, grammar, locks and buffer-pool sandboxes have no lesson or challenge of their own, so the release-checklist item stays open.

**Lessons and challenges for the remaining tools — built, 2026-10-13.** Five lessons (`sandboxLessons.tsx`): the buffer pool (a loop one page too big, the optimal bound, more frames and more misses, a scan against the hot set), the parser (tokens, `AND` before `OR`, an error with a place), the grammar diagram (the order, precedence as layers of rules, what the diagram does not say), the planner's rewrite rules (two make one lookup, a rule needs its neighbour, no index to invent) and the lock table (readers share, a writer waits and is promoted, a circle of waits, one page). Ten challenges: two lock scripts (`one-page-deadlock`, `same-order-no-deadlock`), a fourth kind of script challenge; six settings challenges — a bigger pool with more misses, a clock that is not LRU, a scan that leaves the hot set alone, the lookup with two rules, a tree's third level, one level with two promises — which needed two new controls (a text box for a reference string, check boxes for the rules) and a `group` on each; and two query challenges (where the `AND` lands, six clauses in one `SELECT`), which gained an optional link to the Parser or the Grammar on the query that was written. The index groups challenges by subject (`challenges/groups.ts`), so "n of m" and "next" count the list the index shows. **The lock sandbox's script is now in the address** (`ui/lockScript.ts`, `?s=`): what was done is a list of steps folded over an empty lock table, so a reload replays it and a lesson can open the sandbox on the situation it is about; the codec is total and bounded (40 steps, four pages, two transactions). **Found while building them:** a deadlock needs a circle, not two resources — two readers who both ask to upgrade one page deadlock on it, and the victim is the transaction whose first lock request is newest, not the one that happens to be waiting. FIFO and second-chance show Bélády's anomaly on the classic string (`1 2 3 4 1 2 5 1 2 3 4 5`: 9 misses at three frames, 10 at four) and LRU never does (10, then 8). Clock is not LRU on `0 1 2 0 3 0 4 2 3 0 3 2` at three frames: victims `1, 2, 3, 0, 4` against `1, 2, 0, 4`, 8 misses against 7. With six frames a 21-page scan between two readings of a hot set of four costs LRU the hot set (12 hits in 41); a scan ring of two keeps it (16 hits, as LRU-2 does; midpoint 15, 2Q 12), and a ring of three, which takes frames from the hot set too, does not. For `WHERE id = 5 AND age > 30` the only pair of the seven rewrite rules that gives an `IndexScan` is predicate pushdown with index selection — index selection alone fires nothing, because the filter has not been folded into the scan. At REPEATABLE READ the two isolation engines disagree on exactly PMP and G2-item. Sorted inserts reach a third level at 10, 17, 21 and 31 keys for fan-outs 3 to 6. Of the eight optional parts of a `SELECT` at most six run together — `DISTINCT`, `WHERE`, `GROUP BY`, `HAVING`, `LIMIT` and `OFFSET` — because `ORDER BY` with `GROUP BY`, and either with a `JOIN`, is refused, and `OFFSET` needs a `LIMIT`. A reference string with a token that is not a number loses that token and runs (`0 1 x` is `0 1`), so what that challenge refuses is an empty string, not a bad one. **Checked by:** each starter runs and does not pass; each solution passes and each near-miss is rejected; every number a lesson quotes is run on the tool's own engine; every link's settings sit within the tool's own limits (an out-of-range value opens the tool at its default); and a test reads the tools index and fails for any tool that no lesson step and no challenge opens (`pages/__tests__/toolCoverage.test.ts`). Ten mutations of the lock-script checks and fourteen of the two query checks were run, and the survivors were pinned by near-misses — releases counted as requests, the page-0 and page-1 guards, and a deadlock guard that the abort guard shadowed (which is removed); the `!r.error` guards that remain are the file's convention. **Budget:** `/learn/:id` 185 → 190, `/challenges` 181 → 186, `/challenges/:id` 301 → 306, `/tools/locks` 117 → 121 and the settings view's opt-in chunk 21 → 36 (each measured + 3): the buffer-pool trace, the planner's rules and both isolation engines are in that chunk and in no index route. **Not done:** the settings runner's handlers are one chunk, so a sort challenge fetches the isolation engines; splitting them by tool is the next thing to do if the chunk needs to shrink.

**The settings runner, split by tool — built, 2026-10-13.** `settingsRunner.ts` imported every tool's driver, so any settings challenge fetched all of them: a sort challenge carried the isolation engines (32.3 kB gzip). It is now the form's reading (`readValues`) and a loader, with one module per tool in `challenges/settings/` — `sort`, `hash-join`, `join-order`, `page`, `hash-index`, `lsm`, `columnar`, `latch-crabbing`, `vector-index`, `buffer-pool`, `planner`, `btree`, `isolation` — each importing only that tool's driver. A challenge loads its own tool's module when its view mounts, so the first Run does not wait for it, and `runSettings` is asynchronous; the loader table is typed over the tool list, so a tool without a module is a type error. The view's opt-in chunk is 4.6 kB (ceiling 36 → 8) and a tool's own is 0.8 kB (planner, join order) to 12.4 (isolation), each with an opt-in row in the budget of its own (`after` in `OPT_IN` may now name the page and the view). **Checked by:** the settings tests, run through the loaded modules; a test that each tool's module holds exactly the challenges that name it; that the lazy path answers as the loaded one does for every challenge; that a tool that will not load is said in words and is asked again; and an end-to-end test that a sort challenge requests no isolation chunk and the isolation challenge does. **Cost:** thirteen chunks compress separately (all chunks 603.0 → 607.0 kB), and each row counts the shared chunks its tool needs, so the rows overlap rather than sum.
| **G4** | 2.5 | **Generated, graded questions + spaced review** | Seeded generators with engine-computed answers (next clock-sweep victim, split point, chosen index, visible tuple), a Leitner scheduler in `localStorage`. **After §9**, disjoint from `STUDY.md`'s bank; built as an experiment with its own measurement. **Built, 2026-10-10, after the §9 pilot.** `/practice`. `ui/quiz/generators.ts` makes a question from a skill and a seed, and **its answer is computed by the engine the question is about**: *clock sweep* runs the real buffer trace and names the frame the hand evicts (the prompt states the usage-count rule, since the answer depends on it); *B+Tree split* inserts into a real tree and reads the new right leaf's first key; *access path* asks the real planner (cost-based, so `id > 40` is a sequential scan and `id = 5` an index lookup); *visibility* applies the real visibility rule, balanced between yes and no over seeds; *redo* and *losers* run a random write-ahead-log script through crash and recovery and read the report. Six skills, as many questions as there are seeds, each with an explanation in the engine's own terms and a link to the page where it can be watched. `ui/quiz/leitner.ts` is a five-box scheduler (a right answer moves a skill up a box and out for 0, 1, 3, 7 or 14 days; a wrong one sends it to box 1, due at once) whose unit is the *skill*, not the question, so every return is a fresh instance and the box measures whether the idea is stable; it is kept in `localStorage` and degrades to starting over. **The experiment's own measurement** is on the page and from the visitor's answers alone: right on the first ask of each skill against right on every later ask, over up to 300 answers; the page says it does not know whether spacing helps. **Disjoint from the instrument:** a test fails if any generated prompt reproduces the study's pool (`7, 2, 9, 3`), leaf (`[10, 20, 30]`, key 25) or table. **Held in tests:** determinism by seed, distinct options with the answer among them and not always in one place, the clock answer re-derived from an independent run of the buffer trace, the split separator read back from the explanation's own halves, the planner choosing more than one kind of scan over seeds, balance of the visibility answers, recovery scripts that really run, and the Leitner rules (promotion, demotion, due order, practice-anyway, the first-ask curve, tolerance of a corrupt store). **Not built:** the study's own questions are not here and never will be; no telemetry (the numbers never leave the browser); the Playground's own prediction cards are separate and unchanged. | 1.5 wk |
| **G5** | 2.5 | **Detail levels** | Novice / standard / expert narration and panel set. Needs event-label variants — **do together with H5** | 1 wk |
| **G6** | 2.5 | **Trace diff** | **Built, 2026-10-04.** "What changed since my last run", reusing `/compare`'s scoring | 3 days |

**G6 — built, 2026-10-04.** The Playground shows a *Since your last run* note whenever a query is run again. It lists each measured number that moved, as before → after, and says whether the optimizer's plan changed shape. The numbers come from the same `scoreOf` that `/compare` uses, now in a shared module `src/ui/scorecard.ts` rather than copied. The plan is compared by its operator sequence, so an index or join choice that changes shows up even when the counts stay the same. Last-run summaries live in `localStorage` per viewer, keyed by SQL text and capped at twenty queries. Every read and write tolerates storage being unavailable, corrupt or full. Data edits and resets go through the same run path, so a write between two SELECTs shows up as the rows it added. **Honest scope:** the comparison is by the same SQL text only, so a changed query starts fresh rather than being matched to its predecessor. Per-viewer state is not shared between devices. **Checked by:** 12 unit tests covering the diff, the plan signature, round-trips, corrupt and unavailable storage, the twenty-query cap, and recency ordering, including a real INSERT between two SELECTs. A mutation that ignored plan changes was caught by the plan test. One e2e walks a query through its first run, an identical re-run, an INSERT, and a re-run that reports 48 → 49 rows. Full gate green. `/playground` is at 313.8 of 315 kB, so no ceiling change was needed. Live-verified in the browser: an identical re-run shows the unchanged note, with no console errors. | 3 days |

#### H. Reach & platform

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **H1** | 2.5 | **PWA / offline** | **Built, 2026-10-04 — verified locally; the preview-deploy check is still open (§25.5 rule 4).** `public/sw.js` is hand-written, with no library. The build (`querylens-service-worker` in `vite.config.ts`) fills in the cache stamp and the list of every file it emitted: 86 files, 1.69 MiB unpacked, about 670 KiB over the wire. The worker installs that list into a cache named for the build and answers same-origin GETs from it. A navigation gets the cached shell, so any route works offline, and the stamp in the cache name means every build installs a worker whose bytes differ. It does not `skipWaiting`: a new version takes over only once no open tab is still running the old one, and an open tab keeps its own cache. `public/manifest.webmanifest` names 192 and 512 PNG icons, generated by `scripts/build-icons.py`. The CSP gains `manifest-src 'self'`, which is the directive that matters: without it the browser refuses the manifest. `worker-src 'self'` is also added as the plan asked, but `script-src 'self'` already admits the worker, so it is redundant. The worker registers in production builds only. **Checked by:** `e2e/offline.spec.ts`. A loaded page is controlled by the worker and the manifest names both icons. Under the production CSP read from `_headers`, Chromium returns the manifest through `Page.getAppManifest` and reports no violation. With the network off, a visited route and a lazy route never opened this session both load. Mutations: dropping `manifest-src` fails the CSP test; removing the navigation fallback fails the offline test; dropping lazy chunks from the precache fails it too. `/learn/:id` went from 167 to 168 kB, dated in `scripts/bundle-budget.ts`, because the registration grew the entry chunk. **Not verified:** `pnpm preview` does not apply `_headers`, so the policy is applied from the file inside the test. The real check is a Cloudflare preview deploy. That touches shared infrastructure, so it is for the maintainer to run. | 2–3 days |
| **H2** | 2.5 | **Embeds + essays** | **Built in part, 2026-10-04: the essays. In-page embeds are not built, by decision.** Cloudflare joins matching `_headers` rules, so a `/embed/*` block cannot override the global `frame-ancestors 'none'`. Relaxing it needs Worker code (the project has none) or a second host. You chose no in-page framing for now, so the URL stays the embed (§20). The `/embed` routes and the step-control `postMessage` API are not built; they wait for a named embedder. **Essays:** `/docs/essays/index-write-tax` (B+Tree writes: 1.88 and 1.92 pages per insert at fan-out 4, from the engine's own node diff) and `/docs/essays/scan-resistance` (LRU against LRU-2 on one trace: 48 and 44 misses, and 4 and 0 on the final re-read). **Interactivity is by link, not embedded widgets.** Embedding a shared demo pulled the docs chunk into the entry bundle and cost every route about 50 kB (dated in `scripts/bundle-budget.ts`). **The isolation-anomalies essay, built 2026-10-10 now that D5 exists:** `/docs/essays/repeatable-read`, *REPEATABLE READ means two different things*. Its claim is the one the matrix computes: at `REPEATABLE READ` the locking engine lets phantoms through and not write skew, and the snapshot engine the reverse; both prevent lost update and read skew, both allow the anti-dependency cycle, and at `SERIALIZABLE` neither lets any of the ten through. Each table cell links to the run behind it in `/tools/isolation`; the write-skew schedule is linked under row locks (a deadlock, one session rolled back, the table ends 0 and 100), under snapshots at `REPEATABLE READ` (both commit, 0 and 0) and under serializable snapshots (the second commit refused, 0 and 100); the phantom schedule under locks and under snapshots. `essays.test.ts` holds each of those claims against the engine. It names what it does not show: two small engines are not two products (PostgreSQL's level is snapshot isolation, SQL Server's is locking, InnoDB's a hybrid neither models), the snapshot engine's `SERIALIZABLE` is not PostgreSQL's, and ten anomalies are a sample of Hermitage's. The index-write-tax essay's two out-of-date model-limit bullets (that there was no log and no locking) now point at `/tools/wal` and the schedule tool. **Checked by:** `e2e/essays.spec.ts` (each link opens the same trace under its policy), the cold-load route list in `regressions.spec.ts`, and a regenerated `llms.txt`. **Decided 2026-10-05: no in-page framing.** `frame-ancestors 'none'` stays everywhere, so no `/embed` route and no `postMessage` API are planned. The URL is the embed (§20). Revisit only when a named embedder asks. | 1 wk |
| **H3** | 2.0 | **Publish the CLI and `@querylens/engine` 0.x** | `dist` build, `files` allow-list, npm provenance from a tag-triggered OIDC workflow, a stability disclaimer. The "second consumer" trigger (§22.8) is met — the site and the CLI already are two. **Scope decided, 2026-09-24:** `@querylens/engine` and `@querylens/mcp` under an npm organisation named `querylens`; the CLI unscoped as `querylens` (free, so `npx querylens` works — claim it early, since an unclaimed name can be taken). **Needs you:** create the organisation (free for public packages; I cannot create accounts) and enable trusted publishing (OIDC) for this repository; then I wire the tag-triggered workflow. *Caveat:* "unclaimed" comes from a package search, and a scope can be held by an account with no packages — if creating `querylens` says it is taken, fall back to `@query-lens` **Code side built, 2026-10-05; publishing is not done.** Three packages, each built into its own `dist`, each with a `files` allow-list, a README with a stability statement, and `publishConfig` for public access with provenance: `packages/engine` (`@querylens/engine`), `packages/cli` (`querylens`, the terminal trace, which bundles its own copy of the engine so `npx querylens` needs nothing else), and `packages/mcp` (`@querylens/mcp`, the MCP server, which declares its two runtime dependencies). `pnpm build:packages` builds all three, rewrites the declaration files' import specifiers so NodeNext consumers resolve them, and refuses to finish if a test or a `.ts` specifier got in. Verified by installing each packed tarball: the engine typechecks in a strict NodeNext project and runs; the CLI runs through the installed bin symlink; the MCP server answers `initialize` and `tools/list` over stdio. The publish workflow `.github/workflows/publish-packages.yml` runs on `engine-v*`, `cli-v*` and `mcp-v*` tags: it checks the tag against the package version, runs the gate, builds, smoke-tests the built package, and publishes with OIDC and provenance. No npm token is stored. **A bug found and fixed on the way:** the CLI and the MCP server decided they were the entry point by comparing `process.argv[1]` with their own path. npm runs a bin through a symlink, so that comparison failed and an installed CLI printed nothing; verified before the fix, and the check now resolves the symlink. Names checked on 2026-10-05: `querylens`, `@querylens/engine` and `@querylens/mcp` all return 404, so none is published. An unpublished name can still be held by an organisation with no packages, which only a logged-in check can rule out. **Needs you, free:** create the npm organisation `querylens` (free for public packages), and configure trusted publishing for each package with this repository and `publish-packages.yml`. Check npm's current trusted-publishing documentation first: it may require one initial publish from your machine before a brand-new package accepts a trusted publisher. Then push a tag. | 3–4 days
| **H4** | 2.0 | **`@querylens/mcp` + `llms.txt`** | **Built, 2026-09-28** (npm publishing still needs H3's organisation). `mcp/server.ts`: three tools over the real `runQuery` — `run_query` (rows, disk reads/hits/evictions, and the full step-by-step narration, JSON), `explain_trace` (PostgreSQL-shaped plan text, `EXPLAIN` or `EXPLAIN ANALYZE`), `compare_policies` (the same query under LRU and clock, side by side) — each grounded in an actual engine run, not a prompt an assistant could hallucinate past, over three preset datasets (`users`/`orders`/`logins`, columns read live so a tool's own description can never drift from the data). Runs locally over stdio (`pnpm mcp`); no hosted service (RESEARCH.md §44 — a toy in-memory engine with no auth is not a thing to expose to the internet). Tested over the SDK's own in-memory transport pair — a real client, a real server, real JSON-RPC, no mocks — covering all three tools, an error surfaced as data rather than a thrown failure, every dataset, and both `EXPLAIN`/`EXPLAIN ANALYZE`; a separate spawn-and-handshake check confirms the stdio entry point itself starts and answers `initialize` for real. `public/llms.txt`: a machine-readable docs index in the https://llmstxt.org shape, generated (`pnpm llms-txt`) from `src/docsNav.ts` and every page's own frontmatter `title`/`description` — never hand-duplicated, so it cannot drift the way a hand-written summary would — and `build-llms-txt.test.ts` fails the build if the committed file disagrees with what regenerating it produces right now, the same "regenerate or the build catches it" discipline `public/og.png` (§19.3) already has. Seams: `@modelcontextprotocol/sdk` + `zod` added as dependencies; `tsconfig.node.json`/`vite.config.ts`'s test `include` gained an `mcp/**` entry, parallel to `bin/`/`scripts/`/`oracle/`. Not yet published — `bin/querylens.ts` (the CLI) is in exactly the same state, working and unpublished, since before this item | 3 days |
| **H5** | 2.5 | **i18n (conditional)** | Engine events carry `{key, params}` beside the English `label`; a catalogue; one locale **only with a named maintainer** (§22.6's standing rule) | 2–3 wk + per locale |
| **H6** | 2.5 | **Accessibility depth** | **Built in part, 2026-10-04: arrow-key navigation among tree diagrams.** The parse tree, query plan and B+Tree are each a `tree` whose nodes are `treeitem`s, announcing level and place among siblings. Tab enters a tree at one tab stop. Arrow keys move up to the parent, down to the first child, and left and right through siblings, and the viewport follows focus. Arrows follow the hierarchy only, so a B+Tree's leaf sibling chain is not walked. **Data-table views, 2026-10-05:** a `Show as table` toggle (`src/ui/DataView.tsx`) puts the same numbers in a real table on the hash index (directory and buckets), LSM (every SSTable), join order (every subset), and columnar (per-column encoding and sizes). The latch-crabbing, vector-index and compare pages already had tables; the trace-diff note is text. **Automated audit, 2026-10-05:** `e2e/audit.spec.ts` scans 50 routes with axe-core against WCAG 2.2 A and AA; it found no violations. A probe that injects a missing image alt confirmed the scanner does report violations. **Corrected, 2026-10-14:** the scan waited for `#root > *`, which the lazy route's shell satisfies before the page's own content renders, so for some routes it was scanning a loading screen — 'no violations' was true of the wrong thing, and it flaked on the runs where the page was quick. It now waits for the network to settle and the first heading, and runs each route in the light and dark palettes at 1280 and 360 px (268 scans), and `e2e/auditStates.spec.ts` presses Run, shows each table toggle and chooses each radio and tab on thirty-four pages, scanning after each (68 more). Done properly it found ten real failures, all fixed: unfocusable scrolling tables and code blocks (`ScrollRegion`; docs `<pre>`s get a tab stop from a rehype plugin; short code wraps), an unnamed `<select>` on `/tools/columnar`, `rules:` at 2.9:1 on `/tools/planner`, and 13 px check boxes. Removing the tab stops fails ten of the scans, so the audit has teeth. axe's *incomplete* results (contrast over a pseudo-element, a lone symbol) are not asserted. **Page titles, 2026-10-15:** every route kept `index.html`'s `<title>` (WCAG 2.4.2, which axe cannot see because a title exists); each page now names itself and its section (`src/ui/documentTitle.ts`, set by `PageHeader` from its heading, by `DocsLayout` from the sidebar label), and `e2e/titles.spec.ts` fails on a default or repeated title over the same route list the audit scans (`e2e/support/routes.ts`). **Statement, 2026-10-05:** `/docs/accessibility` says what is checked, how, and what is not. It is deliberately not a conformance claim. **Data-table views for the transaction and durability tools, 2026-10-12:** the same toggle on `/tools/schedule` (the lanes become one row per record the run made: step, session, statement, what happened, result, anomalies flagged), `/tools/isolation` (the two matrices become the eighty cells as rows, with the published result and whether it agrees beside each, and the run behind a chosen cell as rows), `/tools/concurrency` (the run under the chosen protocol), `/tools/wal` and `/tools/recovery` (a step's effects as kind, page, LSN and detail, and a recovery's three passes as one table in the order they ran) and the Playground's Durability dialog (which shares those components). The row builders are pure (`ui/transactionTables.ts`, `ui/isolationTable.ts`, `ui/walTables.ts`) and tested for counts and content. **`DataTable`'s scroll region was not keyboard-reachable** when a table was wider than its panel; it is now a labelled, focusable region. **Still open:** the manual NVDA, VoiceOver and TalkBack pass, which needs someone who uses those tools, and the keyboard walk-through of the rest of the app; a conformance claim can only follow those. **Checked by:** unit tests on the relations and the key mapping (mutating the ArrowRight mapping fails two of them), and `e2e/treeKeyboard.spec.ts` and `e2e/dataViews.spec.ts`: one tab stop, the arrows walk the tree, and an axe scan limited to the tree with the WCAG 2.2 AA tags finds nothing. `/playground` is at 315.0 of 315 kB, so it has no headroom left. | 1 wk + ongoing |
| **H7** | 2.5 | **Workspaces** | **Built in part, 2026-10-04: named workspaces, export and import.** A workspace is a snapshot of a custom database, kept in IndexedDB (chosen over OPFS: structured storage with no worker, and the file export covers portability). The Custom-mode **Workspaces** dialog saves, opens, deletes, downloads as `*.querylens.json`, and opens a file. Every read goes through the same validator as the working copy, so a snapshot or a file that does not check out is refused whole. The dialog is a lazy chunk, so it costs the Playground nothing until it is opened. **Saved queries, 2026-10-05:** the same Workspaces dialog keeps named queries in a second IndexedDB store (the schema moved to version 2, so existing libraries upgrade in place). A query loads back into the editor and is not run until Run is pressed. Queries are kept per browser, and are reachable from Custom mode only, for now. **The live autosave moved to IndexedDB, 2026-10-05.** The working copy is one record in the same database as the library (`src/ui/idb.ts`, schema v3, one cached connection). The Playground loads it asynchronously when Custom is chosen, and a load that finishes after the user has moved to another dataset is dropped. A copy still in the old `localStorage` key is moved across the first time it loads, and the old key is removed only after the write succeeds. **Checked by:** `e2e/workingCopy.spec.ts` (an edit persists through a reload, read from the IndexedDB record directly; the old key migrates and is removed), and a mutation that disables the autosave fails the persistence test. The earlier feature tests seed the old key, so they exercise the migration too. **Still open:** nothing in H7's current scope. **Checked by:** e2e on saved queries (save, reload, load into the editor without running), and unit tests on the name rules and the file format (a mutated validator fails the whole-file refusal test), and `e2e/workspaces.spec.ts` on real IndexedDB and real downloads: save, reload, open, delete, download, import, and a refused file. | 4–5 days
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
- [x] The study kit is live *(built 2026-09-24; automated tests pass on desktop and a phone-width run was checked by hand)* and at least one **real participant** has completed it end to end on a phone *and* a laptop. *(Pilot completed 2026-10-10: P01 on laptop, P03 on mobile, collated into `scoring/`. That folder, `key.csv` and `codes.txt` are kept local, not committed: they hold the arm assignments and the links, which `STUDY.md` §4 keeps private. The devices are not in the recorded results — the opt-in timing that would record them was off.)*
- [x] A homework-shaped query using `OR`, `IN`, `LIKE`, `DISTINCT`, `HAVING` and a **non-unique** indexed column runs and narrates end to end; `sql.mdx`, `limits.mdx` and `/tools/grammar` all agree. *(Held by `homework.test.ts` against a plain computation of the same rows; the grammar page's own test checks it against the parser.)*
- [x] `limits.mdx` no longer says "unique key" or that a join never uses an index. *(Rewritten 2026-10-10; the only "unique key" left is the optimistic-validation rule that refuses a key another transaction took.)*
- [ ] Name decided and recorded *(done: keep, with descriptor)*; custom domain live; the launch post published; CLI, engine and MCP on npm. *(2.0.0-rc.1 was cut 2026-10-15 with this item open — the owner's decision — and rc.2 and rc.3 (2026-10-18) followed; 2.0.0 waits on it.)* *(Checked 2026-10-14. Done: the name, with its descriptor. Open, and yours: the domain (`querylens.org` is recommended and unbought), the launch post, and the npm organisation `querylens` with trusted publishing enabled. The CLI, `@querylens/engine` and `@querylens/mcp` build, pack, install and run from tarballs, and the tag-triggered workflow is written; publishing waits for the organisation.)*
- [x] Per-route budgets replace the single sum. *(H8, built 2026-09-25; every route and tool has a row in `scripts/bundle-budget.ts`.)*

**2.1 — The optimizer, honestly**
- [x] `ANALYZE` statistics are inspectable; at least one dataset shows a q-error ≥ 10×. *(C1 built 2026-09-29: `ANALYZE table`, `pg_stats`-shaped per-column stats, read by the cost model. C2 built 2026-09-29: the `employees` dataset's correlated `department`/`office` measures 11.0×, shown under `EXPLAIN ANALYZE`.)*
- [x] A three-table query is ordered by DP with the lattice visible; "Why not?" shows the runner-up. *(C4 and C5: `/tools/join-order` and the planner's *Why not?* note.)*
- [x] `limits.mdx`'s "cost never decides" is replaced by the true statement. *(The *What cost decides* section.)*

**2.2 — Transactions**
- [x] Two sessions interleave from a URL; a deadlock resolves live *in the engine*. *(Re-worded 2026-10-14, on the user's decision, from "…in the Playground…", which was written before `/tools/schedule` existed: that tool takes the interleaving from its address and resolves a deadlock in the engine's own lock table,. The Playground itself still runs one session, and does not host the lanes.)*
- [x] The isolation matrix's PostgreSQL and InnoDB columns match Hermitage's documented outcomes **in tests**; write skew reproduces under SI and is prevented under SER. *(Met for PostgreSQL's and SQL Server's published results, 79 of 80 cells with the one difference declared, and for MySQL's InnoDB — a third column, as of 2026-10-14 — whose page published 19 of the 40 cells: all 19 agree but one, OTV at READ UNCOMMITTED, declared; the other 21 are computed and carry no claim. The write-predicate variants of PMP and G-single, which that page also runs, are not run. Write skew reproduces under snapshots and under InnoDB's REPEATABLE READ and is prevented under SERIALIZABLE on all three.)*

**2.3 — Durability**
- [x] Crash → recover restores exactly the committed state; all four steal / force combinations are demonstrated; analysis, redo and undo are each a stage in the trace. *(The first two are met and held by properties, at `/tools/recovery` and in the Playground's Durability dialog. As of 2026-10-14 the third is met as recovery's own trace: a strip of the three stages and a slider that walks the report one row at a time in the order the machine took it, saying what each step was and which stage it belongs to, in the tool and in the dialog. They are not stages of the query pipeline's trace — a query's run has no recovery in it, and adding three to the `Stage` union would put three unbuilt-looking stages on every query.)*

**2.4 — Storage engines**
- [x] Every shipped tool has a lesson, a challenge, a data-table view and its own budget row; B+Tree vs. LSM reports amplification numbers from real counters. *(Budget rows: every tool. Data-table views: every tool, as of 2026-10-12. Lessons and challenges, as of 2026-10-13: every tool in the tools index has at least one of each, and a test reads the index and fails for a tool that has not (`toolCoverage.test.ts`). Thirty lessons in three groups — the pipeline sixteen, storage engines six, transactions and durability eight — and fifty-two challenges: twenty queries, sixteen for transactions and durability (fifteen scripts and the isolation matrix) and sixteen for storage and execution. B+Tree vs. LSM: write, read and space amplification from the counters of both trees, in `/compare`.)*

**2.5 — Reach & learning layer**
- [ ] A course map with a non-affiliation note; the generated quiz shipped *after* §9; a published accessibility statement backed by a manual screen-reader pass; the app works offline on a real device. *(Checked 2026-10-14. Done: the course map, with its note (G1); the generated quiz, `/practice`, built after the pilot (G4); the accessibility statement is published at `/docs/accessibility`, with the automated half — every route in both themes at two widths, and after the controls are used — holding. Open, and yours: the manual NVDA, VoiceOver and TalkBack pass the statement is to be backed by, and offline on a real device, which is H1's preview-deploy check.)*

### 25.9 Decision log

| Item | Verdict | Earliest | Trigger to revisit |
|---|---|---|---|
| **Release `2.0.0-rc.1`** (withdrawn; **rc.2**, then **rc.3**) | **Decided, 2026-10-15 (owner)** — a release candidate, not 2.0.0. rc.1 (`c2b79e8`) reached production and its service worker broke every visit after the first (it cached Cloudflare's `/index.html` redirect as the shell); withdrawn untagged, fixed and re-cut as rc.2: RELEASING.md holds 2.0.0 for the whole 2.0 checklist, and its launch item (domain, launch post, npm) is open. Cut on `version/v2`; `main` fast-forwards to it and the tag follows CI there, both on the owner's go-ahead. **rc.3, 2026-10-18 (owner):** rc.2 and what its first days in production turned up — the assets' doubled `Cache-Control`, a page's parameters landing on the next page, every route loading flowinger, CI past its time limit — plus flowinger 1.0.1 and the CodeMirror pins; cut on `main`, where work now happens (`version/v2` is retired) | now | The launch item done → cut 2.0.0 |
| SQLite oracle (A1) | **Built, 2026-09-25** — two engine bugs found on the first run; TLP follows B1 | now | — |
| §9 study kit (A2) | **Built, 2026-09-24** — runner + `pnpm study`; the instrument travels in the link, not the bundle | now | Pilot completed 2026-10-10 (n=2, laptop + mobile) |
| **Run the §9 study during 2.0** | **Decided, 2026-09-24** | now | §25.6 checkpoint before 2.2 |
| **Wait for the §9 pilot data before building 2.2 (D1–D6) and 2.3 (E1–E4)** | **Pilot completed, 2026-10-10** — 2 participants (laptop P01 + mobile P03) collated in `scoring/`. Gate cleared to proceed into 2.2. | 2026-10-10 | — |
| Rename before launch (A5) | **Decided: keep the name, paired with a descriptor** | 2026-09-24 | A rival contests it, or launch feedback shows confusion |
| Custom domain (A5) | **Recommended: `querylens.org`** — awaiting purchase | after purchase | — |
| SQL tier 2 (B1, B2) | **Built, 2026-09-25** — B1 in three slices (predicates: `OR` / `NOT` / parentheses, `IS [NOT] NULL`, `[NOT] IN`, `[NOT] LIKE`, `NOT BETWEEN`, with three-valued logic; arithmetic; `OFFSET`), B2 in two (`HAVING`; `SELECT DISTINCT`). This row said "Planned" until 2026-10-17; §25.4's B1 and B2 rows have the detail | now | — |
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
| Cost-based choice (C5–C6) | **C5 built, 2026-09-30** (index vs. scan, join algorithm and join order chosen by cost, each with a "Why not?"); **C6 slice 1 built, 2026-10-01** (the 3,000-row `transactions` dataset) — the Web Worker and focus+context tree rendering are **deferred by decision**, because neither trigger has fired | now | Main-thread jank, an unreadable tree, or a dataset past 10,000 rows |
| Transactions: locks, isolation, MVCC (D) | **Built, 2026-10-10 (D1–D6)** — schedules, enforced locks, isolation by locking, versions and snapshots, the Hermitage matrix, the concurrency-control compare; the gate was cleared by the §9 pilot | now | — |
| WAL / ARIES recovery (E) | **Built, 2026-10-10 (E1–E4)** — the log and the log-before-data rule, steal/force, checkpoints and ARIES, recovery from the Playground's own writes | now | — |
| LSM, hash index, columnar, vectorized, latch crabbing, vector index (F) | **Built, 2026-10-01 to 2026-10-14 (F1–F7)** — a `ColumnScan` operator was **declined by decision** (2026-10-05); optimistic lock coupling, F5's optional half, was added 2026-10-14 | now | — |
| F7 scan-resistant ring buffer | **Built, 2026-10-10:** `SeqScan` brackets a scan with `pool.beginScan`/`endScan`; `scanRing` is off by default; a range in the sandbox's reference string is a marked scan. | 2026-10-10 | — |
| Generated quiz (G4) | **Built, 2026-10-10** — `/practice`, generated questions answered by the engine they are about, disjoint from the study's bank | now | — |
| Confidence ratings (G2) | **Built, 2026-10-04** — optional "How sure?" chips recorded with each prediction | now | — |
| PWA / offline (H1) | **Built, 2026-10-04, verified locally** | now | The preview-deploy check, and offline on a real device (yours) |
| Embeds + essays (H2) | **Essays built, 2026-10-04; in-page embeds not built, by decision** (the CSP rule cannot be overridden per path) | now | A preview deploy shows a narrower `frame-ancestors` is possible |
| Publish CLI + `@querylens/engine` (H3) | **Code side built, 2026-10-05; scope decided:** org `querylens`; CLI unscoped. Publishing waits for the organisation | after the org exists | You create the org + enable trusted publishing |
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
  `HAVING`, outer joins and an uncorrelated `IN (subquery)`, and stops. *(2026-10-15, decided by the owner: the
  clauses it already has may also combine — `ORDER BY` with `GROUP BY`, and both with `JOIN` (§26). No new
  construct; the line above still holds.)*
- **No Postgres-dialect `EXPLAIN` viewer** (§20.6) and **no APM use case** (§2).
- **No accounts, no graded submission, no telemetry, no real-time collaboration.** The MCP server runs
  where the user runs it; nothing new leaves the browser.
- **No Rust / WASM rewrite.**
- **No claim of affiliation** with any course or institution whose syllabus is used as a checklist (G1).


---

## 26. After the v2 merge — fixes, then letting the clauses combine

*Started 2026-10-14, after `main` was merged into `version/v2` (`19f7ec4`).* A full test pass over the merged
branch — every gate, plus a differential probe of LEFT JOIN, join chains and `IN (subquery)` against SQLite and a
75,000-input crash fuzz — found six things to fix, all done: `NULL NOT IN (∅)` and unresolved subqueries outside
`WHERE`'s `AND`/`OR`/`NOT` (`6c70637`, with the oracle extended to C3's shapes), the tour's hand-off race
(`a7fc063`), CI that retried flaky tests away (`46ce55e`), one browser title for every page (`e3ed2c7`), and docs
the merge left stale (`d157021`).

### Feature 1 — the clauses combine

The parser refused the commonest query shapes there are: `ORDER BY` with `GROUP BY` (*the biggest accounts
first*), and either of them, or an aggregate, in a query with a `JOIN` (*posts per author*). Every operator they
need already existed — `Sort` spilling through the pool, both aggregate strategies, the left-deep `Join` chain — so
this is plan building, narration and checks, not new SQL (§25.10's note). Three slices, each its own commit with
the full gate and an oracle extension:

| Slice | What | Status |
|---|---|---|
| a | `ORDER BY` above an aggregate: a grouped column or an aggregate — selected or not (`aggregateSpecsOf` computes it) — sorted after `HAVING`. A sort aggregate and the `Sort` above it spill to separate scratch blocks. | **Built, 2026-10-15** |
| b | `ORDER BY` above a `JOIN`, by a qualified column; the Sort's scratch block moves past every joined heap. | **Built, 2026-10-15** |
| c | `GROUP BY`, `HAVING` and aggregates above a `JOIN`. | **Built, 2026-10-15** |

**Slice a, checked by:** unit tests (the plan shape, a crafted table whose groups arrive in the opposite order to
the answer — an earlier seed-data version let a missing aggregate pass unnoticed — NULL groups, HAVING, the
refusals, and that the two sorts' scratch pages never overlap), and the oracle, which now generates `ORDER BY` on
aggregate queries by a grouped column or any aggregate, under both strategies (coverage asserts all four
combinations). A Sort that cannot read an aggregate's key fails three oracle suites. The oracle cannot see the
order when the sort key is not selected — only the rows — which is what the crafted unit test is for. The
`every-clause` challenge (was `six-clauses`, never released) now asks for seven clauses; the grammar diagram lets
`ORDER BY` take an aggregate call.

**Slice b, checked by:** the same ordered answer from all five join algorithms on a `LEFT JOIN` (NULL padding first
descending), the plan shape, the qualifier refusals and DISTINCT's rule; and the oracle, which now draws an `ORDER
BY` on any column of any table in a generated join (coverage: every algorithm, and LEFT steps). A Sort that cannot
read a joined key fails three oracle suites. **Two scratch-page bugs found on the way**, both fixed and pinned: the
reservation for a sort after a join was capped at 20,000 rows, and the pool silently ignores ids past its end, so a
bigger sort's merge passes went uncounted (a test counts every pass's writes — and caught the cap only once it
counted every pass, not the first); and a `LEFT JOIN` onto an empty table reserved nothing for the padded rows the
next `sort-merge` step sorts, so its two sides shared page ids (a test checks four sorts' pages are disjoint).
The course map's SQL row, stale since C3 (it said "one JOIN" and listed outer joins and subqueries as missing), is
corrected.

**Slice c, checked by:** posts per author over a `LEFT JOIN` — zero for the author with none — identical under all
five join algorithms and both aggregate strategies; HAVING and a join-wide aggregate; the plan shape; the qualifier
and grouping refusals; and an EXPLAIN estimate of the groups, which now counts a grouped column's distinct values in
its own table (looked up in the FROM table, where the column does not exist, it came out as 1). The oracle
generates aggregate queries over its join chains — grouping, HAVING, ORDER BY and all — as a fourth kind of read;
an unqualified group key fails two oracle suites, and three 10,000-case seeds are clean. Coverage thresholds for
ordered joins and ordered groups come down (measured 11–20 and 21–33) now that reads split four ways. **One more
bug found on the way, older than this feature:** `SELECT name FROM users HAVING COUNT(*) > 1` answered one row with
`name: null` instead of being refused — the grouping check never looked at `HAVING`'s aggregates. Fixed and pinned.
**Feature 1 is done:** all eight optional parts of a `SELECT` run together; what still refuses a query is what it
means (an ungrouped column, a missing table name, DISTINCT sorting by an unselected column), never which clauses it
has. The *every-clause* challenge stays on its one-table database and asks for all seven parts that has.

### Feature 4 — the release (cut, 2026-10-15; rc.1 withdrawn, rc.2 cut)

**What went wrong on the way, and what changed because of it.** rc.1 was fast-forwarded to `main` and deployed. The
post-deploy check found the site loading once and then failing on every later navigation: the service worker
precached `/index.html`, Cloudflare redirects that path to `/`, and a cached redirect cannot answer a navigation.
None of 608 e2e tests saw it, because `vite preview` never redirects — and RELEASING's preview-deploy rule for these
very files (`sw.js`, `_headers`, the manifest) was exactly the check skipped. The fix caches the shell as `/`; the
lasting change is that the preview server now redirects `/name.html` the way the platform does, which made three
existing offline tests fail on the broken worker. rc.1 stays in the CHANGELOG as deployed-and-withdrawn, untagged.


`2.0.0-rc.1`, the owner's choice over 2.0.0 because the 2.0 checklist's launch item is open (§25.9). Cut in one
commit on `version/v2` per RELEASING.md: `[Unreleased]` became `[2.0.0-rc.1] - 2026-10-15` with a short summary
above the full notes (73 kB of them, under GitHub's 125,000-character body limit), a fresh empty `[Unreleased]`,
the link references, and `package.json`. The CHANGELOG test required a non-empty `[Unreleased]`, which RELEASING's
own step 3 empties; it now requires only that the newest dated release has notes. CI runs on `main` and pull
requests, not on `version/v2`, so the order is: fast-forward `main` to the cut commit (which is also the production
deploy — Cloudflare builds `main`; production served `ccfa2b6` until then), let CI pass on it, then tag
`v2.0.0-rc.1` and publish a pre-release with `pnpm -s release-notes 2.0.0-rc.1`. `version/v2` changes six
deploy-config paths since `main` (`public/_headers`, `sw.js`, the manifest and icons, `index.html`'s manifest
link), which RELEASING asks to see on a preview deploy before `main` moves; no preview of `version/v2` answers at
the branch alias, so that check is the owner's, in the Cloudflare dashboard.

### Feature 3 — a preset with NULLs (built, 2026-10-15)

No preset row held a NULL, so the Playground never showed three-valued logic on its own — and `NULL NOT IN (∅)`
stayed wrong until the oracle's generated NULLs found it (§26's first fix). `customers` (`src/engine/datasets.ts`)
is 20 rows written out so each NULL is placed on purpose: five with no `city` (so `= 'Paris'` and `<> 'Paris'`
together miss five), eight with no `referrer` (so "who referred nobody", `id NOT IN (SELECT referrer …)`, returns
no one), seven with no `discount` and one with 0 (so `COUNT(discount)` counts the 0 and `AVG` divides by 13, not
20). A new dataset rather than NULLs in an old one, because every pinned number in the lessons, challenges and e2e
tests on the old ones would have moved. The lesson *NULL is not a value* sits with the Playground lessons, after
*errors*; `stepLink` gained a `dataset` so a step can open on a preset other than `users`, and a test re-runs each
of its links on `customers` and holds the numbers its prose quotes. The challenge *Everyone not in Paris* checks the
exact set of customers, by `id` or `name`, so any correct query passes (`<> … OR IS NULL`, or `NOT IN` a subquery
of Paris's ids) and `<>`, `NOT (=)` and `NOT IN ('Paris')` do not; a mutation that drops the NULL-city customers
from the expected set fails six tests. A test also holds that `customers` is the only preset with any NULL.

### Feature 2 — every replacement policy in the Playground (built, 2026-10-15)

The engine had eight policies; the Playground's *Eviction* picker, its `p=` parameter, a saved default, a trace
file and an assignment link took two. The narration and the buffer panel already explained all eight, so the
picker, the URL codec, Settings, the trace-file reader and the assignment builder now take any of them (one guard,
`isReplacementPolicyName`, beside the names and labels in `engine/types.ts`, which UI code imports without pulling
in the engine). **Checking the narration found the one policy that could not honestly run in a query:** optimal
needs the future, a query had none, and it acted as FIFO while narrating Bélády's choice — through `/compare`,
`/trace`, the CLI and the MCP server too. `runQuery` now rehearses a statement under FIFO to record its demand
reads (the same under every policy, since the plan decides them — tested for all eight), then runs it with that
record as the future; the pool keeps read-ahead to a scan's own pages for a query's record (`lookaheadFrom:
'query'`), unlike a sandbox's reference string. Checked by: the rehearsal's premise, optimal never missing more
than any policy and fewer than FIFO on a sorted scan (63 vs 75), the database untouched by the rehearsal, the
read-ahead tests under optimal, every policy round-tripping through a link and a trace file, and an e2e that picks
2Q and optimal in the Playground. Turning the rehearsal off, or letting a query's record widen read-ahead, each
fails a test.

## 27. QueryLens v3 — the SQL a Textbook Asks For, and the Last Two Subjects

> Added 2026-10-18, after `2.0.0-rc.3`, on the owner's request for "next features, things to add for the next
> major version", built on the branch `version/v3`. This section plans **product v3** as five releases, 3.0–3.4,
> milestones **M22–M26** (§10's numbering continues from §25's M14–M21). Item IDs use new letters — **S**, **T**,
> **P**, **X**, **L** — so none collides with §25's A–H. Evidence, all in the repository: the course map's own
> *Partly* and *Not covered* rows (`src/pages/DocsContent/study/course-map.mdx`), `reference/limits.mdx`'s
> *What's out of scope entirely*, and the two §25.9 rows already marked **Horizon (v3)**.

### 27.1 Where v2 leaves off

v2 built every item §25.4 planned except those waiting on the owner — the domain, the launch post, the npm
organisation (A5, H3) and a manual screen-reader pass (H6) — and three deferred on their own triggers: the Web
Worker (C6), i18n (H5) and detail levels (G5, which shares H5's refactor). Measured against the course map:

| Course-map row | Status after v2 | What is missing (the map's own words) |
|---|---|---|
| Parallel execution | **Not covered** | Multi-core operators, exchange |
| Distributed databases | **Not covered** | Replication, partitioning, consensus |
| SQL | Partly | Correlated subqueries and `EXISTS`, `RIGHT`/`FULL` joins, window functions, CTEs, DDL |
| Relational model and algebra | Partly | Set operators (∪, −, ×) and division |
| Concurrency-control theory | Partly | Precedence graphs: serializability is checked by replay, not by drawing the conflict graph |
| Two-phase locking | Covered, with gaps | Index-range and next-key locks, multi-granularity (intention) locks |
| Cost models and join ordering | Covered, with gaps | Only left-deep plans are enumerated, never bushy ones; histograms beyond a few most-common values |

And one gap no row names: **every Playground preset is one table.** Joins, `LEFT JOIN`, `IN (subquery)`, join
order and the cost-based join choice — most of what v2's C3–C5 built — are reachable only through the Custom
schema editor, `/tools/planner`'s fixed pair, the CLI and the MCP server. A visitor who never opens Custom never
sees a join.

### 27.2 The thesis

1. **Finish the core contrast before widening again.** A query a database textbook's exercises ask for —
   "authors with no posts", "customers who ordered both", "every pair" — should parse, plan, narrate and run,
   checked against SQLite. That is the cheapest way to put v2's optimizer in front of more people, and it
   deepens §9's contrast rather than widening away from it (§22.1's fifth question).
2. **Two syllabus subjects remain** — parallel execution and distributed databases — and both fit §25.2's Q7
   *if* workers, messages and failures are **inputs**: a schedule, a fault point, a partition. D (transactions)
   and E (recovery) already proved the pattern; P and X reuse it.
3. **Theory v2 shows by replay should be shown by construction**: a precedence graph beside the replay check,
   intention locks beside the row locks, bushy plans beside the left-deep ones.

So the order is **SQL completeness → theory you can see → parallel → distributed**, with the learning layer
moving with each item rather than after it.

### 27.3 The filter — §25.2's eight, plus one

§20.1's four questions, §22.1's fifth and §25.2's Q6–Q8 all apply unchanged. One more, earned by §27.1's last
paragraph:

9. **Is it reachable from a preset?** A feature only the Custom editor can reach is one most visitors never
   meet. Every S item names the preset it runs on; S2 exists to make that possible for the multi-table ones.

### 27.4 Release plan

| Release | Milestone | Theme | Scope (item IDs, §27.5) | Est. | Gate |
|---|---|---|---|---|---|
| **3.0** | **M22** | The SQL a textbook asks for | S1–S7 | 4–5 wk | none — start now |
| **3.1** | **M23** | Theory you can see | T1–T5 | 3–4 wk | — |
| **3.2** | **M24** | Parallel execution | P1–P3 | 4–6 wk | 3.0 |
| **3.3** | **M25** | Distributed databases | X1–X4 | 6–8 wk | P1's scripted workers |
| **3.4** | **M26** | Learning & reach | L1–L4 | parallel track | — |

Estimates are §25.3's units and, like v2's, ceilings: v2 beat its own several times over. The schedule risk is
still validation and maintenance, not typing.

### 27.5 The item catalogue

Costs are against the modules that exist today (paths checked 2026-10-18).

#### S. The SQL a textbook asks for

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **S1** | 3.0 | **`EXISTS` / `NOT EXISTS` as semi- and anti-joins** | **Built, 2026-10-18** — as planned below; `src/engine/exists.ts` resolves each `EXISTS` (a `SemiJoinClause`, or a one-time answer kept on the node), `buildPlan.ts`'s `buildSemiJoin` puts it after the chain, `Join.joinType` gained `semi`/`anti` and a `residual`, and the four join operators each stop at the first match; the oracle generates both kinds and found a printer bug on its first run (a quoted string printed unparseably, fixed). Its lesson and challenge were built with S2's preset. A subquery correlated through one equality between a column of its own table and a column of the outer query's (`posts.authorId = authors.id`), with any other condition kept as a residual. Planned as a **semi-join** (⋉) or **anti-join** (▷) at the end of the join chain, run by all four join algorithms and chosen by cost like any other join — **nested-loop *is* "run the subquery again for every outer row, stopping at the first match"**; hash, sort-merge and index nested-loop are the unnested forms, which is decorrelation shown rather than described. An uncorrelated `EXISTS` runs once, before planning, like `IN (subquery)`. `NOT EXISTS` against `NOT IN` with a NULL is the lesson. Oracle-checked. | 1 wk |
| **S2** | 3.0 | **A multi-table preset** | **Built, 2026-10-18** — `shop` (`customers`, `products`, `orders`); edits tracked per table, other tables in a link as `d.<table>` and in a trace file as `otherRows`; a *Table* picker for **Edit data**; S1's lesson (`/learn/not-exists`) and challenge (`/challenges/never-ordered`). Found on the way: `/trace` dropped `t` from its links (fixed). The Playground's first preset with more than one table (a small shop: customers, orders, products) — so `JOIN`, `LEFT JOIN`, `IN`/`EXISTS` and join order run on load. Touches the dataset picker, the data editor (one tab per table), the share-link row codec (per table), trace files and the assignment builder. S1's lesson and challenge ride here, where a preset can reach them. | 1–1.5 wk |
| **S3** | 3.0 | **`UNION [ALL]`, `INTERSECT`, `EXCEPT`** | **Built, 2026-10-18** — a `compound` statement; each member planned and optimized on its own (`planner/compound.ts`), a `SetOp` plan node above them, every table laid out once so members share pages, each member run in its own context; `UNION` reuses the DISTINCT node (hash or sort), `INTERSECT`/`EXCEPT` hash only. The oracle generates compounds; it found that `SELECT n, n` silently dropped a column, now refused and ledgered. Lesson `/learn/set-operations`, challenge `/challenges/nobody-ordered-it`. A compound `SELECT`; ∪ ∩ − in the relational-algebra view; duplicate removal by hash or by sort through the existing `aggregateStrategy` seam, so `/compare` can set them side by side. Oracle-checked. | 1 wk |
| **S4** | 3.0 | **`CROSS JOIN`, `RIGHT` and `FULL [OUTER] JOIN`** | **Built, 2026-10-19** — `RIGHT` runs natively rather than as a mirrored `LEFT` (the plan keeps the tables as written, so the trace reads the query): nested-loop, hash and sort-merge keep a set of the inner rows that matched and emit the rest last; index nested-loop gives way to nested-loop. `CROSS JOIN` and `FROM a, b` are a `Join` with `joinType: 'cross'`, nested-loop only; a new rule, `product-to-join`, makes σ over × a ⋈ — except under a later `RIGHT`/`FULL`, which the oracle's first run caught. Pushdown never filters a padded side; reordering only touches all-inner chains. Lesson `/learn/outer-joins`, challenge `/challenges/leave-no-one-out`. As first planned: × and the full outer join. `RIGHT` runs as the mirrored `LEFT`, said aloud in the plan; `FULL` needs to remember which inner rows matched — a bitmap the nested-loop and hash operators keep — which is the lesson. | 1 wk |
| **S5** | 3.0 | **`COUNT(DISTINCT col)`** (and `SUM`/`AVG` `DISTINCT`) | **Built, 2026-10-19** — `distinct` lives on the aggregate's column argument (`AggregateArg`), so every printed key carries it; `AggregateSpec.distinct`; hash keeps a set per group, sort adds the column to its sort key when one column is all its DISTINCT aggregates read (`distinctSortColumn`) and keeps sets otherwise; values compared by `equalityKeyOf`, as `SELECT DISTINCT` does; `MIN`/`MAX` accept it too. Oracle-generated (one column aggregate in four). Challenge `/challenges/count-each-once`; no lesson of its own. As first planned: a per-group set in both aggregate strategies; the sort strategy gets it by sorting on (group, value). | 3 days |
| **S6** | 3.0 | **Scalar subqueries** | `x > (SELECT AVG(price) FROM products)` — uncorrelated, run once like `IN (subquery)`, with the "returned more than one row" error a real engine raises. A correlated scalar subquery stays out (§27.10). | 3–4 days |
| **S7** | 3.0 | **Table aliases and self-joins** | `FROM employees AS e JOIN employees AS m ON e.manager = m.id`, and a subquery correlated with its own table ("customers who referred nobody", the `customers` preset's question, written as `NOT EXISTS`). The engine keys a joined row by the name in scope, so an alias becomes that name and the base table is looked up once. | 1 wk |

#### T. Theory you can see

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **T1** | 3.1 | **Precedence graph** | In `/tools/schedule`: committed transactions as nodes, an edge for each pair of conflicting operations in schedule order, a cycle drawn and named. Checked against the existing replay-based serial check (`engine/serialCheck.ts`) on every Hermitage schedule and on random ones — the two must agree wherever conflict-serializability and the replay check coincide, and the page says where they do not (view-serializable schedules). | 1 wk |
| **T2** | 3.1 | **Multi-granularity locking** | IS / IX / S / SIX / X on a table → page → row hierarchy in the lock table; the compatibility matrix computed, not drawn; lock escalation at a threshold. | 1 wk |
| **T3** | 3.1 | **Next-key (gap) locks** | InnoDB's answer to phantoms: the phantom schedule prevented at `REPEATABLE READ` by a lock on the gap, shown on the index leaf it covers. The Hermitage InnoDB column's phantom cells are the check. | 1 wk |
| **T4** | 3.1 | **Bushy plans** | `/tools/join-order` enumerates bushy trees beside left-deep ones over the same subset lattice — how many more plans there are, and the shapes where a bushy one wins. | 4 days |
| **T5** | 3.1 | **Equi-depth histograms** | `ANALYZE` with a chosen bucket count; a range estimate's q-error against the bucket count, on the `transactions` preset. | 3 days |

#### P. Parallel execution (the course map's *Not covered* row)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **P1** | 3.2 | **`/tools/parallel` — morsel-driven execution** | A scan and an aggregate split into morsels of pages, handed to *N* workers by a dispatcher. Worker speeds are a **scripted profile** (an input, Q7) — never threads or timers. Speedup, skew and work stealing measured in ticks. | 1.5 wk |
| **P2** | 3.2 | **Exchange operators** | Gather, repartition (by hash) and broadcast; a parallel hash join's two strategies compared by rows moved and ticks. | 1.5 wk |
| **P3** | 3.2 | **Serial vs parallel in `/compare`** | The same query's plan run serially and with *N* workers: ticks, and Amdahl's serial fraction measured from the run. | 4 days |

#### X. Distributed databases (the course map's other *Not covered* row)

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **X1** | 3.3 | **`/tools/partitioning`** | Hash, range and consistent hashing (with virtual nodes) over one table; add or remove a node and count the rows that move; skew. | 1 wk |
| **X2** | 3.3 | **`/tools/2pc` — two-phase commit** | A coordinator and participants; failures as inputs (a crash before or after the vote, a lost message); the blocking window drawn; presumed abort. | 1.5 wk |
| **X3** | 3.3 | **`/tools/raft` — consensus** | Leader election and log replication over a scripted message schedule (delays, drops and partitions are inputs). Election safety, log matching and leader completeness asserted by property tests over seeded random schedules. No membership changes, no snapshots — labelled. | 2–3 wk |
| **X4** | 3.3 | **Distributed join** | Broadcast against shuffle across X1's partitions, priced in rows over the network. | 1 wk |

#### L. Learning & reach

| ID | Rel. | Item | Shape | Cost |
|---|---|---|---|---|
| **L1** | 3.4 | **A lesson, a challenge and a text alternative per item** (Q6) | In the item's own commit wherever a preset can reach it; S1's wait for S2. `toolCoverage.test.ts` already fails a tool without them. | per item |
| **L2** | 3.4 | **Detail levels** (G5, carried over) | Novice / standard / expert narration. Still shares H5's event-label refactor. | 1 wk |
| **L3** | 3.4 | **The course map and `limits.mdx` move with each item** (§25.5 rule 6) | Every S, T, P and X item updates the row it changes, in its own commit. | per item |
| **L4** | 3.4 | **2.0's open launch item** (owner's) | The domain, the launch post and the npm organisation are still open from §25.8; v3 does not wait on them. | — |

### 27.6 Engineering rules for v3

§25.5's seven rules stand. Two more:

8. **A SQL construct is supported only once SQLite agrees.** Each S item extends `oracle/` in its own commit
   — a generator for its shape and a coverage threshold — not after the release, as C3's slices did.
9. **Workers, messages and node failures are inputs** (Q7, extended to P and X): a schedule and a fault list,
   seeded, never `setTimeout`, threads or `async` inside `src/engine/` or a tool's driver.

### 27.7 Risks specific to v3

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Widening again** | P and X are second products in §22.1's sense | Each ships with a lesson, a challenge and a text view; at most one P/X tool per release until a signal (§25.6) points at one |
| **Subquery scope bugs** | A correlated reference resolved against the wrong table returns plausible wrong rows | Qualification is required inside a subquery that can see two tables (the `JOIN` rule, applied to scopes); the oracle generates correlated shapes |
| **Model honesty for Raft and 2PC** | A protocol toy that looks complete is §12's "plausible but false" | Assert properties, never claim an implementation; label every simplification on the page |
| **Preset churn** | Pinned numbers in lessons, challenges and e2e tests move when a preset changes | S2 adds a preset rather than editing one — Feature 3's precedent |
| **Bundle growth** | New tools on shared groups | Each tool its own lazy chunk and budget row (Q8) |

### 27.8 Definition of done

**3.0 — The SQL a textbook asks for**
- [ ] A query using `NOT EXISTS`, `UNION`, a `FULL JOIN`, `COUNT(DISTINCT …)` and a self-join through an alias
  runs and narrates end to end on a preset; `sql.mdx`, `limits.mdx` and `/tools/grammar` agree.
- [ ] The oracle generates every S shape, with coverage thresholds; three 10,000-case seeds are clean.
- [ ] The course map's *SQL* and *Relational model* rows lose every missing item but window functions, CTEs and DDL.

**3.1 — Theory you can see**
- [ ] The precedence graph and the replay check agree on every Hermitage schedule, and the page names the
  view-serializable cases where they differ.
- [ ] A phantom is prevented by a gap lock at InnoDB's `REPEATABLE READ`, in the Hermitage matrix's own cell.

**3.2 — Parallel execution**
- [ ] The course map's *Parallel execution* row is at least *Partly*: morsels, exchange and a measured speedup.

**3.3 — Distributed databases**
- [ ] The course map's *Distributed databases* row is at least *Partly*: partitioning, 2PC and Raft, each with
  its property tests.

### 27.9 Decision log

| Item | Verdict | Earliest | Trigger to revisit |
|---|---|---|---|
| v3 on `version/v3`, one item per commit | **Decided, 2026-10-18 (owner)** — "do the work on a new branch" | now | — |
| `EXISTS` / `NOT EXISTS` (S1) | **Built, 2026-10-18** — semi- and anti-joins under all four algorithms, oracle-checked; its lesson and challenge built with S2 | now | — |
| A multi-table preset (S2) | **Built, 2026-10-18** — `shop`, with S1's lesson and challenge | now | — |
| Set operations (S3) | **Built, 2026-10-18** — ∪ ∩ − over members planned on their own; INTERSECT never mixed with the others; no `INTERSECT ALL`/`EXCEPT ALL` | now | — |
| Outer-join completion (S4) | **Built, 2026-10-19** — `RIGHT`/`FULL`/`CROSS`/comma joins, run natively; `product-to-join` rewrite | now | — |
| `COUNT(DISTINCT)` (S5) | **Built, 2026-10-19** — both strategies, sort on (group, value) | now | — |
| Scalar subqueries, aliases (S6–S7) | **Planned** | 3.0 | — |
| Theory you can see (T1–T5) | **Planned** | 3.1 | — |
| Parallel execution (P1–P3) | **Planned** — §25.9's *Horizon (v3)* row, now scheduled | 3.2 | — |
| Distributed databases (X1–X4) | **Planned** — §25.9's other *Horizon (v3)* row | 3.3 | P1's scripted workers exist |
| Web Worker engine (C6's deferred half) | **Still deferred** | — | Main-thread jank, or a dataset past 10,000 rows |
| Window functions, recursive CTEs | **Still declined** (§4, §25.10) | — | A course adoption that asks for them |
| A correlated scalar subquery | **Declined for 3.0** | — | S1 and S6 both shipped, and a lesson needs one |
| In-app LLM explainer | **Still declined** (§25.6's kill criteria) | — | — |

### 27.10 What v3 deliberately does not add

- **No window functions, no recursive CTEs, no DDL** — §4's and §25.10's reasoning stands.
- **No correlated scalar subqueries** in 3.0; `EXISTS` and `IN` cover the correlation lesson.
- **No real threads, no real network.** P and X run scripted schedules in the same pure-function shape as D and E.
- **No membership changes or log compaction in Raft**, and no Paxos — one consensus protocol, honestly labelled.
- **No bundled or local LLM, no accounts, no telemetry, no graded submission** — §25.10 unchanged.
- **No Rust / WASM rewrite.**

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
