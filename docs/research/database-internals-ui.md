# Research Report: Database Internals Visualizers & High-Density UI Architecture

**Document ID:** `R2-RESEARCH`  
**Task Contract:** R2 — Design Research: Database Internals Visualizers & High-Density UI  
**Target File:** `docs/research/database-internals-ui.md`  
**Author:** AO Worker (`query-lens-4`)  
**Date:** 2026-10-13  
**Status:** Complete  

---

## Executive Summary

Database management systems are complex layered state machines. When visualizing database internals for engineers and students, interfaces face two conflicting failure modes:
1. **Toy Abstraction Trap:** Over-simplified cartoon animations (e.g., basic sorting bars, isolated node trees) that fail to convey true physical storage mechanics, concurrency semantics, or memory hierarchy limits.
2. **Telemetry Deluge Trap:** Raw flame graphs and overwhelming EXPLAIN dumps (e.g., thousands of JSON lines or unannotated graph nodes) that practitioners find opaque and students find incomprehensible.

**QueryLens** occupies a unique, unoccupied position in the developer tools landscape: it delivers a complete vertical slice of database execution—from raw SQL string parsing all the way down to disk-page buffer frame swaps, B+Tree latch traversal, and page-level locks—while executing 100% synchronously in the browser.

This research report investigates state-of-the-art visualizers and systems across academic and production domains:
- **CMU 15-445 BusTub** (Course benchmark for buffer pool management, B+Tree indexing, and Volcano execution)
- **VisuAlgo** (Pioneering algorithmic animation platform by Steven Halim)
- **Dalibo pev2 / explain.dalibo.com** (Gold standard for PostgreSQL plan tree visualization)
- **PlanetScale & Vitess Query Insights** (Modern production plan inspection and index routing)
- **SQLite Internal Tools** (`sqlite3_analyzer`, DB Browser, page layout specifications)
- **Neon Storage Architecture** (Modern separation of compute cache and pageserver storage)

From these benchmarks, we extract rigorous visual architecture patterns, layout conventions, ergonomic standards, and component architectures across four critical areas:
1. **B+Tree Index Traversal:** Dual-channel node differentiation, latch crabbing visualization, leaf sibling chain navigation, and viewport-constrained focus framing.
2. **Buffer Pool Memory Layout:** Fixed slot grid geometry, dirty-versus-clean eviction mechanics, circular clock-sweep hand visualization, and multi-channel telemetry HUDs.
3. **Volcano Iterator Tree Visualization:** Operator classifications, dual-metric cost/cardinality badges, Sankey-proportional row stream bandwidth, and optimizer side-by-side AST/plan diffing.
4. **Timeline Scrubber Ergonomics:** Macro-phase partitioning across the 8 pipeline stages, event heatmap minimap spines, predict-then-reveal interactive pauses, and zero-CLS cognitive fatigue mitigation.

---

## 1. The 8 QueryLens Pipeline Stages: Mental Models & Visual Representation

QueryLens breaks SQL execution down into eight sequential pipeline stages. Each stage requires a specialized visual idiom while maintaining global aesthetic and ergonomic continuity.

```
┌─────────┐   ┌─────────┐   ┌──────────┐   ┌──────────┐
│ 1. Parse│──▶│ 2. Plan │──▶│3. Optimize──▶│4. Execute│
└─────────┘   └─────────┘   └──────────┘   └──────────┘
                                                │
                                                ▼
┌──────────┐   ┌─────────┐   ┌──────────┐   ┌──────────┐
│8. Result │◀──│ 7. Lock │◀──│6. B+Tree │◀──│5. Buffer │
└──────────┘   └─────────┘   └──────────┘   └──────────┘
```

### 1.1 Pipeline Stage Comparison Matrix

