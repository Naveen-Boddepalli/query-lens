# Design Research: Tool Page Layouts

> **Scope**: the 25 interactive tool pages under `/tools/*` (`src/pages/tools/*.tsx`, routed from the table in `src/App.tsx`) and the tools index (`src/pages/ToolsIndexPage.tsx`)
> **Question**: why do the tool pages feel primitive and crammed, and what one layout system would fix all of them?
> **Method**: a code audit of every page, then the running app (`pnpm dev`) captured with Playwright at 1440×900 and 375×812, dark theme, on 2026-11-21 (branch `design/aurora-theme`, Prism theme). Evidence crops are in [`tool-layouts/`](tool-layouts/).
> **Status**: research and proposal only. No app code changed.

---

## Executive summary

Every tool page is built the same way: a `PageHeader` with a long blurb, then one or more hand-rolled
"control cards" whose contents sit in a `flex flex-wrap` row, then KPI cards or readouts, then a
diagram panel, then a stack of deep-dive sections. All of it sits in one centred column (`max-w-4xl`
or `max-w-5xl`). The cramped look comes from that structure, not from the Prism tokens:

1. **Every control is a peer.** Parameters (configure the model), operations (do something to it),
   scenarios (load a whole worked example) and view options all sit in the same wrapping row with the
   same visual weight. Where a row breaks depends on label widths, so buttons strand onto their own
   line. Recovery puts **14 buttons, 3 selects and 2 inputs across three rows, three of them in the
   accent fill**.
2. **There is no layout region for controls, the canvas or the readout.** The page is one long
   column, so on a 1440×900 screen the diagram starts 550–900px down and ~40% of the width is empty.
   On a phone, Recovery shows **~1,450px of controls and presets before any output**.
3. **Time and stepping have no home.** Only the buffer pool uses the shared `PlaybackControls`, and it
   is below the fold. Recovery, Raft, WAL, Schedule and Concurrency each invent their own stepper,
   slider or clickable list, in different places.
4. **Two page generations disagree.** Nine pages (the older set) have breadcrumbs and four uppercase
   mono KPI cards with arbitrary `text-[0.7rem]` sizes. Sixteen pages have no breadcrumbs and inline
   readouts. Panels are re-typed as raw class strings on 23 of 25 pages instead of using
   `panelSurface`.
5. **Mobile is unfinished.** The page itself never scrolls sideways (`scrollWidth` = 375 on every
   tool), but content clips inside cards with no scroll cue: matrices (Isolation), wide tables
   (Parallel, Vector, Page, Concurrency), a select spilling out of its card (2PC). SVG diagrams scale
   to fit until unreadable (Raft, 2PC, B+Tree, Parser, Planner).

The proposal is a **tool workbench**: one shell with five named regions (header, inspector, stage,
transport, deep-dive). Every control is sorted into one of five kinds, and each kind has exactly one
home. The shell uses the existing tokens and primitives plus about ten small components in
`src/ui/tool/`. It is piloted on Buffer pool → B+Tree → Raft, then rolled out in four batches grouped
by page shape.

---

## 1. What exists today

### 1.1 Shared building blocks the tools already use

| Piece | Where | Used by | Notes |
| :--- | :--- | :--- | :--- |
| `PageHeader` | `src/ui/PageHeader.tsx` | 25/25 | Breadcrumbs optional (only 9 pages pass them); has an unused `actions` slot |
| Button primitives `btnPrimary/Secondary/Ghost` | `src/ui/primitives.ts` | 25/25 | The doc comment says *"the one primary action on a view"*; pages break this (see §2) |
| `segmentedTrack` / `segBase` / `segOn` / `segOff` | `primitives.ts` | ~10 | Most pages use `segBase` **without** the track, so options read as loose pills |
| `inputField` | `primitives.ts` | most | Used for inputs and selects alike |
| `panelSurface`, `card` | `primitives.ts` | some | 23/25 pages also hand-write `rounded-xl border border-edge bg-surface-2…` |
| `DataView` ("Show as table") | `src/ui/DataView.tsx` | 12 | The toggle renders as a right-aligned orphan line *above* its panel |
| `PlaybackControls` + `usePlayback` | `src/ui/PlaybackControls.tsx` | **1** (buffer pool) | Good component: icon transport, speed, scrubber, keyboard shortcuts |
| `ScrollRegion` | `src/ui/ScrollRegion.tsx` | 16 | Wraps the wide tables, which do scroll, but gave no cue that they did (fixed in §5.0) |
| Layout shell | `src/ui/Layout.tsx` | all | `lg:h-dvh lg:overflow-hidden` with an inner `overflow-y-auto` pane, so `position: sticky` works inside it |

### 1.2 Per-tool audit

Columns: **controls** is what the page offers (counts from the source; buttons rendered in `.map`
count once). **Above the fold** is the 1440×900 first view. **375px** is what breaks on a phone. Full
captures were taken for every tool. The crops linked here are the clearest examples.

