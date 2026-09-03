# Project Plan: QueryLens — Interactive Database Internals Visualizer

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
- Production query debugging / APM use case.
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

---

## 6. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Engine language | TypeScript **6.0.3 (pinned)** | TS 7 is faster but `typescript-eslint` excludes it (`<6.1.0`); revisit after 7.1 |
| Engine execution context | Main thread, pure sync module | Step-back needs full history anyway; worker-ready for v1 |
| Frontend framework | React + TypeScript | Familiar, large ecosystem, easy state management for step-through UI |
| Visualization | React Flow (`@xyflow/react`) for plan/AST/B+Tree graphs, `d3-hierarchy` for layout math, `motion` for animation | Node-based graphs without hand-rolling SVG; d3-hierarchy supplies tree layout |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) | CSS-first config (`@import "tailwindcss"`, `@theme`); no `tailwind.config.js` |
| SQL editor | CodeMirror 6 (`@uiw/react-codemirror` + `@codemirror/lang-sql`) | ~50kB tree-shaken vs Monaco's 2–5MB; a `<textarea>` cannot syntax-highlight |
| Hosting | **Cloudflare Pages** (free tier) | Vercel Hobby is non-commercial-only by ToS and pauses past 100GB; Cloudflare serves unlimited static bandwidth. Cloudflare now steers *new* projects to Workers static assets, but Pages is fully supported with no migration deadline — **revisit only when this project first needs a server-side piece** (an error-beacon endpoint, hosting for the §9 study), not before |
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
- v1 stretch: simple cost estimates (row count heuristics) to justify plan choices, shown as annotated numbers on plan nodes.

### 7.4 Execution Engine
- Iterator/Volcano-style execution model (`next()` pull-based) — classic and easy to animate step-by-step, since each `next()` call is a natural visualization tick.
- Physical operators: `SeqScan`, `IndexScan`, `Filter`, `Project`, (v1: `NestedLoopJoin`).

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
  InnoDB-style midpoint LRU is a good v1 third option.
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
  (Space = play/pause, ←/→ = step); learners in training settings lean on them heavily.
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
| v1 | Expand SQL coverage: joins, cost estimates, InnoDB midpoint-LRU as a third policy | Post-MVP |

M8 sits between "the app works" and "the URL is public." It is not polish — every item on the P0 list in
§14 fails *silently* if skipped, which is why it gets its own gate rather than being folded into M7.

**Both gates are through P0 and P1.** What is left in either is P2: the light theme (§15.3, whose
estimate this document had wrong — see the note there), undo for row deletion, and the standing
obligation to re-run the contrast sweep at each visual change. Two of §14.6's checks stay open until
the URL is live, because nothing can fetch the site before it exists.

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
- **Checklist ceremony.** The opposite failure: importing a service-shaped production checklist into an
  application with no server, no secrets and no user data, and spending three weeks on secret rotation,
  uptime monitoring and incident tiers that reduce no risk here. Mitigation: [RESEARCH.md §21](RESEARCH.md#21-what-i-deliberately-left-out)
  names what is deliberately *not* being done, so skipping it is a decision on the record rather than an
  oversight to be re-litigated.

---

## 13. Future Directions (post-v1, not committed)
- Rust + WASM engine rewrite for performance and authenticity.
- Course/curriculum packaging (structured lessons, quizzes tied to visualizations).
- Comparison mode: same query, different index strategy, side-by-side.
- Community query-sharing (would require backend + persistence).

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
- [~] securityheaders.com reports A or A+, and the SQL editor is still styled under the live CSP.
      *The editor half is verified — `dist/` was served under the exact `_headers` policy and
      CodeMirror renders styled, with zero CSP violations in the console. The grade itself needs
      the public URL and is the one item that cannot be closed before the first deploy.*
- [x] `LICENSE` exists and the README names it.
- [~] Pasting the URL into Slack or Twitter shows an image of the product.
      *`public/og.png` (1200×630, the buffer pool mid-eviction) plus `og:`/`twitter:` tags with an
      absolute URL from `VITE_SITE_URL`/`CF_PAGES_URL`. Unverifiable until something can fetch it.*
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