| Stage ID | Stage Name | Underlying Data Structure | Primary Visual Idiom | Key Visual Metrics & State Indicators | Prior Art Reference |
|:---|:---|:---|:---|:---|:---|
| `parse` | **Parser** | Token stream & Abstract Syntax Tree (AST) | Collapsible syntax tree with SQL code range linking | Token types (Keywords, Identifiers, Literals), grammar production rules, AST depth | AST Explorer, Babel, Lezer |
| `plan` | **Planner** | Relational Algebra logical operator tree | Directed Acyclic Graph (DAG) with top-down flow | Logical operator badges (`LogicalScan`, `LogicalFilter`, `LogicalJoin`), projected schema | DuckDB EXPLAIN, Calcite |
| `optimize` | **Optimizer** | Rewritten relational tree (Rule transformations) | Side-by-side or diffable dual tree with fired rule badge | Applied rewrite rule (`PredicatePushdown`, `ProjectionPruning`), estimated cost delta | CockroachDB EXPLAIN (OPT), Dalibo pev2 |
| `execute` | **Execution** | Physical Volcano iterator tree | Animated iterator tree with active pull/emit pulses | Operator state (`open`, `next`, `close`), actual rows returned vs estimated, execution time | Goetz Graefe Volcano paper, Dalibo pev2 |
| `buffer` | **Buffer Pool** | Fixed frame array, hash page table, clock ring | 2D Slot Card Grid with circular clock sweep pointer | Frame ID, Page ID, Pin Count (`refcount`), Dirty bit (`✎`), Usage Count ticks (`●●●○○`), Hit/Miss rates | CMU 15-445 BusTub, PostgreSQL `shared_buffers` |
| `index` | **Index** | B+Tree (balanced n-ary tree with linked leaves) | Hierarchical multi-key tree with sibling chain links | Internal vs Leaf markers, divider keys, descent hop path (`path.slice(-2)`), S/X latch crabbing indicators | BusTub B+Tree Printer, VisuAlgo, PlanetScale |
| `lock` | **Lock Manager**| Lock Table (Hash map of resource ID $\to$ granted/waiting lists)| Two-phase locking matrix & dependency wait-for graph | Lock Mode (`Shared` vs `Exclusive`), Holder Transaction ID, Granted vs Waiting queues, lock escalation | Gray & Reuter Transaction Processing, Postgres `pg_locks` |
| `result` | **Result** | Materialized tuple collection & tabular recordset | Dense tabular data grid with schema headers & summary HUD | Row count, column projection types, query runtime, byte size, client formatting | PGAdmin, TablePlus, DBeaver |

---

## 2. B+Tree Index Traversal: Visual Architecture & Patterns

The B+Tree is the foundational storage index for relational databases. However, visualizing a production B+Tree poses severe graphical challenges: high fan-out (order $M \ge 4$) causes explosive horizontal tree widths that quickly exceed screen dimensions, while concurrent search protocols (such as latch crabbing) involve subtle temporal states that static tree diagrams cannot depict.

### 2.1 Internal vs. Leaf Node Differentiation

In a B+Tree, internal nodes and leaf nodes serve fundamentally different architectural roles:
- **Internal Nodes:** Serve strictly as routing guides. They contain $K$ ordered separator keys and $K+1$ child page pointers. They never store user data records or tuple IDs.
- **Leaf Nodes:** Contain actual record payloads or pointer pairs `(Key, RID)` and are chained together horizontally via bidirectional sibling pointers (`prev_page_id`, `next_page_id`).

#### Design Rules for Dual-Channel Differentiation
To ensure immediate comprehension and comply with WCAG 2.2 accessibility standards, internal and leaf nodes must differ in **both shape and color**:

```
INTERNAL NODE (Routing Router)
┌──────────────────────────────────────────────┐
│ ● INTERNAL  Page #4                         │
├───────────┬───────────┬───────────┬──────────┤
│ Ptr: P#2  │  Key: 10  │ Ptr: P#5  │ Key: 25  │
└───────────┴───────────┴───────────┴──────────┘
      │                       │
      ▼                       ▼

LEAF NODE (Data Storage & Sibling Chain)
◄── prev                                                 next ──►
┌───────────────────────────────────────────────────────────────┐
│ ○ LEAF  Page #5  [3 tuples, free: 342B]                       │
├───────────────┬───────────────┬───────────────┬───────────────┤
│ [10 → RID:1:1]│ [14 → RID:1:2]│ [22 → RID:1:3]│ (empty slot)  │
└───────────────┴───────────────┴───────────────┴───────────────┘
```

1. **Glyph & Icon Markers:**
   - Internal nodes carry a solid glyph `●` and an explicit uppercase badge `INTERNAL`.
   - Leaf nodes carry a hollow ring `○` and an explicit uppercase badge `LEAF`.
2. **Palette & Surface Materiality:**
   - **Internal Nodes:** Deep slate/indigo base with crisp violet-tinted borders (`border-hue-violet/60`, `bg-surface-2`). Visual metaphor: cool, structural, routing backbone.
   - **Leaf Nodes:** Rich emerald/teal base with subtle cyan borders (`border-hit/60`, `bg-surface-3`). Visual metaphor: tangible data residency, target values.
   - *BusTub Compatibility:* CMU 15-445 uses magenta/pink for internal and green for leaves. Utilizing violet/indigo for internal and teal/emerald for leaves maintains immediate cognitive resonance for students while modernizing the aesthetic.