| # | Tool (route) | Controls, as laid out | Above the fold @1440 | 375px | Main layout problems |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | Buffer pool (`buffer-pool`) | Ref-string input with a long inline hint, frames number input, 3 selects (policy, read-ahead, scan ring), Run (primary) + Generate, in one card. 4 KPI cards. Diagram. Narration card. `PlaybackControls` last | Diagram half visible. **Transport not visible** ([crop](tool-layouts/buffer-pool-1440-fold.jpg)) | Frame tiles squeeze to "frame / 0" | Run/Generate wrap to their own row. Read-ahead and scan ring are expert options shown at the same weight as policy. Transport sits far from the diagram it drives |
| 2 | Slotted page (`page`) | Target page select, page size number, preset-size segments (the same parameter twice). 4 KPI cards. Page map. Tuple table | OK | **Page-map labels collide** ("free space" over #3). **Table clips** (EMAIL, AGE hidden, no cue) | Two controls for one value. Table needs a scroll wrapper |
| 3 | Row vs column (`columnar`) | Rows, page size, Reshuffle. Then local controls inside each of 3 sections (encoding select per column, NSM/DSM/PAX segments, filter selects + slider) | Good | OK | Local controls are a good idea, but each section draws them differently. Segments without a track |
| 4 | Write-ahead log (`wal`) | Card 1: 4 segmented parameter groups + a 5-line prose aside. Card 2: txn/cell/value + Add change (primary) + Begin/Commit/Roll back + page select + Write/Read page + Flush, split by `w-px` bars. **10 example pills** + Clear. Script list + step detail. Four-way table | Controls and presets fill the fold | ~1,300px of controls before the script. **Stranded separator bars** | Parameters, operations and scenarios mixed. Prose squeezes the controls. Presets weigh as much as actions |
| 5 | Crash recovery (`recovery`) | WAL's controls + Checkpoint/Begin/End checkpoint + **Crash + Recover, both accent-filled** + "stopping again after" + Recover-then-crash. 7 examples. A phase stepper with its own back/forward slider halfway down | **3 rows of controls** ([crop](tool-layouts/recovery-1440-controls.jpg)) | **~1,450px of controls before output** ([crop](tool-layouts/recovery-375-controls.jpg)) | Three primary buttons. Separators strand on wrap. Its stepper is not the shared transport |
| 6 | B+Tree (`btree`) | Fan-out select, key input, Insert (primary)/Delete/Find, separator, Sample/1–20/Clear. 4 KPI cards. Narration above the tree. Tree with legend + zoom/fit. Key strip | Good, the best of the set | Tree **scaled to fit, unreadable**. Buttons wrap to 2 rows | Already close to a command bar. Narration sits above the diagram, not with the step |
| 7 | Hash index (`hash-index`) | Writes, scheme, bucket capacity, **"Initial buckets" disabled with no reason**, Reshuffle. Stats card. "Look up a key" card with an accent button that looks disabled when the field is empty. Directory grid | OK. The 3-col grid leaves a gap | 16 slots stack in one column (~1,400px) | Lookup is an operation in its own card, away from the stage |
| 8 | Vector index (`vector-index`) | Points, k, query, Reshuffle. Cost table. Scatter + readout. Layer bars | OK | **Recall column clipped**, method names wrap to 4 lines ([crop](tool-layouts/vector-375-clipped.jpg)) | Table needs priority columns or a scroll wrapper |
| 9 | Latch crabbing (`latch-crabbing`) | Fanout, threads, inserts, Reshuffle. 3 stat cards. Timeline "tabs" drawn as pills. **60-row table as the visualization** (≈2,000px) | Stats only | Table is the page | Tabs should be a segmented control in the panel header. A lane chart would replace 60 rows |
| 10 | LSM tree (`lsm`) | **7 parameters in one wrap row**, Reshuffle stranded on row 2. Metrics card with a 4/2/1 ragged grid. Look-up card. Levels | Controls + metrics fill the fold | OK | No grouping (workload, compaction, bloom). Ragged metrics |
| 11 | Parser (`parser`) | SQL textarea. 4 KPI cards. Token ribbon. AST | AST at the fold | AST tiny | AST is **scaled to fit even on desktop** (nodes ~6px text) |
| 12 | Grammar (`grammar`) | None. 37 rule cards (7,363px desktop, 10,770px phone) | Reference page | Very long | Needs an index or jump list, not controls. Out of the shell's main scope |
| 13 | Planner (`planner`) | SQL textarea. **9 rule checkboxes in a wrap row** with an inline "RULES:" label. 4 KPI cards. Canonical vs optimized trees. Rule log | Trees at the fold | Checkbox wall ~250px | **Canonical tree rendered tiny, optimized tree clipped** at the panel bottom ([crop](tool-layouts/planner-1440-trees.jpg)) |
| 14 | External sort (`sort`) | Records, records/page, buffer pages, "Shuffle Keys". 4 KPI cards. Prose. Run lanes | Good | OK | Title Case labels ("Shuffle Keys") |
| 15 | Hash join (`hash-join`) | Build keys, probe keys, records/page, buffer pages, "Shuffle Keys". 4 KPI cards. Partition passes. Bucket detail | Good | OK | Same as sort. Fine candidate for the generic shell |
| 16 | Join order (`join-order`) | Demo query block. Written vs DP cards. Prose. "Try your own order" chips (tiny). Lattice. Then the "Bushy plans" section with **its own control row** (shape segments + 4 selects + "Two pairs") ~2,000px down | Query + cards | 6,024px page | Two tools in one page. The second tool's controls are buried |
| 17 | Histograms (`histograms`) | Column segments (mono, no track), buckets/from/to inputs. Caption. Estimate readout. Histogram. Bucket-count sweep. "Back to this column's range" button at the bottom | Good | Histogram small | A reset action far from its controls |
| 18 | Parallel (`parallel`) | Query + dispatch segments, workers, pages/morsel. A `fieldset` of 4 per-worker speed selects (an expert option). Readout. Gantt. Speedup table. Exchange section with **3 more control groups** | Good | **Speedup and exchange tables clip**. Gantt unreadable | Per-worker speeds belong in an Advanced group |
| 19 | Locks (`locks`) | Txn segments, page select, mode segments, "Request Lock" (primary), "Deadlock Example", Reset. 4 KPI cards. Page cards. T1/T2 cards. Compatibility matrix. Timeline | Good | **Button labels wrap inside buttons** | Title Case. A scenario ("Deadlock Example") drawn as an action |
| 20 | Transaction schedules (`schedule`) | The table. Session segments + statement + Add step (primary) + BEGIN/COMMIT/ROLLBACK. Locking (4 segments) + accounts + prose. **16 example pills** + Clear. Two-lane schedule. Precedence graph. End state | Controls + presets fill the fold | Example wall ~300px. Segment labels wrap | Presets dominate. The step list is a good model but has no transport |
| 21 | Isolation matrix (`isolation`) | None (1 toggle). 3 matrices + the selected run | Matrices | **Matrix clips to 1.5 of 4 columns** ([crop](tool-layouts/isolation-375-clipped.jpg)) | Needs a sticky first column and a scroll cue, or a level picker on mobile |
| 22 | Concurrency compare (`concurrency`) | 7 example pills + separator + accounts segments. Two-lane schedule. Protocol table (rows as pills). Run detail | Good | Two-lane schedule squeezes SQL to ~10 chars per line. Table clips | On phones, lanes should collapse to a single list with session chips |
| 23 | Partitioning (`partitioning`) | Scheme segments, key, nodes, virtual nodes. "Then" segments. Readout. Before/after bars. Rings. Join section with its own controls | Good, the best-organised page | OK | A good model for local section controls |
| 24 | Two-phase commit (`2pc`) | **9 scenario pills**. Participants + 3 vote segments. Coordinator/participant/lost-message selects with long sentences as options. Outcome. Space-time diagram. Logs | Scenarios + controls | **Select overflows its card** ([crop](tool-layouts/2pc-375-overflow.jpg)). Diagram unreadable | Scenario wall. Sentence-length options |
| 25 | Raft (`raft`) | **5 scenario pills**. Servers segments, seed, loss, commands, no-op segments. Partition checkboxes + crash select. Invariants. Timeline. "Logs at tick" slider in a separate card | Timeline at ~810px | **Timeline unreadable** ([crop](tool-layouts/raft-375-timeline.jpg)) | The scrubber is detached from the timeline it scrubs. Failure injection mixed with workload |

**Tools index** (`/tools`): the card grid works and is not crammed. The category filter is a row of
pills that could become `segmentedTrack`. No change is needed for the workbench.

---

## 2. Recurring problems

Each problem names the pages where the screenshots show it most clearly.

| ID | Problem | Evidence | Why it reads as "primitive" |
| :-: | :--- | :--- | :--- |
| P1 | **Flat, ungrouped control rows.** Every parameter is a sibling in `flex flex-wrap items-end gap-3` | LSM (7 selects), Buffer pool, Hash index, Vector, Sort | Nothing tells the eye which settings belong together. Breaks depend on label length |
| P2 | **No action hierarchy.** Several accent fills per screen, or a primary that looks disabled | Recovery (Add change, Crash, Recover), WAL, Schedule, LSM/Hash "Look up" | `btnPrimary` is defined as *the one* primary action, and pages use it for "important-looking" buttons instead |
| P3 | **Four kinds of control in one row:** parameters, operations, scenarios, view switches | WAL, Recovery, Schedule (16 presets), 2PC (9), Raft (5), Locks ("Deadlock Example") | Scenarios load a whole state and should not look like a button that does one thing |
| P4 | **Prose inside the control card** | WAL, Recovery (5-line aside), Schedule (locking note) | Squeezes controls into the left 60% and adds a second reading task |
| P5 | **Hand-made separators** (`w-px` bars) | Recovery ×3, WAL ×2, Page ×2, B+Tree, Schedule, Planner, Concurrency | They strand at the start or end of a wrapped line (visible at 375px) |
| P6 | **Same job, different idiom** | Binary: segments (Raft no-op), a select (Buffer read-ahead), a checkbox (Planner). Small numeric range: number input (frames 2–8) or select. Segments with and without `segmentedTrack` | The page looks assembled, not designed |
| P7 | **Two page generations** | 9 pages: breadcrumbs, uppercase mono KPI cards, `text-[0.7rem]`/`text-[0.75rem]` (up to 10 arbitrary sizes on Planner). 16 pages: neither. Max widths 4xl vs 5xl | Moving between tools feels like switching apps |
| P8 | **The visualization isn't the hero** | At 1440×900 the first diagram starts 550–900px down. Column 896–1024px wide on a 1440 screen. Planner and Parser trees are drawn tiny, and Planner's optimized tree is clipped | The thing people came to see is the smallest, lowest element |
| P9 | **Stepping is fragmented** | Shared transport on 1 page (below the fold). Recovery's own slider. Raft's detached tick slider. WAL/Schedule/Concurrency step by clicking list rows, with no transport or keyboard | No consistent "time" affordance across a product built on step-through |
| P10 | **Orphan view toggles** | "Show as table" floats right-aligned on its own line above 12 panels | Reads as stray text, not as a control of the panel |
| P11 | **Mobile: controls first, output last; diagrams shrink; tables clip** | Recovery/WAL ~1,300–1,450px before output. Raft/2PC/B+Tree/Parser diagrams fit-scaled. Isolation/Parallel/Vector/Page/Concurrency tables clipped. 2PC select overflow. Page-map label collision. Locks button text wraps | A phone visitor sees a form, not a tool |
| P12 | **Long intro copy above everything** | Raft 7 lines desktop / 14 on phone. Recovery and WAL cite `plan.md §25.4` in user-facing text | Delays the tool. Internal references leak into the UI |
| P13 | **Label casing and disabled states** | "Request Lock", "Shuffle Keys", "Deadlock Example", "Page Resource" vs sentence case elsewhere. Hash index's disabled "Initial buckets" gives no reason | Small inconsistencies add up to "unfinished" |

What is **not** the problem: colour, type scale, radius and elevation. The Prism tokens render well
on every page. The fix is structure and component discipline.

---

## 3. How strong tools and explainers lay out controls

### 3.1 Patterns, with sources

**Fixed inspector beside the canvas, not floating over it.** Figma's UI3 beta floated its panels,
then reverted after feedback that floating panels "cramped the canvas, especially on smaller
screens". The shipped design uses fixed but resizable panels, with toolbars floating at the bottom of
the canvas. Figma also moved hidden icon menus to inline dropdowns that appear only when a value is
non-default, and kept full-context labels that match the aria-labels.
([Figma: Our approach to designing UI3](https://www.figma.com/blog/our-approach-to-designing-ui3/),
[Navigating UI3](https://help.figma.com/hc/articles/23954856027159))
→ *QueryLens: a fixed left inspector at `lg`. Never overlay controls on the diagram.*

**Group, label, then reduce noise.** Figma's UI3 notes say properties are "grouped to match more
modern workflows", with a header row for actions on the selection. Linear's redesign was about
reducing visual noise and tightening alignment, not adding chrome.
([Figma help](https://help.figma.com/hc/articles/23954856027159),
[Linear: How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui),
[Linear: A design reset](https://linear.app/now/a-design-reset))
→ *Named groups (`fieldset` + `legend`) and aligned label/value rows replace the wrapping row.*

**One primary action per view.** Design systems agree. SAP Fiori: "only one primary action for the
entire page", with the rest secondary. Apple: one primary per toolbar, styled prominently. KDE: about
8 frequent toolbar commands at most, and no more than 3 on mobile.
([SAP Fiori: Action placement](https://www.sap.com/design-system/fiori-design-web/v1-142/foundations/best-practices/global-patterns/action-placement),
[Apple HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars),
[KDE HIG: Toolbar](https://develop.kde.org/hig/patterns-command/toolbar/))
→ *Already QueryLens's own rule (`btnPrimary` doc comment). The system has to enforce it.*

**Segmented controls for 2–5 mutually exclusive view or mode choices.** Guidance converges on 2–5
segments of equal width, used for selecting or switching views, never for actions (add, remove,
edit). Fall back to a dropdown when space is short. Apple suggests segmented controls for switching
views in a toolbar or inspector pane.
([Apple HIG: Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls),
[GitLab Pajamas: Segmented control](https://design.gitlab.com/components/segmented-control),
[eBay Playbook: Segmented button](https://playbook.ebay.com/design-system/components/segmented-button))
→ *A `Segmented` component that becomes a `<select>` when it has more than 5 options or not enough
width. "Crash" and "Insert" stay buttons.*

**Checkbox vs switch vs radio.** A switch suits a clearly binary setting that applies at once. If
the label can't describe both states, use radios or segments. A checkbox is for selection within a
set.
([NN/g: Toggle-switch guidelines](https://www.nngroup.com/articles/toggle-switch-guidelines/),
[NN/g: Checkboxes](https://www.nngroup.com/articles/checkboxes-design-guidelines/),
[GNOME HIG: Switches](https://developer.gnome.org/hig/patterns/controls/switches.html),
[Primer: Toggle switch](https://primer.style/product/components/toggle-switch/guidelines))
→ *Planner's 9 rules are a set (checkbox list in a group, with all/none). "New leader's no-op on/off"
is a switch. "Log before data: Enforced/Off" is a switch whose label states the rule.*

**Progressive disclosure for rarely used settings.** Defer advanced features to a secondary
location to make the interface easier to learn and less error-prone. Disclosure based on guesses
backfires, because people know a feature exists but can't find it.
([NN/g video: Progressive disclosure](https://www.nngroup.com/videos/progressive-disclosure/),
[IxDF: Progressive disclosure](https://ixdf.org/encyclopedia/progressive_disclosure.html))
→ *Every inspector gets an "Advanced" group, collapsed by default, that names its contents in the
summary ("Read-ahead, scan ring").*

**Playback lives with the stage, at the bottom, and is keyboard-driven.** VisuAlgo puts "the typical
media UI at the bottom of the page" (to start, previous, play/pause, next, to end, speed), driven by
Space, arrows and −/+. Its separate e-Lecture mode is toggled from the top right.
Hohman et al. cite "the ability to play, pause, and scrub content" as letting readers set their own
pace. Their summary of the stepper-vs-scroller debate notes one study found comprehension better in
slideshow layouts, and that mobile likely needs swipe stepping.
([VisuAlgo: Sorting](https://visualgo.net/en/sorting),
[Distill: Communicating with Interactive Articles](https://distill.pub/2020/communicating-with-interactive-articles/))
→ *One sticky `Transport` at the bottom of the stage for every step-based tool, using the existing
`usePlaybackShortcuts`.*

**Devtools: a toolbar over an overview, then the detail view, then tabs below.** Chrome's
Performance panel stacks an action bar, then a timeline overview you drag to select a range (with
breadcrumbs for zoom levels), then the main track view. Analysis tabs (Summary, Bottom-up, Call
tree, Event log) sit below, with a filter row beside them. Recording options sit behind a "Capture
settings" disclosure.
([Chrome DevTools: Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference))
→ *Raft and 2PC timelines: the scrubber belongs on the timeline itself. Analysis panels (logs,
invariants, tables) become tabs under the stage instead of more stacked cards.*

**Notebook controls: a labelled input column with a fixed label slot.** Observable Inputs give every
input a `label` that sits apart from the control (`width` is documented as "not including the
label"). `Inputs.form` combines several inputs "into a single cell for a more compact display". Radio
and checkbox show every option. Select shows one or a few.
([Observable Inputs README](https://github.com/observablehq/inputs),
[Observable Inputs docs](https://observablehq.com/framework/inputs/))
→ *`ControlRow` uses a fixed label column, so groups align vertically and stop wrapping.*

**Explorable explanations keep controls next to the thing they change.** Red Blob Games' notes
describe linked side-by-side diagrams, and observe that labels on the diagram itself would be best,
but "interactivity makes it harder". Hohman et al. stress details-on-demand and in-place reveal.
([Red Blob Games: notes on interactive explanations](https://redblobgames.com/x/2306-educ432),
[Distill](https://distill.pub/2020/communicating-with-interactive-articles/))
→ *Local controls for deep-dive sections, as Columnar and Partitioning already do, get a standard
`SectionControls` row in the section header.*

**Tables on phones.** Columns must stay legible without zooming. Lock the header and the first
column. Show clearly that more columns exist off-screen (arrows or cut-off cells, not dots). Let
people pick which data to see. Rotating the phone is a last resort.
([NN/g: Mobile tables](https://www.nngroup.com/articles/mobile-tables/),
[Chrome: Responsive tables](https://developer.chrome.com/docs/modern-web-guidance/guides/ui-atoms/responsive-table))
→ *`ResponsiveTable`: horizontal scroll inside the card, sticky first column, an edge-fade cue. For
Isolation, a level picker on phones.*

**Bottom sheets for controls on phones.** A standard (non-modal) bottom sheet keeps the main content
usable underneath. A modal sheet blocks it.
([Material: Bottom sheets](https://m3.material.io/components/bottom-sheets),
[Android: Bottom sheets](https://developer.android.com/develop/ui/compose/components/bottom-sheets))
→ *On phones the inspector becomes a collapsible summary bar ("LRU · 4 frames · Edit") that opens
the groups in place, or as a standard sheet. The stage stays visible.*

**Size the layout to the container, not the viewport.** Container size queries are Baseline Widely
Available, so a control group can switch from two columns to one based on the inspector's width.
([MDN: Container size and style queries](https://developer.mozilla.org/docs/Web/CSS/Guides/Containment/Container_size_and_style_queries),
[web-features: container queries](https://web-platform-dx.github.io/web-features-explorer/features/container-queries))
→ *Tailwind v4 has `@container` built in. `Segmented` → select fallback and two-column groups use
container queries.*

### 3.2 What to borrow, and what not to

| Borrow | Avoid |
| :--- | :--- |
| Figma's fixed, resizable side panel and full-context labels | Figma's floating panels over the canvas (they reverted them) |
| VisuAlgo's bottom transport and keyboard map | VisuAlgo's 1366px-minimum desktop-only layout |
| DevTools' toolbar → overview → detail → tabs stack for timelines | DevTools' density (QueryLens is for learners) |
| Observable's label column and compact grouped form | Observable's notebook-length vertical flow as the only layout |
| Linear's noise reduction (fewer borders, tighter alignment) | Adding a card per control group (more borders, not fewer) |

---

## 4. Proposed system: the tool workbench

### 4.1 Regions

```
lg (≥1024px)                                                          max-w-screen-2xl, px-6
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ HEADER  Tools / Buffer pool                                        [Share] [Reset] [⋯]         │
│ Buffer pool sandbox — one-line summary.  About this tool ▸                                     │
├───────────────────────┬──────────────────────────────────────────────────────────────────────┤
│ INSPECTOR  18rem      │ METRICS  Accesses 10 · Hit ratio 40% · Evictions 3 · Step 7/25        │
│ sticky, own scroll    ├──────────────────────────────────────────────────────────────────────┤
│                       │ STAGE  ┌ title ─────────── legend ──── [Diagram|Table] [− + Fit] ┐    │
│ Scenario  [▾ LRU loop]│        │                                                        │    │
│ ─ Workload ─────────  │        │                 the visualization, full width           │    │
│ Ref string [______]   │        │                                                        │    │
│ ─ Pool ─────────────  │        └────────────────────────────────────────────────────────┘    │
│ Frames     [− 4 +]    │ NARRATION  "Page 3 misses; frame 1 (page 0) is the LRU victim."       │
│ Policy     [LRU   ▾]  ├──────────────────────────────────────────────────────────────────────┤
│ ▸ Advanced (2)        │ TRANSPORT sticky  ⏮ ◀ [▶ Play] ▶ ⏭  ━━━━●━━━━━━  7/25  1× ▾         │
├───────────────────────┴──────────────────────────────────────────────────────────────────────┤
│ DEEP DIVE  sections with their own local controls (tables, comparisons, explanations)          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Header**: breadcrumbs always. Title + one-sentence summary. The long blurb moves into an "About
  this tool" disclosure, open on first visit (reuses `firstVisit.ts`), collapsed after. `PageHeader`'s
  existing `actions` slot holds tool-level meta actions: share link (URL state already exists),
  reset, download PNG/SVG.
* **Inspector** (left, `lg` and up): every *parameter* and the *scenario picker*. Sticky inside the
  layout's scroll pane, with its own scroll when long. Width token `--tool-rail` (18rem). Resizable
  later, as in Figma, but not needed for v1.
* **Stage** (centre): an optional metric strip, the visualization panel with its own header toolbar
  (title, legend, view toggle, zoom), the narration line, and the transport. It takes all the
  remaining width.
* **Transport**: `PlaybackControls`, made sticky to the bottom of the stage column. Present only on
  step-based tools.
* **Deep dive**: everything that is not the live model (comparison tables, "the same script four
  ways", bushy plans), in consistent `ToolSection`s with an optional local control row in the section
  header.

**md (768–1023px)**: the inspector becomes a full-width collapsible bar above the stage (groups
in a 2- or 3-column grid via container queries). Everything else is the same.

**Phone (<768px)**: header (title + summary only) → **inspector summary bar** ("LRU · 4 frames ·
read-ahead off · [Edit]"; tapping it expands the groups in place, or opens them as a standard bottom
sheet) → command bar → stage → narration → deep dive. The transport sticks to the bottom of the
viewport. Diagrams keep a readable minimum scale and pan horizontally inside the stage, with an edge
fade, instead of shrinking to fit. Tables use `ResponsiveTable`.

### 4.2 Control taxonomy: every control has exactly one home

| Kind | What it does | Examples today | Home | Component |
| :--- | :--- | :--- | :--- | :--- |
| **Parameter** | Configures the model. The output recomputes live | frames, policy, fan-out, compaction strategy, steal/force, servers, loss % | Inspector, in a named group | `ControlGroup` + `ControlRow` + `Segmented` / `Stepper` / `Switch` / select |
| **Scenario** | Loads a whole worked example (parameters + script) | WAL's 10, Schedule's 16, 2PC's 9, Raft's 5, Recovery's 7, Concurrency's 7, "Deadlock Example" | Top of the inspector (one control) | `ScenarioPicker`: a menu with title + one-line description, prev/next arrows, shows "Custom" once edited |
| **Operation** | Does one thing to the current state | Insert/Delete/Find, Add change, Begin/Commit, Crash, Recover, Request lock, Look up | Command bar at the top of the stage, beside what it acts on | `CommandBar`: input(s) + **one** primary + secondaries + overflow menu. A separate `btnCritical` for Crash |
| **Time** | Moves through the trace | play/step/scrub, "logs at tick", recovery phase back/forward, clicking a script row | Transport (sticky). Row clicks still work and sync with it | `Transport` (wraps `PlaybackControls`) + optional phase chips |
| **View** | Changes presentation, not the model | Show as table, Naive/Crabbing/Optimistic timeline, zoom/fit, legend | Stage panel header | `StagePanel` toolbar slot, `Segmented` (small) |
| **Meta** | About the page | Reshuffle seed, Reset, Clear, share, download | Header actions (Reset/Share). Reshuffle as a ghost button inside the Workload group next to the seed it changes | existing `btnGhost` |

Rules that come out of this:

1. **One `btnPrimary` per tool**: the main operation in the command bar (Insert, Add change, Request
   lock). Tools with no operation (Sort, LSM, Vector…) have *no* primary. Parameters apply live.
   Buffer pool's "Run" becomes "apply on Enter or blur" for the ref string.
2. **Crash is critical, not primary.** Add `btnCritical` (an outline using `--color-evict`, filled on
   hover). Recover becomes secondary, or the primary when the state is "crashed" (the primary follows
   the state).
3. **No `w-px` separators.** Grouping comes from `CommandBar` clusters (`gap-1` inside a cluster,
   `gap-3` between) and from overflow menus, which never strand.
4. **No prose inside control groups.** One-line help as `ControlRow` hint text or an `(i)` tooltip.
   Longer explanations move to the narration line (state-dependent) or the About disclosure.
5. **Idiom per value type**: 2–5 exclusive options → `Segmented` (with a track, equal widths, select
   fallback). Binary setting → `Switch` whose label states the rule. Small integer range →
   `Stepper` (− n +). Free text/SQL → `inputField`/`CodeMirror`. Sets → a checkbox list in a group
   with all/none. Long sentence options (2PC) → select with short labels plus a description line.
6. **Disabled means explained**: a disabled control shows why, in its hint ("Linear hashing only").
7. **Sentence case everywhere**: "Request lock", "Shuffle keys".

### 4.3 Components (`src/ui/tool/`)

All are thin, built from the existing primitives and tokens, and in the module-constant + small
component idiom `primitives.ts` already uses.

| Component | Purpose | Sketch of the API | Built on |
| :--- | :--- | :--- | :--- |
| `ToolShell` | The regions + responsive switching | `<ToolShell header inspector command metrics stage narration transport>{deepDive}</ToolShell>` | CSS grid `lg:grid-cols-[var(--tool-rail)_minmax(0,1fr)]`, `@container` |
| `ToolHeader` | Breadcrumbs, title, summary, About disclosure, actions | `title`, `summary`, `about`, `actions`, `crumb` | `PageHeader` (extended, not replaced) |
| `Inspector` | Sticky rail / md bar / phone summary bar | `summary="LRU · 4 frames"`, children are groups | `panelSurface`, `<details>` on phones |
| `ControlGroup` | A named, optionally collapsible group | `legend`, `advanced?`, `defaultOpen?` | `fieldset`/`legend`, `eyebrow` |
| `ControlRow` | Label column + control + hint | `label`, `hint`, `htmlFor` | `grid-cols-[7.5rem_minmax(0,1fr)]`, stacks under a 16rem container |
| `Segmented` | Radiogroup with a track, equal widths, select fallback | `value`, `onChange`, `options`, `size` | `segmentedTrack`/`segBase`/`segOn`/`segOff`, `role="radiogroup"` |
| `Stepper`, `Switch` | Small int range, binary setting | `min`, `max` / `checked` | `inputField`, accent tokens |
| `ScenarioPicker` | Presets as one control | `scenarios: {id,title,blurb}[]`, `value`, `onPick`, `isCustom` | listbox popover (Radix not needed: `<select>` + description first) |
| `CommandBar` | Operations, one primary | `<CommandBar primary={…} secondary={[…]} overflow={[…]}>inputs</CommandBar>` | `btnPrimary/Secondary/Ghost`, new `btnCritical` |
| `StagePanel` | The visualization frame + toolbar | `title`, `legend`, `views={['Diagram','Table']}`, `zoom`, `minScale` | `panelSurface`, `.ql-stage-panel` with `--stage` set by tool category |
| `MetricStrip` | One KPI style for all tools | `items: {label, value, sub?, tone?}[]` | `text-label`/`text-heading`, `tabular-nums`, `--color-hit/miss/evict` |
| `Transport` | Sticky playback + phases | `playback`, `length`, `phases?` | `PlaybackControls`, `usePlaybackShortcuts` |
| `ResponsiveTable` | Tables that survive 375px | `stickyFirstColumn`, `caption` | `ScrollRegion` + an edge-fade mask |
| `ToolSection` | Deep-dive section with local controls | `title`, `controls?`, `children` | `card` |

Token additions in `src/index.css` `@theme` (no new colours):

```css
--tool-rail: 18rem;          /* inspector width at lg */
--tool-gap: 1rem;            /* gap between regions; gap-4 */
--control-label: 7.5rem;     /* ControlRow label column */
--stage-min-h: 22rem;        /* stage panel minimum height at lg */
```

Plus in `primitives.ts`: `btnCritical`, `controlLabel` (`text-label text-ink-dim`), and
`metricValue`/`metricLabel`, so the uppercase-mono KPI style and the `text-[0.7rem]` sizes can be
deleted.

**Prism tie-in**: each tool category already maps to a stage colour (`storage = buffer`,
`indexing = index`, `query = execute`, `transactions = lock`, `distributed = parse`; `frontend.md`).
`ToolShell` sets `--stage` from the tool's category, and `StagePanel` uses `.ql-stage-panel`, so the
stage header rule, the active `Segmented` option and the transport progress pick up that one hue.
That gives each family an identity with no new tokens, and `--stage` is a registered `<color>`, so it
cross-fades.

### 4.4 Before / after sketches

#### A. Buffer pool (parameters + playback)

```
BEFORE (1440×900, first view)                       AFTER
┌ Tools / Buffer Pool ───────────────────┐          ┌ Tools / Buffer pool ──────────────────── [Share][Reset] ┐
│ Buffer pool sandbox                    │          │ Buffer pool sandbox — watch a policy pick victims. About ▸│
│ 4-line blurb …                         │          ├──────────────┬───────────────────────────────────────────┤
│┌ Reference string (long hint…) Frames  ┐│         │ Scenario     │ Accesses 10 · Hit 40% · Evict 3 · LRU     │
││ [0 1 2 3 4 …]   [4] Policy[LRU▾]       ││         │ [Loop ▾] ◀ ▶ │┌ Frames ── hit ● miss ● evict ● ─────────┐│
││ Read-ahead[off▾] Scan ring[off▾]      ││          │ ─ Workload ─ ││ [0] [1] [2] [3]   clock hand ↻           ││
││ [Run] [Generate pattern]   ← own row  ││          │ Ref [0 1 2…] ││                                          ││
│└────────────────────────────────────────┘│         │ ↻ Generate   │└──────────────────────────────────────────┘│
│ [ACCESSES][CURRENT STEP][HIT][POLICY]  │          │ ─ Pool ───── │ Page 3 misses; frame 1 is the LRU victim.  │
│┌ frames… (half visible) ───────────────┐│         │ Frames [−4+] │ ⏮ ◀ [▶ Play] ▶ ⏭ ━━━●━━━━━ 7/25  1×▾ (sticky)│
  … narration, transport below the fold             │ Policy [LRU▾]│                                            │
                                                    │ ▸ Advanced(2)│                                            │
                                                    └──────────────┴────────────────────────────────────────────┘
```

Changes: Run disappears (the ref string applies on Enter). Read-ahead and scan ring go under
Advanced. The "Current step" KPI moves into the transport. Diagram, narration and transport are all
visible in the first view.

#### B. Crash recovery (the most crowded page)

```
BEFORE: 3 control rows, 3 accent buttons, 7 preset pills, all above the script
[2|3|4] [Enforced|Off] [Steal|No-steal] [No-force|Force]  │ 5-line prose aside
T1▾ a▾ [99] [Add change] [Begin T1][Commit T1][Roll back T1] | 1▾ [Write page]
[Read page][Flush log] | [Checkpoint][Begin ckpt][End ckpt] | [Crash][Recover]
…stopping again after [2] [Recover, then crash]
Examples [Redo…][Undo…][Both at once][A checkpoint…][Crash during recovery][Break the rule][Clear]

AFTER
┌ INSPECTOR ─────────────┐ ┌ COMMAND BAR ────────────────────────────────────────────────────────┐
│ Scenario               │ │ Txn [T1▾] Cell [a▾] Value [99]  [Add change]  Begin · Commit · Roll back│
│ [Redo: committed… ▾]◀▶ │ │ Page [1▾] Write · Read · Flush log   Checkpoint ▾   ⚠ Crash    ⋯       │
│ ─ Machine ──────────── │ └──────────────────────────────────────────────────────────────────────┘
│ Pool frames [2|3|4]    │ ┌ STAGE  Script │ Step 6: recover ─────────── [Diagram|Table] ───────┐
│ ─ Rules ────────────── │ │ 1 begin T1   │ Analysis → Redo → Undo   (phase chips)              │
│ Log before data  ◉ on  │ │ 2 set a=99   │ Buffer pool │ Disk │ Durable log │ Log buffer (tabs) │
│ Uncommitted [Steal|No] │ │ … 6 recover ●│                                                      │
│ At commit [No-force|F] │ └──────────────────────────────────────────────────────────────────────┘
│ ▸ Crash timing         │  ⏮ ◀ [▶] ▶ ⏭ ━━━━━━●━ step 6/6 · Analysis 4 · Redo 3 · Undo 0 (sticky)
│   (stop again after N) │
└────────────────────────┘  DEEP DIVE: "If the machine stopped here", "Is the database right?"
```

Changes: the 7 examples become one picker. The 4 rule groups become a "Rules" group with one-line
hints (the prose aside goes to About). Operations become a two-line command bar with clusters, one
primary (Add change), Crash as `btnCritical`, and Recover becomes the primary only after a crash.
Checkpoint variants go into a menu. "Recover, then crash" goes into the collapsed "Crash timing"
group. The recovery phase stepper merges into the one transport (phase chips on the scrubber). The
four state tables become tabs in the stage instead of a 2×2 card grid.

The same treatment covers **WAL** (subset), **Schedule** (session cluster + statement + Add step;
BEGIN/COMMIT/ROLLBACK as secondaries; 16 examples in the picker, grouped by anomaly family) and
**Concurrency**.

#### C. Raft (scenarios, failure injection, timeline scrub), desktop and phone

```
AFTER, desktop
┌ INSPECTOR ───────────────┐ ┌ METRICS  Leader S2 · term 1 · committed 6 · invariants 4/4 ✓ ────────┐
│ Scenario [Leader crashes▾]│ ├ STAGE  Timeline ──── follower ● candidate ● leader ● down ● [Diagram|Table]┤
│ ─ Cluster ─────────────  │ │ S1 ▕T0▕T1──────────────────────────────────────────────▏               │
│ Servers      [3|5]       │ │ S2 ▕T0▕▇T1━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▏  ← drag = scrub│
│ Client cmds  [5 ▾]       │ │ …  0      30      60      90     120     150 ticks                     │
│ No-op on new leader  ◉   │ ├ [Logs at tick] [Invariants] [Messages]  ← analysis tabs (DevTools-style)│
│ ─ Failures ────────────  │ │ S1 1·T1 no-op 2·T1 x=1 …                                               │
│ Message loss [0% ▾]      │ └────────────────────────────────────────────────────────────────────────┘
│ Partition  S1 S2 S3 S4 S5│  ⏮ ◀ [▶] ▶ ⏭ ━━━━━━━━━━━━━━━━━━━━━━●  tick 150/150  1× (sticky)
│ Crash        [none ▾]    │
│ ▸ Advanced: seed [1] ↻   │
└──────────────────────────┘

AFTER, 375px
┌ Raft ──────────────────────┐
│ Elect, then replicate ▾ ◀ ▶│  ← scenario picker stays visible
│ 5 servers · 0% loss · Edit │  ← inspector summary bar (expands in place)
│┌ Timeline ── [Diagram|Tbl]┐│
││ S1 ▕T0▕T1────── → pans    ││  ← min 2px per tick; horizontal pan + edge fade
││ S2 ▕T0▕▇T1━━━━━ →         ││
│└───────────────────────────┘│
│ Leader S2, term 1, entry 6 ✓│
│ [Logs] [Invariants]         │
│ ⏮ ◀ [▶] ▶ ⏭ ━━━●━━ 150/150  │  ← sticky to viewport bottom
└────────────────────────────┘
```

Changes: the detached "logs at tick" slider merges into the transport, and dragging on the timeline
scrubs (as in DevTools' overview). Partition checkboxes become toggle chips in a "Failures" group,
separate from cluster settings. The seed goes to Advanced. The invariants panel becomes a tab beside
the logs. On phones the timeline keeps its scale and pans instead of shrinking to the
[current thumbnail](tool-layouts/raft-375-timeline.jpg).

### 4.5 Mobile rules (phones, <768px)

1. Output before configuration: scenario picker + inspector summary bar, then the stage. Never
   ~1,400px of controls first.
2. Diagrams have a minimum readable scale (node text ≥ 11px). Overflow pans inside `StagePanel`, with
   an edge fade and a "Fit" button, instead of `viewBox` fitting to 343px.
3. Tables go in `ResponsiveTable`: sticky first column, header visible, edge-fade cue. For matrices
   with more than 4 data columns, add a column picker (Isolation: pick a level).
4. Two-lane schedules (Schedule, Concurrency) collapse to one list with session chips (A/B) below
   480px container width.
5. Sticky transport at the bottom of the viewport, with targets ≥ 24px (already the rule in
   `primitives.ts`, WCAG 2.2 SC 2.5.8), plus swipe left/right on the stage to step, as Hohman et al.
   suggest.
6. Selects use short option labels. Sentence-length descriptions go below the control (2PC).

---

## 5. Migration plan

### 5.0 Quick wins (independent, a few lines each; can land before the shell)

| Fix | Pages |
| :--- | :--- |
| Wrap wide tables in `ScrollRegion` with a sticky first column | Isolation, Parallel (×2), Vector, Page, Concurrency |
| `min-w-0 max-w-full` on selects in flex rows | 2PC (overflow) |
| Sentence-case button labels | Locks, Sort, Hash join, Page |
| Explain disabled controls in a hint | Hash index ("Initial buckets") |
| Replace `w-px` separators with `gap-3` between clusters | Recovery, WAL, Page, B+Tree, Schedule, Planner, Concurrency |
| Remove `plan.md §…` references from user-facing blurbs | WAL, Recovery, Schedule, Isolation, Concurrency, Join order |
| Fix tree fit/clip: give the canonical and optimized trees the same scale and enough height | Planner, Parser |

**Status (2026-11-21): done.** Two findings were corrected on the way. The wide tables were already
inside `ScrollRegion` and did scroll; what they lacked was any sign of it. `ScrollRegion` now fades
the edge with more behind it and can pin the first column (`stickyFirst`). The 2PC overflow was the
select's intrinsic width, now capped by `inputField`'s `max-w-full`, and a re-measure found one more
overflow, the recovery step slider. The Planner clip came from `FlowTree` fitting a nominal 62px node
height while plan operators render up to 128px; it now fits each node's rendered height. Planner and
Parser panels take their height from the tree's depth. Separators became cluster wrappers, so a
cluster wraps as one unit. Parser on a phone is still limited by width, so it is still small; that
needs the pan-instead-of-shrink rule in §4.

### 5.1 Build order

| Phase | Work | Pages | Why this order | Size |
| :-: | :--- | :--- | :--- | :-: |
| 0 | Build `src/ui/tool/*`, the tokens and `btnCritical`. Add a Playwright spec that screenshots every tool at 1440 and 375 and fails on `scrollWidth > clientWidth` *inside* cards | none | The components and the regression net come first | M |
| 1 | **Pilot** (one page per commit) | Buffer pool → B+Tree → Raft | Three shapes: parameters + playback, operations (command bar), scenarios + failures + timeline scrub. Buffer pool already has `PlaybackControls` | M |
| 2 | Older-generation pages (KPI cards + breadcrumbs) → `MetricStrip`, inspector | Sort, Hash join, Page, Parser, Planner, Locks | Removes the second page style early. Mostly mechanical | S each |
| 3 | Parameter-sweep tools (no operations, live recompute) | LSM, Hash index, Columnar, Histograms, Vector, Latch crabbing, Partitioning, Parallel, 2PC | Inspector + stage + `ToolSection`. Latch crabbing's tabs → `Segmented`. 2PC scenarios → picker | S–M each |
| 4 | Script and step tools sharing `CommandBar` + transport | WAL → Recovery → Schedule → Concurrency | Largest pages. WAL first because Recovery is a superset. Needs the step list ↔ transport sync | L each |
| 5 | Reference-shaped pages | Isolation, Join order (split "Bushy plans" into a `ToolSection` with local controls), Grammar (jump list) | Least interactive. Mostly `ResponsiveTable` + sections | S–M |

**Phase 0 status (2026-11-21): done.** The components are in `src/ui/tool/` (documented in
`frontend.md` §8.4), with unit tests in `src/ui/tool/__tests__/`. `e2e/toolLayout.spec.ts` checks all
25 tools at 1440 and 375px for page overflow, elements escaping their card and content clipped inside
one. On its first run it found one more bug, in the slotted page's map, which is now fixed.
`TOOL_SHOTS=1` saves the screenshots.

**Phase 1 progress (2026-11-22):** Buffer pool is on the workbench. Open questions 1–3 went with the
recommendations: there is no Run button (the string applies on Enter or blur), the inspector sits on
the left, and on phones the settings expand in place. The page has no metric strip, because the frame
panel already shows hits, misses, evictions and the hit rate. Its scenarios are the buffer-pool
lesson's seven setups. At 1440×900 the stage starts at 268px on a return visit, and the transport is
in the first view. The phone transport needed a layout fix: the layout's scroll pane now scrolls only
from `lg` up, so `position: sticky` sticks to the phone's own viewport.

B+Tree followed (2026-11-22). Key, Insert (the one primary), Delete and Find form the command bar.
The Sample, 1–20 and Clear buttons became a "Starting keys" picker, since Clear and "Empty tree"
were the same thing, and fan-out became a four-option `Segmented`. The four KPI cards became a
`MetricStrip`, and the narration moved under the tree. On phones, `FlowTree` takes a `minZoom`: a tree
too wide to fit at 0.8 is framed at 0.8 from the top and pans, which is §4.5 rule 2, and Fit still
shows the whole tree.

Raft finished Phase 1 (2026-11-22). The five scenario buttons became a picker. Cluster settings
(servers, client commands, a no-op `Switch`) and failures (message loss as a `Segmented`, the
partition as toggle chips, the crash, with each tick range applied on Enter or blur) are now
separate groups, and the seed is under Advanced. The detached "logs at tick" slider is gone: one
`Transport` runs over the run's ticks. It opens on the finished run, lingers on elections and
crashes, and plays the calm run in about twenty seconds. Its phase chips jump to each election and
failure. Clicking the timeline, or dragging on it with a mouse, scrubs. The narration says what
happened at the playhead, the `MetricStrip` (leader, committed, leaders elected, safety) follows it,
and the logs under the timeline show that tick. Diagram and Table are a view switch in the stage
header. On phones the timeline keeps a 44rem scale and pans, scrolling to keep the playhead in view
once it moves. Changes from the sketch: the safety checks are a section below the workbench rather
than a tab beside the logs, so all four are visible without a click, and the metric carries the
4/4 summary. Fixed along the way: the playback shortcuts no longer take Space from a focused button
or arrows from a segmented control. Raft is the first page to put both on one screen.
**Phase 2 status (2026-11-22): done.** The six older-generation pages (breadcrumbs, uppercase KPI
cards, a 4xl column) are on the workbench, one commit each: Sort, Hash join, Slotted page, Parser,
Planner and Locks. That retires the second page style.

- **Sort and Hash join** are the plain parameter-sweep shape: Data and Memory groups (`Stepper`,
  `Segmented`), a readout, every pass on one stage, and the cost sentence as the narration.
- **Slotted page** has one size field. 512 B, 4 KB and 8 KB are shortcut chips into it, not a
  second control for the same value. The slot table sits on the stage under the map, so picking a
  tuple in either picks it out in both. Typing a size no longer snaps back on each digit.
- **Parser** has no inspector, because the SQL is its only input. The SQL goes in the command
  region with a menu of six examples, and the token ribbon sits over the tree on the stage.
- **Planner** puts the index `Switch` and a rule checklist (All, None, and a "fired" mark per rule)
  in the inspector. The query and five worked examples go in the command region, and both plans
  sit side by side on the stage.
- **Parser and Planner** both dropped their readouts. Every number in them was already in the
  stage header, the checklist or the plan captions, and the readout pushed the trees down.
- **Locks:** the "Deadlock example" button became one of five scenarios. The next request's
  transaction, page and mode moved into the command bar with Request lock as the one primary.
  The narration repeats the last step's lines, and the timeline and the compatibility matrix are
  sections below.

Fixes along the way, each its own commit:

- `Stepper` clamped on every keystroke, so 32 could not be typed into a 6–64 field. It now applies
  a value once it is in range and clamps on blur. It also hides the browser's spin arrows, which
  clipped two digits.
- Plan nodes with a long cost basis outgrew the tree's 144px row and ran into the row below, in
  the Planner and the Playground alike. The basis is clamped to two lines (still whole for a screen
  reader and in the hover title), and wide nodes get a 192px row.
- `AstTree` and `PlanTree` take `FlowTree`'s `minZoom`. The parser tree is never framed below 0.7
  (0.8 on a phone) and pans instead, because fitting a clause-heavy statement drew 5px labels even
  on a desktop. The plans use 0.7 on phones.

**Phase 3 status (2026-11-22): done.** The nine parameter-sweep pages are on the workbench, one
commit each: LSM tree, Hash index, Row vs. column, Histograms, Vector index, Latch crabbing,
Partitioning, Parallel execution and Two-phase commit. Every tool page now uses `ToolShell`.

- **Shared shape.** Settings go in the inspector as `Stepper` and `Segmented`. An operation goes in
  the command bar: a key lookup on LSM and Hash index, a cluster change on Partitioning. The live
  numbers go in a four- or six-item readout, so phones get even rows. The main picture sits on
  the stage, and every former `DataView` toggle is now the stage's Diagram | Table switch. Deep dives
  follow as `ToolSection`s.
- **Settings that apply to one mode only.** A leveled-only, linear-only, ring-only or
  shared-queue-only control is no longer greyed out with no reason given. Under the other mode it
  gives way to a one-line note that says why it does not apply.
- **Latch crabbing.** The protocol tabs became a `Segmented` in the stage header over the timeline.
  The readout follows the chosen protocol, and the three side-by-side columns became one
  comparison table.
- **Two-phase commit.** The nine scenario buttons became a `ScenarioPicker` with a blurb each,
  matched to the current settings, and the outcome sentence became the narration.
- **Shared sections stay.** Partitioning keeps its distributed join section and Parallel its
  exchange section, which challenges share; both now sit below the workbench.

Fixes along the way:

- `Stepper` sizes its input to its maximum, so four-digit values (Histograms' range, Columnar's
  rows) no longer clip. It also takes optional `buttonLabels`, so a picker reads "Previous query" and
  "Next query" rather than "Fewer query".
- A `ToolSection` description keeps a 16rem basis, so on a phone the header controls wrap below it
  instead of squeezing it.
- Chromium can leave a stale zero-height box for an inspector row whose label or hint text changes
  in place next to rows that appear or vanish. The row vanished from the accessibility tree too, so
  tests caught it. LSM's trigger row is keyed on the strategy, and Parallel's dispatch hint is fixed
  text, with the per-dispatch explanation moved into the narration. When a mode switch changes a
  row's label or hint, check the row after switching.

Each tool migrates as its own commit with before/after screenshots from the Phase 0 spec, matching
the repo's one-item-per-commit cadence. The URL state (`addressBar.ts`, `walUrl.ts`, `scheduleUrl.ts`
…) does not change, because the shell only moves controls, so shared links keep working.

### 5.2 How to tell it worked

* At 1440×900: the stage top is ≤ 300px from the page top on every tool, and the transport is visible
  without scrolling.
* At 375px: the first diagram or output is within one screen (≤ 812px) on every tool, nothing clips
  inside a card, and the e2e overflow check passes.
* At most one `btnPrimary` per page (a lint-style unit test that renders each page and counts
  `.ql-fill-accent` buttons).
* Zero `text-[…rem]` arbitrary sizes and zero hand-written panel class strings in
  `src/pages/tools/`.

---

## 6. Open questions for the owner

1. **Live recompute everywhere?** Every parameter tool already recomputes instantly except Buffer
   pool's "Run". The proposal removes Run. Keep it if the explicit commit is part of the lesson.
2. **Inspector on the left or the right?** Left matches reading order and keeps the transport under
   the stage. Figma and DevTools put inspectors on the right of a canvas. Left is recommended because
   here the controls *precede* the output rather than describe a selection.
3. **Phone controls: expand in place or bottom sheet?** In-place `<details>` is simpler and needs no
   focus management. A standard sheet keeps the stage in view while editing. In-place is recommended
   for v1.
4. **Scope of Grammar and Isolation**: treat them as reference pages (jump list, responsive tables)
   rather than forcing the workbench on them.

---

## Sources

* Figma — [Our approach to designing UI3](https://www.figma.com/blog/our-approach-to-designing-ui3/); [Navigating UI3](https://help.figma.com/hc/articles/23954856027159)
* Linear — [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui); [A design reset](https://linear.app/now/a-design-reset)
* Chrome DevTools — [Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference); [Responsive tables](https://developer.chrome.com/docs/modern-web-guidance/guides/ui-atoms/responsive-table)
* Observable — [Inputs (GitHub README)](https://github.com/observablehq/inputs); [Observable Inputs docs](https://observablehq.com/framework/inputs/)
* VisuAlgo — [Sorting visualization](https://visualgo.net/en/sorting)
* Hohman, Conlen, Heer, Chau — [Communicating with Interactive Articles](https://distill.pub/2020/communicating-with-interactive-articles/) (Distill, 2020)
* Red Blob Games — [Notes on interactive explanations](https://redblobgames.com/x/2306-educ432)
* Nielsen Norman Group — [Mobile tables](https://www.nngroup.com/articles/mobile-tables/); [Toggle-switch guidelines](https://www.nngroup.com/articles/toggle-switch-guidelines/); [Checkboxes](https://www.nngroup.com/articles/checkboxes-design-guidelines/); [Progressive disclosure (video)](https://www.nngroup.com/videos/progressive-disclosure/)
* IxDF — [Progressive disclosure](https://ixdf.org/encyclopedia/progressive_disclosure.html)
* Apple HIG — [Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls); [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars); [Panels](https://developer.apple.com/design/human-interface-guidelines/panels)
* SAP Fiori — [Action placement](https://www.sap.com/design-system/fiori-design-web/v1-142/foundations/best-practices/global-patterns/action-placement)
* KDE HIG — [Toolbar](https://develop.kde.org/hig/patterns-command/toolbar/)
* GNOME HIG — [Switches](https://developer.gnome.org/hig/patterns/controls/switches.html); Primer — [Toggle switch](https://primer.style/product/components/toggle-switch/guidelines)
* GitLab Pajamas — [Segmented control](https://design.gitlab.com/components/segmented-control); eBay Playbook — [Segmented button](https://playbook.ebay.com/design-system/components/segmented-button)
* Material Design — [Bottom sheets](https://m3.material.io/components/bottom-sheets); Android — [Bottom sheets](https://developer.android.com/develop/ui/compose/components/bottom-sheets)
* MDN — [Container size and style queries](https://developer.mozilla.org/docs/Web/CSS/Guides/Containment/Container_size_and_style_queries); web-features — [Container queries](https://web-platform-dx.github.io/web-features-explorer/features/container-queries)
* W3C — [WCAG 2.2 SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

Some guidance (Apple's segmented-controls page, Material's segmented buttons) comes from search
excerpts and design-system pages that quote it, because the primary pages need JavaScript to render.
Where a claim rests on one of those, the cited page is the one the excerpt came from.
