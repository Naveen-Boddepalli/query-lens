# QueryLens

An in-browser toy relational database engine that animates a SQL query as it moves through
**Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result**.

A learning tool, not a production DB tool. See [plan.md](plan.md) for scope and
[RESEARCH.md](RESEARCH.md) for the evidence the plan is built on.

## Status: M4 complete — parser, planner, optimizer, buffer pool, B+Tree index

Five stages of eight are real. `IMPLEMENTED_STAGES` in
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
| M5 | Volcano executor wiring it all together | next |
| M6 | Lock manager visual layer | |
| M6.5 | Predict-then-reveal + editable seed data | |
| M7 | Polish, a11y, deploy | |

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

## Decisions made during M0/M1/M2/M3/M4

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