3. **Data Anatomy & Typography:**
   - **Internal Node Cell:** Keys displayed in bold monospace (`font-mono font-semibold text-ink`), separator divider lines between child pointers (`border-r border-edge/80`).
   - **Leaf Node Cell:** Key-to-RID pairs displayed in structured key-value pill chips (`[Key → Page:Slot]`). Includes page-level header telemetry: slot count and free byte counter.

### 2.2 Latch Crabbing Protocol & Descent Traversal

In concurrent database engines, search operations traverse down the B+Tree using **latch crabbing** (also called lock coupling):
1. Acquire shared read latch (`S-latch`) on parent node.
2. Read separator keys to determine child pointer.
3. Acquire `S-latch` on child node.
4. Release `S-latch` on parent node (unless inserting/splitting, which requires holding parent write latches until safety is proven).

#### Visual Representation of Traversal & Crabbing
Static tree visualizers usually just highlight the entire path from root to leaf in bright yellow. This creates visual clutter and fails to explain *why* the engine is looking at a specific child node.

**The QueryLens Crabbing & Focus Hop Pattern:**
- **Two-Hop Focal Window:** Instead of attempting to center an entire 4-level tree across 1600 pixels, the canvas viewport tightly frames the active descent hop: `focusIds = path.slice(-2)` (parent plus current child). The parent provides context; the child shows the current evaluation.
- **Active Latch Indicator Badge:**
  - When an internal node is holding an active latch, render a subtle glowing halo (`shadow-[0_0_16px_var(--color-accent)]`) and a small latch indicator (`🔒 S-Latch`).
  - When the traversal descends into the child, the child's latch illuminates, and the parent's latch transitions to a soft dashed trail (`released`), creating an intuitive animation of the "crabbing" motion.
- **Key Comparison Callout:** Beside the active internal node, render a small tooltip or inline chip demonstrating the exact conditional evaluation:
  $$\text{Target Key: } 18 \implies 10 \le 18 < 25 \implies \text{Take Pointer to Page 5}$$

### 2.3 Leaf Node Doubly-Linked Lists (Sibling Chains)

A fundamental advantage of B+Trees over hash indexes and standard B-trees is efficient range scanning (`WHERE id BETWEEN 10 AND 50`). Once the initial leaf node is reached via tree descent, the engine never traverses the root again; it walks the leaf sibling pointers horizontally.

#### Sibling Chain Layout Standards
- **Horizontal Chain Edges:** Connect leaf nodes using distinctive horizontal dashed or solid connector lines (`border-t-2 border-dashed border-teal-500/70`).
- **Bidirectional Arrows:** Clearly render `prev` (left arrow `◄`) and `next` (right arrow `►`) handle indicators at the left and right margins of each leaf node card.
- **Range Scan Animation Sequence:**
  1. Root-to-leaf descent highlights Leaf $L_1$.
  2. For the subsequent range tuples, the cursor shifts smoothly across the horizontal sibling edge from $L_1 \to L_2 \to L_3$.
  3. The root and internal nodes visibly dim (`opacity-30`), focusing 100% of the user's attention on the leaf-level linked list scan.

### 2.4 High-Density Graph Layout & Viewport Framing

| Requirement | Conventional Visualizer Flaw | Recommended QueryLens Architecture |
|:---|:---|:---|
| **Tree Fan-out** | Nodes collide or expand off-screen, forcing massive horizontal scrolling. | Dynamic D3-hierarchy layout with compact horizontal node widths (internal nodes: `w-44`; leaves: responsive compact slots). Unvisited sibling subtrees collapse into collapsed summary pills (`[+3 sibling pages]`). |
| **Viewport Zoom & Pan** | Auto-zoom violently recenters on every step, causing motion sickness. | Smooth spring-damped camera transitions with fixed zoom constraints (`minZoom: 0.4`, `maxZoom: 1.5`). Focus transitions occur only across major branch switches. |
| **Search Outcome Feedback** | Cryptic console logs or small text alerts. | Decisive outcome badges anchored to the target leaf slot: `✓ Found (Tuple #12)` in bright green (`text-hit`), or `✕ Not Found (Key does not exist)` in amber/red (`text-evict`). |

---

## 3. Buffer Pool Memory Layout & Cache Mechanics

