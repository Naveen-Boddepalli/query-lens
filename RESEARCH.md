# QueryLens — Research Findings

Four passes, in one file.

- **Part I — Pre-build (2026-09-01, §1–§8).** Is this worth building, and is the design right?
  Written before any code existed.
- **[Part II — Production readiness](#part-ii--production-readiness) (2026-09-02, §9–§23).** Written
  after M0–M7 shipped, asking the narrower question: what has to be true before the URL is handed to
  strangers.
- **[Part III — UI/UX production readiness](#part-iii--uiux-production-readiness) (2026-09-02, §24–§35).**
  The same question asked of the interface, by driving the running app on desktop and phone and measuring
  what it does.
- **[Part IV — v2 research](#part-iv--v2-research) (2026-09-24, §36–§46).** Written the day after the
  first deploy. v1 is built and live; what should v2 be? The evidence behind plan.md §24–§25.

---

## Part I — Pre-build

Research pass over `plan.md`, done 2026-09-01, before writing code.
Verdict up front: **the project is worth building and the differentiation holds — but two decisions in the plan should change before M0, and one of them is the core UX.**

Confidence labels: **[verified]** = I checked it directly (npm registry, source docs, the paper itself). **[sourced]** = from a credible secondary source. **[judgment]** = my reasoning, not a citation.

---

## 1. The finding that should change the product

### The plan's core UX is the configuration that the research says doesn't work

`plan.md` §8 describes a **viewing** experience: user types SQL, presses Run, watches an animation, with playback controls. §12 already flags "visualization quality is the actual product." The research says the risk is worse than that — it's not that clunky animation would hurt, it's that *polished animation alone has repeatedly failed to beat reading a text document.*

From the Hundhausen, Douglas & Stasko meta-study of 24 experiments on algorithm visualization (I extracted the source PDF and read it directly) **[verified]**:

- **Only 11 of the 24 studies yielded a statistically significant result.** The body of evidence is "widely mixed."
- The headline conclusion, verbatim from the abstract: *"how students use AV technology has a greater impact on effectiveness than what AV technology shows them."*
- On passive viewing: *"individuals do not stand to benefit from the technology by merely passively viewing visualizations, no matter how high the level of their epistemic fidelity."*
- Stasko et al.'s own study: the animation group beat the text-only group on a post-test, **but not significantly**.
- Price: a debugger with vs. without an animated view — **no significant difference**.
- Gurka: when the two groups' *activities* were equalized, the animation effect **disappeared**.

The decisive one for us — the HalVis studies (Hansen, Schrimpsher & Narayanan). HalVis engages users by having them **construct their own input data sets, answer questions, and make predictions**. It significantly outperformed text, and lectures, and — Study V — **a conventional one-view algorithm animation environment with no facilities for interactive prediction or question-answering.**

That last comparison is close to *exactly* QueryLens-as-specified vs. QueryLens-plus-prediction. The paper's framing: the technology is *"not as a conveyer of knowledge, but as a tool for knowledge construction."*

Note "epistemic fidelity" in that quote — that is precisely the property `plan.md` optimizes hardest for (§2: "100% honest about ground truth," owning the engine so every number is true). That work is worth doing for credibility and for your own correctness, but the research says it is **not the variable that drives learning**. Fidelity is table stakes; engagement is the product.

**Recommendation — promote two features from "nice-to-have" into the MVP definition:**

1. **Predict-then-reveal.** Before a step executes, ask the user to commit to an answer. "Buffer pool is full. Which frame gets evicted?" → they click a frame → *then* the animation runs and shows whether they were right. This is the single highest-leverage feature in the whole product and it is cheap: it's a modal over an event stream you already have. Natural prediction points fall out of the existing `StepEvent` union — `buffer:evict` (which frame?), `index:traverse` (which child pointer?), `optimize` (where does the filter move to?), `result` (how many rows?).
2. **User-constructed input data.** Let the user edit the seed rows and re-run. "Construct their own input data sets" is named explicitly in the winning condition. Cheap for us: the dataset is an in-memory array. Even a 20-row editable grid qualifies.

**And change the §9 validation test.** As written, step 3 asks 5–10 users "does the animation build intuition?" — users will say yes, because animations are pleasant to watch. That is exactly the self-report that the mixed experimental record contradicts. Instead, give them a **post-test**: 5 questions they could only answer by having understood the mechanism ("here's a full buffer pool and an access sequence — what gets evicted?"). Compare against a control group who read a well-written text explanation of the same material for the same duration. If QueryLens can't beat a good blog post, that's the signal to know before spending 10 weeks on animation polish.

This does not slow the MVP down much — the prediction layer rides on the event stream that §7.8 already specifies. But it reorders what "done" means.

---

## 2. Architecture: drop the Web Worker for v0

`plan.md` §5 calls the Web Worker "the key architectural decision." I think it's the wrong call for v0, for a reason the plan itself implies. **[judgment]**

The two stated benefits don't hold here:

- *"Keeps the UI responsive during execution."* Execution is a toy engine over a handful of rows across ~8 buffer frames. That's microseconds of work. There is no jank to prevent.
- *"Creates a natural message-passing boundary that doubles as the step event stream."* You get an equally clean boundary — a better one — from a pure synchronous function. And the worker's boundary is the *wrong shape*: `postMessage` is a push stream, while the UI in §8 needs **step back**. Step-back means you must retain the full event history regardless. Once you're holding the whole array, streaming has bought you nothing.

The natural design is:

```ts
// pure, synchronous, no DOM, no async
function runQuery(sql: string, db: Database): { events: StepEvent[]; result: Row[] }
```

Run it on click, get the complete trace, and let the UI scrub through an array it already owns. Playback becomes an index into an array — trivially correct for step-forward, step-back, reset, speed, and scrubbing. With a worker you'd be reconstructing that array on the main thread anyway, plus async plumbing, plus serialization, plus a harder debugging story (no straightforward breakpoints across the boundary), plus worker-aware test setup.

**Keep the engine worker-*ready* instead:** pure functions, no DOM access, fully serializable events, zero React imports. If a future feature ever needs it (a 100k-row dataset to show a scan that actually takes time, or the v1 "concurrent second query"), moving it into a worker is a small, contained change. Vite's native support makes that migration genuinely easy — `new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' })` works with no plugin, though note Vite only detects it when `new URL()` is written **inline** in the `new Worker()` call **[verified, Vite docs]**.

Skip Comlink. It's RPC-shaped; our contract is a value returned once, not a chatty interface.

**Saves roughly the back half of M0** and removes the debugging tax from every milestone after it.

---

## 3. Honesty problem: textbook LRU is not what real databases do

`plan.md` §7.5 specifies LRU eviction, and §2 makes "be 100% honest about ground truth" a top-line goal. These are in tension, because **neither of the two databases your users will actually meet uses textbook LRU** **[sourced]**:

- **PostgreSQL** deliberately avoids an LRU list — maintaining one requires a central lock on every page access, which becomes a scalability bottleneck. It uses **clock sweep**: each buffer has a `usage_count` capped at 5, incremented on access; eviction walks the buffer descriptors circularly, decrementing `usage_count` on each pass, and evicts the first buffer with `refcount == 0 && usage_count == 0`.
- **MySQL/InnoDB** uses LRU but with **midpoint insertion**: the list is split ~37.5% from the tail, new pages enter at the midpoint rather than the head, and a page is only promoted to the young region on a *second* access more than `innodb_old_blocks_time` (default 1s) after the first. This exists specifically to stop a large sequential scan from flushing the hot working set.

So "buffer pool eviction = LRU" is itself the misconception §12 says the product must avoid creating.

**Recommendation:** make the replacement policy a **pluggable strategy** behind one interface, and ship v0 with **LRU *and* clock sweep** as a toggle. Three arguments for this:

1. It converts the plan's biggest honesty liability into its best teaching moment. "Same query, same access pattern, two policies, different victim" is exactly the §13 "comparison mode" idea, available at MVP cost.
2. **Clock sweep animates better than LRU.** A hand sweeping around a ring of frames, decrementing counters, is a far more legible and memorable visual than a reordering list. This is a visual asset, not a chore.
3. It's cheap *if done at the start* and annoying later — it's one interface boundary, decided once.

InnoDB's midpoint LRU is a good v1 third option (it directly motivates *why* scan-resistance matters).

---

## 4. Competitive landscape — differentiation holds

I checked the closest prior art. Nothing occupies QueryLens's position.

| Tool | What it does | Gap it leaves |
|---|---|---|
| **[sql-execution-visualizer](https://github.com/ashwin-athappan/sql-execution-visualizer)** (Ashwin Athappan) | The nearest thing to QueryLens. Next.js 16 + TS + Zustand + Monaco. Hand-written SQL parser/executor, B+Tree with splits, pipeline view, step-through with 0.25×–5× speed. Live on Vercel. | **2 stars, 40 commits, ~1 person-project.** No buffer pool, no planner/optimizer stage, no lock manager, no disk-vs-cache distinction. Pipeline shown is the *logical* clause order (FROM → JOIN → WHERE → …), not the physical execution path. **[sourced]** |
| **B+Tree visualizers** — USF/Galles, PlanetScale's blog widget, systemdesignsimulator.org, toolkit.whysonil.dev | Insert/split/delete animation on one data structure. Several are polished. | Data structure in isolation. No SQL, no query, no storage layer, no "why did my query use this." |
| **CMU 15-445 BusTub b_plus_tree_printer** | Students dump their own B+Tree to DOT/Graphviz. Pink = internal, green = leaf. | A **debugging aid for students already writing a B+Tree in C++**, not a learning tool. Static output, no query pipeline. Your exact target user uses this and gets nothing pedagogical from it. |
| **[pev2](https://github.com/dalibo/pev2) / explain.dalibo.com, DuckDB Explain Visualizer** | Production-grade plan visualization for *real* engines. Plan tree, per-node timing/rows/cost/buffers, colour-coded problem highlighting. | Consumes real `EXPLAIN` output — **the plan is the input, so nothing upstream of it is visible**. No parser, no storage, no index traversal. Aimed at practitioners debugging a slow query, not learners. |

**The unoccupied position is real and it's exactly QueryLens's:** the *full vertical slice* — parse → plan → optimize → execute → buffer → index — on a **query the user typed**, with the layer nobody visualizes (**storage: pages, buffer pool, disk-vs-cache**) as the centerpiece. **[judgment]**

Two things to steal:
- **From pev2:** the side-panel that re-colours the plan tree by a chosen metric (time / rows / cost / buffers). That "one tree, switchable lens" pattern is directly reusable and it's literally the product's name.
- **From BusTub:** pink-internal/green-leaf is the colour convention CMU students already have in their heads. Match it for free familiarity.

One caution: `explain.dalibo.com` ships as a **single downloadable HTML file** you can run locally. That's a strong distribution move for a teaching tool — worth considering as a build target later (instructors can hand it out; it works offline in a lecture hall).

---

## 5. Stack — verified versions and two corrections

All versions checked against the npm registry today **[verified]**. Local toolchain (Node 24.16.0, pnpm 11.1.2, git 2.54.0) is fine — Vite 8 requires Node `^20.19.0 || >=22.12.0`.

| Layer | Decision | Version | Note |
|---|---|---|---|
| Build | Vite | 8.2.2 | Native worker support if ever needed |
| UI | React + react-dom | 19.2.8 | |
| Language | **TypeScript 6.0.3 — not 7** | 6.0.3 | **See correction below** |
| Styling | Tailwind CSS + `@tailwindcss/vite` | 4.3.3 | v4 is CSS-first: `@import "tailwindcss"`, `@theme` directive, no `tailwind.config.js` |
| Tests | Vitest | 4.1.11 | |
| SQL editor | `@uiw/react-codemirror` + `@codemirror/lang-sql` | 4.25.11 / 6.10.0 | **See correction below** |
| Plan/AST trees | `@xyflow/react` (React Flow) | 12.11.5 | |
| Layout math | `d3-hierarchy` | 3.1.2 | |
| Animation | `motion` | 13.1.1 | |
| Hosting | **Cloudflare Pages — not Vercel** | — | **See correction below** |

### Correction A: TypeScript 6.0.3, not 7.x

TypeScript 7.0 is GA (7.0.2, with 7.1 nightlies building daily) and is the Go rewrite — 8–12× faster builds. Tempting. But **[verified from the npm registry]**: `typescript-eslint@8.69.0` declares its peer dependency as `typescript: ">=4.8.4 <6.1.0"`. It **explicitly excludes TypeScript 7.** The cause is that TS 7.0 ships with no stable programmatic compiler API; a replacement is expected in 7.1, targeted around **October 2026** **[sourced]**.

So it's a straight trade: type-aware linting, or a faster compiler on a codebase that will take under two seconds to typecheck either way. Take the linting. Pin 6.0.3, revisit after 7.1 lands and typescript-eslint ships support. (Vite/`@vitejs/plugin-react` transpile via esbuild/SWC and don't typecheck, so this only affects `tsc --noEmit` and the editor.)

### Correction B: use CodeMirror 6, don't hand-roll the editor

§8 proposes "a styled `<textarea>` with basic syntax highlighting is enough." Those two things are in conflict — a `<textarea>` **cannot** do syntax highlighting. Getting there means the overlay hack: a syntax-highlighted `<pre>` positioned pixel-perfectly behind a transparent textarea, kept in sync on scroll. It's a well-known tar pit (font metrics, scroll sync, IME, mobile) and it will eat days that §12 says belong to animation polish.

CodeMirror 6 is the right call: **~50kB tree-shaken for a basic editor** vs. Monaco's **2–5MB** (Sourcegraph's migration cut 2.4MB, 43% of their search page's JS) **[sourced]**. `@codemirror/lang-sql` gives SQL highlighting and completion out of the box. It also unlocks a feature the plan wants anyway — inline error squiggles from your own parser, which makes the parser stage feel real.

Note the competitor chose Monaco; on a static-hosted teaching tool that's megabytes of payload for features nobody needs here.

### Correction C: Cloudflare Pages, not Vercel

§11 says "Vercel or Cloudflare Pages." They are not equivalent **[sourced]**:

- **Vercel Hobby is non-commercial only** — prohibited by ToS for revenue-generating use. §13 contemplates "course/curriculum packaging," which would breach it. Moving later means $20/seat Pro.
- **Bandwidth behaviour on a traffic spike differs sharply.** Vercel Hobby caps at 100GB/month and **pauses the site** past it. Cloudflare Pages serves unlimited static bandwidth. For a tool whose growth path is "gets posted to Hacker News / r/programming," being taken offline by your own success is the exact wrong failure mode.
- Cloudflare Pages free: unlimited sites, unlimited static requests, 500 builds/month.

QueryLens v0 is a pure static SPA, so Cloudflare's Workers-side limits (100k req/day, 10ms CPU) never apply. Choose Cloudflare Pages now — it costs nothing to pick correctly at the start, and §11's $0 target survives contact with a traffic spike.

---

## 6. Engine design questions the plan leaves open

### 6.1 Events are deltas — derive state by folding, don't store snapshots

§7.8's event union is **deltas** (`{stage:"buffer", action:"hit", pageId:3}`), but §4 describes each stage as "a discrete, inspectable state snapshot." Those are different data models and the ambiguity will bite at the first step-back. **[judgment]**

Keep the deltas — they're the better contract — and derive view state by folding:

```ts
const stateAt = (events: StepEvent[], n: number) =>
  events.slice(0, n).reduce(applyEvent, initialState);
```

Memoise per index, or keep a running state and apply an inverse on step-back. Don't deep-clone the whole engine per step: it bloats memory, makes events non-diffable, and — the real cost — you lose the ability to animate *the transition*, which is the entire product. An eviction should be a frame visibly leaving, not frame-grid-N replaced by frame-grid-N+1.

Add a `label: string` (human-readable narration) and a `predictable?: PredictionPrompt` field to the event type now, while it's cheap. The narration line is what turns the animation into a lesson, and `predictable` is the hook for §1's prediction layer.

### 6.2 Making Volcano iterators emit events

§7.4 picks the pull-based Volcano model — correct, and it maps beautifully to stepping, since each `next()` is a natural tick. Two ways to get events out **[judgment]**:

- **Trace buffer (recommended for v0):** pass an `emit(event)` callback down into every operator; run to completion; return the array. Simplest possible thing, and it works because we're pre-computing anyway (§2).
- **Generators (if we ever need laziness):** `function* next(): Generator<StepEvent, Row | null>`. Operators yield events and return rows; the driver pumps them. This gives genuinely pausable execution — worth remembering if v1 adds a large dataset or the concurrent-query demo, but it's more machinery than v0 needs.

### 6.3 B+Tree: the split rule that causes most bugs

M4 is the plan's longest milestone (2–3 weeks) and this is where implementations usually go wrong. The rule, stated precisely **[sourced]**:

- **Leaf split → COPY up.** The separator key goes to the parent *and stays in the leaf.* Every key must remain present in the leaves, since leaves hold all the data entries.
- **Internal split → PUSH up.** The middle key moves to the parent and is *removed* from the node.

Applying leaf semantics to internal nodes (or vice versa) is the classic off-by-one and it produces a tree that looks plausible and silently returns wrong results. Write property-based tests **before** the visualization: insert N random keys, then assert (a) every inserted key is findable, (b) leaves are in sorted order via the sibling chain, (c) all leaves are at equal depth, (d) every node except the root is at least half full. Authoritative reference: CMU 15-445 Lecture 7 "Tree Indexes."

Also: use **small node fan-out (3–4 keys)** so splits happen constantly and are visible. Realistic fan-out is in the hundreds and would never split on a demo dataset — this is a case where the *simplified* model teaches better, and the disclaimer covers it.

### 6.4 Accessibility — cheap now, expensive to retrofit

An animation-centric tool has real obligations **[sourced]**:

- **WCAG 2.2.2 (Pause, Stop, Hide)** applies to auto-playing motion over 5 seconds. §8's Play/Pause/Step controls already satisfy this — worth knowing you get it for free.
- **`prefers-reduced-motion` is not sufficient on its own** and doesn't replace those controls; you need both. Honour the media query by snapping between states instead of tweening.
- **Keyboard shortcuts are specifically noted as important for learners in training settings.** Space = play/pause, ←/→ = step. Trivial now, invasive later.

---

## 7. Suggested changes to the plan

| § | Current | Change to | Why |
|---|---|---|---|
| §4, §8 | Playback controls only | **+ Predict-then-reveal, + editable seed data** as MVP scope | The one variable the evidence supports (§1) |
| §5, §6 | Engine in Web Worker | Pure sync module, worker-ready | Step-back needs full history anyway (§2) |
| §7.5 | LRU only | Pluggable policy; ship LRU **+ clock sweep** | Honesty goal + better animation (§3) |
| §6 | "Vercel or Cloudflare Pages" | **Cloudflare Pages** | ToS + bandwidth (§5C) |
| §6 | TypeScript (unversioned) | **Pin 6.0.3** | typescript-eslint excludes TS 7 (§5A) |
| §8 | Styled `<textarea>` | **CodeMirror 6** | textarea can't highlight; ~50kB (§5B) |
| §9 | Ask users "is it helpful?" | **Post-test vs. a text-explanation control** | Self-report is the measure that failed (§1) |

Milestone impact: M0 shrinks (no worker wiring). M3 grows slightly (second eviction policy). A new ~1 week of prediction-layer work is best folded into M5/M7 rather than bolted on at the end. Net effect on the ~10–14 week estimate: **roughly neutral.**

---

## 8. Open questions for you

1. **Does the prediction layer belong in the MVP?** This is the biggest call. It's the one change the evidence most supports, and it slightly delays "full pipeline animates end-to-end." I'd do it — a beautiful animation nobody learns from is the failure mode the meta-study describes.
2. **Which query does the vertical slice use?** §9 says indexed point lookup (`WHERE id = 5`). It's the right *first* one, but a point lookup touches only ~3 pages and never evicts — so it makes the buffer pool, your best differentiator, look boring. Consider building the **sequential scan on a non-indexed column** as the *second* query and demoing them side by side; the eviction storm in the scan is what makes the index lookup feel like magic.
3. **Is the `.dc.html`-style single-file offline build worth targeting later?** (pev2's distribution trick — instructors can hand out one file.) Not an MVP concern, but it may influence keeping the bundle dependency-light.

## Sources (Part I)

- [A Meta-Study of Algorithm Visualization Effectiveness](http://s3.amazonaws.com/publicationslist.org/data/helplab/ref-52/JVLC-AVMetaStudy.pdf) — Hundhausen, Douglas & Stasko (read in full)
- [Reevaluating and Refining the Engagement Taxonomy](https://dl.acm.org/doi/pdf/10.1145/1597849.1384397) — Lauer
- [Extending the Engagement Taxonomy](http://cs.joensuu.fi/pages/int/pub/myller09.pdf) — Myller et al.
- [sql-execution-visualizer (GitHub)](https://github.com/ashwin-athappan/sql-execution-visualizer) · [live](https://sql-execution-visualizer.vercel.app/)
- [pev2 (GitHub)](https://github.com/dalibo/pev2) · [explain.dalibo.com](https://explain.dalibo.com/) · [DuckDB Explain Visualizer](https://db.cs.uni-tuebingen.de/news/duckdb-explain-visualizer/)
- [CMU 15-445 Project #2 B+Tree](https://15445.courses.cs.cmu.edu/spring2026/project2/) · [BusTub B+Tree Printer](https://15445.courses.cs.cmu.edu/fall2024/bpt-printer/) · [Lecture 7: Tree Indexes](https://15445.courses.cs.cmu.edu/fall2021/notes/07-trees.pdf)
- [PostgreSQL Clock-Sweep and Buffer Management](https://kenwagatsuma.com/blog/postgresql-clock-sweep-and-buffer-management) · [MySQL vs PostgreSQL Internals: Buffer Pool](https://kernelmaker.github.io/mysql-vs-pg-bufferpool) · [Evolution of Buffer Management in Database Systems](https://arxiv.org/pdf/2512.22995)
- [Vite — Web Workers](https://vite.dev/guide/features#web-workers)
- [Migrating from Monaco to CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror) · [Monaco vs CodeMirror 6 (2026)](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)
- [TypeScript 7.0 GA: who should wait](https://blog.codercops.com/blog/typescript-7-0-ga-migration-playbook-2026/) · [InfoQ: TypeScript 7.0 released](https://www.infoq.com/news/2026/08/typescript-7-released/)
- [Cloudflare Pages free tier limits 2026](https://temps.sh/blog/cloudflare-pages-free-tier-limits-2026) · [Vercel vs Cloudflare Pages](https://speedvitals.com/blog/cloudflare-pages-vs-vercel/)
- [WCAG Pause/Stop/Hide and prefers-reduced-motion (w3c/wcag#3766)](https://github.com/w3c/wcag/issues/3766) · [web.dev: Animation and motion](https://web.dev/learn/accessibility/motion)

---

## Part II — Production readiness

Second research pass, done 2026-09-02, **after** M0–M7 shipped and before the first public deploy.
Part I asked "is this worth building and is the design right." This part asks one narrower question:
**what has to be true before this URL is handed to strangers.**

Verdict up front: **the application is done; the production surface around it barely exists.** Six things
are missing that would each be felt on day one, and four of the six are under an hour of work. Nothing
found here says "don't deploy" — it says the current failure modes are silent ones, and silent is the
expensive kind.

Same confidence labels as Part I: **[verified]** = I ran it or read the source. **[sourced]** = credible
secondary source. **[judgment]** = my reasoning.

---

## 9. First, scope the checklist honestly

Most "production readiness" checklists are written for a service: secrets management, database backups,
rate limiting, PII handling, on-call rotations, SOC 2, blue/green cutover, connection-pool tuning. For
QueryLens, **almost none of it applies, and pretending otherwise is how a two-day hardening pass turns
into a three-week one.** There is no server, no database, no auth, no session, no user data, no
third-party call, no secret. `runQuery` is a pure function over a string and an array, and the whole
application is a folder of static files.

What is genuinely left is a short list, and it is worth naming precisely because the list is short: **[judgment]**

1. **Does it survive its own bugs** — an uncaught throw in the browser is the total outage here.
2. **Can anyone tell when it breaks** — with no server there are no logs, no 500 rate, no alert.
3. **Is the artifact reproducible and reversible** — same input, same bundle; and a way back.
4. **Is the supply chain that produced the bundle trustworthy** — the only code execution risk in the product.
5. **Does the browser know what the page is allowed to do** — headers, since there is no runtime to enforce anything.
6. **May other people legally use it** — the growth path in §13 is instructors forking it.
7. **Does it load and respond fast enough on the audience's hardware** — a lecture-hall laptop, not yours.

Everything below is one of those seven. Anything that is not one of those seven is ceremony, and §21
lists what I deliberately left out.

---

## 10. Nothing currently enforces the checks that already pass

**[verified]** `pnpm test` → 281 tests across 13 files, green. `pnpm typecheck`, `pnpm lint`, `pnpm build`
→ all green. And **there is no `.github/` directory at all** — no workflow, no CI, no required check.

The gap is not test quality; it is that all of that quality is opt-in on a laptop. With a Cloudflare Pages
Git integration, whatever lands on `main` is what the world gets, typechecked or not. The single highest
value-per-line change in this entire document is a ~40-line workflow that runs the four commands that
already exist.

Two hardening details that are free if done at the start and irritating to retrofit **[sourced]**:

- **Pin every action to a full 40-character commit SHA, not a tag.** Tags are mutable, and both of the
  major CI supply-chain incidents exploited exactly that: `tj-actions/changed-files` (March 2025) had all
  its version tags rewritten across roughly 23,000 dependent repos and exfiltrated CI secrets from every
  workflow that ran in the window; `trivy-action` (March 2026) had 75 of its 76 tags force-pushed. Datadog's
  2026 research puts the share of organisations that never SHA-pin any action at **71%**.
- **`permissions: contents: read` at the workflow top level**, elevated per job only where a job needs
  more. GitHub's own guidance is default-read, raise deliberately. This repo's CI needs nothing but read.

There are no secrets to leak here today, which is precisely why it is cheap to establish the habit now —
the first secret this repo ever holds will be a Cloudflare deploy token.

---

## 11. A crash today is a white screen with no message

**[verified]** `grep -rn "ErrorBoundary\|componentDidCatch\|getDerivedStateFromError\|window.onerror\|unhandledrejection" src/` returns **nothing**. There is no boundary anywhere in the tree
and no global handler.

The engine's *expected* failures are handled well — `runQuery` returns errors as values
([runQuery.ts](src/engine/runQuery.ts): unparseable SQL, unknown table, unknown column all return
`{ events, rows: [], error }`), and the UI renders them as CodeMirror squiggles. That is the good half.
The missing half is the *unexpected* throw: a B+Tree invariant that holds for the seed data but not for
data the user typed, an `undefined` index into a page, a React render error in a panel. Any of those
unmounts the entire application and leaves a blank page — no message, no way back, no way to report it.

Two things make this more likely here than in a typical app **[judgment]**:

- **M6.5 made the seed data user-editable**, so the engine's input is now user-controlled. Every property
  test in `src/engine/__tests__` runs against generated or seed-shaped data; a user can type shapes no test
  has seen.
- **The UI is a fold over an event array.** A single malformed event doesn't degrade one panel; it can throw
  inside `applyEvent` and take the whole render with it.

Mechanics worth knowing before writing it **[sourced]**: as of React 19 **error boundaries are still class
components** — there is no hook equivalent — but `createRoot` now accepts `onUncaughtError`,
`onCaughtError` and `onRecoverableError` as root options. They complement boundaries rather than replacing
them: the root callbacks are the reporting hook, the boundary is the thing that renders a fallback.

The design that fits this product specifically: **the fallback should offer the repro.** The complete state
that produced any crash is a SQL string, a seed table, a policy name and a step index — all serialisable,
all already in `App`. A fallback that renders "something broke; here is your query and data, copy it into
an issue" turns the worst UX moment in the product into the only bug report you will ever actually receive.
That is a five-minute feature that no telemetry vendor can sell you.

---

## 12. Nobody will tell you it broke

There is no telemetry of any kind. For a static site that is a defensible position — but it collides
with plan.md §9, which makes the whole validation strategy depend on **5–10 real users** completing a
session. If the app throws on their browser, or the CodeMirror bundle fails to load on a slow campus
network, the study returns "it didn't work for me" with no stack trace and no way to distinguish a
teaching failure from a bug. **[judgment]**

The options, with their real costs:

| Option | Cost | What it buys |
|---|---|---|
| Nothing (status quo) | $0, zero bytes | Honest "nothing leaves your browser" claim stays literally true |
| Error boundary with a **copyable repro** | ~40 lines, zero bytes | The only bug reports you'd get anyway, but reproducible |
| Cloudflare Web Analytics | free, ~1 script | Pageviews. **Still processes IPs and user agents, which are personal data under GDPR even with no cookies** **[sourced]** |
| Plausible / Fathom / Umami class | ~$9/mo or self-host | Cookieless, no consent banner claimed, aggregate only **[sourced]** |
| Sentry free tier | free to 5k errors/mo, ~30 kB SDK, a third-party `connect-src` | Actual stack traces, with `build.sourcemap: 'hidden'` uploaded but not served **[sourced]** |

**Recommendation: the copyable-repro boundary before deploy; defer the vendor decision until the §9 study
is actually scheduled** — that is the week silent breakage starts costing real data, and not before.
**[judgment]** Note that "no backend, no accounts, no telemetry, nothing leaves your browser" is a genuine
feature for a classroom tool, not merely an absence; if it is given up, it should be given up on purpose
and said out loud in the README, not drifted away from.

---

## 13. Content-Security-Policy: measured, not guessed

**[verified — I ran this]** I served the real `dist/` over a local static server with a strict policy
injected, loaded the app, ran a query, and read the console.

**The good news is better than expected.** The production `dist/index.html` contains **zero inline
scripts** — Vite emits `<script type="module" crossorigin src="/assets/…">` and nothing else. So
`script-src 'self'` works with **no hashes and no nonces**, which is the clean case a pure static SPA is
supposed to get and frequently doesn't **[sourced]**. There were no `script-src`, `img-src`, `font-src` or
`connect-src` violations at all.

**The bad news is specific and would have shipped broken.** Under `style-src 'self'` the SQL editor loses
every style — line numbers stack, syntax highlighting disappears — and the console reports:

```
Applying inline style violates the following Content Security Policy directive 'style-src 'self''.
```

The cause, traced to source: CodeMirror styles itself through `style-mod`, which in a normal document takes
the `<style>`-element path — `doc.createElement("style")` and then `this.styleTag.textContent = text`
(`style-mod@4.1.3/dist/style-mod.cjs:93,128`). The `adoptedStyleSheets` path above it is skipped because it
is guarded on `!root.head`, and a document has a head. So CodeMirror writes an inline stylesheet at runtime,
and a strict `style-src` blocks it. **[verified]**

**Hashes are not a way out.** `style-mod` rewrites `textContent` as further modules mount, so the content
is not stable across the session, and React Flow's inline `style` attributes fall under `style-src-attr`
where hashes don't apply without `'unsafe-hashes'` anyway. The right call is `'unsafe-inline'` **for styles
only** — a far smaller concession than the script-side equivalent, and now a decision with a reason
attached rather than a copy-pasted default. **[judgment]**

The policy that I verified renders and runs correctly, end to end:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Two notes. `frame-ancestors` is **ignored in a `<meta>` tag** and must be a real response header — which
`public/_headers` already gives us, so this costs nothing. And `connect-src 'self'` will have to be edited
the day analytics or Sentry is added; that is a feature, not friction — it makes §12's decision visible in
a diff instead of silent.

---

## 14. The rest of the headers

`public/_headers` currently sets caching, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin` **[verified]** — a good start, and both of those are on
every 2026 list. Missing, in descending order of value **[sourced]**:

- **`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`** — two years, the value that
  makes a domain eligible for the preload list.
- **CSP** — §13.
- **`Permissions-Policy: geolocation=(), microphone=(), camera=()`** — the app uses no device APIs, so deny
  them all; free, and it shows up on every scanner.
- **`Cross-Origin-Opener-Policy: same-origin`** — blocks cross-origin window access.
- **Do not add `X-Frame-Options`.** CSP's `frame-ancestors` supersedes it, and `X-XSS-Protection` is
  deprecated and harmful. The 2026 advice is to *drop* headers, not accumulate them.

Verification is a URL, not an argument: Mozilla Observatory and securityheaders.com both grade this
configuration, and A+ is achievable for a static site with no exceptions or excuses. **[sourced]**

---

## 15. Supply chain: the only real code-execution risk in the product

`pnpm audit --prod` is clean today **[verified]**, and the dependency tree is 305 packages in the store for
an application with no backend. The threat is not a known CVE; it is the next compromised release of a
package already in the tree. 2025–26 made that concrete: the **Shai-Hulud** worm compromised **796 packages
with 132M monthly downloads**, Glassworm followed in early 2026, and the **Axios** compromise in March 2026
hit one of the most-downloaded packages on npm through credential theft. **[sourced]**

A lockfile pins what is installed but does nothing the moment you intentionally upgrade or add a package —
which is exactly when the compromised version arrives. The time-delay defence is the one that covers that
window, because **most malicious packages are detected and removed within days of publication**. **[sourced]**

- **pnpm v11 defaults `minimumReleaseAge` to 1440 minutes (one day)** **[sourced, pnpm docs]**. But
  `pnpm config get minimumReleaseAge` here returns `undefined` **[verified]** — we are relying on an implicit
  default from whichever pnpm the machine or CI happens to run. **Commit it explicitly, and raise it to
  10080 (7 days).** This project has no reason to want a package the day it ships. **[judgment]**
- **`blockExoticSubdeps: true`** — stops a transitive dependency resolving from a git URL or tarball.
- **Explicit `allowBuilds`** rather than blanket approval of postinstall scripts.
- **`--frozen-lockfile` in CI**, which is the lockfile's actual enforcement point.
- **Renovate or Dependabot**, grouped and on a schedule — an unmaintained lockfile is its own risk, and
  batching upgrades pairs correctly with a 7-day release-age floor.

---

## 16. The bundle is one 807 kB chunk

**[verified — build output]**

```
dist/assets/index-BtKTZAVR.css   44.69 kB │ gzip:   8.29 kB
dist/assets/index-g0DuG2fw.js   807.51 kB │ gzip: 261.38 kB   (Vite warns: >500 kB)
```

Everything is in one chunk, so the first paint pays for CodeMirror (~370 kB raw / ~120 kB gzip, per the
README's own measurement) **and** React Flow + d3-hierarchy (~62 kB gzip) — even though the trees render
nothing until the user presses Run. The editor is needed immediately; the graph panels are not. That is a
textbook split, and Vite 8's Rolldown backend exposes it through `build.rolldownOptions` **[sourced]**.

The metric that actually matters is not the byte count, though. Core Web Vitals thresholds are LCP < 2.5 s,
**INP < 200 ms**, CLS < 0.1, judged at the **75th percentile of field data** — and **INP is the most
commonly failed vital in 2026, with 43% of sites over the line** **[sourced]**. For QueryLens, INP is
the one to watch on principle: pressing → re-folds the event stream, re-derives view state and re-lays out a
React Flow graph, all inside one keypress-to-paint. That is *literally* an interaction-to-next-paint, and
it is the interaction the whole product is built around.

I have **not** measured it, and the honest recommendation is to measure before optimising **[judgment]**:
`createTraceProjector` already memoises per index, so stepping may well be fine. What to do now is put a
**bundle-size budget in CI** (fail the build if the entry chunk exceeds a set gzip size) and a **step-latency
assertion in a test**, so a regression is caught by a machine rather than by a student on a slow laptop.

---

## 17. Accessibility is a strong claim with no regression test

The README reports a composited-contrast sweep across every pipeline stage finding **zero elements below
WCAG AA**, and it found a real bug (CodeMirror's light-background `defaultHighlightStyle` rendering keywords
at 1.6:1). That is better diligence than most projects manage. The problem is that it was a **one-off
measurement, and there is nothing to stop the next style change undoing it** — no axe, no
`eslint-plugin-jsx-a11y` **[verified: not in `package.json`]**, no test.

Context on the bar **[sourced]**: European Accessibility Act enforcement began **28 June 2025**;
EN 301 549 currently references WCAG 2.1 AA, with **v4.1.1 expected during 2026 to incorporate WCAG 2.2**.
Whether the EAA legally binds a free educational tool with no commerce is genuinely doubtful — but the
target user is universities and training programmes, and "meets WCAG 2.2 AA" is a procurement checkbox
there. It is worth being able to say it truthfully. **[judgment]**

Calibration matters when picking tooling: **automated engines catch roughly 30–57% of WCAG failures**;
the rest only surface under keyboard, screen-reader and cognitive-load testing **[sourced]**. So axe in CI
is a **regression net** — it protects the work already done — and not a compliance claim. The manual sweep
stays the real check, and should be repeated at each visual change, not annually.

---

## 18. The tests stop exactly at the engine boundary

**[verified]** All 13 test files live in `src/engine/__tests__`. `@testing-library/react`, `jsdom` and
`src/test/setup.ts` are installed and wired into `vite.config.ts` — and **not one test uses them**.

So the parser, planner, buffer pool, B+Tree and executor are covered by 281 tests, while the code most
likely to break in front of a user has none: playback gating, the prediction gate array
(`gates[i]` = "do not advance past step i"), the keyboard shortcuts, the data editor's per-column type
preservation, the viewport framing. Several of those are called out in the README as subtle, which is
exactly the profile of code that needs a test.

The highest-value additions, in order **[judgment]**:

1. **One Playwright smoke test** — load the built app, press Run, step to the end, assert the result rows.
   This is the test that catches "the deploy is broken," which no unit test can.
2. **Testing Library tests for the gates** — prediction blocks advancement, answering unblocks it,
   step-back never re-locks.
3. **A data-editor test** — types survive an edit round-trip, since the README calls that out explicitly.

Coverage thresholds are worth turning on at the same time, if only to stop the number sliding.

---

## 19. Licensing: the repo is public and has no licence

**[verified]** No `LICENSE` file, and the remote is a public GitHub repository. Under default copyright
that means **all rights reserved**: nobody may legally fork it, an instructor may not adapt it for a
course, and no university will touch it. That directly blocks plan.md §13's "course/curriculum packaging"
and Part I §4's observation that pev2's handout-a-single-file distribution is a strong move for a teaching
tool.

MIT is what this audience expects and is the shortest path; Apache-2.0 adds an explicit patent grant and
is the safer choice if institutional adoption is a goal. Either is fine, and **not choosing is the only
bad option**. **[judgment]** The existing decision to keep React Flow's attribution badge already respects
their licence; a short third-party-notices line in the README closes the loop.

---

## 20. Deploy mechanics: the boring parts that get skipped

- **Hosting stands.** Cloudflare now steers *new* projects toward Workers with static assets, but **Pages
  remains fully supported with no forced migration and no deadline** **[sourced]**. For a pure static SPA,
  Workers buys nothing today. The trigger to revisit is concrete: the first time this project wants any
  server-side piece — an error-beacon endpoint, hosting for the §9 study — that is the moment to migrate,
  not before.
- **Version stamp.** There is no way to tell which commit is live. A commit SHA in a `<meta>` tag and a
  console banner makes every bug report say which build it came from. Minutes of work.
- **Rollback.** Cloudflare Pages retains previous deployments and rolls back in one click. That is fine —
  but it needs to be *written down*, because the moment it is needed is the moment nobody is reading docs.
- **`404.html`.** The app has no client-side routing, so no SPA redirect rule is needed (as the README
  says) — but a typo'd path currently gets Cloudflare's default 404 rather than a way back to the app.
- **The front door is a link preview.** `index.html` has `og:title`, `og:description` and
  `twitter:card: summary` — but **no `og:image`** **[verified]**, no canonical URL and no `robots.txt`.
  For a tool whose distribution path is a link posted to Hacker News, Reddit or a course page, the preview
  card *is* the landing page, and it is currently a grey box. A single screenshot of the buffer pool
  mid-eviction is the cheapest marketing this project will ever get.

---

## 21. What I deliberately left out

Naming the non-work is part of the recommendation, because a padded checklist is how this pass fails. **[judgment]**

- **Secrets management, key rotation, WAF, rate limiting, DDoS planning** — no server, no secrets, and
  Cloudflare absorbs the traffic side on the free tier.
- **Subresource Integrity on our own assets** — SRI defends against a compromised third-party CDN; our
  assets are same-origin, content-hashed and covered by `script-src 'self'`.
- **Cookie consent banner** — no cookies, no storage, nothing to consent to. This only becomes a question
  if §12's analytics decision goes the wrong way.
- **A privacy policy** — nothing is collected. If that changes, one paragraph, not a document.
- **Uptime monitoring** — a static asset on Cloudflare's edge; if it is down, so is a large slice of the web.
- **Docker, staging environments, blue/green** — Pages preview deployments per branch already provide
  the only staging this needs, free.
- **SLOs, on-call, incident severity levels** — for a solo project with no users yet, this is cosplay.
  Revisit if a university ever depends on it in a scheduled lecture.

---

## 22. Suggested changes to the plan (Part II)

| § | Current | Change to | Why |
|---|---|---|---|
| §10 | Milestones end at M7 | **Add M8 "Production readiness"** with an explicit deploy gate | The app is done; the surface around it is not (§9) |
| §6 | Cloudflare Pages | Keep — **add the revisit trigger** (first server-side need) | Pages is supported; Workers buys nothing yet (§20) |
| §8 | A11y = reduced motion, keyboard, contrast | **+ axe in CI as a regression net**, manual sweep stays the check | A one-off measurement decays (§17) |
| §11 | $0 hosting | Unchanged; **note the two paid forks** (analytics, domain) | Both optional, both deferred (§12) |
| §12 | Four risks, all pedagogical | **+ two operational risks**: silent client-side failure, checklist ceremony | §11, §21 |
| — | — | **New §14: Production readiness** — P0 gate / P1 first fortnight / P2 ongoing | Sequencing is the deliverable, not the list |

Estimated effort: **P0 is roughly one focused day** (CI, error boundary, headers, licence, preview image,
pnpm settings); P1 is **two to three days** spread over the fortnight after launch. Neither blocks the §9
validation study, and P0 should be done before the URL is shared with the first outside user.

---

## 23. Open questions for you

1. **Telemetry: in or out?** The "nothing leaves your browser" claim is real and worth something to this
   audience. My recommendation is to keep it and ship the copyable-repro boundary — but if the §9 study is
   happening soon with users you cannot sit next to, Sentry for the duration of the study is the pragmatic
   call. Decide once, write it in the README either way.
2. **MIT or Apache-2.0?** MIT if the goal is "anyone can grab it"; Apache-2.0 if the goal is a university
   adopting it into a course.
3. **Is the §9 study the deploy trigger, or is the deploy the study's recruiting channel?** These sequence
   differently: the first wants a private URL and P0 only; the second wants the preview image, the licence
   and the analytics decision resolved before anything is posted anywhere.

---

## Sources (Part II)

- [pnpm — Mitigating supply chain attacks](https://pnpm.io/supply-chain-security) · [npm supply chain security in 2026](https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026) · [3 pnpm settings to protect yourself](https://gajus.com/blog/3-pnpm-settings-to-protect-yourself-from-supply-chain-attacks)
- [Hardening GitHub Actions: lessons from recent attacks (Wiz)](https://www.wiz.io/blog/github-actions-security-guide) · [Pinning GitHub Actions — a complete guide (StepSecurity)](https://www.stepsecurity.io/blog/pinning-github-actions-for-enhanced-security-a-complete-guide) · [GitHub Docs — secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [Setting security headers in 2026: CSP, HSTS, COEP and what actually matters](https://www.checkfast.io/blog/securing-headers-csp-hsts-2026) · [Deploying CSP in single-page applications](https://dev.to/robertinoc_dev/deploying-csp-in-single-page-applications-2a48) · [CSP FAQ (Google)](https://csp.withgoogle.com/docs/faq.html)
- [React 19 — createRoot error options](https://react.dev/reference/react-dom/client/createRoot) · [Sentry — React error boundary](https://docs.sentry.io/platforms/javascript/guides/react/components/errorboundary) · [Why React error boundaries are still class components](https://renderlog.in/blog/why-react-error-boundaries-class-components/)
- [Core Web Vitals 2026 — LCP, INP, CLS thresholds](https://www.corewebvitals.io/core-web-vitals) · [Core Web Vitals 2026 optimisation guide](https://www.digitalapplied.com/blog/core-web-vitals-2026-inp-lcp-cls-optimization-guide) · [Vite — build options](https://vite.dev/config/build-options) · [Rolldown output options](https://rolldown.rs/reference/)
- [European Accessibility Act compliance guide (Level Access)](https://www.levelaccess.com/compliance-overview/european-accessibility-act-eaa/) · [EAA + WCAG 2.2 (OneTrust)](https://www.onetrust.com/blog/understanding-the-european-accessibility-act-and-wcag-22/) · [axe-core + Playwright accessibility testing](https://www.qamadness.com/a-you-oriented-guide-to-axe-core-playwright-accessibility-testing/)
- [Cloudflare — migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) · [Cloudflare Pages vs Workers in 2026](https://mecanik.dev/en/posts/cloudflare-pages-vs-workers-which-to-use-in-2026/)
- [Plausible — privacy-focused web analytics](https://plausible.io/privacy-focused-web-analytics) · [Analytics without a cookie banner](https://www.cookieyes.com/blog/analytics-without-cookie-banner/) · [Privacy-friendly analytics guide 2026](https://clickport.io/blog/privacy-friendly-analytics-guide)

### Verified locally on 2026-09-02

`pnpm test` → 281 passing across 13 files · `pnpm build` → 807.51 kB / 261.38 kB gzip in one chunk ·
`pnpm audit --prod` → no known vulnerabilities · `pnpm config get minimumReleaseAge` → `undefined` ·
`grep` for error boundaries → no matches · `ls .github` → does not exist · `ls LICENSE*` → no matches ·
CSP tested by serving the real `dist/` under policy and reading console violations + screenshots ·
`style-mod@4.1.3/dist/style-mod.cjs:93,128` read directly for the inline-style path.

---

## Part III — UI/UX production readiness

Third pass, done 2026-09-02, after Part II. Part II asked what has to be true before the URL is public;
this one asks the question a visitor asks: **is this good enough to hand to a stranger who has thirty
seconds and no idea what a buffer pool is.**

Method: I ran the app and drove it — desktop (1440×900), phone (375×812), first-run, a full trace, the
prediction loop, the data editor — and measured rather than eyeballed where measuring was possible
(computed contrast over composited backgrounds, computed font sizes at a doubled root size, target
rectangles, focus location, `location.href`). Screenshots and console throughout.

Verdict up front: **the interface is better built than it looks and worse composed than it is built.**
The typography, colour, contrast and keyboard work are done properly — I could not break the contrast
claim, and the a11y semantics under the hood are better than most shipped products. What is missing is
mostly *composition*: the first screen shows nothing, the primary button appears to do nothing, the
question is nowhere near the picture it is about, and nothing that happens can be shared with anyone.

Same labels: **[verified]** = I ran it. **[sourced]** = credible secondary source. **[judgment]** = mine.

---

## 24. What "production-level UI/UX" means for *this* product

Worth pinning down before listing anything, because the usual bar is the wrong bar. QueryLens has no
signup, no funnel, no retention loop and nothing to convert. Its success metric is already written down:
plan.md §9's post-test — **can someone answer a mechanism question they could not answer before.**
So the UI's job is comprehension, and every UX finding below is worth fixing only insofar as it removes
something between a learner and the mechanism. **[judgment]**

That reframing kills a lot of standard advice (onboarding tours, activation checklists, engagement
nudges) and promotes things a normal product review would rank lower — like where the question sits
relative to the diagram it refers to (§28), which turns out to have a meta-analytic effect size attached.

---

## 25. The first thirty seconds are blank, and then appear to fail

Two findings that compound into one bad first impression. **[verified]**

**The empty state is the largest thing on screen and it teaches nothing.** On load, the stage panel — a
fixed 27rem (432px) box, the biggest element in the layout — reads *"Nothing has run yet. Press Run to
build a trace, then Space to play it."* On a 375×812 phone that box is more than half the viewport, and
the playback controls sit below it, off-screen. The product's entire value proposition is invisible until
the visitor takes an action, and the thing they are asked to trust before acting is an empty rectangle.

The 2026 consensus on this is unusually direct: treat the first empty screen as the onboarding surface,
and for tools with a learning curve **a pre-populated example beats a blank start, because users learn by
modifying something that already works** **[sourced]**. QueryLens is the archetype of that case — it
already *has* a default query, a seeded table and a deterministic trace. The trace could simply be run on
mount, leaving the visitor looking at a parsed AST and a narration line instead of a grey box, with every
control still exactly where it was.

**And pressing Run looks like nothing happened.** I clicked Run and compared before/after: the stage panel
still said "Nothing has run yet", the narration still said "Press Run, then step through", and the stage
tracker was unchanged. The *only* differences were the counter going `0 / 0` → `0 / 33` in 12px type in
the corner, and the Play button becoming enabled. The user pressed the primary button in the interface
and the interface did not visibly respond.

This is the textbook failure of visibility-of-system-status, and the documented consequence is exactly
what a first-time user will do here: **click the button again, believing the first click failed**
**[sourced]**. Feedback for a sub-100ms action is not a spinner — it is a state change: advance to step 1
on Run so the parse is on screen, and say "33 steps ready" where the eye already is.

---

## 26. The layout ignores the room it is in

The stage panel is `h-[27rem]` — a fixed height, not a range. **[verified]** The comment above it gives a
real reason: *"if the panel resizes with its content, the playback controls below it move out from under
the cursor mid-step."* That is a correct observation and a wrong fix, and it costs at both ends:

- **At 1440×900**, the app stops around 740px and leaves a band of empty background below the controls —
  the visualisation stays letterboxed while the monitor has room to spare. On the widest screens the
  trees render into a panel with more empty margin than diagram.
- **At 375×812**, the same 432px box is 53% of the viewport, and on first load it is 432px of *nothing*,
  pushing Play, the scrubber and the speed control below the fold.

The constraint the comment protects — controls must not move while stepping — is satisfied by any layout
that pins the control bar rather than freezing the panel: `min-height` plus a grid whose control row
holds position, or `dvh`-based sizing on large screens. **[judgment]**

**Mobile deserves a decision rather than a default.** Mobile is 51–64% of global web traffic depending on
whose measurement you take, but developer and technical audiences skew hard to desktop **[sourced]**, and
typing SQL on a phone is nobody's plan. The realistic mobile scenario for this product is not authoring —
it is **someone opening a link a friend or lecturer sent them, on a phone, to see what it is.** That
argues for a mobile experience that is deliberately read-first: run the default trace on load, put the
step controls within thumb reach, and drop the keyboard-shortcut bar, which currently renders
`Space / ← / → / Home / ⌘↵` on a device with none of those keys. **[verified]**

Credit where due: at 375px there is **no horizontal scroll** and the page is 1218px tall — the responsive
plumbing works. This is a composition problem, not a breakage problem. **[verified]**

---

## 27. Nothing is shareable — there is no URL state at all

`location.href` never changes: it is `/` on load and `/` after typing a query, editing 48 rows of seed
data, switching the eviction policy to clock sweep and stepping to event 27. **[verified]**

For this product that is the single biggest missing *feature*, not merely a UX gap. Every scenario the
plan is built around wants a link:

- plan.md §9's validation study wants every participant to start from an identical state.
- plan.md §13's "course packaging" wants an instructor to set homework: *here is a query, predict what the
  buffer pool does.*
- Part I §4's competitive framing wants the thing that gets posted to Hacker News to be a **specific
  moment** — the eviction storm — not a home page a reader must reconstruct.
- The predict-then-reveal loop (Part I §1, the feature the evidence supports) is *made* of shareable
  moments: "step 13, which child pointer?" is a question worth sending to someone.

This is the settled convention for tools of this shape — Compiler Explorer, the TypeScript playground,
regex101 and Excalidraw all encode the interesting state in the URL, and it is why their screenshots
come with links attached. **[judgment]** The state here is small: SQL string, policy, prediction on/off,
step index, and seed rows only when edited — comfortably a compressed query parameter, and it stays
inside the "nothing leaves your browser" promise, since a URL is not a request to us.

Second-order benefit worth naming: a URL that survives a refresh also fixes the fact that **a reload
today silently discards an edited dataset** — a real loss-of-work moment in a product that explicitly
invites people to construct their own data. **[verified: state is `useState` only, nothing persisted]**

---

## 28. The question is nowhere near the picture it is about

The prediction card renders in the left sidebar, roughly 200px wide, while the visual it refers to fills
a ~900px panel on the right. At the B+Tree step the mismatch is starkest: the prompt reads *"Node n8
separates on 10 19 28 37. Looking for 5 — which child pointer does the search follow?"* while the panel
on screen is showing **the Buffer Pool** — the tree the question is about is not visible anywhere.
**[verified: `aria-current="step"` was on Buffer Pool while that prompt was displayed]**

The tell is in the prompt text itself: it has to *recite* the node's keys in words because it cannot rely
on the learner seeing them.

This is the one finding with hard numbers behind it. The **spatial contiguity principle** — people learn
more when related words and pictures are near each other — and its inverse, the **split-attention
effect**, are among the better-replicated results in multimedia learning: a meta-analysis of **58
independent comparisons found g = 0.63** for integrated over separated designs **[sourced]**. Separated
sources force mental integration, which consumes the working memory that should be doing the learning.

That effect size is comparable to the one Part I used to justify building the prediction feature at all.
Having built it, putting it 900px from its referent gives back a chunk of what it bought. The fix is
placement, not new functionality: **render the prompt against the panel it concerns** — anchored to the
buffer grid for an eviction question, over the tree for a traversal question — and make the stage panel
show the stage the question is about before asking it. **[judgment]**

---

## 29. The data editor breaks the modal contract in three measurable ways

The dialog is marked up correctly — `role="dialog"`, `aria-modal="true"`, `aria-label` — and then does
none of the behaviour those attributes promise. Measured with the editor open: **[verified]**

1. **Focus is never moved into the dialog.** After clicking "Edit data", `document.activeElement` is still
   the "Edit data" button *behind* the overlay (`dialog.contains(activeElement) === false`).
2. **Escape does not close it.** With focus outside, pressing Escape leaves it open — the handler is a
   React `onKeyDown` on the dialog element, so an event that starts on `<body>` never reaches it. The
   escape hatch works only after the user has already clicked inside.
3. **Tab walks straight into the page behind.** Two Tab presses from the opened state land on an input
   outside the dialog; the background is neither `inert` nor trapped.

There is no reason to hand-roll any of this in 2026. `<dialog>` with `showModal()` has been Baseline
widely available since March 2022 (~96% of users) and supplies the top layer, the backdrop, the focus
trap, the inert background and Esc-to-close for free; the newer `closedby` attribute adds click-outside
dismissal declaratively **[sourced]**. Swapping the hand-built overlay for the native element deletes
code and fixes all three defects at once.

Two smaller things in the same component: the per-row delete `×` is an unconfirmed destructive action with
no undo (mitigated, but not replaced, by "Reset to seed"), and focus is not restored to the triggering
button on close. **[verified from source]**

---

## 30. Dark-only, and the browser is never told

`<html class="dark">` is hardcoded, the token block defines exactly one palette, and there is no
`prefers-color-scheme` handling anywhere. Two distinct problems. **[verified]**

**The cheap one:** `getComputedStyle(document.documentElement).colorScheme` is `"normal"`. The page never
declares `color-scheme: dark`, so the browser keeps painting native UI for a light page — scrollbars, the
`<select>` popup, form-control chrome and the text caret. It is a one-line fix with a visible payoff.

**The real one:** there is no light theme. The usual "dark mode is more accessible" claim does not hold —
roughly **one in three adults has astigmatism, for whom light-on-dark text produces halation** (blur and
haloing that causes headaches), which is why the current guidance is to offer the choice rather than
pick for the user **[sourced]**. There is also a use case specific to this product: **lecture halls and
projectors**, where dark UIs wash out and a light theme is what actually gets read from the back row.
plan.md §13's course-packaging path runs directly through a projector. **[judgment]**

The groundwork is already right: every colour is a semantic token in `@theme`, so a light palette is a
second block of variable values plus a toggle, not a redesign. Doing it while there are 8 tokens is
cheap; doing it after a year of one-off colours is not. Note that the existing palette avoids pure black
and pure white, which is the other half of the halation advice, and should stay that way. **[verified]**

---

## 31. Four small things, each measured

- **`⌘` is shown to every user on every platform.** The binding is correct — CodeMirror's `Mod-Enter`
  resolves to Ctrl off macOS — but both labels ("Run ⌘↵" and the shortcut hint) hardcode the Command
  glyph, and there is **no platform detection anywhere in `src/`** **[verified: grep]**. Most of the
  student audience is on Windows or Linux and is being told to press a key their keyboard does not have.
- **Eight elements are pinned at 10–11px and ignore the user's font-size setting.** Tailwind's scale is
  rem-based, so almost all type scales correctly — I doubled the root font size and everything moved,
  *except* the eight `text-[10px]` / `text-[11px]` arbitrary values, which stayed exactly 10px and 11px
  while their neighbours doubled **[verified]**. These are the keyboard hints and the stages badge. Page
  zoom still scales them (so WCAG 1.4.4 is not the issue) — but the default-font-size setting is the
  accommodation many low-vision users actually use, and these opt out of it.
- **The scrubber is 16px tall** — under WCAG 2.2's SC 2.5.8 Target Size (Minimum) 24×24 CSS px, an AA
  criterion **[verified: measured rect; [sourced] for the threshold]**. It is also the control a touch
  user needs most, since they have no arrow keys. (SC 2.5.7 Dragging Movements is *satisfied* — the
  step buttons are a single-pointer alternative to dragging the slider.)
- **The keyboard-shortcut bar renders on touch devices**, advertising Space, ←, →, Home and ⌘↵ to a
  phone. **[verified at 375px]**

---

## 32. What is already right, and should not be touched

Naming this matters as much as the findings, because a "make the UI production-level" mandate is exactly
how working things get rewritten. **[verified unless noted]**

- **Contrast passes.** I re-ran a composited sweep (walking each element's ancestor chain, compositing
  translucent layers, converting OKLCH/OKLab properly): **66 text elements, zero below WCAG AA, lowest
  ratio 5.29:1.** The README's claim still holds on the default screen. Two earlier versions of my own
  script reported dozens of failures — both were colour-parsing bugs, which is a fair warning about
  automated contrast tooling on an OKLCH codebase.
- **The semantics are better than average**: `aria-current="step"` on the pipeline tracker, `aria-live`
  on the narration and the prediction card, per-cell `aria-label`s in the data grid, real `<button>`s
  throughout, a global `:focus-visible` ring, `<header>`/`<main>` landmarks.
- **Reduced motion is honoured** in CSS and in the JS viewport animation, alongside — not instead of —
  the Play/Pause controls, which is what WCAG 2.2.2 actually requires.
- **The prediction feedback is genuinely good**: "Right." / "Not quite." with a substantive explanation of
  *why*, plus a nudge to press → and watch it happen. This is the pedagogical core and it works.
- **No horizontal scroll at 375px**, and the fixed-height decision is *documented with its reason* — the
  reason is real even though the fix should change.

---

## 33. What I deliberately left out

- **A design-system rewrite or a component library.** Eight semantic tokens and Tailwind are correct at
  this size; adding shadcn/Radix would be a week spent to arrive where the project already is.
- **An animation library.** `motion` was removed during M7 for good reason and nothing here argues for
  bringing it back — the missing motion is a *transition* between states, which CSS already does.
- **An onboarding tour, coach marks, or a product walkthrough.** §25's fix — run the default on load — is
  the same lesson delivered by the product instead of by an overlay, and §24 says the metric is
  comprehension, not activation.
- **Mobile authoring parity.** Nobody writes SQL on a phone; §26 argues for read-first, not feature-equal.
- **Internationalisation.** The audience reads English SQL keywords; this is a v2 concern at best.
- **A visual redesign.** The look is coherent and legible. Almost nothing below is about how it looks.

---

## 34. Suggested changes to the plan (Part III)

| § | Current | Change to | Why |
|---|---|---|---|
| §8 | UI/UX plan describes panels and controls | **+ first-run behaviour, + prompt placement, + shareable URL** | §25, §28, §27 |
| §10 | Milestones end at M8 | **Add M9 "UI/UX readiness"** | Sequencing (§35) |
| §12 | Risks are pedagogical + operational | **+ "the first thirty seconds"** as a named risk | §25 |
| — | — | **New §15: UI/UX readiness**, P0/P1/P2 like §14 | The gate shape already works |

Effort: **P0 is under a day** — run-on-load, Run feedback, native `<dialog>`, `color-scheme: dark`,
platform-correct modifier key, drop shortcut hints on touch, un-pin the eight px sizes, thicken the
scrubber. **P1 is two to three days** — URL state, prompt placement against its panel, responsive height.
Light theme is P2 and is a half-day because the tokens already exist.

---

## 35. Open questions for you

1. **Run the default trace on load, or land on a curated still?** Running on load is one line and shows
   the real product. A curated frame (the buffer pool mid-eviction) is a better *poster* but is a second
   thing to maintain. I would run it on load and leave the poster to §14's `og:image`.
2. **How much state goes in the URL?** Query + policy + step is small and always shareable. Adding 48
   edited rows makes long links; a length cap with a "data was customised" note is the usual compromise.
3. **Is the light theme before or after the §9 study?** If any part of that study runs in a room with a
   projector, before.
4. **Does the prediction prompt move into the panel, or does the panel move to the prompt?** Anchoring
   prompts to their visual is the stronger fix; a middle path is simply forcing the stage panel to the
   stage the question is about, which is much less work.

---

## Sources (Part III)

- [Spatial contiguity and split-attention effects: a meta-analysis](https://link.springer.com/article/10.1007/s10648-018-9435-9) · [The split-attention principle in multimedia learning (Cambridge Handbook)](https://www.cambridge.org/core/books/abs/cambridge-handbook-of-multimedia-learning/splitattention-principle-in-multimedia-learning/497A2FCB9737E3009B3CF0E4D97F7B99)
- [Empty states as onboarding: a practical playbook](https://www.72technologies.com/blog/empty-states-as-onboarding-surface) · [Empty state UI design](https://www.setproduct.com/blog/empty-state-ui-design) · [SaaS empty state patterns](https://pixxen.com/blog/saas-empty-state-design/)
- [Visibility of system status](https://uxuiprinciples.com/en/principles/visibility-of-system-status-principle) · [Response time limits: 0.1s, 1s, 10s](https://uxuiprinciples.com/en/principles/response-time-limits) · [Doherty threshold](https://uxuiprinciples.com/en/principles/doherty-threshold)
- [MDN — `<dialog>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) · [The modern modal in 2026, without accessibility traps](https://www.dfm2html.com/tutorials/the-modern-modal-in-2026-using-the-html-dialog-element/) · [HTML dialog: accessible native modals (2026)](https://www.buildmvpfast.com/blog/html-dialog-element-accessible-modal-browser-native-2026)
- [WCAG 2.2 new success criteria explained](https://www.audioeye.com/post/whats-new-with-wcag-2-2/) · [Deque University — WCAG 2.2 updates](https://dequeuniversity.com/resources/wcag-2.2/)
- [Inclusive dark mode (Smashing Magazine)](https://www.smashingmagazine.com/2025/04/inclusive-dark-mode-designing-accessible-dark-themes/) · [The dark mode accessibility myth, debunked](https://stephaniewalter.design/blog/dark-mode-accessibility-myth-debunked/) · [Come to the `light-dark()` side](https://css-tricks.com/come-to-the-light-dark-side/)
- [Mobile vs desktop traffic share 2026 (Statista)](https://www.statista.com/statistics/277125/share-of-website-traffic-coming-from-mobile-devices/) · [Mobile vs desktop trends 2026](https://www.digitalsilk.com/digital-trends/mobile-vs-desktop-traffic-share/)

### Verified locally on 2026-09-02

Drove the running app at 1440×900 and 375×812. `location.href` unchanged across query, data, policy and
step changes · Run leaves panel, narration and tracker unchanged (`0 / 0` → `0 / 33` and Play enabling are
the only deltas) · data editor: `dialog.contains(document.activeElement) === false` on open, Escape leaves
it open, two Tabs land outside · `getComputedStyle(document.documentElement).colorScheme === "normal"` ·
root font-size doubled: all rem type scaled, the 8 `text-[10px]`/`text-[11px]` elements did not · scrubber
rect 16px tall · composited contrast sweep: 66 elements, 0 failures, min 5.29:1 · `grep` for platform
detection in `src/`: no matches · 375px: `scrollWidth === innerWidth`, document 1218px tall.

---

## Part IV — v2 research

Research pass done 2026-09-24, the day after the first deploy (`query-lens.1234naveenboddepalli.workers.dev`),
asking one question: **v1 is built and live — what should v2 be?** Method: (1) measure v1 from the repo
rather than from memory; (2) read the competition and the field's own current syllabus; (3) go back to the
learning-science evidence Part I leaned on and ask what it implies for features Part I never considered
(a quiz, confidence ratings, an AI explainer); (4) find the cheapest ways to make the engine *credible*
rather than merely correct; (5) check the biggest-ticket ideas (transactions, recovery, storage engines)
against what already exists in `src/`.

Verdict up front: **v2 should not be "more SQL."** It should be four things, in this order — *prove it
works* (run the §9 study, add a correctness oracle), *raise the engine's ceiling* to where a homework query
survives (SQL tier 2, real indexes, a cost model that decides rather than decorates), *add the two subjects
courses teach right after query execution* (transactions, then recovery), and only then *broaden into
storage engines and access methods*. **An in-app LLM should not ship; an MCP server should.** And the
project's name needs a decision before the launch post, not after it.

Confidence labels as in Part I: **[verified]** = I checked it directly this pass (ran it, fetched it,
counted it). **[sourced]** = from a credible secondary source or a search summary I could not open in
full. **[judgment]** = my reasoning, not a citation.

---

## 36. v1 in numbers **[verified]**

Counted from the repository on 2026-09-24 (commands under *Verified locally*, below).

| | |
|---|---|
| Calendar time, first commit → first deploy | **23 days** (2026-09-01 → 2026-09-23), 106 commits. §10 estimated the MVP alone at 10–14 weeks part-time |
| Source | 23.7k lines of TS/TSX (8.7k of it `src/engine/`, **zero files importing React**), plus 0.9k lines of MDX docs |
| Tests | 9.6k lines of unit tests (**1,170 tests, 56 files**), 2.0k lines of e2e (**79 tests**, incl. axe in both themes) |
| Surface | 14 top-level routes · 8 stage explainers · 9 lessons · 12 challenges · 9 `/tools/*` sandboxes · 12 docs pages |
| Engine | 8 pipeline stages · `SELECT`/`INSERT`/`UPDATE`/`DELETE` · 6 optimizer rules · 3 join algorithms · 2 aggregate strategies · 6 buffer-pool policies · cost estimates on every plan node |
| Bundle | **377.9 kB** gzip of a 424 kB budget (headroom **46 kB, 11%**); `standalone-tools` at 42.7/43, `trace-ui` at 55.5/56 — **two groups are already at their ceiling** |
| Security / a11y | securityheaders.com **A+** (live); axe: zero violations, both themes; `aria-live` narration track |
| Validation | **The §9 post-test has not been run.** No participant has used it |

**The observation that matters most for planning:** 23 days against a 10–14 week estimate says *typing
speed is not v2's constraint.* The things v1 could not buy with time are the ones v2 has to spend effort
on — evidence that it teaches, and a reason for anyone to arrive. **[judgment]**

---

## 37. The landscape — what exists, and what none of it does **[verified: fetched 2026-09-24]**

Part I §4 concluded the differentiation holds. Re-checked against what is live today:

| Tool | What it is | What it visualizes | What it does not |
|---|---|---|---|
| **sql-execution-visualizer.vercel.app** | Browser-only SQL runner (`CREATE`/`INSERT`/`SELECT`/`UPDATE`/`DELETE`) | Animated B+Tree (insert/split/delete); the logical clause order (`FROM → JOIN → WHERE → …`); an execution-plan walkthrough | By its own page: **no buffer pool, no locking, no memory management** |
| **systemdesignsimulator.org/internals** | Interview-prep site: B-Tree, **LSM Tree, Copy-on-Write B-tree, Slotted Page, Write-Ahead Log, Isolation Levels** simulators; "8-Week Interview Roadmap", "Top 50 System Design Questions" | Scripted animations per concept | On the page fetched: no quizzes or progress tracking; no SQL engine underneath (**[sourced]** — the simulators themselves were not opened) |
| **PlanetScale, "B-trees and database indexes"** (Ben Dicken) | A single, very well-made interactive essay | B-tree insert/split, keys-per-node slider | One subject. Reported at ~2 months of work for that one piece **[sourced]** |
| **Research prototypes** (NEURON, arXiv 1805.05670; TIPS, arXiv 2210.13722) | NL explanation of query plans; selection of informative *alternative* plans for teaching | Plans, not execution | Not products |

Three things follow.

1. **The breadth of scripted simulators is already someone else's.** LSM, WAL and isolation levels exist
   on a competitor as animations. QueryLens cannot win a "who has more animations" race, and should not
   enter it. Its answer must be the thing a scripted simulator cannot do: **the isolation matrix, the
   compaction cost, the recovery outcome are *computed by running the engine*, not drawn from a script**
   — and they are checkable against external ground truth (§40, §42).
2. **What QueryLens has that none of the three does** — real SQL through a real pipeline, a buffer pool
   with six policies, a write path with dirty-page writeback, external sort spilling through that pool,
   predict-then-reveal, shareable moments, presenter/print/assignment surfaces, an accessible narration
   track, and no telemetry — is the moat, and v2 should deepen it before diluting it.
3. **The interview-prep audience is real and underserved by rigour.** The competitor's framing (roadmap,
   "top 50 questions" linking to simulators) is a distribution pattern worth copying in *content*, not in
   architecture (plan.md §3 already names interview prep as target user #2). **[judgment]**

---

## 38. The syllabus test — v1 against CMU 15-445/645 Fall 2026 **[verified titles; coverage is judgment]**

The plan's first target user is "CS students taking DB courses (e.g., CMU 15-445 style curriculum)"
(§3). The course's own current schedule is the most objective coverage checklist available. Lecture
*titles* were fetched from `15445.courses.cs.cmu.edu/fall2026/schedule.html`; I did not read lecture
content, so "coverage" below is my reading of the titles against what `src/` does. **This is not a claim of
endorsement by, or affiliation with, the course.**

The syllabus's own one-line summary of the topic list: *data models · storage models (n-ary,
decomposition) · query languages · storage architectures (heaps, log-structured) · indexes + filters
(trees, hash tables, vector) · transaction processing (ACID, concurrency control) · recovery (logging,
checkpoints) · query processing (joins, sorting, aggregation, optimization) · parallel architectures
(multi-core, distributed).*

| # | Lecture | v1 | What v1 has / lacks | v2 |
|---|---|---|---|---|
| 1 | Relational Model & Algebra | ◐ | Logical plan tree, but no relational-algebra notation | 2.0 plan-as-RA toggle |
| 2 | Modern SQL | ◐ | Subset (no `OR`/`NOT`/`IN`/`LIKE`/`DISTINCT`/`HAVING`/outer joins/subqueries) | 2.0 SQL tier 2 |
| 3 | Database Storage I | ● | Heap pages; slotted-page inspector | — |
| 4 | Memory Management | ● | Buffer pool, six policies, dirty writeback | 2.4 scan resistance |
| 5 | Database Storage II | ◐ | Tuple layout ✓; **log-structured ✗** | 2.4 LSM |
| 6 | Storage Models & Compression | ○ | Row store only | 2.4 columnar + compression |
| 7 | Hash Tables | ◐ | Grace hash join's bucket collisions; no static/dynamic hashing | 2.4 hash indexes |
| 8 | Indexes & Filters I | ● | B+Tree, range scans — **unique keys only** | 2.0 non-unique/composite |
| 9 | Indexes & Filters II | ○ | No filters (Bloom), tries or vector indexes | 2.4 Bloom + vector |
| 10 | Index Concurrency Control | ○ | No latch crabbing | 2.4 latch crabbing |
| 11 | Sorting & Aggregations | ● | External merge sort; hash vs sort aggregate | — |
| 13 | Joins | ● | Nested-loop, hash, sort-merge, Grace tool — **join never uses an index** | 2.0 index nested-loop |
| 14 | Query Execution I | ◐ | Volcano ✓; materialization / vectorized ✗ | 2.4 vectorized |
| 15 | Query Execution II | ○ | No parallel execution | horizon |
| 16 | Query Planning & Optimization I | ● | Six rules, cost annotations | — |
| 17 | Query Planning & Optimization II | ◐ | Cost estimates ✓; **no join ordering, no plan enumeration, no statistics** | 2.1 |
| 18 | Concurrency Control Theory | ○ | Nothing in the pipeline | 2.2 |
| 19 | Two-Phase Locking | ◐ | `/tools/locks`: S/X, waiters, deadlock, victim — outside the engine | 2.2 |
| 20 | Timestamp Ordering | ○ | — | 2.2 |
| 21 | Multi-Version Concurrency Control | ○ | — | 2.2 |
| 22 | Database Logging | ○ | — | 2.3 |
| 23 | Database Recovery | ○ | — | 2.3 |
| 24 | Distributed Databases | ○ | — | horizon |

> **Update, 2026-09-25 (v2):** the live, maintained version of this table is the docs page
> `/docs/study/course-map` (plan.md §25.4 G1), in course-neutral topic names and with the v2 coverage — relational
> algebra, SQL tier 2, non-unique/composite/unique/bulk-loaded indexes and the index nested-loop join have all landed
> since the table below was written. The table below is left as the v1 baseline.

(12 and 25 are in-class exam-style sessions and carry no content.) **Of 23 content lectures: 6 covered (●),
7 partly (◐), 10 not at all (○).** The largest single hole is **lectures 18–23 — concurrency control
through recovery, six lectures, 26% of the course, zero covered** in the main pipeline. That is the
strongest evidence for v2's "second and third subject" pillar, and it is independent of anyone's taste.
Note also the syllabus now lists **vector** indexes alongside trees and hash tables, and **log-structured**
storage alongside heaps.

Two gaps are *internal* rather than syllabus-driven, and both are visible in v1's own docs
(`reference/limits.mdx`): every B+Tree assumes a **unique key** (a duplicate silently overwrites — which is
why `posts` could not index `authorId`), and a `JOIN` **never consults an index**, so "nested-loop wins
when the outer is tiny and the inner is indexed" — a sentence §23.1 itself writes — cannot be demonstrated.
A sceptical student finds both in the first ten minutes.

---

## 39. What the learning-science evidence says, beyond Part I

Part I §1 rested the product on one finding: how learners *use* a visualization matters more than what it
shows. This pass re-checked that and looked for what it implies for features Part I did not consider.

1. **Engagement beats viewing — still.** The engagement-level cut of that literature **[sourced]**: where
   learners did something beyond watching (predicted, answered questions, constructed input), **10 of 12**
   comparisons found a significant learning gain; among **view-only** comparisons, **3 of 9** did. (Part I
   read the meta-study's own 24-experiment / 11-significant tally directly; the two cuts agree in direction.)
   A controlled comparison found *responding* (predicting what the animation would do) produced
   significantly higher active engagement than watching with instructor commentary. **This is v1's
   design and the evidence for it is intact.**
2. **Predict-then-reveal has its own literature: the pretesting effect** **[sourced]**. Kornell et al.
   (2009) and Richland et al. (2009) showed learning benefits from attempting answers *before* instruction
   even when the attempt is wrong; a 2023 review in *Educational Psychology Review* and 2025 replication
   work in *Memory & Cognition* both appear. Mechanism named in the sources: errorful generation — the
   learner commits, then notices the mismatch. It works **only when feedback follows**, which v1's
   reveal provides. *Implication:* asking for a **confidence rating** with each prediction is a candidate
   upgrade. Hypercorrection (a confidently held error is corrected more strongly) was verified before G2 was
   built: Butterfield & Metcalfe (2001, *Journal of Experimental Psychology: Learning, Memory, and Cognition*)
   found that high-confidence errors were the most likely to be corrected on a retest after feedback
   **[sourced]**. The follow-up caveat is that Butler et al. (2011) found the effect persisted over a week, but
   the high-confidence errors came back **[sourced]**. So G2 records confidence for the calibration view and
   does not claim retention.
3. **Animation vs static, and pacing** **[sourced]**. Höffler & Leutner (2007), 26 studies / 76
   comparisons: animation beats static pictures overall, **d = 0.37** (95% CI 0.25–0.49); larger when the
   animation is *representational* (d = 0.40) and largest for *procedural-motor* knowledge (d = 1.06).
   Mayer's segmenting principle — learner-paced segments rather than a continuous animation — improved
   transfer in 3 of 3 tests (**d ≈ 0.98**), most where material is complex, fast, and the learner is a
   novice. *Implication:* v1's step-through, learner-paced playback is the right default; auto-play stays
   secondary; and a **detail level** (novice / standard / expert) is worth considering because the same
   source class says instructional supports that help novices can hinder experts (the *expertise reversal*
   effect — **[judgment]**, not fetched this pass).
4. **Retrieval practice and spacing** **[sourced]**. One meta-analytic figure reported in the sources found
   for this pass: mean **g = 0.50** (159 effects) for retrieval practice against reading. But the most
   relevant *field* study — spaced retrieval across nine introductory STEM courses (*Int. J. STEM
   Education*, 2024) — is titled *"is the glass half full or half empty?"* and the effect is uneven.
   *Implication:* an in-app quiz is worth building **as an experiment with its own measurement**, not on the
   assumption it works. And there is a design opening no static quiz has: the engine is ground truth, so
   questions can be **generated and graded from a seed** ("here is a clock-sweep state; which frame goes
   next?") — an unbounded bank that cannot contaminate §9's fixed study questions (§22.4's stated blocker).
5. **What novices get wrong** **[sourced]**. A think-aloud study of SQL novices (ICER 2021) organized
   misconceptions into four categories: from *previous course knowledge*, *generalization-based*,
   *language-based*, and *incomplete or incorrect mental models*. The last is exactly what an internals
   visualizer targets. *Implication [judgment]:* v1's challenges are goal-shaped but not
   *misconception-shaped*. Each of "an index always speeds a query up", "LRU is what real databases run",
   "`COUNT(*)` and `COUNT(col)` are the same", "a function on the column still uses the index" is a
   testable claim the engine can refute in one run — a natural challenge, tagged by category.
6. **Showing what the optimizer *didn't* choose** **[sourced]**. The TIPS paper (arXiv 2210.13722) starts
   from the observation that DBMSs show students only the chosen plan, so the optimizer stays a black box;
   it selects *k informative alternative plans* to show, and reports a three-year in-class evaluation.
   *Implication:* v1 shows the chosen plan with estimates; a **"Why not?" panel** showing the runner-up and
   its cost is the natural v2 step, and it needs a cost model that actually chooses (§41).

**Statistical honesty about §9.** §9 proposes 5–10 participants per arm. For a two-sample comparison
(normal approximation, two-sided α = .05, power .80) the required n per arm is ≈ 15.7 / d²: **d = 1.2 →
~11; d = 0.8 → ~25; d = 0.5 → ~63; d = 0.37 (the animation meta-analysis average) → ~115.** A 10-per-arm
study can only detect a *very large* effect; it is an exploratory signal, and its write-up should say so.
**[judgment / calculation]**

---

## 40. Correctness credibility — an oracle that costs nothing **[verified]**

v1's promise is that "every number is true to this engine." That is a claim about *consistency*, not about
*correctness of SQL semantics*. The cheapest available upgrade turns it into a checkable claim about result
sets, and it needs **no new dependency and no bundle bytes**:

- **`node:sqlite` ships in the Node this project already pins.** `.node-version` is `22`; the module was
  added in v22.5.0 and stopped requiring `--experimental-sqlite` in **v22.13.0 / v23.4.0**. Node marks it
  *Stability 1.2, release candidate*. Verified here: Node v24.16.0 embeds **SQLite 3.53.1** and an
  in-memory `DatabaseSync` runs `CREATE`/`INSERT`/`SELECT`.
- **`fast-check` 4.9.0 is already a devDependency**, used by four test files (B+Tree insert/delete, external
  sort, hash join). Property-based testing is an established idiom in this repo.
- **The technique has a track record.** SQLancer's oracles have found hundreds of logic bugs in SQLite,
  DuckDB, ClickHouse, TiDB and CockroachDB **[sourced]**: *NoREC* (an optimized query must return what its
  unoptimized translation returns), *TLP* (partition a predicate `p` into `p`, `NOT p`, `p IS NULL`; the
  three results, composed, must equal the original), *PQS* (a query built around a chosen "pivot" row must
  return it).

**Design [judgment].** Three layers, cheapest first:
(a) **Metamorphic, inside QueryLens** — same query with every optimizer rule off vs. on returns the same
rows (NoREC-shaped); all three join algorithms and both aggregate strategies agree; `Sort`+`Limit` vs.
reference. Needs nothing external.
(b) **Differential against SQLite** — generate tables and queries from the toy grammar, run both, compare
result multisets (sequences under `ORDER BY`), aggregates with a float tolerance, `NULL` behaviour.
(c) **TLP, once `NULL` three-valued logic exists** (v2.0 SQL tier 2 adds it).
**Caveats to design in, not discover:** SQLite is dynamically typed with type *affinity*, so generated data
must be typed so semantics coincide; some divergences will be **documented semantic differences** (string
collation, integer division), not bugs — keep a *divergence ledger* rather than a list of `skip`s; and CI
must run a **seeded, bounded** number of cases (a long fuzz belongs in a scheduled job with the same
read-only token discipline as `ci.yml`).
**Product payoff:** a docs page, "How we know the answers are right," listing exactly what is compared
against SQLite — which strengthens the honesty claim (§2, §12) from *consistent* to *checked*.

---

## 41. The optimizer story — make it decide, then make it wrong on purpose

v1's cost model annotates every node and reconciles estimate against actual in the narration; but
`limits.mdx` is explicit that **rules fire on structure and never on a cost comparison** — the estimates
justify a rewrite's *narration*, they do not *decide* it. The field's own evidence says where the teaching
value is **[sourced]**:

- Leis et al., *How Good Are Query Optimizers, Really?* (VLDB 2015; a 2025 follow-up, *Still Asking*, is in
  VLDB vol. 18): cardinality estimators **routinely** produce large errors that grow with query
  complexity — often **an order of magnitude or more** for larger expressions — because real data is
  correlated and non-uniform, which breaks the independence assumption. Exhaustive dynamic-programming
  join enumeration **still helps** despite bad estimates, and the **cost model matters much less than the
  cardinality estimates**.

**Implications [judgment].** A v2 optimizer lesson worth having has five parts: (1) **statistics as
inspectable objects** — `ANALYZE` producing distinct counts, null fraction, most-common values and an
equi-depth histogram the learner can open; (2) a **deliberately correlated dataset** where the independence
assumption fails and the estimate is off by 10–100×, shown as **q-error** (max of est/act and act/est) — the
metric that paper uses; (3) **join ordering by dynamic programming** with the subset table visible — which
needs the multi-join grammar v1 lacks (`limits.mdx`: "no more than one `JOIN` per query, so no join-order
choice"); (4) **plan enumeration that actually chooses**, so a rule can be *skipped because the cost says
no*; (5) the **"Why not?" panel** (§39.6). Keep §12's rule: name every heuristic, and say real optimizers
differ. A histogram that pretends to be Postgres's is exactly the "plausible but false" §12 prohibits.

---

## 42. The transactions and recovery block — what exists, what an external oracle offers

**The external ground truth already exists.** Kleppmann's **Hermitage** defines **ten anomaly tests** —
G0 (write cycles), G1a (aborted reads), G1b (intermediate reads), G1c (circular information flow), OTV
(observed transaction vanishes), PMP (predicate-many-preceders), P4 (lost update), G-single (read skew),
G2-item (write skew), G2 (anti-dependency cycles) — and records the outcome at each isolation level for
**eight databases** (PostgreSQL, MySQL/InnoDB, Oracle, SQL Server, FoundationDB, CockroachDB, YugabyteDB,
Memgraph) **[verified: README fetched]**. Snapshot isolation is the canonical case: it exhibits none of the
anomalies the SQL standard prohibited yet is not serializable — **write skew** — which is the single
best "looks safe, isn't" example in the field **[sourced]**.

**Design [judgment].** An isolation matrix — *anomaly × isolation level × mechanism (locking vs. MVCC)* —
that is **computed by running each anomaly's scripted schedule through the engine**, not drawn. Tests then
assert the computed cells against Hermitage's *documented behaviour* for PostgreSQL and InnoDB. That is
behavioural ground truth (what the outcome is), explicitly **not** a claim about implementation, and it is
exactly the "real engine underneath" answer to §37's first point.

**What v1 already contains that this builds on:**
- `src/ui/lockSimulation.ts` — pure and total: FIFO waiter queues, a wait-for graph rebuilt per request,
  deadlock detection, youngest-transaction victim selection — currently *outside* the engine, driving only
  `/tools/locks`. `src/engine/locks/lockManager.ts` (the pipeline's own) tracks holders only, by design
  ("v0 runs one query at a time").
- `BufferPool.markDirty()` / `write()` and evict-with-writeback — §22.2 called dirty writeback "the buffer
  pool's other half." It is also the precondition for the steal/no-steal and force/no-force matrix that
  recovery teaches.
- **The engine is a pure synchronous function** (§5). Concurrency must not break that. The way to keep it:
  make the *interleaving an input* — `runSchedule([(session, statement), …], db)` returns events like
  `runQuery` does. Deterministic, replayable, shareable as a URL, testable — and no threads, timers or
  async ever enter `src/engine/`.

**Recovery (lectures 22–23).** ARIES's three phases — analysis, redo, undo — with the dirty-page table,
transaction table and compensation log records as visible panels, a **crash button** that drops the buffer
pool and keeps disk + log, and the buffer pool's flush rule ("log before data page") as the visible
constraint. Scope it as its own tool first (`/tools/recovery`), then connect it to the pipeline's writes.

---

## 43. Storage engines and access methods — breadth, gated on lessons

**What is demanded.** The syllabus lists log-structured storage, filters, hash tables, vector indexes,
storage models and compression (§38). Pavlo's 2025 year-in-review **[verified: fetched]** records five new
columnar file formats challenging Parquet (FastLanes, F3, Vortex, AnyBlox, Amudai) and that "every major
DBMS vendor released" an MCP server after March 2025; the Stonebraker/Pavlo discussion treats vector
indexes as ordinary indexes **[sourced]**. LSM has interactive explainers in the wild (a DEV Community
simulator covering memtable, flush, sparse index, Bloom filters and leveled compaction **[sourced]**) and a
competitor simulator (§37).

**What each needs from v1, and what it teaches that v1 cannot:**

| Tool | Reuses | Teaches | Honest counter |
|---|---|---|---|
| `/tools/lsm` — memtable → L0 → leveled/tiered compaction, per-SSTable Bloom filter | Page I/O counting through the buffer-pool primitives | Write/read/space amplification; **B+Tree vs LSM on the same workload** in `/compare` | Real LSMs have far more knobs; label the model |
| `/tools/hash-index` — extendible + linear hashing | `hashJoin.ts`'s driver style | Directory doubling, local/global depth; why a hash index cannot range-scan | — |
| `/tools/columnar` — NSM / DSM / PAX layouts, dictionary / RLE / delta / bit-packing, late materialization | `slottedPage.ts` | **Finally gives *projection pushdown* something real to save** — §22.9 declined it because a row heap has nothing to skip | — |
| Vectorized vs tuple-at-a-time | Volcano operators | Count of `next()` calls per row vs per batch | Toy batch sizes |
| `/tools/latch-crabbing` — safe-node rule, optionally optimistic lock coupling | `BTreePanel`, `lockSimulation.ts` | Why the root latch is a bottleneck; lectures 10 | Threads are *scripted*, not real |
| `/tools/vector-index` — brute force vs IVF vs HNSW on 2-D points | flowinger (HNSW layers are a graph) | Recall vs distance-computations trade-off | 2-D only; say so |

**A rule worth writing down:** a tool without a lesson and a challenge is a **demo**, not a tool; a
visualization without a text alternative ships an accessibility regression (§17 of Part II already says
automated checks catch only 30–57% of WCAG failures). Every row above ships with a lesson, a challenge, and
a data-table view. **[judgment]**

---

## 44. In-browser AI — feasible, and the wrong first move **[sourced; verdict is judgment]**

**Feasibility.** WebLLM runs small open models in the browser on WebGPU with no server; a 1.5B-parameter
model is roughly a **1.5 GB download** and runs at **30–60 tokens/s on a decent GPU**; WebGPU is stable in
Chrome and Edge and Safari is reported as behind (sources vary — treat as indicative). It fits "nothing
leaves your browser" (§14.4).

**Why it should not ship in v2:**
- **It fails §12's oldest rule.** A model that *narrates* a trace can state a number the trace does not
  contain — "plausible but false," in its purest form. One 2026 SIGCSE study rated GPT-4 only *"marginal"*
  as a Theory-of-Computing tutor: good at conceptual explanation, weak where precision matters.
- **It undermines the pedagogy.** An April 2026 arXiv paper tests *answer leakage* in LLM tutors under
  adversarial students. QueryLens's central mechanism is that the learner commits *before* the answer is
  shown; an assistant that will happily tell them is a bypass around the one feature the evidence supports.
- **1.5 GB is a heavy price** for a tool whose first-visit budget is 24 kB of entry code.

**What to do instead [judgment].**
1. **An MCP server** (`@querylens/mcp`): `run_query`, `explain_trace`, `compare_policies` over the existing
   engine, for the *user's own* assistant. The model then explains by *calling the engine and quoting the
   trace* — grounded by construction — and the cost is a thin wrapper over the CLI's `--json` mode. Pavlo's
   review is the trend evidence: MCP became table stakes for DBMSs in 2025.
2. **`llms.txt` and machine-readable docs** for the same reason. Trivial cost.
3. **Leave the door open** to a *constrained* in-app explainer **after §9**, with kill criteria written now:
   opt-in, local-only, never answers a pending prediction, and every number in its output must appear in
   the event stream or the output is discarded.

---

## 45. Name, URL, distribution

- **The name is in use.** Searching "QueryLens" alongside database terms returns at least **five unrelated
  projects**: a commercial SaaS (`querylens.tech`, "Query Explanation & Optimization for Data Teams"),
  `querylens.ai`, `querylens.cc`, and several GitHub repositories (a JavaFX SQLite plan analyzer, a .NET
  desktop slow-query tool, a Rails engine). `querylens.pages.dev` — found while diagnosing the first
  deploy — serves the SaaS's marketing site. **[verified: searched and fetched]**
- **This is a discoverability problem more than a legal one** — and this pass makes no legal claim (no
  trademark search was done). Everyone searching the name will land on tools that *explain your production
  queries*, which is the audience §2 declares a non-goal. Every backlink created by the §18.2 launch post
  raises the price of changing it. **The cheapest moment to decide is now.** Options: keep the name and
  always pair it with the descriptor; keep it but lead with a distinctive domain; or rename. **[judgment]**
- **The live URL is a `workers.dev` subdomain carrying an account name.** Fine for verification, weak for
  sharing. `VITE_SITE_URL` is already wired for a custom domain (~$10–15/yr, §11).
- **What travels is the interactive essay.** PlanetScale's B-tree piece is the reference for a format that
  gets shared. v2's embed work (§25) should produce two or three essays that double as launch content.
  **[judgment]**

---

## 46. What I deliberately left out, and questions for you

**Left out of v2, and why** (in the discipline of Part II §21):
- **Distributed databases** (2PC, Raft, sharding) — lecture 24, and Pavlo's review notes three competing
  Postgres-sharding projects. A different subject with its own model; a v3 horizon, not a v2 line item.
- **Parallel query execution** (exchange operators, morsel-driven) — lecture 15. Real threads would break
  the pure-engine rule (§42) unless scripted.
- **Query compilation / JIT, learned indexes, graph/document/KV models** — interesting, no demand
  evidence found this pass.
- **Window functions, recursive CTEs** — still declined for §4's reason.
- **A Rust/WASM engine rewrite** — TypeScript is fine at toy scale; the Web Worker path (§5, §22.7) comes
  first and only escalates if it cannot reach ~10k rows.
- **Accounts, graded submission, telemetry, real-time collaboration** — unchanged: own product / not done.

**Questions for you — answered 2026-09-24** (plan.md §25.9, appendix v22).
1. **Keep the name, or rename before the launch post?** (§45.) **Decided: keep, paired with the descriptor.**
   Checked first — npm `querylens` / `query-lens` unclaimed, `@querylens` empty, `querylens.com/.io/.ai/.cc/.tech`
   registered by others, `.org` / `.net` unregistered in WHOIS. Recommended domain: `querylens.org`, to be bought.
2. **Run the §9 study during v2.0, with a self-serve kit, or keep building?** **Decided: run it.** The kit is built; it needs participants.
3. **Transactions before storage engines?** The syllabus gap (six lectures) says yes; LSM has more
   interview-prep pull. My lean: transactions on the main line, LSM as a parallel standalone.
4. **Will anyone maintain a non-English locale?** i18n is expensive here because the engine emits English
   narration strings (§25.4 H5). Without a named maintainer it stays deferred.
5. **npm scope.** **Decided:** org `querylens` for `@querylens/engine` and `@querylens/mcp`; the CLI unscoped as
   `querylens`. The scope is unclaimed today, so no collision blocks it; the org itself must be created by you.

---

## Sources (Part IV)

- Competition: [SQL Execution Visualizer](https://sql-execution-visualizer.vercel.app/) · [System Design Simulator — internals](https://systemdesignsimulator.org/internals/btree) · [PlanetScale — B-trees and database indexes](https://planetscale.com/blog/btrees-and-database-indexes) · [NEURON (arXiv 1805.05670)](https://arxiv.org/pdf/1805.05670) · [TIPS — informative alternative plans for DB education (arXiv 2210.13722)](https://arxiv.org/abs/2210.13722)
- Syllabus: [CMU 15-445/645 Fall 2026 — schedule](https://15445.courses.cs.cmu.edu/fall2026/schedule.html) · [syllabus](https://15445.courses.cs.cmu.edu/fall2026/syllabus.html) · [Lecture 9, Index Concurrency Control (notes)](https://15445.courses.cs.cmu.edu/fall2023/notes/09-indexconcurrency.pdf)
- Learning science: [A Meta-Study of Algorithm Visualization Effectiveness](http://s3.amazonaws.com/publicationslist.org/data/helplab/ref-52/JVLC-AVMetaStudy.pdf) · [Algorithm Visualization in CS Education: Comparing Levels of Student Engagement (SoftVis 2003)](https://dl.acm.org/doi/10.1145/774833.774846) · [Prequestioning and Pretesting Effects: a Review (Educ. Psychol. Rev. 2023)](https://link.springer.com/article/10.1007/s10648-023-09814-5) · [Richland, Kornell & Kao — the pretesting effect](https://learninglab.uchicago.edu/Pre-Testing_files/RichlandKornellKao.pdf) · [Höffler & Leutner (2007), instructional animation vs static pictures](https://www.sciencedirect.com/science/article/abs/pii/S0959475207001077) · [Mayer — segmenting principle](https://www.cambridge.org/core/books/abs/multimedia-learning/segmenting-principle/37240877DDA0362355ADB39936027982) · [Spaced retrieval in nine introductory STEM courses (IJ STEM Ed. 2024)](https://link.springer.com/article/10.1186/s40594-024-00468-5) · [Identifying SQL Misconceptions of Novices (ICER 2021)](https://dl.acm.org/doi/fullHtml/10.1145/3446871.3469759)
- Correctness: [SQLancer](https://github.com/sqlancer/sqlancer) · [Node.js `node:sqlite`](https://nodejs.org/api/sqlite.html) · [How Good Are Query Optimizers, Really? (VLDB 2015)](https://www.vldb.org/pvldb/vol9/p204-leis.pdf) · [Still Asking: How Good Are Query Optimizers, Really? (VLDB 2025)](http://www.vldb.org/pvldb/vol18/p5531-viktor.pdf)
- Transactions: [Hermitage (Kleppmann)](https://github.com/ept/hermitage) · [A Critique of ANSI SQL Isolation Levels](https://arxiv.org/pdf/cs/0701157) · [What write skew looks like (Cockroach Labs)](https://www.cockroachlabs.com/blog/what-write-skew-looks-like/)
- Field trends: [Databases in 2025: A Year in Review (Pavlo)](https://www.cs.cmu.edu/~pavlo/blog/2026/01/2025-databases-retrospective.html) · [LSM tree simulator (DEV Community)](https://dev.to/ebendttl/engineering-a-high-performance-lsm-tree-storage-engine-memtables-sstables-and-compaction-3jfk)
- AI: [WebLLM](https://github.com/mlc-ai/web-llm) · [WebLLM paper (arXiv 2412.15803)](https://arxiv.org/html/2412.15803v2) · [Viability of LLMs as CS Theory Tutors (SIGCSE TS 2026)](https://doi.org/10.1145/3770761.3777358) · [Evaluating Answer Leakage Robustness of LLM Tutors (arXiv 2604.18660)](https://arxiv.org/pdf/2604.18660)
- Name: [querylens.tech](https://querylens.tech/) · [querylens.ai](https://querylens.ai/) · [querylens.cc](https://querylens.cc/)

### Verified locally on 2026-09-24

`git log --reverse` first commit 2026-09-01, last 2026-09-23, 106 commits · `find src -name '*.ts*' -not -path
'*__tests__*' | xargs cat | wc -l` = 23,706; `src/engine/` = 8,742; `grep -rl "from 'react" src/engine` = 0 files ·
unit-test lines 9,630 (`pnpm test`: 1,170 tests / 56 files); e2e lines 1,971 (`pnpm test:e2e`: 79 tests) ·
`.node-version` = `22`; `node -v` = v24.16.0; `require('node:sqlite')` opens `:memory:`, creates, inserts and
selects; `process.versions.sqlite` = 3.53.1 · `grep -rl fast-check src bin scripts` = 4 test files ·
`pnpm budget`: total 377.9 / 424 kB gzip · live `securityheaders.com` scan of the deployed URL = A+ ·
`limits.mdx` states unique-key B+Tree, one `JOIN` per query, no `OR`/`NOT`/`DISTINCT`/`HAVING`/`OFFSET`/outer
joins/subqueries/transactions.
