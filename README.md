# QueryLens

An in-browser toy relational database engine that animates a SQL query as it moves through
**Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result**.

A learning tool, not a production DB tool. See [plan.md](plan.md) for scope and
[RESEARCH.md](RESEARCH.md) for the evidence the plan is built on.

## Status: MVP complete, both P0 gates closed

All eight pipeline stages are real, the run halts to ask you to predict before it reveals, the seed
data is editable, and the whole thing is keyboard-driven and accessible. The *application* is done.

**M8 and M9 — the two P0 gates that stood between it and a public URL — are now done.** The app runs
its first trace on load, survives its own bugs with a copyable repro instead of a blank page, ships
under a tested CSP, and carries a licence. What is left of those milestones is their P1 lists, which
are the fortnight *after* launch by design.

[plan.md §14](plan.md#14-production-readiness--the-deploy-gate) was the deploy gate, from
[RESEARCH.md Part II](RESEARCH.md#part-ii--production-readiness): ten P0 items, each of which fails
silently if skipped. All ten are in. Two of its six done-checks cannot close until the URL is live —
the securityheaders.com grade and the link-preview card both need something able to fetch the site —
so [§14.6](plan.md#146-definition-of-done) marks those `[~]` with what *was* verified locally.

[plan.md §15](plan.md#15-uiux-readiness--the-comprehension-gate) was the comprehension gate, from
[RESEARCH.md Part III](RESEARCH.md#part-iii--uiux-production-readiness), which drove the running app on
desktop and phone and measured it. The verdict was *better built than it looks, worse composed than it
is built*. All eight P0 items are in; the one done-check still open is the shareable URL, which §15.2
puts in P1. Measuring rather than eyeballing paid for itself twice: the font-size sweep caught the SQL
editor and React Flow's badge on top of the eight labels the audit had listed, and running the trace on
load turned out to break React Flow's viewport fit in a way that only a transform readout showed.

**The other outstanding item is not code**: plan.md §9 step 4 asks for a post-test against a
text-explanation control, with 5–10 target users. That experiment decides whether the format works,
and it needs people, not commits. `IMPLEMENTED_STAGES` in
[types.ts](src/engine/types.ts) is the single source of truth for that, and the UI reads it: the
header counts built stages, unbuilt ones are dashed in the pipeline tracker, and selecting one says
plainly that it is not built yet. plan.md §2 makes honesty about ground truth a top-line goal, and a
pipeline that *looks* complete when it is not would teach the wrong thing.

| Milestone | Scope | State |
|---|---|---|
| M0 | Scaffold, event contract, fold, playback, UI shell | ✅ done |
| M1 | Recursive-descent parser + AST visualization | ✅ done |
| M2 | Planner + predicate pushdown + plan tree | ✅ done |
| M3 | Pages, buffer pool, LRU **and** clock sweep | ✅ done |
| M4 | B+Tree index + traversal visualization | ✅ done |
| M5 | Volcano executor wiring it all together | ✅ done |
| M6 | Lock manager visual layer | ✅ done |
| M6.5 | Predict-then-reveal + editable seed data | ✅ done |
| M7 | Polish, a11y, deploy config | ✅ done |
| M8 | **Production readiness — the deploy gate (plan.md §14)** | ✅ P0 done · P1 open |
| M9 | **UI/UX readiness — the comprehension gate (plan.md §15)** | ✅ P0 done · P1 open |
| — | **Validation post-test with real users (plan.md §9)** | ⬜ your call |

Two things are worth knowing before the first deploy:

- **CI is written, but a workflow file is not a rule.** `.github/workflows/ci.yml` runs typecheck,
  lint, test and build on every PR and push to `main`. Making it *blocking* is a branch-protection
  setting in the repository, which no file in here can turn on.
- **`VITE_SITE_URL` decides the canonical and `og:image` URLs.** It falls back to Cloudflare's
  `CF_PAGES_URL`, then to `https://query-lens.pages.dev`. Set it if the site gets a custom domain.

## Commands

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # vitest
pnpm typecheck  # tsc -b
pnpm lint       # eslint
pnpm build      # tsc -b && vite build
```

## Architecture

```
src/engine/   pure, synchronous, no DOM, no React, no async
src/ui/       a renderer of engine state, nothing more
```

`runQuery(sql, db, options)` returns the **complete** event array in one synchronous call.
Playback is then an index into an array the UI already owns, which makes step-back, scrubbing and
reset trivially correct. See plan.md §5 for why this is deliberately *not* a Web Worker.

**Events are deltas, not snapshots.** `applyEvent` folds them into a `ViewState`;
`createTraceProjector` memoises per index so stepping backward is free. Snapshotting per step
would forfeit the ability to animate the *transition*, which is the entire product.

### Rules for `src/engine`

1. Pure and synchronous. No DOM, no React import, no async, no I/O.
2. Every emitted value must be structurally cloneable — this keeps the engine worker-ready
   should a v1 feature ever need it.
3. Every event carries a human-readable `label`. The narration is what turns an animation into
   a lesson.
4. Correctness tests come *before* visualization (see plan.md §7.6 for the B+Tree case).

## The v0 SQL subset

```
statement  := select [';'] EOF
select     := SELECT selectList FROM identifier [WHERE expr]
selectList := '*' | identifier (',' identifier)*
expr       := comparison (AND comparison)*
comparison := operand ('=' | '<' | '>') operand
operand    := identifier | number | string | NULL | TRUE | FALSE
```

Anything outside it gets a message naming the scope rather than a token-level complaint —
`JOIN` says joins arrive in v1, `>=` says v0 handles `=`, `<` and `>`, `a.id` says qualified names
come with joins. The tokenizer deliberately recognises keywords and operators the parser rejects,
purely so those messages are possible. Errors carry a character span, which CodeMirror renders as a
squiggle under the offending text.

## The optimizer

Two rules, applied in order, each producing one `optimize` event with before/after trees and the
changed node highlighted:

1. **`predicate-pushdown`** — folds `Filter` into the scan beneath it. In a single-table query the
   filter already sits directly above the scan, so there is nothing to push it *past*; the real move
   is pushing it *into* the scan, which then discards rows as it reads them.
2. **`index-selection`** — swaps `SeqScan` for `IndexScan` when a conjunct is an equality on the
   indexed column. Conjuncts the index cannot answer stay behind as a **recheck**: the index narrows
   the search, it does not verify the predicate.

When nothing fires, the optimizer says so out loud rather than silently emitting nothing.

Deliberately absent: **cost estimates** (plan.md §7.3 defers them to v1 — inventing costs we cannot
justify is exactly the plausible-but-false detail §12 warns about) and **projection pushdown**
(it would not reduce I/O in a page-based row store, so showing it as an optimization would teach
something untrue).

`SELECT * FROM users WHERE id = 5` and `SELECT * FROM users WHERE age > 30` already diverge here —
the first gets both rules, the second only pushdown. That is plan.md §9's side-by-side contrast
beginning to show up.

## The storage layer

48 rows at 4 rows/page is **12 pages against 8 frames**, so a full scan evicts four times. That is
deliberate: a table small enough to never evict would make the buffer pool — the product's best
differentiator — look inert, and plan.md §9 wants the scan's eviction storm shown next to an index
lookup that touches almost nothing.

Replacement is pluggable behind one interface with two implementations:

- **LRU** — the textbook policy, and the one PostgreSQL deliberately avoids: maintaining the ordering
  needs a lock on every page access.
- **Clock sweep** — what PostgreSQL actually does. `usage_count` capped at 5, a hand that walks in a
  circle decrementing as it goes, evicting the first frame at zero with `refcount == 0`.

### The toggle does *not* show what plan.md §7.5 claims

§7.5 pitches it as "same access pattern, two policies, different victim". That is only true when
access is **skewed**. On a uniform sequential scan every page is equally cold, so both policies evict
exactly the same pages — clock just takes 8 extra sweep steps to reach the same answer (44 events vs
36). Both facts are pinned by tests, and the panel says so rather than implying a difference that is
not there. **M4 did not fix this, contrary to what M3 predicted.** A point lookup touches four pages against
eight frames, so it never evicts at all and the two policies are again indistinguishable. Measured:
`WHERE id = 5` is 4 disk reads and 0 evictions under both.

Neither of the queries QueryLens currently runs can demonstrate the difference. It needs a workload
that re-reads some pages while others stream past — a nested-loop join, or an index scan over many
keys. Both are v1. The policies still earn their place (clock sweep is what PostgreSQL actually
does, and its sweep mechanism is visible on the scan), but the "same pattern, different victim"
demo does not exist in this product yet, and the panel does not pretend otherwise.

### Simulated latency

plan.md §7.5 asks for latency distinguishing a buffer hit from a disk read. The engine is pure and
synchronous, so it cannot sleep and has no measurement it could honestly report. Instead a disk read
carries `dwell: 2.5` — an explicit **playback pacing weight**, not a latency claim — and playback
lingers on it proportionally.

## The B+Tree

All data in the leaves, internal nodes hold separators only, leaves chained left to right. Fan-out
is 4 keys — real fan-out is in the hundreds and would never split on a demo dataset, so the
simplified model teaches better. Each node lives on its own page *after* the heap pages, so heap and
index compete for the same buffer frames.

The split rule, which is where implementations go wrong:

- **leaf split → COPY up** — the separator goes to the parent *and stays in the leaf*, because
  leaves must hold every key.
- **internal split → PUSH up** — the middle key moves to the parent and is *removed* from the node.

`validate()` checks every structural invariant plan.md §7.6 lists, and property tests run it over
~1,300 random insertion orders and fan-outs. To confirm the suite can actually catch the bugs it was
written for, three deliberate mutants were introduced and all three were caught: leaf-split pushing
up (7 failures), internal-split copying up (3), and a lopsided split leaving nodes under half full
(3).

### The §9 contrast is now real

| | `WHERE id = 5` | `WHERE age > 30` |
|---|---|---|
| access method | IndexScan | SeqScan |
| disk reads | **4** | **12** |
| evictions | 0 | 4 |
| trace length | 22 events | 36 events |

## Execution

Volcano model: every operator exposes `open` / `next` / `close`, and rows are **pulled** from the
root downward — one `next()` is one visualization tick. Nothing materialises the whole table; a row
travels all the way to the top before the next is fetched, which is exactly what the interleaving of
`buffer` and `execute` events in the trace shows.

Operators: `SeqScan` (walks heap pages, pinning each while its rows are read), `IndexScan`
(traverses the B+Tree, then fetches the one heap page), `Filter`, `Project`.

### Three-valued logic

Predicates evaluate to TRUE, FALSE or **UNKNOWN**, and only TRUE passes a `WHERE` clause. A
comparison against NULL is UNKNOWN, not false; FALSE dominates UNKNOWN in an `AND`. This is modelled
rather than flattened to booleans because it is real, commonly-missed SQL semantics — it is why
`WHERE age > 30` and `WHERE NOT (age <= 30)` do not partition a table containing NULLs.

### Results are checked against a reference

Execution tests compute the expected rows with a plain JavaScript filter and compare. The same
answer must come back regardless of which access method the optimizer picks, which replacement
policy is selected, and how pages or frames are sized — so a storage bug cannot hide behind a
correct-looking result.

## Locks

Page-level shared locks, taken before a page is read and released after. A sequential scan holds one
page at a time. The index descent **crabs**: it takes the child's lock *before* releasing the
parent's, so the branch cannot be restructured out from under the descent — briefly holding two, and
that overlap is the technique. Tests assert the peak concurrent count is exactly 1 for a scan and
exactly 2 for a descent, and that no query ever ends holding anything.

### What this layer does not model

It is **visual only**, as plan.md §7.7 specifies, and the panel says so rather than letting a lock
icon imply protection from a rival:

- v0 runs exactly one query, so **no lock ever waits on another**. There is no contention, no
  blocking, no deadlock, and no wait queue.
- Real engines separate a short **latch** on the buffer frame from a transaction-length **lock** on
  the data. Both are collapsed here into one page-level read lock held for the duration of the read.

A second, concurrent query is the v1 feature that would make this layer mean something.

## Predict-then-reveal

RESEARCH.md §1: across 24 experiments, passive viewing did not reliably beat reading text *"no
matter how high the level of their epistemic fidelity"*. Everything from M1 to M6 is the fidelity
half. This is the other half.

Playback **stops before** an event that would reveal an answer and asks you to commit. Four prompts,
at the points plan.md §8 identifies, at most once each per run:

| Stage | Question |
|---|---|
| `optimize` | Given an index on `id`, what should the optimizer do with `id = 5`? |
| `index` | Which child pointer does the search follow? |
| `buffer` | Which frame gets evicted? |
| `result` | How many rows come back? |

**Every prompt is generated from live engine state**, so the correct answer is whatever the engine
is about to do — none of it is authored. The child options are built from the node's real separator
keys; the eviction options are the frames actually occupied; the row-count options always contain
the true total. Tests assert that each prompt's correct option exists among its options and matches
the event that follows it, for every supported query.

Prediction is **on by default** — the evidence says it is what teaches — with a checkbox to turn it
off, and a per-prompt skip. Scrubbing is deliberately never blocked: a prompt should not trap
someone who wants to jump elsewhere in the trace.

## Editable seed data

"Construct their own input data sets" is named explicitly in the condition that beat both text and a
conventional animation in the HalVis studies. Rows can be edited, added and deleted, and applying
re-runs the query immediately — so changing the data changes every number downstream. Cell edits
preserve each column's type, so `42` in a number column stays a number.

## Accessibility

- **WCAG 2.2.2 (Pause, Stop, Hide)** — satisfied by the Play/Pause controls, which came free with
  the playback model.
- **`prefers-reduced-motion`** — CSS transitions are neutralised by a media query, and the viewport
  animations (which are JavaScript, so no media query can reach them) snap instead of tweening. This
  does *not* replace the controls; WCAG requires both.
- **Keyboard throughout** — Space, ←/→, Home, ⌘↵, with the shortcuts shown on screen rather than
  hidden behind a help modal. The space bar is matched on `code`, so it survives layouts where `key`
  is `'Spacebar'`. A visible focus ring is defined globally.
- **Contrast** — every text element is measured against its **fully composited** backdrop (walking
  the ancestor chain and painting each translucent layer, since a naive parent-colour lookup gives
  wrong answers) at every pipeline stage. Currently **zero elements below WCAG AA**.

  That sweep found a real bug: CodeMirror's `defaultHighlightStyle` is built for light backgrounds,
  so SQL keywords were rendering at **1.6:1**. The editor now uses a purpose-built dark highlight
  style.

  Re-measured on 2026-09-02 against the running app: **66 text elements, zero below AA, minimum 5.29:1.**
  Nothing regressed. Note the caveat found while doing it — two versions of the measuring script reported
  dozens of false failures, both times by mis-parsing OKLCH/OKLab colours, which is worth knowing before
  trusting any off-the-shelf contrast tool on this codebase.

- **Not yet done** — there is no light theme, and `color-scheme` is never declared, so native scrollbars
  and `<select>` popups still render as light-mode chrome. See
  [plan.md §15](plan.md#15-uiux-readiness--the-comprehension-gate).

## Deploying

Cloudflare Pages, per plan.md §6 — Vercel's Hobby tier is non-commercial-only by ToS and pauses the
site past 100 GB, which is the wrong failure mode for a teaching tool that might get posted
somewhere busy.

```
Build command:            pnpm build
Build output directory:   dist
Node version:             pinned to 22 by .node-version
```

`public/_headers` sets immutable caching for hashed assets, revalidation for the entry document, and
the full security block from [plan.md §14.3](plan.md#143-the-security-headers-tested-rather-than-assumed):
CSP, HSTS, `Permissions-Policy`, COOP, `X-Content-Type-Options` and `Referrer-Policy`. No SPA redirect
rule is needed — the app has no client-side routing.

The CSP was **tested, not copied**. `dist/` was served under the exact policy and the console read for
violations. Two results worth keeping: the build emits zero inline scripts, so `script-src 'self'`
needs no hashes and no nonce; and a strict `style-src 'self'` silently breaks the SQL editor, because
CodeMirror's `style-mod` styles itself by assigning `textContent` to a runtime `<style>` element.
Hashes cannot fix that — the content changes as modules mount — so `'unsafe-inline'` is scoped to
styles only, on purpose. `frame-ancestors` is in the header rather than a `<meta>` because it is
ignored in a tag. `X-Frame-Options` and `X-XSS-Protection` are deliberately absent.

There is **no telemetry of any kind**, and that is a decision rather than an omission
([plan.md §14.4](plan.md#144-the-telemetry-decision-stated-rather-than-drifted-into)): no analytics, no
error tracking, no cookies, nothing leaves the browser. `connect-src 'self'` means adding any of it
would show up as a diff in this file. The bug report that replaces it is the copyable crash repro —
SQL, policy, step index, edited rows, build SHA — offered by the error boundary and printed to the
console by the global handlers.

The licence is [MIT](LICENSE).

## Decisions made during M8/M9

- **Every GitHub Action is pinned to a 40-char commit SHA**, with the tag in a trailing comment as
  documentation only. Mutable tags are how `tj-actions/changed-files` and `trivy-action` exfiltrated
  CI secrets. `permissions: contents: read` is set at workflow level: nothing in this build writes.
- **`allowBuilds: []` is stated, not left implicit.** Verified that not one package in the graph has
  a `preinstall`, `install` or `postinstall` script — so adding one becomes a diff somebody has to
  approve rather than a script that simply starts running. `minimumReleaseAge: 10080` is written down
  for the same reason: pnpm 11 defaults it to 1440, but `pnpm config get minimumReleaseAge` returns
  `undefined` here, and an implicit default is not something CI's pnpm can be assumed to share.
- **The crash repro is published during render, not from an effect.** The state worth reporting is the
  state of the render that threw; an effect only ever sees renders that already succeeded, so it would
  report step 12 for a crash the user caused by stepping to 13. The write is idempotent, so StrictMode's
  double render is harmless.
- **Two boundaries, not one.** The root boundary is the alternative to a white screen; the panel
  boundary around `StageDetail` keeps the editor, narration, tracker and playback alive when one stage
  renderer dies, and is keyed by stage so leaving a broken stage clears it.
- **The crash report is shown on screen, not only behind the Copy button.** Clipboard access can be
  denied, and that is exactly the case where the text still has to be selectable.
- **`landingStep` gates on the prompt, not just on Run.** Landing on step 1 is what makes Run visibly
  respond — but if step 0 itself asks a question, predict-then-reveal outranks the feedback and it
  stays at 0.
- **`usePlayback` gained `land` alongside `seek`.** `seek` clamps against the length it can see, which
  during a Run is still the *previous* trace's — so seeking to step 1 right after a run that followed a
  parse error (length 0) would clamp to 0. `land` skips the upper clamp because the derived `step`
  re-clamps against the new length on render anyway.
- **The data editor is a native `<dialog>`.** `showModal()` fixed all three measured defects at once —
  focus never entered, Escape did nothing, Tab reached the background — and returns focus to the
  trigger for free. Playback shortcuts are suspended while it is open.
- **jsdom 30 implements none of the `<dialog>` methods**, so `src/test/setup.ts` carries a shim. It
  mirrors the spec's close request deliberately, firing a cancelable `cancel` and honouring
  `defaultPrevented`, so a regression that swallows Escape fails the test instead of slipping through.
- **Small text is three rem tokens now, not eighteen pixel values.** `--text-2xs` and `--text-3xs` sit
  below Tailwind's `text-xs`. Measuring at a doubled root font size caught two the audit had not
  listed: `.cm-editor` at 13px, and React Flow's attribution badge at 10px from its own stylesheet.
- **React Flow's viewport fit is gated on `useStore(s => s.width)`.** Every viewport call is a silent
  no-op while React Flow's store reports width 0, which is exactly the state at first paint now that
  the trace runs on load. Gating on its measured width also refits on window resize. The unfocused case
  now frames every node through the same d3 maths the focused case uses, so `fitView` — which needs
  node measurements these graphs never report — is gone from the component entirely.
- **A hidden browser pane throttles `requestAnimationFrame`**, so React Flow's animated transform never
  lands and the tree looks unfitted. It is indistinguishable from a fit that never ran, and it cost two
  wrong fixes before a `duration: 0` run and a headless screenshot separated the two.

## Decisions made during M0/M1/M2/M3/M4/M5/M6/M6.5/M7

- **TypeScript pinned to 6.0.3.** `typescript-eslint@8.69.0` declares `typescript: ">=4.8.4 <6.1.0"`
  — it excludes TS 7. Verified against the registry. Revisit once 7.1 ships a stable compiler API.
- **CodeMirror is wired up directly**, not via `@uiw/react-codemirror`. That wrapper statically
  imports its `basicSetup` bundle (search, folding, linting) whether or not you pass
  `basicSetup={false}`, so its flags cannot tree-shake. A ~40-line binding
  ([CodeMirrorEditor.tsx](src/ui/CodeMirrorEditor.tsx)) saved ~70 kB.
- **RESEARCH.md's "~50 kB tree-shaken" CodeMirror figure does not hold.** `@codemirror/view` alone
  is 480 kB of source. The editor stack costs ~370 kB raw / ~120 kB gzip in practice. Still the
  right call — Monaco is 2–5 MB — but the budget is 2–3× what the research assumed.
- **`@codemirror/state` and `/view` are pinned via `pnpm-workspace.yaml` overrides.** CodeMirror
  breaks, in types and at runtime, if two copies are loaded.
- **The parser emits the parse stage as a progressive reveal** — SELECT list, then FROM, then WHERE,
  then a summary. Display-tree node ids are stable across those steps so the tree animates as it
  grows instead of remounting.
- **`Mod-Enter` is a CodeMirror keybinding at `Prec.highest`, not a DOM handler.** The default keymap
  binds it to `insertBlankLine` and consumes the event before React sees it. It re-emits as a DOM
  `CustomEvent` so the extension array can stay module-scoped — rebuilding it per render would tear
  the editor down on every keystroke.
- **React Flow + d3-hierarchy for trees**, as plan.md §6 specifies: d3 does the layout maths,
  React Flow only draws. Cost is ~62 kB gzip. Bundle is now 250 kB gzip total; if that becomes a
  problem, these trees are static layouts and could be plain SVG.
- **One tree renderer for everything.** `FlowTree` takes a `FlowNode` and a kind→colour map;
  `AstTree` and `PlanTree` are thin wrappers. The B+Tree in M4 should be a third.
- **Rewrites mark changed nodes by object identity**, not by id bookkeeping that could drift: a rule
  returns the `Plan` objects it produced, and the display conversion highlights exactly those.
- **The default query is the sequential scan, not the point lookup**, until M4 builds the B+Tree.
  An `IndexScan` plan emits *no* page I/O today: reading every page and calling it an index scan
  would be exactly the lie this product exists to avoid. The default flips back after M4.
- **Buffer events carry `clockHand` on eviction.** The hand also advances past pinned frames and past
  the victim itself, and those moves emit no event — so the UI could not reconstruct the position.
  A test folds the emitted events and compares the result against the engine's real buffer state,
  which is how that gap was found.
- **The tree view follows the traversal, framing the current hop** (parent plus the child just
  entered). Framing the whole root-to-leaf path is unreadable: on a wide tree that box spans almost
  the entire width.
- **Viewport maths is done by hand, from the d3 layout.** React Flow's `useNodesInitialized` and
  `fitView({ nodes })` both depend on measured node dimensions, and these graphs never report as
  measured — so both silently do nothing rather than failing loudly. `requestAnimationFrame` is
  also unreliable here (throttled when the pane is not painting). A short timeout plus positions we
  already hold is deterministic. Note this means the M1 note about `useNodesInitialized` fixing the
  clipped AST tree was wrong — the panel height increase in the same change is what fixed it.
- **`execute` events are per row, per operator.** A full scan is a long trace (55 events against the
  index lookup's 25) and that length *is* the lesson — it is what the query actually costs.
- **The ad-hoc scan driver from M3 is gone.** It existed only so the buffer pool could be watched
  before an executor existed; `SeqScan` now does that work as a real operator.
- **The lock manager is real, not decorative.** It tracks what is held, is re-entrant on the same
  page and mode, ignores releases of unheld locks, and reports statistics. It has no wait queue,
  because with one query nothing could ever be queued — building one now would be untested
  speculation.
- **Playback gating is an array, not a callback.** `gates[i]` means "do not advance past step i".
  A predicate over the current step would need the step, and the step comes from the hook — the
  array breaks that cycle without a ref.
- **Keyboard shortcuts match the space bar on `code`, not `key`**, so they survive layouts where
  `key` is `'Spacebar'`.
- **React Flow's attribution badge stays.** Their licence asks you not to hide it without a Pro
  subscription. It was restyled rather than removed, because its default colour sits at ~1.2:1 here.
- **`motion` was removed from the dependencies.** It was in the plan's stack and never used — the
  animation that mattered turned out to be viewport movement and CSS transitions.