The buffer pool sits between volatile CPU execution and durable disk storage. It manages a fixed array of in-memory frames (`BufferFrame[]`) that cache disk pages (`Page[]`). Understanding hit-versus-miss dynamics, dirty-page flushing, and replacement victim selection is central to database engineering.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BUFFER POOL HUD: [Hits: 142]  [Misses: 18]  [Hit Rate: 88.8%]  [Writes: 4] │
└─────────────────────────────────────────────────────────────────────────────┘

FRAME 0 [Clean]        FRAME 1 [Dirty ✎]      FRAME 2 [Empty]        FRAME 3 [Victim ✕]
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ frame 0          │  │ frame 1  👉 HAND │  │ frame 2          │  │ frame 3          │
│ Page #102        │  │ Page #84         │  │ (empty slot)     │  │ Page #12         │
│ Pin: 1 [S-Latch] │  │ Pin: 0  [DIRTY ✎]│  │ Pin: 0           │  │ Pin: 0  [CLEAN]  │
│ Usage: ●●●○○     │  │ Usage: ●●○○○     │  │ Usage: ○○○○○     │  │ Usage: ○○○○○     │
│ [✓ HIT]          │  │ [↻ SWEPT]        │  │                  │  │ [✕ EVICTED]      │
└──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘
```

### 3.1 Fixed Frame Grid Architecture

Visualizing the buffer pool requires a dense, highly structured card grid representing physical memory frames:
- **Grid Layout:** Standardized 4-column responsive grid (`grid grid-cols-2 sm:grid-cols-4 gap-2.5`). For 8-frame configurations, 2 rows of 4; for 16-frame configurations, 4 rows of 4.
- **Frame Card Anatomy:**
  1. **Header Row:** Frame index label (`frame 0`, `frame 1`) on the left; Clock Sweep hand indicator (`👉` or animated pulsing marker) on the right.
  2. **Page Identity:** Monospace page ID label (`Page #42`) or dimmed placeholder (`empty`).
  3. **Pin Count (Refcount):** Pin counter with lock status (`Pin: 2`). Pin count $> 0$ visually locks the card (shield or anchor icon), clearly indicating to the user that this frame is immune to eviction.
  4. **Usage Count Gauge (Clock Policy):** A discrete 5-segment bar or pip array (`●●●○○`) representing PostgreSQL's `usage_count` (capped at 5).
  5. **Status & Mood Footer:** Dynamic status tag (`✓ hit`, `↓ disk read`, `✎ written`, `✕ evicted`, `↻ swept`).

### 3.2 Dirty vs. Clean State Semantics

A major gap in academic visualizers is the failure to distinguish between clean and dirty pages. In a real database, evicting a clean page costs zero disk writes (it is simply overwritten), whereas evicting a dirty page requires a synchronous disk I/O write (flushing the page to the WAL and data file) before the frame can be reused.

#### Multi-Channel State Markers
- **Clean Frames:**
  - Border: Neutral slate border (`border-edge`).
  - Fill: Standard dark surface fill (`bg-surface-3`).
  - Glyph: Subtle checkmark or neutral badge (`[CLEAN]`).
- **Dirty Frames:**
  - Border: Amber/violet warning border (`border-hue-violet`).
  - Fill: Soft violet tint (`bg-hue-violet/15`).
  - Glyph: Pencil badge (`✎ DIRTY`).
  - **Writeback Event Animation:** When a dirty frame is selected for eviction or checkpointed, trigger a distinct disk-write animation: a downward arrow strobe (`✎ disk write`), incrementing the global `Writes` telemetry counter, before the frame is cleared.

### 3.3 Clock-Sweep Hand Visualization

PostgreSQL deliberately avoids textbook LRU because maintaining an LRU list requires acquiring a global mutex on every single page lookup, destroying multi-threaded concurrency. PostgreSQL uses **Clock Sweep** (a variant of the second-chance algorithm).

#### Mechanics of the Visual Clock Hand
1. **The Circular Hand Pointer:** The buffer manager maintains an index pointer (`clock_hand`) cycling from $0 \dots N-1$. In the UI, this hand is visualized as an unmistakable directional indicator (`👉` or a luminous turquoise pointer ring hovering over the frame card).
2. **Inspection & Decrement Step:**
   - The hand points to frame $i$.
   - If `frame[i].pin_count > 0`: Frame is actively in use; skip immediately.
   - If `frame[i].usage_count > 0`: Decrement usage count (`usage_count--`, pip lights down from `●●●○○` to `●●○○○`), display mood `↻ swept`, and advance the hand to $i+1$.
   - If `frame[i].pin_count == 0` and `frame[i].usage_count == 0`: **Victim Found!** Evict page, display mood `✕ evicted`, and break.
