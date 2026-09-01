# QueryLens — Pre-Build Research Findings

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

## Sources

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
