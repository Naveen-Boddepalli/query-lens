# Project Plan: QueryLens — Interactive Database Internals Visualizer

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
| M10 | **Visual design maturity (§16) + landing page (§19):** self-hosted typefaces, named type/space/motion scales, hover states across every diagram panel, footer, first-screen framing | ~1.5 days (P0) + 1 week (P1) — **P0 done** |
| M11 | **Docs, manual, licensing & governance (§17–§18):** docs site, Getting Started, the two manual pages the §9 study needs, `LICENSE-DOCS`, font licensing, README restructure | ~1 week (P0/P1) + ongoing — **docs site built, see note** |
| v1 | Expand SQL coverage: joins, cost estimates, InnoDB midpoint-LRU as a third policy | Post-MVP |

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
   how to skip it when demonstrating to a room.
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

- [ ] The docs framework decision is recorded with its embedding requirement, and the site builds
      and deploys at `/docs` on the same Cloudflare Pages project.
- [ ] FAQ answers "Is this a real database?", "Where is my data stored?", and "Can I use this in my
      course?"
- [ ] Getting Started exists and a first-time user completes it without opening the README.
- [ ] The two manual pages the §9 study depends on — eviction and B+Tree split — exist, each with
      annotated screenshots, a "try this", and a link that opens the app at that state.
- [ ] At least one Concepts page embeds a real component from `src/` rather than a screenshot (or
      the embed requirement is explicitly dropped and the tool choice revisited with it).
- [ ] `LICENSE-DOCS` exists (CC BY 4.0) and the docs footer states it.
- [ ] `OFL.txt` ships with the font files, subset files are renamed off the reserved font name, and
      `NOTICE` covers both fonts.
- [ ] No docs page mixes two Diátaxis modes.

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

Still blocked on §17.1, and correctly so — moving content out of the README before the docs site
exists would delete it. Target shape once it is unblocked:

1. Title, badges, one-line description
2. A GIF, not a screenshot — the product is motion, and a still cannot show a page being evicted
3. **What is this?** — three sentences
4. **Try it** — the live link, above every other link
5. **Features** — 8–10 one-line bullets
6. **Quick start (developers)** — clone, install, dev, test
7. **Documentation** — the docs site
8. **Contributing**, **Licence** (code MIT, docs CC BY 4.0), **Acknowledgments**

Everything currently between "Status" and the end — architecture, decisions, storage layer, B+Tree,
execution, the gate write-ups — moves to the docs site under Architecture. The README stops being a
decision log and becomes a front door. Target: **under 120 lines**, from 665.

### 18.5 Definition of done

- [x] `CONTRIBUTING.md` exists and is linked from the README.
- [x] `CODE_OF_CONDUCT.md` exists with the Contributor Covenant v2.1.
- [x] `SECURITY.md` exists with reporting instructions and scope statement.
- [x] `CHANGELOG.md` exists with v0.1.0 as the baseline.
- [x] `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` exist.
- [x] `.github/PULL_REQUEST_TEMPLATE.md` exists.
- [x] README has badges at the top.
- [x] README links to CONTRIBUTING.md, CODE_OF_CONDUCT.md, and SECURITY.md.
- [ ] GitHub Discussions is enabled and `ISSUE_TEMPLATE/config.yml` routes questions there.
- [ ] README restructured to user-facing format, under 120 lines (blocked on §17.1).

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

**P0 complete; the four P1 items in §19.2 are open.**

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
- [ ] Preset query chips exist and the third demonstrates the §9 index/no-index contrast. — §19.2, P1
- [ ] First-visit hint appears once, is dismissible, and never returns. — §19.2, P1
- [ ] The tour is skippable, reduced-motion-safe, and never auto-replays. — §19.2, P1
- [x] The OG image is regenerated after the §16 visual pass ~~and verified on at least three
      platforms~~. *Regenerated by `pnpm og` (`scripts/build-og.ts`), which drives the built app to
      step 91 of the sequential scan — the first eviction — through the app's own shareable-URL
      format and screenshots it, so the card cannot drift from the design again without someone
      choosing not to re-run it. The alt text was already stale: it said "four frames" through a
      change that made it eight. **Verification on three platforms stays open until the URL is
      live**, alongside §14.6's two other held-open checks.*