3. **Ergonomic Animation Pacing:**
   - Instead of skipping intermediate decrements in zero milliseconds, animate the sweep with a rapid micro-strobe (80ms per frame decrement) so the user sees *why* frame 3 was chosen over frame 1.

### 3.4 Telemetry HUD & Hit/Miss Accounting

At the base or top of the Buffer Pool panel, provide a persistent Telemetry HUD:
- **Hits ($H$):** Green badge (`text-hit`), incremented when a requested page is already resident in any frame.
- **Misses / Disk Reads ($M$):** Blue/cyan badge (`text-miss`), incremented when a page must be loaded from simulated disk.
- **Evictions ($E$):** Coral/red badge (`text-evict`), incremented when an existing resident page is discarded to make room for a new page.
- **Disk Writes ($W$):** Violet badge (`text-hue-violet`), incremented when a dirty page is flushed to disk.
- **Hit Rate ($HR$):** Prominently formatted as a percentage:
  $$HR = \frac{H}{H + M} \times 100\%$$
- **Dual-Channel Accessibility:** Every metric includes an explicit unicode symbol prefix (`✓` hits, `↓` disk reads, `✕` evictions, `✎` writes) so comprehension does not rely exclusively on hue.

---

## 4. Volcano Iterator Tree & Execution Dynamics

The execution engine in relational databases processes queries using the **Volcano iterator model** (pioneered by Goetz Graefe). Each operator is an object exposing three primary interface methods:
- `open()`: Initialize operator state, allocate buffers, open child iterators.
- `next() -> Tuple | EOF`: Pull exactly one tuple from downstream children, apply transformation, and return it.
- `close()`: Clean up resources and terminate.

Execution is strictly demand-driven: the root operator (e.g., `Result` or `Project`) calls `next()` on its child, which cascades down the tree until reaching a storage scan (`SeqScan` or `IndexScan`).

```
                    ┌────────────────────────┐
                    │    Result (Project)    │
                    │   Output: id, total    │
                    └───────────▲────────────┘
                                │  ▲ Tuple Stream
                                │  │ [1 row emitted]
                    ┌───────────┴────────────┐
                    │      Filter (WHERE)    │
                    │      total > 500       │
                    │      ~12 rows (est)    │
                    └───────────▲────────────┘
                                │  ▲
                                │  │ [Filtered: 88 dropped]
                    ┌───────────┴────────────┐
                    │     SeqScan (orders)   │
                    │    Scanned: 100 rows   │
                    └────────────────────────┘
```

### 4.1 Operator Badges & Semantic Categories

Every node in the execution plan tree must display clear categorical badges so the user instantly distinguishes between cheap stream operations and expensive blocking operations:

| Category | Typical Operators | Algorithmic Complexity | Visual Badge & Color Tone | Blocking vs Streaming Behavior |
|:---|:---|:---|:---|:---|
| **Scan (Leaf)** | `SeqScan`, `IndexScan`, `IndexOnlyScan` | $O(N)$ table scan or $O(\log N)$ tree seek | Teal / Cyan pill (`bg-teal-500/15`, `border-teal-500/60`) | Streaming (pulls pages from buffer pool) |
| **Filter (Unary)** | `Filter` (Selection $\sigma$) | $O(1)$ per tuple | Amber / Orange pill (`bg-amber-500/15`, `border-amber-500/60`) | Streaming (discards non-matching tuples instantly) |
| **Project (Unary)**| `Project` (Projection $\pi$) | $O(1)$ per tuple | Sky Blue pill (`bg-sky-500/15`, `border-sky-500/60`) | Streaming (computes expressions and columns) |
| **Join (Binary)** | `NestedLoopJoin`, `HashJoin`, `MergeJoin` | $O(M \times N)$ or $O(M + N)$ | Violet / Purple pill (`bg-purple-500/15`, `border-purple-500/60`) | Hybrid: HashJoin build-phase blocks; probe-phase streams |
| **Sort / Group** | `Sort` (ORDER BY), `Aggregate` (GROUP BY) | $O(N \log N)$ or $O(N)$ with hash table | Crimson / Rose pill (`bg-rose-500/15`, `border-rose-500/60`) | **Fully Blocking:** Must consume 100% of input before emitting first row |
| **Limit (Unary)** | `Limit` | $O(1)$ up to $K$ tuples | Indigo pill (`bg-indigo-500/15`, `border-indigo-500/60`) | Streaming with early termination (`close()`) |

