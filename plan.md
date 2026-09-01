# Project Plan: QueryLens — Interactive Database Internals Visualizer

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
| Hosting | **Cloudflare Pages** (free tier) | Vercel Hobby is non-commercial-only by ToS and pauses past 100GB; Cloudflare serves unlimited static bandwidth |
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
- **Predict-then-reveal prompts**: at marked steps the run halts and asks the user to commit before revealing.
  Natural prompt points fall straight out of the §7.8 event union — `buffer:evict` (which frame?),
  `index:traverse` (which child pointer?), `optimize` (where does the filter move to?), `result` (how many rows?).
  This is the single highest-leverage feature in the product and it is cheap: a modal over an event stream
  that already exists.
- **Editable seed-data grid**: change the rows, re-run, see a different trace.
- **Policy toggle**: LRU ⇄ clock sweep on the buffer pool panel.
- **Accessibility** (cheap now, invasive later): the Play/Pause controls already satisfy WCAG 2.2.2
  (Pause, Stop, Hide). Honour `prefers-reduced-motion` by snapping between states instead of tweening —
  it does *not* replace the controls, both are required. Keyboard shortcuts throughout
  (Space = play/pause, ←/→ = step); learners in training settings lean on them heavily.
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
| **MVP complete** | Full pipeline for indexed point lookup **+ sequential-scan contrast** (§9), deployed free | **~10-14 weeks part-time** |
| v1 | Expand SQL coverage: joins, cost estimates, InnoDB midpoint-LRU as a third policy | Post-MVP |

---

## 11. Cost Summary
- Development: $0 (own hardware, free/open-source tools).
- Hosting: $0 (Vercel/Cloudflare Pages free tier).
- Domain (optional): ~$10-15/year.
- Persistence/accounts (deferred, optional in v1+): $0 on free tiers (Supabase/Firebase) at MVP scale.

**Total to ship MVP: $0, or ~$10-15/year if a custom domain is desired.**

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

---

## 13. Future Directions (post-v1, not committed)
- Rust + WASM engine rewrite for performance and authenticity.
- Course/curriculum packaging (structured lessons, quizzes tied to visualizations).
- Comparison mode: same query, different index strategy, side-by-side.
- Community query-sharing (would require backend + persistence).