### 4.2 Cost Metrics & Cardinality Verification

Inspired by Dalibo's **pev2** visualizer, QueryLens plan trees should display dual metrics on every operator node:
1. **Estimated Cardinality vs Actual Rows:**
   - Display estimated rows ($\sim E_{rows}$) derived from planner statistics alongside actual rows processed ($A_{rows}$).
   - **Estimation Skew Alert:** When the ratio $\frac{\max(E, A)}{\min(E, A)} > 5$, render an exclamation warning chip (`⚠️ Skew: 12x`). In production database tuning, cardinality misestimates are the #1 cause of catastrophic plan choices (e.g., choosing a Nested Loop join over a Hash join because the planner thought the table had 5 rows instead of 500,000).
2. **Cost Formula Display:**
   - Display the optimizer cost score ($C_{start} \dots C_{total}$) computed via classic system R formulas:
     $$\text{Cost} = (\text{Page Fetches} \times W_{page}) + (\text{Tuple Computations} \times W_{cpu})$$

### 4.3 Row Count Flow & Bandwidth Dynamics

Static arrows fail to show data volume. If a scan processes 10,000 rows and a filter filters it down to 10 rows, the visual weight of the lines should reflect that reality.

- **Sankey-Proportional Edge Widths:** Vary connector line thickness between operators proportionally to tuple volume:
  - 1–10 rows: 1px hairline stroke (`stroke-edge`).
  - 10–100 rows: 2.5px medium stroke (`stroke-accent/60`).
  - $> 100$ rows: 4.5px dense stroke (`stroke-accent`).
- **Tuple Pulse Animations:** During step execution, when a child operator yields a row to its parent in response to `next()`, trigger a brief light pulse travelling upward along the connector line. This makes the Volcano pull-streaming model immediately obvious to visual learners.

### 4.4 Rule-Based Optimizer Rewrites (Before & After Diffing)

Between the Planner stage and the Executor stage, the Optimizer applies rule-based transformations (e.g., Predicate Pushdown, Join Reordering, Unused Projection Pruning).

#### The Side-by-Side Tree Diff Pattern
- Render two trees side-by-side or provide a clean toggle tab:
  - **Left / Tab A:** `Logical Plan` (unoptimized).
  - **Right / Tab B:** `Physical Plan` (optimized).
- **Rule Callout Banner:** Between or above the trees, display the specific heuristic rule that triggered:
  $$\text{Rule Fired: } \mathbf{PredicatePushdown} \implies \text{Moved Filter(age > 30) below Join(users, orders)}$$
- **Highlight Transformed Nodes:** Nodes created, relocated, or deleted by the optimizer rule receive a glowing highlight border (`ring-2 ring-accent`) and an "Optimized" tag.

---

## 5. Timeline Scrubber Ergonomics & Cognitive Load Management

A typical database query trace in QueryLens generates between **40 and 400 granular micro-events** across the 8 pipeline stages: tokenizing tokens, building AST branches, constructing plan nodes, testing buffer frames, descending B+Tree levels, acquiring page latches, and pulling rows.

Stepping through hundreds of events can easily induce **visual fatigue, disorientation, and change blindness** if the UI changes unpredictably or requires chaotic eye movements across disparate screen quadrants.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ TIMELINE TRANSPORT:                                                              │
│ [↺ Reset] [◀ Back] [ ▶ Play ] [▶│ Step]   Speed: [ 1× ▼]   Step: 28 / 142        │
├──────────────────────────────────────────────────────────────────────────────────┤
│ STAGE HEATMAP SPINE:                                                             │
│ [ Parse ][ Plan ][ Optimize ][    Execute    ][ Buffer Pool ][ B+Tree ][ Result ]│
│ ░░░░░░░░░▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓█████████████████████████████████████████████████████│
│ ──────────────────────────────▲──────────────────────────────────────────────────│
│                               Thumb (Step 28: Buffer miss -> Frame 2)            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Hierarchical Scrubber & Phase Partitioning

To tame high event volumes, QueryLens must organize the timeline into a two-tier hierarchy: **Macro-Phases** and **Micro-Steps**.

1. **Macro-Phase Stage Bands:** The overall progress rail (Pipeline Tracker) represents the 8 stages. Clicking any stage chip immediately jumps the scrubber to the first event of that stage.
2. **Micro-Step Slider:** The slider scrub track covers individual `StepEvent`s within the current query execution.
3. **Stage Jump Markers on the Track:** Small vertical tick dividers divide the scrubber slider into segments corresponding to each pipeline phase. Hovering over a segment displays a tooltip with the stage name and event count (e.g., `Buffer Pool: Steps 18–35 (18 events)`).

### 5.2 Heatmap Minimap Spine

Directly beneath or inside the scrubber slider track, embed a dense 4px-tall **Event Minimap Spine**:
- Each event is rendered as a 1px colored bar on the spine:
  - Emerald (`#10b981`): Cache hit / leaf found.
  - Cyan (`#06b6d4`): Disk read / buffer miss.
  - Amber (`#f59e0b`): Filter drop / miss.
  - Violet (`#8b5cf6`): Dirty page write / sort pass.
  - Rose (`#f43f5e`): Lock wait / eviction.
- This gives the user an instantaneous gestalt representation of where the query spends its effort before they even start scrubbing.

### 5.3 Predict-Then-Reveal Interactive Pauses

As established in educational psychology research (Hansen, Schrimpsher & Narayanan meta-studies, HalVis, and `RESEARCH.md` §1), passive viewing of animations produces almost zero measurable retention. Learning occurs when users must **commit to a prediction** before seeing the outcome.

#### Interaction Architecture for Predict-then-Reveal
1. **Interception Checkpoints:** When the playback reaches a pedagogical decision point:
   - `buffer:evict`: Buffer pool is full. *Which frame will the clock sweep evict?*
   - `index:traverse`: B+Tree search at internal node. *Which child pointer will be followed?*
   - `optimize:pushdown`: Predicate pushdown rule available. *Where does the filter belong?*
   - `result:cardinality`: Query execution complete. *How many rows will be returned?*
2. **Modal Interception State:**
   - Playback automatically halts (`playing = false`).
   - The scrubber displays a glowing question prompt icon.
   - A sleek glassmorphic prediction card appears over the relevant panel.
   - Interactive targets (e.g., the candidate buffer frames or child tree nodes) pulse with a subtle hover border (`cursor-pointer ring-2 ring-accent/50`).
3. **Commit & Reveal:**
   - The user clicks their selected frame or answer option.
   - The UI reveals the ground truth:
     - If correct: Green celebration sheen (`✓ Correct! Frame 2 had usage_count = 0 and pin_count = 0`).
     - If incorrect: Explanatory diagnostic callout (`✕ Incorrect. Frame 1 had usage_count = 2, so the hand decremented it and moved to Frame 2`).
   - Scrubber unlocks, allowing the user to step forward and observe the physical execution.

### 5.4 Cognitive Ergonomics & Layout Stability (CLS = 0)

1. **Zero Cumulative Layout Shift (CLS):**
   - As the user steps from step 1 to step 100, the dimensions of panels, node cards, and text labels must **never shift or re-wrap**.
   - Metric labels, headers, and description paragraphs must use pre-reserved min-heights and monospace tabular figures (`font-mono tabular-nums`).
2. **Keyboard Transport Shortcuts:**
   - `Space`: Toggle Play / Pause.
   - `ArrowLeft` / `ArrowRight`: Step backward / Step forward by 1 event.
   - `Shift + ArrowLeft` / `Shift + ArrowRight`: Jump backward / forward to stage boundary.
   - `Home` / `End`: Reset to start / jump to final query result.
   - `1`, `2`, `3`, `4`: Set playback speed ($0.5\times$, $1\times$, $2\times$, $4\times$).
3. **Motion Restraint (`prefers-reduced-motion`):**
   - For users with vestibular sensitivity or when `prefers-reduced-motion` is active: disable spring animations, translation pans, and camera auto-centering. Replace them with instantaneous state updates accompanied by a soft, static highlight outline (`border-accent`).

---

## 6. Synthesis: Technical Recommendations for QueryLens

To guide implementation across upcoming tasks (T4 Playground Layout, T5 Visualizer Panels, T6 Standalone Tools), the following technical recommendations synthesize these design patterns with the QueryLens codebase:

### 6.1 State & Event Interfaces

The existing `StepEvent` union in `src/engine/types.ts` is already clean and synchronous. For maximum visual fidelity, panels should derive their visual moods from the active event:

```ts
// Visual mood derivation contract for UI panels
export type VisualMood = 'hit' | 'miss' | 'load' | 'write' | 'evict' | 'sweep' | 'lock' | 'traverse';

export interface PanelVisualState {
  activeStage: Stage;
  activeStepIndex: number;
  totalSteps: number;
  highlightedIds: ReadonlySet<string>;
  mood: VisualMood | null;
  telemetry: {
    bufferHits: number;
    bufferMisses: number;
    bufferWrites: number;
    bufferEvictions: number;
    rowsEmitted: number;
  };
}
```

### 6.2 Component Refinement Directives

1. **`BTreePanel.tsx`:**
   - Enhance the `FlowTree` node rendering to explicitly include `● INTERNAL` and `○ LEAF` badge headers with distinct color palettes (violet/indigo for internal; teal/emerald for leaves).
   - Display key-to-RID pairs as distinct pills within leaf nodes.
   - Retain the two-hop focal window (`path.slice(-2)`) to keep traversal visible without horizontal blowout.
   - Include horizontal dashed edges for leaf sibling chains to support range scan comprehension.

2. **`BufferPoolPanel.tsx`:**
   - Enhance the 4-column frame grid cards with distinct dirty badges (`✎ DIRTY`) and clean badges (`✓ CLEAN`).
   - For the Clock Sweep policy, render the hand position prominently (`👉` or glowing pointer ring) and visualize `usage_count` with a 5-tick indicator bar (`●●●○○`).
   - Animate clock sweeps with rapid sequential decrements during stepping.
   - Maintain the dual-channel telemetry HUD at the footer (`✓ hits`, `↓ misses`, `✕ evictions`, `✎ writes`).

3. **`FlowTree.tsx` / `PlanTree.tsx`:**
   - Assign distinct categorical tones to operator types (Scan = Teal, Filter = Amber, Project = Sky, Join = Violet, Sort = Rose, Limit = Indigo).
   - Render Sankey-proportional connector strokes reflecting row count volume.
   - Display dual badges: estimated cardinality ($\sim N$) and actual processed rows, with an exclamation alert on large estimation skews.

4. **`PlaybackControls.tsx` / `PipelineTracker.tsx`:**
   - Maintain the connected progress rail design for the 8 stages with clear connector lines and active status pips.
   - Ensure transport buttons meet WCAG 2.2 SC 2.5.8 touch target minimums ($\ge 24\text{px}$ hit targets; currently 32px rounded-full buttons).
   - Integrate keyboard navigation hotkeys (`Space`, `ArrowLeft`, `ArrowRight`, `Home`, `End`).
   - Add a subtle stage-segmented heatmap spine along the scrubber slider track.

---

## 7. Comparative Assessment of Visualizer Systems

| Feature / Dimension | BusTub (CMU) | VisuAlgo | Dalibo pev2 | PlanetScale / Vitess | SQLite Tools | **QueryLens** |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Pipeline Breadth** | Isolated C++ components | Single data structures | Plan tree only | Plan tree & query metrics | Low-level B-tree pages | **Full 8-stage vertical slice** |
| **B+Tree Crabbing** | Graphviz static dump | No concurrency | N/A | N/A | File format only | **Two-hop animated descent & latch indicators** |
| **Leaf Sibling Chains** | Yes (DOT pointers) | No | N/A | N/A | Linked page IDs | **Explicit bidirectional sibling rails** |
| **Buffer Pool Layout** | C++ Frame table | None | Buffer count badges | Server metrics | In-memory cache pages | **Interactive 2D card grid + dirty/clean states** |
| **Clock-Sweep Hand** | Code assignment | None | None | None | None | **Animated pointer hand + usage counter ticks** |
| **Volcano Pull Model** | C++ iterator | None | Static tree | Static tree | Opcode bytecode (VDBE) | **Animated pull/emit tuple stream pulses** |
| **Timeline Scrubbing** | None | Simple forward slider | None | None | Step-by-step bytecode | **Dual-tier macro-stage & micro-step scrubber** |
| **Pedagogical Interception**| None | Pre-made quiz mode | None | None | None | **Predict-then-reveal checkpoint cards** |
| **Execution Environment**| Native C++ | Browser (JS) | Web (Vue/SVG) | SaaS Web UI | CLI / C | **100% Client-side React 19 / TS in browser** |

---

## 8. Conclusion

High-density database visualization succeeds not through gratuitous 3D effects or decorative animations, but through **epistemic fidelity, dual-channel encoding, and cognitive restraint**.

By adopting:
- **Dual-channel visual markers** for internal versus leaf B+Tree nodes,
- **Explicit dirty-versus-clean** memory frame state cards with clock-sweep tick indicators,
- **Categorical operator badges and Sankey-proportional row stream flows** for Volcano execution, and
- **Phase-partitioned scrubber tracks with predict-then-reveal interactive pauses**,

QueryLens can transform abstract database internals into a tangible, intuitive, and deeply engaging learning and debugging environment for developers worldwide.
