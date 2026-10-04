# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Two essays** (plan.md §H2): *An index is a tax on every write* and *One scan can empty the cache*, with measured page counts for the B+Tree and LRU against LRU-2 on one trace, and links into the sandboxes that replay them. In-page embeds are not built.
- **Installable, and works offline after a first visit** (plan.md §H1). A hand-written service worker caches the app's own files, so the Playground, the docs and every tool open with no network. The web manifest names install icons. Only the app's files are cached, never your queries or data. A new version applies once no open tab is still running the old one.
- **Confidence ratings on predictions** (plan.md §G2) — "How sure?" before each prediction is committed, and a Calibration section on `/progress` showing how often rated predictions came true at each level. The rating is optional, so answering without one still reveals and counts toward the overall record.
- **Six misconception challenges** (plan.md §G3) — each names a wrong belief about SQL (a filter the index cannot serve, an expression around an indexed column, `= NULL`, `COUNT(*)` vs `COUNT(col)`, `NOT IN` with a NULL, a WHERE on a LEFT JOIN's inner side) and reveals it once solved. The checks read the parsed predicate, so a query with the right rows and the wrong shape does not pass.
- **A trace diff in the Playground** (plan.md G6) — re-running a query shows what changed since its last run: each measured number that moved, and whether the optimizer's plan changed shape. The numbers are `/compare`'s own scorecard.
- **LRU-2 buffer replacement** (plan.md §25.4 F7, slice 1) — a scan-resistant policy, selectable in the buffer-pool sandbox and the Compare policy picker. It evicts by each page's second-most-recent reference, so a one-pass scan no longer flushes a hot set of pages that are reused. The default policy is unchanged.
- **A vector-index sandbox**, `/tools/vector-index` (plan.md §25.4 F6) — brute force, IVF and HNSW answering the
  same nearest-neighbour question, scored by distances computed and recall over seeded queries. HNSW is a real layered
  graph; at this size its recall-per-distance is not better than IVF's, and the page says so.
- **A latch-crabbing sandbox**, `/tools/latch-crabbing` (plan.md §25.4 F5) — the same scripted concurrent inserts
  run under naive page latching and under lock coupling, side by side on the real engine B+Tree. Crabbing releases
  each ancestor once the child below is safe, so threads block far less. Optimistic lock coupling is not included.
- **A tuple-at-a-time vs. batched `/compare` mode** (plan.md §25.4 F4) — runs one real query and counts the
  `next()` calls each operator makes, per row, against the calls a batched engine would make for the same rows at a
  batch size you pick. Nothing re-executes; the counts come from the run's own trace.
- **A row-vs-column storage sandbox**, `/tools/columnar` (plan.md §25.4 F3, sandbox slice) — NSM (row store), DSM
  (column store) and PAX (the hybrid) laying out the same table three ways, with real compressed-size counters
  for dictionary, RLE, delta and bit-packing encodings, and the late-vs-early materialization trade-off that
  decides whether a column store's own layout advantage actually pays off for a given query.
- **An extendible/linear hashing sandbox**, `/tools/hash-index` (plan.md §25.4 F2) — pick a scheme and watch it
  grow: extendible hashing's directory doubles only when a full bucket has no spare depth to split into; linear
  hashing's round-robin split pointer grows the bucket array one at a time, decoupled from which bucket actually
  overflowed. A live demo shows exactly why neither scheme can answer a range query — ten consecutive keys
  scatter across several unrelated buckets, with no sorted chain to walk the way a B+Tree's leaf chain provides.
- **A B+Tree-vs-LSM `/compare` mode, closing out the LSM-tree sandbox work** (plan.md §25.4 F1, fourth and
  closing slice) — the exact same write sequence fed into a real B+Tree and into the LSM-tree model, side by
  side, with write and read amplification reported from real counters on both sides (not estimates). The units
  are deliberately different — index pages touched for the B+Tree, raw entries rewritten for the LSM tree —
  because that difference is the actual structural contrast: a B+Tree updates in place, so its write cost stays
  small and roughly constant as data grows; an LSM tree defers writes and pays for it later in compaction, so
  its write cost measurably grows with data size instead.
- **A tiered compaction strategy for the LSM-tree sandbox** (plan.md §25.4 F1, third slice) — alongside the
  existing leveled strategy, pick "Tiered" to see the real RocksDB-style alternative: merges accumulate into one
  unsplit table per tier instead of re-splitting into non-overlapping ranges, so any level can hold several
  overlapping SSTables, not just L0. The trade-off is real and measured, not cosmetic: tiered costs less write
  amplification than leveled for the identical writes, but more worst-case read amplification — both directions
  shown live when you switch strategies on the same demo.
- **A Bloom filter for the LSM-tree sandbox** (plan.md §25.4 F1, second slice) — every SSTable now carries its
  own filter, sized by a tunable bits-per-key (2–20), and a real `lookupKey` read path checks it before ever
  touching a table: look up any key and watch which SSTables it actually checked, highlighted green for the
  real hit and amber for a filter false positive. Read amplification and the false-positive rate are measured
  by running real lookups against every written key plus a sample of guaranteed misses, not estimated from the
  textbook formula — closing the honesty gap the first slice named explicitly.
- **An LSM-tree sandbox**, `/tools/lsm` (plan.md §25.4 F1, first slice) — writes buffer in a memtable, flush to
  disk as an immutable, sorted SSTable, then compact into fewer, larger files at the next level down. Change the
  memtable size or a level's capacity and watch the cascade, the non-overlapping key ranges it produces below
  L0, and the write, space and read amplification it costs — including the non-obvious case where write
  amplification drops *below* 1×, when the memtable itself coalesces an overwrite before it is ever flushed.
- **A `transactions` preset dataset** (plan.md §25.4 C6, first slice) — 3,000 rows, indexed on `id`, built for a
  genuinely deep B+Tree (height 7, measured — two levels past any existing preset) and a scan that evicts hard
  enough to be dramatic: the "Eviction storm" preset drives the buffer pool to a 0% hit rate. A point lookup or
  a narrow indexed range stays a short trace regardless of table size; only the deliberately unindexed presets
  cost what a full scan over 3,000 rows really costs.
- **A "Why not?" panel** (plan.md §25.4 C5, fourth and closing slice) — every cost-based decision (index vs.
  scan, join algorithm, join order) already compared its chosen option against the one it beat; a small panel
  in the Playground and `/tools/planner` now shows that same comparison structured — "Why not a sequential
  scan? An estimated 12 pages — against `id` index lookup's 4 pages, the one actually chosen" — rather than
  leaving it for a reader to parse out of the step's own sentence. No new cost math: the same numbers the
  narration already named.
- **Join order chosen by cost** (plan.md §25.4 C5, third slice) — a chain of 2+ plain inner `JOIN`s now
  actually runs in whichever left-deep order C4's own Selinger-style search finds cheapest, not necessarily
  the order it was written in. Every original `JOIN` predicate is reused unchanged — reordering only ever
  decides *which table joins when*, never invents a new condition. A chain with a `LEFT JOIN` anywhere in
  it is never reordered, on purpose: `LEFT JOIN` is not commutative or associative in general, so doing so
  could silently change which rows get NULL-padded, not just the cost. The plan-stage narration says up
  front when a query's `JOIN`s run in a different order than typed, and why; `/tools/join-order` and the
  Playground's "second opinion" note still exist for the one case that keeps needing them — a chain with a
  `LEFT JOIN` in it.
- **Join algorithm chosen by cost** (plan.md §25.4 C5, second slice) — a `JOIN`'s physical algorithm is no
  longer always nested-loop by default. `EngineOptions.joinStrategy` left unset now means every algorithm
  that could run each step — nested-loop, hash, sort-merge, and index nested-loop when the inner table has a
  usable index — is priced with the same per-algorithm formulas `EXPLAIN` already showed, and the cheapest
  one runs, chain-aware and bottom-up for a multi-join query. `/compare` and `/tools/planner` are unaffected:
  both already force a specific algorithm explicitly for every run, which this never overrides. Unlike
  index-vs-scan (C5's first slice), there is no "declines but stays" outcome here — every candidate is a
  real, working plan, so the rule always ends up choosing one.
- **Index vs. scan chosen by cost** (plan.md §25.4 C5, first slice) — `index-selection` and
  `range-index-selection` no longer take an index just because it matches the predicate's shape: once the
  most-selective candidate is picked, its own estimated page cost is compared against the scan it would
  replace, the same formula `EXPLAIN` already shows. A candidate that would not actually be cheaper — a
  low-selectivity index, or any index at all on a table too small for a B+Tree's own overhead to pay for
  itself — is declined, and the step says what it considered and why: "matches the predicate, but the
  estimated cost disagrees … no cheaper, so the scan stays." This retires `limits.mdx`'s "no cost-based
  query optimization" line for these two rules; every other rewrite still fires on structural match alone,
  and the join algorithm and join order (`/tools/join-order`) are still never chosen by cost. Twelve test
  files needed their fixture tables sized up to stay meaningful under honest cost accounting, since this
  engine's deliberately tiny constants meant most existing tables were too small for any index to ever win —
  a real, if unglamorous, consequence of a cost comparison finally having teeth.
- **Join ordering by dynamic programming** (plan.md §25.4 C4) — a new standalone, `/tools/join-order`,
  teaches Selinger's System R algorithm over the *subset lattice*: for `n` tables in a `JOIN` chain, the
  cheapest left-deep way to join every table in each of the `2^n - 1` subsets, built up bottom-up from
  smaller subsets, with every candidate the search tried for each subset visible, not just the winner. A
  new demo dataset (`departments`/`employees`/`projects`/`timesheets`, a tree rather than a chain) shows a
  natural-looking "hub, then each branch" order costing 5.2× the DP-optimal one. A multi-join query in the
  Playground gets the same search as an informational note on its own plan-stage narration — what a
  cost-based search would have joined the tables as, and its estimated cost next to the written order's.
  Deliberately visualization-only: a query still always executes in the order it was written; nothing here
  changes what runs, only what gets said about it.
- **`IN (subquery)`** (plan.md §25.4 C3, third slice, closing C3) — `x [NOT] IN (SELECT column FROM table
  [WHERE …])`, the one place a `SELECT` may appear inside another query. Always uncorrelated (the subquery's
  own `WHERE` can only name a column on its own table) and always exactly one plain column — no `JOIN`,
  `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `DISTINCT` or aggregate, since none of those could change which
  values end up in the set `IN` tests membership against. Resolved exactly once, as its own real sub-run of the
  engine (its own buffer pool, its own disk reads), before the outer query — in `SELECT`, `DELETE` or
  `UPDATE`'s `WHERE` — is planned; from that point on it is an ordinary value list, so the cost model, the
  executor and every optimizer rule need no new cases at all, and the classic `NOT IN` NULL trap applies to a
  subquery-sourced list exactly as sharply as a hand-written one.
- **Multi-join** (plan.md §25.4 C3, second slice) — zero or more `JOIN`s chained left-deep:
  `FROM a JOIN b ON … JOIN c ON …` joins `c` against whatever `a ⋈ b` already produced, not against `a` and `b`
  independently. Each `JOIN`'s `ON` must name the table it introduces on one side and some table already in the
  query — `FROM`'s, or an earlier `JOIN`'s, not necessarily the one written just before it — on the other; the
  same table can never appear twice (no aliasing to tell two copies apart). All four join algorithms chain
  correctly, and `index-nested-loop`'s per-table fallback now applies **per step**, so one step in a chain can run
  as an index join while another, on an unindexed table, quietly runs as nested-loop instead. `LEFT` and inner
  joins mix freely within one chain, NULL-padding independently at each step.
- **`LEFT JOIN`** (plan.md §25.4 C3, first slice) — `[INNER | LEFT [OUTER]] JOIN table ON a.col = b.col`. A bare
  `JOIN`/`INNER JOIN` behaves exactly as before; `LEFT [OUTER] JOIN` keeps every row of the `FROM` table, even one
  that matches nothing (or whose join column is itself NULL), NULL-padding the joined table's columns instead of
  dropping the row. Built for **all four join algorithms** — nested-loop, hash, sort-merge and index-nested-loop —
  which must all agree on the padded rows the same way they already had to agree on matched ones. The classic
  pitfall is closed: a `WHERE` on the joined table is never pushed below a `LEFT JOIN` (that would filter rows out
  before the join can find out they would not have matched, silently turning it back into an inner join), so
  `… LEFT JOIN posts ON … WHERE posts.title IS NULL` correctly finds only the rows that got NULL-padded. `RIGHT`,
  `FULL` and `CROSS` stay out of scope.
- **A correlated dataset, and q-error** (plan.md §25.4 C2) — a fourth preset dataset, `employees`: `department`
  and `office` are perfectly correlated (every department occupies exactly one office), which is exactly the
  independence assumption every `AND` in a `WHERE` clause makes and exactly where it can badly fail.
  `WHERE department = 'x' AND office = 'y'` is no narrower than `department = 'x'` alone, but the optimizer
  estimates it as if the two columns were unrelated. `EXPLAIN ANALYZE` now names the gap as **q-error**
  (`max(est/actual, actual/est)`, the metric Leis et al.'s cardinality-estimation paper uses) beside any operator
  whose estimate is off by 2× or more; the `employees` headline query measures **11.0×**, produced by ordinary
  correlated data, not a contrived worst case. An ordinary, well-estimated query shows nothing extra.
- **`ANALYZE` and real statistics** (plan.md §25.4 C1) — `ANALYZE table` is a real statement: a real scan of the
  real table, producing per-column statistics shaped after PostgreSQL's own `pg_stats` (distinct count, null
  fraction, most-common values with their real frequencies, an equi-depth histogram, and correlation between a
  column's own order and the table's physical row order). Its own answer is one row per column, shown in the
  same Result panel any other query's is — there is no separate stats panel to build. The cost model reads a
  table's statistics when `ANALYZE` has set them, in place of scanning the live rows: an equality on a most-common
  value gets its real frequency, a range reads the histogram's real bucket overlaps. They are a **snapshot**, not
  a live fact — a table's writes never touch them, so a table that grows a new common value without a fresh
  `ANALYZE` gets a stale, sometimes wildly wrong, estimate (a real q-error over 20× is one `INSERT` away). A table
  that has never been `ANALYZE`d keeps exactly today's behaviour, unconditionally accurate and unconditionally
  unrealistic — the entire existing test suite passed unmodified.
- **An MCP server, and `llms.txt`** (plan.md §25.4 H4) — `mcp/server.ts` exposes three tools to the user's own
  coding assistant, each grounded in a real run of the actual engine rather than a description of one: `run_query`
  (rows, disk-read/hit/eviction counts, and the full step-by-step narration), `explain_trace` (a PostgreSQL-shaped
  plan, optionally `ANALYZE`d against a real run), and `compare_policies` (the same query under LRU and clock
  eviction, side by side). Runs locally over stdio (`pnpm mcp`) against three preset datasets; no hosted service.
  `public/llms.txt` is a machine-readable docs index generated from the docs' own navigation and frontmatter
  (`pnpm llms-txt`), checked for staleness on every test run. Publishing `@querylens/mcp` to npm still needs the
  organisation plan.md §25.4 H3 does.
- **Clustered (index-organized) tables** (plan.md §25.4 B3, fifth and final slice) — a table may be stored *in* one
  of its own `UNIQUE` indexes' key order rather than insertion order, so a range on that key reads pages in
  sequence: measured, **6 disk reads clustered vs 8 for the same rows unclustered** on a small, scrambled table.
  Every *other* index on a clustered table then carries the row's clustering key instead of its physical address —
  a clustered leaf moves rows between pages the way any leaf does, and a stored address would go stale — so an
  equality lookup through one costs a second, real descent, through the clustered index itself; a covering query
  still costs only one, and a range scan or an index-nested-loop join never chooses a clustered table's secondary
  index at all. Checked by a standalone oracle that runs the same random session of writes and reads against two
  databases differing only in whether they are clustered, asserting every result and every write's index soundness
  agree — clustering is a purely physical fact, so identical answers are the only correct outcome. Not yet exposed
  in the Custom database editor.
- **Course map and interview roadmap** (plan.md §25.4 G1) — two pages under a new *Study* section of the docs.
  The **course map** lines a typical database course up against QueryLens topic by topic, marking each *covered*,
  *partly* or *not covered* in words, with where to practise it and what is missing — including the large part
  (transactions, recovery, MVCC, column stores, LSM trees) it does not touch. The **interview roadmap** is a
  six-week path through the site: watch, explain out loud, and check with the challenges. Neither is affiliated with
  a course, university or employer, and says so first.
- **Bulk-loaded indexes, and an *Index build* comparison** (plan.md §25.4 B3, fourth slice) — an index can be
  built by sorting the entries and packing the leaves to a fill factor instead of inserting one row at a time. It
  is a smaller, often shallower tree with identical answers: over 400 rows a point lookup costs **5 disk reads**
  bulk-loaded and **7** built the old way (whose leaves come out three-quarters full — the split rule at work),
  and 7 again when the leaves are packed only half full. `/compare` has a fourth mode that runs the same query
  over the three builds and scores tree height, index pages and disk reads.
- **`UNIQUE` indexes** (plan.md §25.4 B3, third slice) — declare one in the Custom database's *Manage tables*
  (`email, team+role`). A unique constraint is an index lookup made before a key goes in: `INSERT` and `UPDATE`
  ask the index whether the key is already there, and if it is the statement is rejected with the key and the
  row that holds it, and changes nothing. The Playground keeps the trace of a rejected statement — the lookup that
  found the duplicate — rather than saying the query did not run. NULLs never conflict. Checked against SQLite's own
  `UNIQUE INDEX` on random sequences of writes.
- **Composite indexes** (plan.md §25.4 B3, second slice) — one B+Tree over several columns, entered through a
  *leftmost prefix*: an index on `(city, age)` answers `city = 'oslo'` and `city = 'oslo' AND age = 30`, but not
  `age = 30` alone, because its entries are ordered by `city` first. The plan says so when it declines one, and a
  new predict-then-reveal question asks it before the answer. A query that reads only the index's columns is
  *covered*: an index-only scan answers it from the entries without touching the heap. Writes maintain the
  entries, an index join can probe one through its leading column, and the Custom database's *Manage tables*
  takes `city+age`. A range on the column after an equality prefix (`city = 'oslo' AND age > 30`) walks just
  that run of entries.
- **Index nested-loop join** (plan.md §25.4 B4) — the fourth join algorithm. Instead of rescanning the inner table
  for every outer row, it descends the inner table's own B+Tree on the join column: a few page reads per outer
  row, whatever the inner table's size. The plan gains an `IndexProbe` node for the inner side. It needs an
  index on the inner join column and, without one, runs as a plain nested-loop and says why. **`/compare`'s JOIN
  mode is now four-way**, with a larger `comments` table and a new preset — *a tiny outer over a big indexed
  inner*, where one outer row costs 23 disk reads against 33 for nested-loop and hash — and it shows the other
  half too: with every post as the outer, the index join needs 202 reads to hash's 33.
- **Indexes on columns that repeat** (plan.md §25.4 B3, first slice) — an index entry is now the value plus the
  row's own address, so two rows with the same `authorId` are two entries side by side in the leaves instead of
  one silently overwriting the other. An equality finds every match: it descends toward the *first* entry (going
  left of a separator that equals the value, because a run can straddle one), reads along the leaf, and hops to the
  sibling leaf only when the leaf's high key says the value continues. Each match costs its own heap page, pulled
  as the row is asked for — a `LIMIT` stops the walk early. `DELETE` and `UPDATE` drop and re-add exactly the
  entry that belongs to each row. `posts.authorId` is indexed in the join demo, the case v1 could not handle.
- **Bundle budgets by route** (plan.md §25.4 H8) — `pnpm budget` now prices **each of 30 routes, every page and every
  tool, by what a visitor to it downloads**: the entry chunk, that route's own lazy chunk and every static
  dependency of either, read from Vite's manifest. A change that grows the Playground can only raise the
  Playground's row; a chunk no route reaches fails the build, so a new tool must bring its own row. It also says
  something the old group sums never did: the landing page costs **147 kB** gzip, the Playground **296 kB**
  (CodeMirror is 116 of it), and every route pays a **110 kB floor** (React, the app shell and CSS). The single
  424 kB sum is printed as information, no longer a gate.
- **`EXPLAIN` and `EXPLAIN ANALYZE` as SQL** (plan.md §25.4 B6) — type it in the editor. `EXPLAIN SELECT …` returns a
  `QUERY PLAN` result, one line per operator with the cost model's `est ~N rows`, and **executes nothing** — no page
  is read. `EXPLAIN ANALYZE SELECT …` runs the query for real (the trace you step through is that run) and puts the
  executor's `actual N rows` beside every estimate, then the result size and what the buffer pool did. No timings:
  the engine makes no latency claim. `SELECT` only — `EXPLAIN ANALYZE DELETE` would perform the delete, and says so.
  An `EXPLAIN ANALYZE` chip joins the Playground's presets.
- **The plan as relational algebra** (plan.md §25.4 B5) — the notation a database course opens with, derived from
  the plan the engine actually built. A **Show as → Relational algebra** toggle on the Planner and Optimizer
  panels rewrites each node as `σ` (selection), `π` (projection), `⋈` (join), `γ` (grouping), `τ` (order), `δ`
  (distinct) or `λ` (limit), keeping the physical operator underneath — so a filtered `SeqScan` and an
  `IndexScan` both read `σ_{id = 5}(users)`: *what* is computed beside *how*. **Copy as relational algebra**
  (`π_{name}(σ_{age > 30}(users))`) and **Copy as LaTeX** put the whole plan on the clipboard for a homework
  answer or a slide.
- **`SELECT DISTINCT`** (plan.md §25.4 B2, second slice) — each distinct row once, NULLs counted as equal, applied
  after `WHERE`/`GROUP BY`/`HAVING` and before `LIMIT`/`OFFSET`. Two strategies on the setting `GROUP BY` already
  uses: a streaming **`HashDistinct`** (a hash set of rows seen, no I/O, and a `LIMIT` above it can stop the scan
  early) and a blocking **`SortDistinct`** (sorts everything through the buffer pool, then keeps one of each
  run). `/compare`'s aggregate mode gains `SELECT DISTINCT` presets, so the contrast is measured, not asserted.
  With `ORDER BY`, the sort column must be in the select list (PostgreSQL's rule). `COUNT(DISTINCT x)` is not
  supported yet.
- **`HAVING`** (plan.md §25.4 B2, first slice) — filter *groups* after their aggregates are computed:
  `GROUP BY dept HAVING COUNT(*) > 2 AND SUM(pay) < 500`. `WHERE` filters rows before grouping and so can
  never mention an aggregate; an aggregate in a `WHERE` is now an error that points at `HAVING`. A `HAVING`
  predicate is built like a `WHERE` one (`AND`, `OR`, `NOT`, `IN`, arithmetic…) over aggregates and grouped
  columns, may use aggregates the `SELECT` list does not, and works on a whole-table aggregate too. In the
  plan it is its own `Having` node above the aggregate; the optimizer still pushes a `WHERE` below it.
- **`LIMIT n OFFSET m`** (plan.md §25.4 B1, third and last slice) — page through an ordered result. The trace
  is honest about the cost most tutorials leave out: the skipped rows are still produced by everything beneath
  the `Limit` and then thrown away, so `OFFSET 30` visibly reads more of the table than `OFFSET 0`, and the cost
  model and the plan node say so. An `OFFSET` needs its `LIMIT` (SQLite's rule), and both must be whole numbers.
- **Arithmetic and computed columns** (plan.md §25.4 B1, second slice) — `+ - * / %`, unary minus and
  parentheses in `SELECT`, `WHERE` and `UPDATE … SET`, and `AS` to name a computed column
  (`SELECT price * qty AS total`). NULL in, NULL out; `x / 0` is NULL; whole-number `/` truncates toward zero.
  `UPDATE … SET n = n + 1` reads the row as it was, so `SET a = b, b = a` swaps the two. `INSERT` accepts
  `-5` and arithmetic on literals. The optimizer works constant arithmetic out once (`id = 2 + 3` becomes
  `id = 5`, and *then* uses the index), while `id + 1 = 6` correctly cannot — the index is ordered by `id`.
  Not yet: arithmetic on an aggregate, beside `GROUP BY` or in `ORDER BY`; `SELECT *, x` (found by the
  oracle — SQLite accepts it, QueryLens needs `*` alone). Two ledger entries record the deliberate
  differences from SQLite: arithmetic on text, and dividing a REAL that holds a whole number.
- **Richer `WHERE`: `OR`, `NOT`, parentheses, `<>`, `IS [NOT] NULL`, `IN`, `LIKE`** (plan.md §25.4 B1, first slice) —
  the ceiling a sceptical student hit in ten minutes. A predicate is now a tree (`OR` binds loosest, then `AND`,
  then `NOT`, then one test on an operand) with real three-valued logic: `NOT` of UNKNOWN stays UNKNOWN, so
  `NOT (age > 40)` does not return the NULL-age rows, and `x NOT IN (1, NULL)` is never true — the trap, modelled
  rather than papered over. `[NOT] BETWEEN`, `!=` (as `<>`) and `[NOT] LIKE` (`%` and `_`, case-sensitive,
  PostgreSQL's rule) come with them. An `OR` is one opaque conjunct, so `id = 5 AND (a OR b)` still becomes an
  index lookup; `OR`, `NOT`, `IN`, `LIKE` and `<>` are never index candidates. The plan and AST trees show every
  new node, the cost model estimates each one (and names the heuristic), and the Supported SQL page has the truth
  tables. Checked by a new **ternary-logic-partitioning** suite (a predicate, its negation and its `IS NULL`
  must partition every table — no external oracle needed) and by the SQLite differential run.
- **Opt-in field performance in the study kit** (plan.md §25.4 A6) — §14.2's open question, *does it feel fast
  on a lecture-hall laptop?*, cannot be answered by telemetry the project refuses to have, so it can only be
  *volunteered*. The study's consent screen gains a separate, unticked box: record this device's **INP**
  (Interaction to Next Paint) while the session runs and add it to the result code, with cores, screen width and
  touch as context. It measures in the lesson tabs (not on `/study`), in the participant's own browser, lapses
  after three hours by itself and is deleted when the session ends; the code page says so when it is included.
  A lazy 1.1 kB chunk that nobody else downloads. `pnpm study collate` writes it to the private map (never the
  blind scoring sheet) and `report` adds a responsiveness table — median, worst, good / needs-work / poor —
  with the caveat that a handful of devices is an anecdote. Verified end to end in Chromium (a deliberately slow
  click in the lesson tab arrives in the result code).
- **Release discipline** (plan.md §25.4 A4). `RELEASING.md` writes down how a release is cut — one commit, the
  tag on that commit (1.0.0's tag sits on the deployed commit and its `package.json` still says `0.0.0`) — and
  what to check after a deploy. `pnpm release-notes [version]` derives the GitHub release body from
  `CHANGELOG.md`, so release notes are written once. A list of files whose effect only a real deploy can judge
  (`wrangler.jsonc`, `public/`, `index.html`, `pnpm-workspace.yaml`, `.node-version`) drives a non-blocking CI
  job that annotates a pull request touching them, and a new pull-request checklist item: the first deploy
  needed three fixes no local check could find, and the answer is to look at a preview deploy first.
- **"Report a confusing step"** (plan.md §25.4 A3) — QueryLens has no telemetry by decision, so the only
  signal about *which moment confused someone* is one they choose to send. A link under the Playground's
  narration opens a prefilled GitHub issue form (`confusing_step.yml`) carrying the build, the step and stage,
  what the narration said, the query, and a link that reopens the exact moment. It is a plain link — nothing
  is sent until the reader presses Submit on GitHub, where every field can be edited or deleted — and it
  degrades (drops the edited rows, then the link, then the query text) rather than overrun GitHub's URL limit.
- **A SQLite oracle and a divergence ledger** (plan.md §25.4 A1) — the engine's *rows* are now checked
  against an outside authority on every build. `oracle/` drives `node:sqlite` (Node's built-in; no new
  dependency, nothing in the bundle) with `fast-check`: generated typed tables and grammar-derived statements
  — `SELECT` with `WHERE` / `ORDER BY` / `LIMIT`, aggregates and `GROUP BY`, `JOIN`, and short sessions of
  `INSERT` / `UPDATE` / `DELETE` followed by a read — run in both engines and must agree, with buffer size,
  page size, policy, join algorithm and aggregate strategy drawn at random so every physical strategy is
  checked. Beside it, metamorphic properties inside QueryLens (physical choices never change the rows; the
  optimized plan agrees with a direct evaluation of the predicate; index and heap agree after writes; the
  trace is deterministic), and a coverage suite that **fails the build if the generators stop reaching**
  every optimizer rule, join algorithm, aggregate strategy, empty table, NULL and row-changing write. Seven
  documented differences from SQLite live in `oracle/ledger.ts` as *executable* entries that assert both
  answers and that they still differ, so a closed gap expires its own entry. CI runs it seeded and bounded
  as part of `pnpm test`; a weekly read-only workflow (`.github/workflows/oracle.yml`) runs 20,000 cases per
  property with a fresh, printed seed. A new docs page, **How we know the answers are right**, explains what
  it proves and — as importantly — what it does not.
- **The §9 study kit** (plan.md §25.4 A2) — the validation study can now be run end to end without a
  server. `/study` is an unlisted, `noindex`, kiosk-mode runner (no nav, footer or docs links, so a
  control-arm participant is not one click from the app's own explanation of the material): consent →
  fixed-time material → five questions on a countdown with no way back → a copyable result code, with
  reload-resume and a clock driven by timestamps rather than a counter. **The instrument is not in the
  bundle.** `STUDY.md` says the questions and the control-arm reading must never be shown early or
  shipped publicly, so the runner is inert on its own and the pack — consent text, reading or lessons,
  questions, timings — arrives in each participant's link *fragment* (`/study#p=…`, raw deflate +
  base64url), which is never sent to a server; an e2e test fails the build if any of the study's text
  ever appears in `dist/`. A pack is treated as a stranger's input: every field bounded, task links
  restricted to same-origin paths, decompression capped against a zip bomb, prose rendered as text nodes
  by a four-mark renderer rather than a Markdown library. `pnpm study` is the researcher's side:
  `links` (equal-group random allocation, seeded and reproducible, a private `key.csv`), `collate`
  (a scoring sheet with participant and arm removed and answers shuffled, plus a separate map — STUDY.md
  §3's "score blind"), and `report` (per-arm n, mean, SD, min, max and the smallest detectable effect —
  deliberately no p-value). Adds `src/study/` (58 tests, incl. off-site links and a decompression bomb),
  a `study` bundle row (5.4 kB gzip, its own lazy chunk), six Playwright tests, and STUDY.md §4.

### Changed
- **`DELETE` and `UPDATE` can find their rows by a range of an index.** `DELETE FROM users WHERE id > 40` walks the
  leaf chain instead of scanning the table (a write could only use an equality lookup before); the rows it touches
  are locked and their index entries dropped or moved exactly as before.
- The oracle's default run is now **1,000 cases per property** (was 200), about two seconds: injected bugs in rare
  query shapes survived 200 and 400 and die at 800.
- `package.json` now carries a description, homepage, repository, bugs and keywords (it had none), and
  the README title reads "QueryLens — a database internals visualizer". The name is shared with at least
  five unrelated products (RESEARCH.md §45); the decision is to keep it and always pair it with the
  descriptor, which the site's `<title>` and `og:title` already did.
- The README's CI badge pointed at the old `QueryLens` repository name; it now points at `query-lens`.
- Vitest also runs tests under `scripts/` and `oracle/`; `oracle/` joins `tsconfig.node.json`.

### Fixed
- **EXPLAIN ANALYZE no longer undercounts an operator whose last candidate fails a residual check.** An index
  scan whose final candidate failed its extra predicate reported the discarded candidate's `0` as its row count, even
  when it had already returned rows. The plan now reports the largest count each operator reached.
- **`EXPLAIN ANALYZE`'s actual row count mixed up two nodes that shared an operator.** Its lookup kept one
  count per operator *name* (`SeqScan`, `Join`, …), so a multi-join chain's several `SeqScan`s or `Join`s all
  reported whichever one's count happened to be recorded last — an `authors` scan that really produced 5 rows
  could show `posts`'s 50 instead. Flagged, but deliberately left unfixed, while building multi-join (plan.md
  §25.4 C3 slice b); fixed now. `execute` events and the plan node they annotate both gained an optional
  `table` (a scan's own table, or a `Join`'s `rightTable`) that tells one node of the same kind apart from
  another in the same plan — always enough, since the parser never lets a query name the same table twice.
- **The optimizer claimed "estimated cost decides it" when it does not.** Its rules fire on the shape of the
  predicate, so an index over a repeated value could be chosen and cost more than the scan it replaced. The note
  now says whether the estimate agrees or disagrees and, when it disagrees, that the index was taken anyway.
- **The plan stage said "nested-loop" for a sort-merge join.** When no rewrite rule applied, its note named the wrong
  algorithm; it now names the one that runs.
- **A range scan now reads the leaves it walks.** Each hop along the sibling chain fetches that leaf through the
  buffer pool, as the cost model already assumed — so an `EXPLAIN ANALYZE` estimate and its actual agree on how
  many leaves a range touched.
- **The FAQ still asked "Why no joins, subqueries, or `GROUP BY`?"** — a question the product stopped deserving
  several releases ago. It is now "What SQL is missing?", and lists what really is.
- **The crash report's "Open an issue" and the footer's "Report an issue" opened a blank form.** Both used
  `issues/new?body=…`, but the repository disables blank issues, and with blank issues off GitHub sends a bare
  `issues/new` to the template chooser — dropping the prefilled body. They now name a template
  (`bug_report.yml` with its `description` / `repro` / `error-boundary` fields; the footer goes to the chooser).
  Three issue templates also still linked to the repository's old `QueryLens` name.
- **`WHERE id > NULL` (and `>=`, `<`, `<=`, `BETWEEN … NULL …`, `= NULL`) on an indexed column returned
  rows.** A comparison with `NULL` is UNKNOWN and matches nothing, but the index rules read a `NULL` literal
  as "no bound" and walked the whole index. A `NULL` literal is now never an index key or bound; the
  comparison stays in the filter, where it is UNKNOWN. Found by the oracle.
- **`DELETE FROM t WHERE k = k` deleted the rows where `k` is `NULL`.** `constant-folding` folded a column
  compared with itself to "always true" and dropped it; under three-valued logic it is UNKNOWN on a `NULL`
  row, and only TRUE passes a filter — so `SELECT`s returned, and `DELETE`s destroyed, rows the predicate
  excludes. Only two-literal comparisons fold now. Found by the oracle; an existing unit test that asserted
  the old behaviour was rewritten.

## [1.0.0] - 2026-09-23

The first public release: the application as first deployed to Cloudflare (Workers static assets),
tagged `v1.0.0` at `2b9a37d`. Everything below this line, down to `[0.1.0]`, shipped in it. The
retrospective — what it is, and what it did and did not prove — is [plan.md §24](plan.md#24-where-v1-stands--the-retrospective);
the plan for what comes next is §25. (The tag marks the deployed commit; this version header and the
`package.json` bump landed in the commit after it.)

### Added
- **An Architecture docs page** (`/docs/architecture`, plan.md §18.4/§23) — the engine/UI split, the
  event model, the Volcano executor's current operator list, all six optimizer rules in the order
  they run, storage, locks, and a short "how to extend it" for contributors. Written fresh rather
  than moved from the README verbatim as originally planned, since the README's own architecture
  section had drifted to describing v0-era scope (two optimizer rules, no `JOIN`/writes, a separate
  `docs/` Astro package removed years ago) by the time this shipped.
- **Four new challenges** (plan.md §23.1/§23.2, closing the tranche) — "The sort spill" ( `ORDER
  BY` enough rows that the external merge sort needs more than one run), "Hash beats loop" (a
  JOIN over `authors`/`posts` that reads fewer pages under hash than nested-loop for the *same*
  query — the check reruns your SQL itself under both algorithms and compares real numbers, not
  an estimate), "The dirty eviction" (an `UPDATE` wide enough that an already-dirtied page gets
  evicted, forcing a real writeback), and "The range leap" (a range predicate on the indexed
  column, touching fewer pages than the equivalent full scan). `Challenge` gained two optional
  fields to support the JOIN puzzle: `database` (a one-off `Database` no preset `DatasetId`
  names) and `engineOptions` (forces `bufferFrames: 2`, the same reason `/compare`'s own JOIN
  mode does, so the two algorithms' page counts actually diverge instead of both fitting in
  cache). `check` now also receives the query text, and the page's stats grid gained three more
  fields (sort writes, dirty evictions, range scan used) so every new goal has visible feedback,
  not just pass/fail.
- **Live interactive widgets embedded in the Concepts docs** (plan.md §23.1, closing §17.4's
  last open definition-of-done checkbox) — `concepts/btree.mdx` gets a "find a key" search
  box over a small live tree (`BTreeMiniDemo`), and `concepts/buffer-pool.mdx` gets a
  steppable buffer pool with its own LRU/clock-sweep toggle (`BufferPoolMiniDemo`), both
  reusing the exact `BTreePanel`/`BufferPoolPanel` the standalone `/tools` sandboxes already
  use rather than any new visualization code. Required excluding those two pages from
  `vite.config.ts`'s shared `docs` chunk group — forcing them in had merged
  `BTreePanel`/`FlowTree`/the engine's trace code into the one chunk every other docs page
  shares too, so a bare FAQ visit would have paid for a B+Tree panel it never uses (measured:
  `docs` chunk 15.5 → 49.8 kB gzip). They now fall to rolldown's own default chunking and
  share the existing chunk Playground already needs that code from.
- **B+Tree leaf-chaining range scans** (plan.md §23.1) — `>`, `<`, `>=`, `<=` and
  `BETWEEN` on an indexed column now descend the B+Tree once and walk the leaf sibling
  chain horizontally, instead of falling back to a full table scan the way every range
  predicate did before this. The grammar gained `<=`/`>=` (the tokenizer already lexed
  them, just to reject them) and `BETWEEN lo AND hi`, desugared to `col >= lo AND col <= hi`
  at parse time rather than a new `Expr` kind, so every existing conjunct-walking piece of
  the engine handles a `BETWEEN` for free. A new optimizer rule, `range-index-selection`,
  runs right after `index-selection` and only fires when no equality conjunct matched any
  indexed column — an equality always wins, by rule order, never a cost comparison. The new
  `IndexRangeScan` plan node and executor operator pull one matching row at a time, as
  lazily as every other operator, narrating a `chain-next` step each time a leaf runs out
  and the walk crosses to the next one via its sibling pointer. Priced with a dedicated
  `boundedRangeSelectivity` — the true linear-density interval overlap, not the product of
  two independent `rangeSelectivity` fractions, which would double-discount a `BETWEEN`
  (its lower and upper bound are the same column, not two independent ones). `FlowTree.tsx`'s
  B+Tree sibling edges now light up the same way a lit hierarchical edge already does when
  both leaves they connect were actually visited, so `BTreePanel` shows the real horizontal
  path a scan took. Deliberately excluded from `DELETE`/`UPDATE`'s own optimizer pass — their
  executors only know how to run a `SeqScan` or a single-row `IndexScan`, not an
  `IndexRangeScan`'s multi-row walk — with a dedicated regression test guarding against that
  silently reaching them. No index-only variant yet. 55 new unit tests, 1 new e2e.
- **Undo/redo in the seed data editor and the multi-table schema editor** (plan.md §23.1) —
  `DataEditor.tsx` keeps a `past`/`future` snapshot stack of the table's rows, with an Undo and a
  Redo button in the footer. Repeated keystrokes into the same cell coalesce into one undo step
  (tracked by a `lastEditTarget` ref) so undoing a typed value doesn't mean clicking through every
  character — moving to a different cell, or any structural change (add row, delete row, CSV
  import), starts a fresh step and clears the redo stack. `SchemaEditor.tsx` got the same
  `past`/`future` shape over its own staged `Database`, one entry per add-table, remove-table, or a
  row edit committed from its nested `DataEditor` — no coalescing needed there, since every mutation
  at that level is already a discrete action. Both are button-driven only; `Ctrl+Z`/`Ctrl+Y` were
  deliberately left out to avoid fighting the browser's own native per-field undo inside a dialog
  full of plain `<input>`s.
- **`LICENSE-DOCS`** (plan.md §17.3, §23.1) — the documentation prose under
  `src/pages/DocsContent/` is CC BY 4.0, distinct from the MIT-licensed application source. The
  site-wide footer already carried a "CC BY 4.0 docs" badge; it had nothing to link to until now —
  `Footer.tsx`'s Project column gained a "Docs licence" link beside the existing MIT "Licence" one.
- **A second candidate index, chosen by selectivity** (plan.md §22.2) — `Table.indexedColumn?:
  string` widened to `indexedColumns?: string[]`: each entry is its own independent single-column
  B+Tree, not a composite (multi-column) key over several columns at once, which stays a separate,
  larger step. `buildIndexes` (`index/build.ts`) builds them in turn, each tree's own page ids
  starting exactly where the last one's left off, so no two ever collide with the heap's or each
  other's; `pageCountFor` widened the same way. `ExecContext.tree: BPlusTree | null` became
  `trees: Record<string, BPlusTree>`; the write path (`insert`/`delete`/`update.ts`) now loops over
  every declared column, maintaining each tree in turn, and `UPDATE` only reindexes the ones whose
  own column actually changed. `index-selection` picks the more selective of two or more matching
  candidates by `ndistinct` — the same fact the cost model's own equality-selectivity estimate
  already rests on — and narrates a genuine tie honestly as a tie broken by declaration order, not
  as one index falsely "beating" another with equal numbers (caught live against the shipped `posts`
  fixture before it shipped wrong). `posts` now indexes `id` and `title`, deliberately not
  `authorId` — it repeats (4 distinct among 10 rows), and this B+Tree's `insert` is "last writer
  wins" on a duplicate key, so indexing a repeating column would make `WHERE authorId = 1` silently
  return one row instead of three (found by running the query, not by inspection).
  `SchemaEditor.tsx`'s single-index `<select>` is now a real multi-select. 20 new unit tests, 2 e2e
  (one new, one extended to a real two-index selection).
- **Predicate pushdown into a `JOIN`'s own children** (plan.md §22.2) — a new optimizer rule,
  `join-predicate-pushdown`, splits a `WHERE` clause's conjuncts by which table they qualify (every
  reference is qualified once a query has a `JOIN`, so there's no ambiguity) and pushes each
  single-table conjunct into that side's own `SeqScan`, with its table qualifier stripped first — a
  scan reads that table's raw, unqualified rows, and a qualified reference against them would
  silently match nothing rather than error. A conjunct naming both sides (the join predicate itself,
  restated in `WHERE`, say) stays a residual `Filter` above the `Join`, exactly as before. Needed no
  multi-join grammar, unlike join order, and no cost-model change either — `estimateNode`'s `SeqScan`
  case already prices a `.filter`, so a pushed conjunct's selectivity flows into the `Join`'s own row
  estimate automatically. 12 new unit tests, including two test titles/comments fixed for now
  describing stale behavior ("a residual, not pushed into either scan" was true until this rule
  shipped).
- **Sort-merge join, `JOIN`'s third algorithm** (plan.md §22.2) — `Join.algorithm` widened to
  `'nested-loop' | 'hash' | 'sort-merge'`. The new `sortMergeJoin` operator sorts both sides on the
  join key (each its own `externalMergeSort` call — real spill I/O through the buffer pool, the same
  driver `Sort`/`SortAggregate` already use) and merges the two sorted lists in a single pass, driven
  by a generator (`sortMergeMatches`) that replays the *entire* matching run on both sides once a key
  repeats, rather than a plain two-pointer merge, which would silently drop every pairing after the
  first once the join column isn't unique. The sort key is `equalityKeyOf`'s own coercion, not a raw
  comparison, so a value `compare('=', ...)` calls equal always sorts adjacent — the same property
  hash join's mixed-type test already defended, now proven for sort-merge too. Each side's sort
  scratch gets its own non-colliding page-id block (`runQuery.ts` now reserves one per side — the
  first case two independent sort reservations were ever needed in one query). Priced honestly:
  `left.estPages + right.estPages` (each side read once, like hash) plus both sides' own spill,
  mirroring `Sort`'s own estimate — pricier than hash, cheaper than nested-loop's rescans past a tiny
  table. `/compare`'s join mode is now a genuine three-way ("JOIN algorithms," renamed from
  "Nested-loop join vs. hash join"), each column flagged only where it isn't the best of the three.
  12 new unit tests, 1 e2e updated.
- **The two §9-blocking manual pages** (plan.md §17.2): `/docs/manual/eviction` ("Watch a page get
  evicted") and `/docs/manual/btree-split` ("Watch a B+Tree split"), a new **Manual** group in the
  docs nav. Both are task-shaped how-tos that open the app at the exact state they describe rather
  than showing a screenshot of it — the eviction page's LRU-vs-clock-sweep contrast uses the
  [buffer-pool sandbox](https://query-lens.pages.dev/tools/buffer-pool)'s `ref`/`frames`/`policy`
  URL state to reproduce a real divergence (`0 1 2 0 0 0 3 4 5` at 3 frames — LRU evicts the hot
  page, clock sweep keeps it), and the B+Tree page's two split demos (`/tools/btree?keys=...`) walk a
  verified leaf split (copy-up) and a verified cascading root split (push-up). See plan.md §17.4's
  status note for what was checked and why screenshots were dropped.
- **True vector SVG export for the AST, plan and B+Tree trees** (plan.md §20.3) — a **Download SVG**
  button beside **Download PNG**, emitting real `<rect>`/`<text>`/`<path>` elements instead of
  `html-to-image`'s `toSvg`, which wraps HTML in a `<foreignObject>` that Illustrator, Inkscape and
  PowerPoint all import inconsistently — a screenshot with extra steps, not a real vector export.
  `src/ui/renderSvg.ts` reuses the *exact* d3-hierarchy layout `FlowTree.tsx`'s own `build()` already
  computes, so an exported tree matches what was on screen, but never touches the DOM for geometry:
  every label/detail line in the app is already `font-mono`, so a fixed monospace character-width
  estimate (`wrapMonospace`) wraps text deterministically with no text measurement needed at all.

  Colour is the one place this can't stay fully pure. `resolveTone` reuses each tree's *existing*
  `tones` map verbatim — no second colour table to drift out of sync with what's actually on screen —
  by recognising the app's own two Tailwind conventions (a `hue-<name>` design token, or
  `[var(--color-<name>)]` naming one directly) and resolving them through an injected `resolveColor`
  callback, which keeps the geometry and text-wrapping pure and unit-testable without a real DOM. The
  real, browser-backed resolver (`resolveCssColor`) is a two-step pipeline, not one: a throwaway
  element's computed `color` resolves any `var()`/`color-mix()` reference (the only step that can,
  since those need a real CSS cascade), and then a 1×1 canvas *rasterises* that value to concrete
  8-bit RGBA — because current Chrome's `getComputedStyle` now **preserves** `oklch()`/`oklab()`
  rather than normalising to `rgb()` the way it used to. Skipping that second step would have silently
  reproduced the exact "imports inconsistently" problem this feature exists to fix, just via an
  unsupported colour function instead of `foreignObject` — caught by inspecting an actual downloaded
  file in the browser, not by any unit test.

  `AstTree.tsx`, `PlanTree.tsx` and `BTreePanel.tsx` each had their `TONES`/`toFlow`/`ICONS` moved into
  a sibling data file (`astTreeTones.ts`/`planTreeTones.ts`/`btreeTones.ts`): Fast Refresh only works
  on a file that exports nothing but components, and `StageDetail.tsx` needed the same data these
  components already had to build the new **Download SVG** button. 18 new unit tests (including one
  that imports the three real tone maps and asserts every entry classifies correctly — an anti-drift
  check, not a hardcoded copy), 1 e2e covering all three trees and asserting zero `oklch`/`oklab` ever
  reaches the exported file.
- **A multi-table schema editor in the Playground itself** (plan.md §22.7) — the one piece JOIN
  shipped without. A fourth "Custom" chip joins the existing `users`/`orders`/`logins` data presets;
  clicking it opens on a real, editable `authors`/`posts` pair (the same starter `/tools/planner`
  uses) and a new **Manage tables** button. `SchemaEditor.tsx` lets you add a table (name, a
  comma-separated column list, an optional index), remove one, or open its rows in a nested
  `DataEditor` — native `<dialog>`s stack fine, and this is the only caller that omits
  `DataEditor`'s now-optional `onReset` prop, since a user-authored table has no "seed" to revert to.

  Table and column names are validated by literally tokenizing the candidate string and checking it
  produces exactly one `identifier` token (`isValidName`, `src/ui/customDatabase.ts`) — reusing the
  real tokenizer rather than a hand-written regex means a SQL keyword is rejected for free (it
  tokenizes as `'keyword'`, not `'identifier'`) with zero risk of drifting from what `runQuery` will
  actually accept. `Database.tables` needed no engine change — it was already `Record<string,
  Table>` — so this was purely a UI gap.

  A custom database is deliberately **local only**: kept in `localStorage`
  (`loadCustomDatabase`/`saveCustomDatabase`), never encoded into the URL or a trace file.
  `isCustom` is its own boolean, not a fourth `DatasetId` — widening that closed 3-value union would
  have dragged `urlState.ts`'s positional-by-known-columns row encoding, `traceFile.ts`'s
  `TraceState.dataset`, and `datasets.test.ts`'s one-table-per-preset invariant into supporting an
  open-ended schema none of them were designed for. `Download trace` is disabled with an explanatory
  tooltip while Custom is active, and switching to a preset — or loading a trace file, which always
  names one of the three fixed presets — cleanly exits custom mode. 29 unit tests for the driver, 7
  for `SchemaEditor`, 1 e2e covering the full flow: add a table, edit its rows, `JOIN` it against an
  existing one in the real Playground, reload and confirm it persisted, then switch back to a preset
  and confirm a clean exit.

  Deliberately out of scope for v1: renaming a column after a table is created — the query text
  itself has no way to follow along, so the honest version is "define the columns once, at creation."
- **`/tools/hash-join`, a Grace hash join sandbox** (plan.md §22.3) — the engine's real `hashJoin`
  operator (added just above) never partitions or spills, so this is its own driver, `src/ui/hashJoin.ts`,
  the same "own driver, no playback" shape `externalSort.ts` established for `/tools/sort`. Given a
  build-key list, a probe-key list, and a memory budget, `planHashJoin` lays out the whole plan up
  front: `numPartitions = memPages - 1`; each partitioning level hashes with a Knuth multiplicative
  `h1`, a *different* constant per level so a partition still too big after one pass genuinely
  redistributes on the next rather than repeating the same split; a hard depth cap of 2 so a
  heavily-skewed build side (many equal keys, which no hash of the value alone can ever separate)
  still terminates instead of recursing forever. A leaf partition's build phase hashes again with
  `h2 = key mod numBuckets`, sized so two keys share a bucket on average — collisions are the point,
  not an edge case to avoid — and its probe phase reports each probe key as a genuine match, a bucket
  collision that still failed the equality check, or a clean miss. `HashJoinToolPage.tsx` renders every
  partitioning level as its own row (a dashed box split further, a solid one is a leaf ready to build
  and probe) and a selected leaf's own bucket table and match/miss list below.

  One real bug, caught by looking at the tool in the browser rather than by any of the 19 unit tests
  written first: an initial level-1 multiplier (`40503`) was itself a multiple of 3, so at the tool's
  own default parameters (`numPartitions = 3`) every key collapsed into a single partition on the very
  first split — the "spill" was a silent no-op that just recreated the parent. Fixed by picking
  multipliers confirmed coprime to 2 through 5 (every `numPartitions` this tool can reach), plus a 20th
  regression test reproducing the exact scenario. 1 new e2e test.
- **Hash join, `JOIN`'s second algorithm, and a fourth `/compare` mode naming it against
  nested-loop** (plan.md §22.2) — `Join.algorithm` widens from the single `'nested-loop'` value to
  `'nested-loop' | 'hash'`. The new `hashJoin` operator (`exec/operators.ts`) drains the right side
  once into a plain `Map`, keyed by a new `equalityKeyOf(rightColumn)` helper (`exec/evaluate.ts`) —
  a NULL key is never inserted, the same "NULL never matches NULL" rule nested-loop's own
  `compare('=', ...)` already enforces — then streams the left side, probing the table instead of
  rescanning. `equalityKeyOf` mirrors `compare`'s exact coercion (a number and a numeric string
  collide the same way `compare('=', 5, '5')` already says `true`), so the two algorithms can never
  silently disagree on which rows match — checked directly with a mixed-type test. No partitioning
  or spill: the hash table lives entirely in memory, the same simplification `HashAggregate` already
  makes for `GROUP BY` (partition spill for a build side too large for memory is Grace hash join,
  `/tools/hash-join`'s own deferred future work).

  The cost model prices a hash join at `left.estPages + right.estPages` — each side read exactly
  once — against nested-loop's `leftPages + leftRows × rightPages`; the row estimate is identical
  either way, since the algorithm changes I/O, not cardinality. Nothing in the pipeline picks
  between them on its own: `EngineOptions.joinStrategy` (`'nested-loop'` by default, so every
  existing caller is unaffected) is the seam `/compare`'s new **Nested-loop join vs. hash join** mode
  uses to force each side explicitly and score them — trace steps, disk reads, evictions, rows
  returned — against the same small `authors`/`posts` pair `/tools/planner` already uses. That
  fixture is only 5 heap pages, which fits entirely inside the default 8 buffer frames — so the
  comparison forces `bufferFrames: 2` too, or nested-loop's repeated rescans would just hit cache
  after the first pass and the two algorithms' disk-read counts would tie despite doing genuinely
  different work. 11 new unit tests, 1 e2e.
- **`JOIN`, v1's first join algorithm** (plan.md §22.2) — `FROM t1 JOIN t2 ON t1.a = t2.b`: an
  implicit inner join (bare `JOIN`, no `LEFT`/`RIGHT`/`FULL`/`CROSS`/`INNER`/`OUTER`/`USING` yet,
  each still rejected by name), exactly one per query, computed by nested-loop — the only algorithm
  v1 has. The real new grammar surface is a qualified `table.column` reference: `Expr`'s and
  `SelectItem`'s `column` variant gained an optional `table`, required on *every* column reference
  once a query joins two tables (there is no ambiguity resolution — v0 asks the query to say which
  table) and validated at parse time against the tables the query actually names, so a bare `id` or
  a qualifier naming a third table both fail immediately with a specific message rather than an
  execution-time surprise. A `JoinClause` AST node carries the `ON` equality, checked at parse time
  to be exactly one comparison between a qualified column on each side (`checkJoinOn`); `GROUP BY`,
  `ORDER BY` and an aggregate SELECT item all stay unsupported combined with a `JOIN` for now, each
  rejected the same way `GROUP BY`+`ORDER BY` already reject each other.

  The `Join` plan node's two children are always a bare `SeqScan` — v1 pushes no predicate into
  either side, so a `WHERE` clause is always a residual `Filter` above the join, never inside either
  scan — and its executor rescans the right side whole for every row the left produces, reusing the
  exact reset every operator's `open()` already means rather than rebuilding an operator per row.
  `ExecContext` gained `joinRight`, the first time it has ever needed to represent two tables at
  once: the right table's own heap, its pages numbered right after the left's, so both genuinely
  share one real buffer pool — the rescans' cost is counted disk activity, not a claimed number. The
  joined row is fully qualified (`table.column` for every column on both sides), so same-named
  columns from either table never collide, including under `SELECT *`. The cost model prices a
  `Join` at `left × right / ndistinct(right key)` rows and `leftPages + leftRows × rightPages` —
  nested-loop's honest, unflattering number, the same discipline every other estimate here already
  follows. `constant-folding`'s "column compared with itself" fold now also checks the table
  qualifier, so `authors.id = posts.id` across a join is never mistaken for the same column.

  Reachable today via `/tools/planner`'s two small fixed tables, `authors`/`posts`
  (`createJoinDemoDatabase`), sitting alongside `users` without touching its own index toggle — not
  yet wired into the Playground's own dataset picker (needs the multi-table schema editor, plan.md
  §22.7) or into a `/compare` mode (needs a second join algorithm to name against nested-loop
  first). 38 new unit tests, 1 e2e.
- **A sort aggregate, and a third `/compare` mode naming it against the hash aggregate**
  (plan.md §22.2) — `GROUP BY`/aggregate queries had exactly one execution strategy; this adds the
  second, so there is finally something to compare. `SortAggregate` computes the identical
  `groupBy`/`aggregates` a `HashAggregate` does, but by sorting the input on the `GROUP BY` columns
  first — `externalMergeSort` (`ORDER BY`'s own driver) is generalised from a single-column key to a
  composite tuple so both operators share it rather than duplicating the algorithm — spilling
  through the real buffer pool exactly as `Sort` does, then a single streaming pass collapses each
  run of equal keys into a group. Same output, same row count either way; the difference is entirely
  in the I/O. Nothing in the pipeline picks a strategy on its own: `EngineOptions.aggregateStrategy`
  (`'hash'` by default, so every existing caller is unaffected) is the seam `/compare`'s new
  **Hash aggregate vs. sort aggregate** mode uses to force each side explicitly and score them —
  trace steps, disk reads, pages written, evictions, groups produced — the same way its
  index-vs-sequential-scan mode forces "no index" by dropping `indexedColumn`. `constant-folding`,
  `predicate-pushdown` and `index-selection` all learned to see past *either* aggregate node
  (`unwrapAggregate`/`rewrapAggregate` now cover both `HashAggregate` and `SortAggregate`), and the
  cost model prices a `SortAggregate`'s own spill on top of `HashAggregate`'s existing group-count
  estimate. 19 new unit tests, 1 e2e
- **`/tools/grammar`, a grammar sandbox diagramming the v0 SQL subset** (plan.md §22.3) —
  `src/ui/grammar.ts` holds the grammar as data (a `GrammarPart` union: literal, rule reference,
  choice, optional, repeat), deliberately mirroring `parser.ts`'s own BNF comment line-for-line
  rather than a curved-arrow railroad diagram: a filled pill for a keyword, an outlined box for a
  reference to another rule that jumps to that rule's own row on click, a dashed bracket around
  anything optional, and a loop glyph with its separator next to anything repeated. The page is
  `GalleryPage`'s discipline applied to the grammar itself — `ui/__tests__/grammar.test.ts` checks
  the data against the *real* tokenizer and parser rather than trusting it by hand: every rule
  reference must resolve to a rule that exists, every all-caps literal must be a real keyword or a
  real aggregate function name, and one representative query per rule is run through the real
  `parseStatement`. That last check caught two genuine bugs while the data was being written —
  three missing terminal rules for `identifier`/`number`/`string`, and `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`
  not being tokenizer keywords at all (they parse as ordinary identifiers, recognised by name only
  when followed by `(`; `AGGREGATE_FNS` is now exported from `parser.ts` so the test can check
  against it too) — and along the way caught a real, pre-existing drift bug in `parser.ts`'s own
  header comment, which had gone stale missing `GROUP BY` entirely from before aggregates existed.
  21 unit tests, 1 e2e
- **`/tools/locks`, with enforced concurrency as its own driver** (plan.md §22.2, §22.3) — two named
  transactions (`T1`/`T2`) placing real `shared`/`exclusive` lock requests against four numbered
  pages, with real blocking: `src/ui/lockSimulation.ts` is a pure, total simulator, in the same
  shape as `externalSort.ts` — a conflicting request joins a real FIFO waiter queue per page
  (batching consecutive compatible `shared` waiters together, stopping at the first `exclusive`,
  the standard fairness trade-off every lock manager makes), and every request rebuilds the
  wait-for graph fresh and checks for a cycle back to itself. A cycle is a deadlock: the *youngest*
  transaction in it — the one whose first request came later — is aborted, its locks released and
  any requests it was blocking promoted wherever that now makes room. The page renders a request
  form, a per-page state grid (holders and waiters sit side by side, so the wait-for edge is
  legible without a separate graph drawing), a per-transaction "release" button on each held lock,
  a **Deadlock example** button that seeds the classic two-cycle in one click, and a narrated
  timeline coloured by what each line actually says rather than by which call produced it — a
  single deadlocked request's own narration bundles the bad news (the cycle) with the good (the
  survivor's blocked request finally granted), and painting the whole bundle one colour would get
  that backwards. The SQL pipeline's own lock manager (`engine/locks/lockManager.ts`) is untouched
  on purpose: v0 runs one query at a time, so nothing there ever contends. 24 unit tests
  (`ui/__tests__/lockSimulation.test.ts`), 1 e2e
- **Index-only scan, a fourth optimizer rule** (plan.md §22.2) — when a query's SELECT list needs
  nothing but the indexed column itself (`SELECT id FROM users WHERE id = 5`), the B+Tree leaf's
  key already *is* the answer: `index-only-scan` rewrites the `IndexScan` `index-selection` just
  produced into a new `IndexOnlyScan` node, and `emitIndexLookup` gained a `touchHeap` parameter
  (default `true` — every existing caller unchanged) that, passed `false`, skips the heap page's
  fetch and lock entirely. This is a real, measured discount, not a claimed one: on the seed data
  it is 3 disk reads (the B+Tree's own height) instead of the 4 an ordinary index lookup takes (the
  same 3, plus the heap page). The cost model prices it accordingly. Deliberately narrow: no
  residual conjunct allowed (a recheck needs the row the scan never fetches), and no `Sort`/
  `HashAggregate` in between (an index-only result is always exactly one row, so there is nothing
  yet worth the extra cases). True composite (multi-column) indexes, and a second candidate index
  for the optimizer to choose between, stay open — v0 tables still have exactly one index. 13 unit
  tests (`__tests__/indexOnlyScan.test.ts`), plus new planner and cost-model coverage, 1 e2e
- **Aggregates and `GROUP BY`, with a hash aggregate** (plan.md §22.2) — `COUNT`/`SUM`/`AVG`/`MIN`/
  `MAX` in the SELECT list, and `GROUP BY` on one or more columns, are real. A `SelectItem` union
  (a plain column, or an aggregate call like `COUNT(*)`/`SUM(age)`) replaces the old flat
  column-name list; standard SQL's grouping rule is enforced at parse time — a plain column in the
  SELECT list must be one you group by, or wrapped in an aggregate, whether or not `GROUP BY` is
  written at all. A `HashAggregate` plan node sits between `Filter` and `Project`, computed by an
  operator that — like `Sort` — cannot stream: a group is not known to be complete until the whole
  input has been seen, so it builds one hash-table bucket per distinct `GROUP BY` combination (a
  single bucket, with no `GROUP BY`, over the whole input) on its first pull, then streams the
  finished groups. `constant-folding`/`predicate-pushdown`/`index-selection` all learned to see past
  a `HashAggregate` the same way they already see past `Sort`/`Limit` — `WHERE` always applies
  before aggregation in SQL, so pushing a predicate underneath one is never a shortcut — and the
  cost model gained a group-count estimate (the product of each `GROUP BY` column's distinct-value
  count, capped at the input, the same independence assumption an `AND`'s selectivity already
  makes). `ORDER BY` combined with `GROUP BY` is not supported yet, rejected with a clear hint;
  `LIMIT` still works. One strategy only — a sort aggregate and the `/compare` mode plan.md names as
  the actual point of the pair are the next milestone. 25 unit tests (`__tests__/aggregate.test.ts`),
  plus new parser, planner and cost-model coverage, 1 e2e
- **`constant-folding`, a third optimizer rule** (plan.md §22.2) — a comparison whose truth value
  never depends on the row folds to a boolean at optimize time: two literals (`5 > 3`), or a column
  compared with itself (`age = age`, the `col = col` case). An always-true conjunct drops out of the
  predicate (`X AND true` is just `X`), narrated per clause and, when nothing is left, removing the
  `Filter` entirely. Deliberately does not act on an always-false conjunct — v0's plan shape has no
  node for "this scan returns no rows" without inventing one, so a `1 = 2`-shaped clause is left
  exactly as written; the query still returns the right answer either way, just without the
  optimization. Runs first, ahead of `predicate-pushdown`, so a folded predicate is what the later
  rules and the cost model see — folding away a redundant `1 = 1` also sharpens the estimate, since
  the cost model no longer has to guess at a clause that was never real. Reused automatically by
  `DELETE`/`UPDATE`, which share `optimize()` with `SELECT`. `NULL = NULL` is UNKNOWN, not `TRUE`,
  and correctly does not fold — SQL's three-valued logic, preserved. `projection pushdown` and
  `OR`→`IN` stay out of scope: the former has no real I/O to save in v0's row-oriented heap, the
  latter needs `OR` in the grammar first. 8 unit tests (`optimize — constant folding` in
  `__tests__/planner.test.ts`), 1 e2e
- **`UPDATE`, the write path's third and last statement** (plan.md §22.2) — `UPDATE table SET col =
  value [, col = value ...] [WHERE ...]` changes rows for real, completing the write path
  (`INSERT`/`UPDATE`/`DELETE` are now all real in the pipeline, not just `/tools/btree`).
  `parseStatement` grows a fourth grammar, reusing `INSERT`'s literal-value parser for the right
  side of each assignment. Execution finds its matches exactly the way `DELETE` does — a dedicated
  find-then-mutate pass, since an update mid-scan could shift what a later step reads — reusing
  `predicate-pushdown`/`index-selection` through the same throwaway-`Project` trick, and applies the
  SET assignments to produce each row's replacement. This is the hardest of the three statements for
  one reason: when the assignments touch the *indexed* column, the B+Tree has no in-place rekey, so
  `exec/update.ts` runs the real `deleteKey` and `insert` algorithms in sequence — drop the old key,
  add the new one at the row's existing heap pointer — narrated as one clause per half
  ("Because `id` changed, the B+Tree drops key 5 ..., then adds key 9000 ..."). An assignment that
  leaves the indexed column unchanged, or reassigns it to the value it already had, touches the tree
  not at all. 24 unit tests (`__tests__/update.test.ts`), plus new `parseStatement`/
  `updateDisplayTree` coverage in `__tests__/parser.test.ts`, 1 e2e (the rekey case)
- **`INSERT`, the write path's second statement** (plan.md §22.2) — `INSERT INTO table [(col, ...)]
  VALUES (value, ...)` adds a row for real, persisted in the Playground the same way `DELETE`
  already persists a removal. `parseStatement` grows a third grammar: an optional column list
  (omitted means every column, in table order, same as standard SQL) and a `VALUES` list of
  literals only — v0 has no expressions or subqueries in an INSERT — sharing the
  parenthesised-list parsing and error handling between the two lists. The new row lands on the
  last heap page if it has room, or a fresh one otherwise (`BufferPool.write()`, the same
  fresh-page path `Sort`'s spill already uses), and if the table is indexed, its key goes into the
  B+Tree through the actual `insert` algorithm — real leaf/internal splits, narrated by comparing
  the tree's node count and height before and after, the same technique `/tools/btree`'s own
  insert narration already used. An `INSERT` with only literal values has no predicate and nothing
  to scan, so — unlike `SELECT` and `DELETE` — it skips the Planner and Optimizer stages entirely
  and goes straight from parse to execute; the pipeline tracker shows this honestly rather than
  inventing a trivial plan with nothing in it. 20 unit tests (`__tests__/insert.test.ts`), plus new
  `parseStatement`/`insertDisplayTree` coverage in `__tests__/parser.test.ts`, 1 e2e
- **`DELETE`, the write path's first statement** (plan.md §22.2) — `DELETE FROM table [WHERE ...]`
  removes rows for real, persisted in the Playground the same way the seed-data editor already
  persists an edit. A new parser entry point, `parseStatement`, dispatches to `SELECT` or `DELETE`
  through a shared `Cursor` abstraction (`parse` stays `SELECT`-only for its existing callers).
  Execution is a dedicated find-then-mutate pass (`exec/delete.ts`), not a reused Volcano
  operator — a delete has to find every match before it mutates anything, since removing mid-scan
  could shift what a later step reads — but it narrates through the same `execute`-stage shape
  (`SeqScan`/`IndexScan`, then `Delete`) so the Execute panel reads the same way a `SELECT`'s does.
  It takes real exclusive locks on the heap pages it touches, and removes each row's key from the
  B+Tree with the actual `deleteKey` algorithm — real borrows, merges, and root-collapses, narrated.
  `predicate-pushdown`/`index-selection` are reused unchanged, by wrapping the delete's scan in a
  throwaway `Project *` for optimization and unwrapping it again for both execution and display.
  `BufferPool` gained `markDirty()`: a page a `DELETE` removed a row from now costs a write back to
  disk on eviction, not just a discard — completing the read/write pair `Sort`'s `write()` started,
  shown in the Buffer Pool panel's `writes` stat and the eviction narration ("Page N is dirty — a
  row was deleted from it — so evicting it costs a write back to disk first"). 25 unit tests
  (`__tests__/delete.test.ts`), 1 e2e
- **`ORDER BY` with a real external-merge-sort `Sort` operator** (plan.md §22.2, completing
  `ORDER BY`/`LIMIT` + external sort) — the run-generation-then-merge algorithm already worked out
  for `/tools/sort` (`src/ui/externalSort.ts`), now over real table rows and, unlike that sandbox,
  with every page it writes or re-reads flowing through the *actual* buffer pool: `BufferPool` gained
  a `write()` path alongside `fetch()`, so a Sort's spill pages compete for the same frames a heap
  scan uses — real evictions of heap pages by spill pages and back, shown in the Buffer Pool panel as
  a new violet "✎ written" mood and a `writes` stat. Page ids are never reused (`sortTempPageCount`
  reserves a fresh block per pass before the pool exists, sized generously above the
  perfectly-packed count — a bound it can defend, not a precise figure it can't, per §12).
  `predicate-pushdown`/`index-selection` see past a `Sort` exactly as they already saw past a
  `Limit`. Sort is the one operator here that cannot stream — combined with `LIMIT` it caps the
  *output*, not the scan, and the narration says so. `exec/sort.ts`, pure and unit-tested; NULLs
  sort last ascending / first descending, Postgres's own default
- **`LIMIT`** (plan.md §22.2, first half of the same backlog item) — a real `Limit`
  plan node and Volcano operator: it stops pulling from the operator tree beneath it once the cap
  is reached and closes it, so `SELECT * FROM users LIMIT 1` genuinely never reads the rest of the
  table — fewer buffer `load` events than the unbounded scan, not just a shorter result. The
  optimizer's `predicate-pushdown` and `index-selection` rules see past an outer `LIMIT`
  transparently, the cost model estimates `min(child, LIMIT n)`, and the AST/plan trees and the
  Parser/Planner/Optimizer panels all show it as a real node
- **In-app EXPLAIN** (plan.md §22.2) — a **Copy as EXPLAIN** button next to Copy as text/Mermaid,
  offered once a query has actually run (the result stage — `EXPLAIN ANALYZE` needs an execution,
  same as Postgres). Prints the final plan tree with the cost model's `est ~N rows` next to the
  `actual N rows` each operator really produced, e.g. `IndexScan users.id  key: id = 5  ·  est ~1
  rows  ·  actual 1 rows`. Pure (`explainToText` in `src/export/toText.ts`), reusing `ViewState`'s
  existing per-operator counts — no new engine surface
- **Cost-based optimizer** (plan.md §7.3, §22.2) — the first engine item off the now-lifted §9 gate
  (see §9's v14 note). Every plan and optimize node carries a `~N rows` estimate and the heuristic
  behind it — an equality is `1 / ndistinct`, an open range is linear over the column's min–max, an
  `AND` multiplies its parts and assumes independence — rendered on the Playground panels and in
  `/tools/planner`. The optimizer's rules still fire without consulting the numbers; the numbers
  *justify* the rewrite: the index-selection narration now reads "the sequential scan reads all 12
  pages to return about 1 row; the index lookup reads about 4", and the result narration reconciles
  the guess against the exact count ("the cost model guessed ~37 … the estimate is a heuristic").
  `src/engine/planner/cost.ts`, pure and unit-tested (`src/engine/__tests__/cost.test.ts`)
- **Three more `/challenges` puzzles** (plan.md §22.4) — *push the filter down* (get predicate
  pushdown to fire without an index lookup), *a lookup on the big table* (an `IndexScan` on the
  120-row `orders`, a level deeper than `users`), and *the selective end of a skew* (a `logins` scan
  returning fewer than 20 rows). A challenge can now target a preset dataset; its check runs there
  and the "step through in the Playground" link carries `t=`
- **`querylens` command-line trace** (plan.md §22.8) — `bin/querylens.ts` runs a query through the
  engine and prints the stage-by-stage trace, or `--json` for scripting. Flags: `--policy`,
  `--dataset` (`users` / `orders` / `logins`), `--no-color` (also honours `NO_COLOR` and a non-TTY
  stream); exit codes 0 / 1 (query error) / 2 (usage). `pnpm querylens` and `pnpm trace` both run it.
  Not yet on npm — `npx querylens` awaits a publish
- **Planner sandbox** at `/tools/planner` (plan.md §22.3) — type a query and see its plan tree,
  canonical next to optimized. Toggle each rewrite rule (predicate pushdown, index selection) and
  the `id` index on or off; a ledger says for each rule whether it fired, found no match, or was
  switched off — so the rule ordering is visible (index selection needs pushdown to have run first).
  `optimize()` gained an optional enabled-rules set
- **Print to a paper worksheet** (plan.md §22.6) — a **Print** link on the Playground (and Ctrl-P)
  lays the current query and its whole trace out as a numbered worksheet: the SQL, the run's
  settings, and every step's narration with the predict-then-reveal steps marked. The `@media print`
  hook now also covers the `/trace` transcript and docs pages, so Ctrl-P on a docs page prints the
  article instead of a blank sheet
- **External merge sort sandbox** at `/tools/sort` (plan.md §22.3) — sort more records than fit in
  memory: run generation makes short sorted runs, then `(buffer pages − 1)`-way merge passes fold
  them into one, with the page-I/O cost (`2 × pages × passes`) broken out. Change the buffer budget
  and watch a whole pass drop. Click any merged run to colour its records by which run each came
  from and light up the runs that fed it. Its own driver (`src/ui/externalSort.ts`) — the engine has
  no `Sort` operator yet
- **Preset dataset library** (plan.md §22.7) — a **Data** chip row above the editor loads `users`
  (the 48-row baseline), `orders` (120 rows — a deeper B+Tree and a scan that evicts far harder), or
  `logins` (an 8:1 skew on `status`, so the same `=` predicate returns 9 rows or 71). Each carries
  its own starter query and preset query chips. The choice rides in the share link as `t=` and in a
  downloaded trace file's `dataset` field (both omitted for the default), and `/trace` reads `t` too
- **The 60-second tour** (plan.md §19.2) — five sequential spotlights over the real Playground
  (editor, pipeline rail, stage panel, narration, transport), not a video or a modal carousel. Skip
  or `Esc` at any point, `←/→` to walk it. It never auto-starts: it opens from the first-visit
  hint's **Take the 60-second tour** link, a **Tour** link by *Present*, or `?tour=1`. Under
  `prefers-reduced-motion` it degrades to a static numbered overlay — the five captions as a list,
  no stepping, no moving spotlight
- **Panel "what am I looking at?" affordance** (plan.md §19.2) — a small `?` next to each stage's
  title in the Playground opens a two-sentence explanation of what that panel shows and a link to
  the concept page (`/stages/:id`, or `/docs/concepts/*` for the buffer pool and the B+Tree). The
  same per-stage text now feeds the `/stages` index, replacing a near-duplicate copy that lived there
- **First-visit hint** (plan.md §19.2) — one quiet line under the header, shown once to a cold
  visitor at the app's own front door (`/playground` with nothing in the URL; a shared-moment link
  carries its own context). It points at the keyboard route into the trace — `Space` to play, the
  arrows to step — retires itself on mount so a reload never brings it back, and has a Dismiss button
  for mid-session. Touch devices get a pointer-appropriate line
- **Preset query chips** above the Playground editor (plan.md §19.2) — *Point lookup*, *Sequential
  scan*, *Lookup, no index*. One click loads and runs, so a first visitor isn't asked to invent SQL.
  The third is a `col = value` equality on a **non-indexed** column — the same shape as the point
  lookup, but the planner can't turn it into a B+Tree lookup, which is the contrast the tool exists
  to show
- **Challenge mode** at `/challenges` (plan.md §22.4) — five goal-shaped puzzles: *make the planner
  use the index*, *force an eviction*, *return exactly one row*, *empty result but real work*, *two
  conditions that still match*. Each has a small editor whose Run result is checked against a pure
  predicate — rows / disk reads / evictions / index-used are shown, with a pass/fail verdict and a
  link to step the run in the Playground. Solved marks kept per-browser; no backend
- **Assignment sets** (plan.md §22.4) — `/assignments/new` can now bundle several links: give each a
  label, *Add to set*, and the panel below emits a numbered Markdown worksheet (paste into an LMS or
  print) and a JSON file, both stamped with a class code. Still no submission and no backend — the
  worksheet *is* the hand-out
- **Import CSV** in the seed-data editor (plan.md §22.7) — paste a block of `id,name,email,age`
  rows instead of typing them. A small quote-aware reader (`src/ui/parseCsv.ts`), bounded to 500
  rows and per-column type-checked; an optional header row is skipped, and a malformed block is
  rejected whole with a reason rather than half-imported — the same "untrusted input" discipline the
  shareable URL follows
- **Progress dashboard** at `/progress` (plan.md §22.4) — a returning-visitor page: lessons marked
  complete, which pipeline stages you have seen in a trace, and your prediction record (right / total,
  hit rate). All read from `localStorage` and all degrade to a "nothing tracked yet" empty state; a
  Clear button wipes it. The Playground records stages and prediction outcomes as you go
- **Presenter mode** (plan.md §22.5, §17.2) — a **Present** button on the Playground (or `?present=1`)
  opens a full-viewport view of the current stage for a lecture hall: the diagram large, the narration
  at heading size, keyboard-driven (Space, ←/→, Esc), with an optional real full-screen toggle.
  Prediction prompts are suppressed while it is open — a "commit before the reveal" card stops a room
  rather than helps it. It is a `role="dialog"` overlay over the same live playback, axe-checked
- **Slotted page inspector** at `/tools/page` (plan.md §22.3) — one heap page of `users` laid out to
  the byte: a fixed header, a line-pointer array, tuples packed from the far end of the page backward,
  and the free space between. A page-size slider makes "rows per page" concrete — four toy rows fill
  about 5% of a 4 KB page, and roughly 87 more would fit. `src/ui/slottedPage.ts` synthesises the
  layout (the engine models a page as just a list of rows, §7); pure and unit-tested. A tuple in the
  map cross-highlights its row in the per-tuple byte table
- **Colour-independent shape cues** (plan.md §22.6, §8) — internal vs leaf B+Tree nodes now carry a
  filled disc / hollow ring glyph before the label, and the buffer-pool moods and stat counts carry
  `✓ / ↓ / ✕ / ↻`, so hit/miss/evict and internal/leaf read without relying on hue — for colour-vision
  deficiency and washed-out projectors. Always on, not a toggle
- **`/trace` transcript view** (plan.md §22.6) — beside the JSON-shaped table, a **Transcript**: a
  numbered list of every step's narration, each line a link into the Playground at that step. A
  **Print** button and an `@media print` rule turn it into a paper worksheet — the one thing in the
  app that prints. `v=transcript` in the URL opens straight to it; it doubles as the §9 study's
  control-group artefact (read the steps rather than step them)
- **Five more `/learn` lessons** (plan.md §22.4, §17.2) — the guided track goes from four to nine:
  *Watch a B+Tree split* (in the `/tools/btree` sandbox — a full leaf, one more key, copy-up then
  push-up), *Edit the seed data* (what the trace changes and what it does not), *Predict before you
  look* (prediction mode and the evidence behind it), *Share a moment* (what the URL encodes, and
  why a bad one drops the dataset whole), and *When something goes wrong* (the panel error boundary
  and its self-writing repro). Each Playground link is still computed from a real engine run
- **Screen-reader narration track** (plan.md §22.6, §8) — the Playground's narration line is now a
  permanently-mounted polite live region, so a screen-reader user stepping the trace hears every event:
  the step position, the narration the event already carries, and — on a gated step, where the
  prediction card previously replaced the narration and silenced it — the question, its options, and
  the verdict. Wording is a pure, unit-tested `src/ui/stepAnnouncement.ts`
- **Download trace / Load trace** (plan.md §22.5) — beside *Copy link to this step*, save the current
  Playground moment as a small JSON file and restore it later. It is the shareable-URL state as a file
  — `sql`, `policy`, `predictOn`, `step`, edited `rows`, plus a build stamp — for a dataset too big for
  a URL, or a bug report that wants the seed data attached. No event stream in the file (the engine
  re-derives it deterministically; use `/trace`'s *Copy JSON* for a frozen one), and it is parsed with
  the same defensiveness as the URL: a missing, out-of-range or schema-mismatched field fails the whole
  load. `src/ui/traceFile.ts`, unit-tested
- **Copy as text** (plan.md §22.5) — a third panel-header action beside Copy as Mermaid and Download
  PNG: the AST, the plan, or the **B+Tree** as a `tree(1)`-style indented list in a bare ` ``` `
  fence, for a review comment or an email. Pure, unit-tested conversion in `src/export/toText.ts`;
  unlike Mermaid it covers the B+Tree, because a fixed-width tree renders a sibling chain fine. The
  clipboard button is now one shared `CopyButton` (was `CopyMermaidButton`)
- **`pnpm record`** (plan.md §20.3, §20.8) — `scripts/record.ts` drives the *built* app in a real
  browser, frame-steps a shareable link over a `--from`/`--to` range, and muxes the result to a GIF
  and a WebM with the shipped fonts and `oklch` colours — the completion of M12 and the moving-picture
  half of the §18.2 launch material. It captures the same live panel DOM the **Download PNG** button
  does, so there is no second renderer to drift (the still-frame sibling of `scripts/build-og.ts`).
  The WebM uses whatever ffmpeg is found, falling back to the copy Playwright bundles (VP8); the GIF's
  `palettegen`/`paletteuse` needs a full ffmpeg, and without one the script still writes the WebM plus
  the numbered frames and prints the two commands to finish the GIF. Not an in-app button, by §20.3
- **Download PNG** (plan.md §20.3, §20.8) — a button on every stage's panel that saves it as an
  image with the app's real typeface and `oklch` colours baked in. `html-to-image` is loaded only
  on the first export, so it never affects page load. Verified in Chromium; may fall back to sRGB
  in Safari (a known `foreignObject`-to-canvas bug), which the FAQ notes
- **Copy as Mermaid** (plan.md §20.3, §20.8) — a button on the AST and plan panels (in the
  Playground and the stage explainers) that copies the tree as a Mermaid `flowchart` in a fenced
  code block, ready to paste into a pull request or a doc. Pure, unit-tested conversion in
  `src/export/toMermaid.ts`; the B+Tree is deliberately excluded (Mermaid draws its sibling chain
  badly)
- **Guided path** at `/learn` (plan.md §17.2, §21.3) — four short, ordered lessons (run your first
  query; follow one row from disk to result; watch a page get evicted; make the planner change its
  mind). Each lesson's steps deep-link into the Playground at the exact point they describe — the
  step number computed from a real engine run, so a lesson can't drift out of sync — and each ends
  with one variable to change and re-run. Completion is marked per-browser in `localStorage`
- **Midpoint-LRU buffer policy** (plan.md §7.5) — InnoDB's midpoint-insertion LRU as a sixth
  replacement policy in the buffer-pool sandbox and Compare: a page read from disk enters an "old"
  sublist and only reaches the "young" one when it is read again, so a one-pass sequential scan
  evicts only its own pages and never the hot set — the failure plain LRU has that this fixes
- **`/compare` — index vs. sequential scan** (plan.md §13) — a second mode alongside the
  replacement-policy comparison: the same query run once with the `id` index and once with it
  removed, scored side by side (trace steps, disk reads, evictions, B+Tree node reads, locks, rows).
  Same rows out, very different work — and a query that cannot use the index says so
- **Assignment reveal-lock** (plan.md §20.5) — `/assignments/new` can now lock the reveal: the
  generated link (`&l=1`) opens the Playground with prediction forced on, the prompt's "skip"
  removed, and the playhead — scrubber included — unable to cross an unanswered prediction. It lifts
  one prompt at a time as the learner commits. The author is warned when the chosen step has no
  prompt for the lock to catch on
- **Trace inspector** at `/trace` (plan.md §21.3) — the raw event stream `runQuery` produces for a
  query, as a filterable table (per-stage toggles, a narration text filter), with each event's full
  JSON on click and a Copy-JSON of the filtered set. Runs the same engine path the Playground does;
  every row links into the Playground at that step. Reads the Playground's own `q`/`p`/`d` link keys
- **B+Tree sandbox** at `/tools/btree` (plan.md §20.4, §21.3) — insert, delete and find keys against
  a live B+Tree, with a fan-out slider and the structural invariants re-checked and shown after
  every edit. Building it required **B+Tree deletion** in the engine (`deleteKey`): leaf and
  internal underflow handled by borrowing from a sibling or merging, root-collapse, and a separator
  rewrite up the descent path so every internal key stays a real leaf key. Covered by property
  tests that assert the tree stays sound after every operation against a set oracle (plan.md §7.6)
- **Parser sandbox** at `/tools/parser` (plan.md §20.4, §21.3) — type any SQL, supported or not, and
  see the tokenizer's stream as a colour-coded ribbon and the recursive-descent parser's AST built
  live, with a recursion-depth readout and the parser's own tokenize/parse error messages. No engine
  change: the AST view is the Playground's, driven straight from `toDisplayTree`
- **Three more buffer-pool replacement policies** — FIFO, second-chance and optimal (Bélády's MIN) —
  selectable in the buffer-pool sandbox and on both sides of `/compare`. They sit behind the existing
  `ReplacementPolicy` interface; `optimal` reads the whole page-reference string as lookahead and
  degrades to FIFO where there is none (the SQL pipeline). The Playground, shareable links and
  `/settings` still offer only LRU and clock sweep, so the pipeline's teaching contrast is unchanged
- `/compare` now pits any two of the five policies against each other, rather than being fixed on
  LRU vs. clock sweep
- **Documentation site** at `/docs`, built with Astro Starlight (plan.md §17.1) — sidebar
  navigation, on-this-page outline, full-text search, and the app's own fonts, colours and
  dark/light toggle. Nine pages: what QueryLens is, Getting started, FAQ, Concepts (buffer pool,
  B+Tree), and Reference (supported SQL, keyboard shortcuts, URL parameters, engine limits). Every
  factual claim in them — step numbers, error message text, engine limits — is checked against
  `src/` rather than written from memory, and the Concepts pages link back into the running app at
  the exact step they describe, verified live rather than assumed. Built by its own isolated
  package (`docs/`) with its own lockfile, so the application's dependency tree is never
  re-resolved by documentation work; `pnpm build:site` builds both, and CI now builds the docs as
  their own step so a broken page fails the same gate a broken app build would
- Self-hosted typefaces: JetBrains Mono and IBM Plex Sans (as `QueryLens Sans`), subset to the 235
  codepoints the app renders, ~30 kB each, preloaded and served under the existing `font-src 'self'`
  CSP. Previously the CSS named a font that was never shipped, so it appeared only for visitors who
  happened to have it installed
- Adjusted fallback faces with measured `ascent-override` / `descent-override` / `size-adjust`, so
  `font-display: swap` costs no layout shift
- Named type scale — six steps, one documented role each, with a display size that gives the scale a
  top. Tailwind's own scale is cleared, so every size in `src/` names its job
- Named motion scale — three durations, three curves — reachable from JavaScript via
  `src/ui/motion.ts`, and collapsing to zero under `prefers-reduced-motion`
- Hover and active states on every diagram element: buffer-pool frames, B+Tree/AST/plan nodes, lock
  rows, result rows and pipeline chips. Eight panels previously had one hover rule between them
- A real footer: Docs · GitHub · Licence · Changelog, and the build SHA, so bug reports identify
  their own build
- `apple-touch-icon.png`, generated from `favicon.svg`
- Scroll-snap between sections on phones
- Tabular figures on every number that changes during playback
- `scripts/build-fonts.py`, `scripts/build-icons.py` and `pnpm og` — the fonts, icons and link-preview
  card are all regenerated from source rather than hand-maintained
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` — open-source governance files
- `CHANGELOG.md` — this file
- `NOTICE` — third-party licence attribution, now also covering the two bundled fonts
- GitHub issue templates and pull request template
- §16 (Visual Design Maturity), §17 (Documentation & User Manual), §18 (Community & Governance) and
  §19 (The Landing Page) added to `plan.md`

### Changed
- **The AST, plan and B+Tree trees render through flowinger, our own graph renderer
  (`flowinger` on npm), instead of `@xyflow/react`.** It keeps
  React Flow's API shape — `ReactFlow`, `Handle`, `Background`, `useReactFlow`, `useStore` — and its
  `react-flow__*` class names, so `FlowTree` changed by imports alone and `index.css` and the e2e
  selectors needed nothing. Measured against the React Flow build: the `flow` chunk falls 60.5 → 14.0 kB
  gzip and the total 422.2 → 373.9 kB (against a 424 kB budget, so about 50 kB of headroom instead of
  1.8); CSS 16.8 → 14.3 kB; typecheck, lint and all 1170 unit tests are unchanged, and the e2e suite
  passes 79 / 79 on both builds. On the parse tree and the B+Tree the viewport transform and every node
  rectangle are identical, and edge endpoints agree to within 0.2 units.
  Three things behave differently, and two of them are improvements:
  - **Tree nodes now receive pointer events.** React Flow sets `pointer-events: none` on nodes that are
    neither draggable nor selectable, so the hover styling `FlowTree` documents (and the `title`
    tooltip on a node's row estimate) never fired; it does now.
  - **Nodes are no longer focusable.** React Flow left a `tabindex`, a `role`, an `aria-roledescription`
    and an assertive live region on inert nodes (five no-op tab stops in the parse-tree pane, even
    with `elementsSelectable={false}`); flowinger adds none unless a canvas opts in.
  - **The "React Flow" attribution badge is gone** with the dependency.
  (While it was a git dependency, `pnpm-workspace.yaml`'s `allowBuilds` was not empty: a git-hosted package
  ships no `dist/`, so flowinger's `prepare` script had to build one. Publishing removed that — see below.)
  The pin has since moved to flowinger `0c74b6a`, which adds the React Flow features it lacked
  (controlled flows, edge selection, delete, box selection, sub-flows, culling and more). `FlowTree` uses
  none of them and is unchanged, but they lived in the canvas and its store: the `flow` chunk was 21.7 kB
  gzip (from 14.0) and the total 380.7 kB (from 373.9). Typecheck, all 1170 unit tests and 79 / 79 e2e
  are unchanged.
  It now pins `d132971`, where the canvas is a small core plus opt-in features: `FlowTree` imports
  `FlowingerCore` and `FlowingerProvider` (its only change) and names no feature, since it shows and pans
  a tree and nothing more. The `flow` chunk is **18.2 kB** gzip — 24.0 with the same features carried in
  the canvas — and the total 377.2 kB; the flow budget is 25 → 20. Typecheck, lint, all 1170 unit tests
  and 79 / 79 e2e are unchanged.
  The dependency is now the published package, **`flowinger@0.1.0` from npm** (built from flowinger
  `68bbe79`, where selecting is a feature too), not a git pin. `pnpm-workspace.yaml` is byte-identical to
  `main`'s — `allowBuilds: []`, nothing exempt from `minimumReleaseAge` — and a fresh
  `pnpm install --frozen-lockfile` needs neither. (Resolving a release under a week old needs a one-off
  `minimumReleaseAgeExclude`; once the lockfile holds the resolution it is not needed, so it is not committed.)
  The `flow` chunk is 18.0 kB gzip, the total 377.0 kB; typecheck, lint, all 1170 unit tests and 79 / 79 e2e
  are unchanged.
  Bumped again to **`flowinger@0.2.0`** — mouse events on nodes/edges/the pane, `defaultViewport` and
  `onMove*`, edge label styling and `interactionWidth`, and more of `NodeProps` (`dragging`, `width`,
  `height`, `parentId`…), none of which `FlowTree` uses. The `flow` chunk is 18.9 kB gzip, the total
  378.0 kB (budget still 20 / 424); typecheck, lint, all 1170 unit tests and 79 / 79 e2e are unchanged.
  **The trial branch merged into `main`** (PR #6) at this point — the swap above is no longer a trial.
  Bumped again to **`flowinger@0.3.0`** — `getInternalNode`, `useInternalNode`, `useStoreApi`,
  `ariaLabel`/`ariaRole`/`domAttributes` on nodes and edges, none of which `FlowTree` uses either. The
  `flow` chunk is 19.0 kB gzip, the total 378.1 kB; typecheck, lint, all 1170 unit tests and 79 / 79 e2e
  (Playwright's own chromium, not the installed-Chrome workaround the trial branch needed) are unchanged.
- **`README.md` restructured** (plan.md §18.4) from 682 lines of decision log down to 82 lines of
  badges, a three-sentence pitch, status, commands, deploying and testing — a front door, not an
  architecture reference. The removed content isn't lost: `plan.md` already narrates every one of
  those decisions in more detail and kept current, and the new [Architecture](src/pages/DocsContent/architecture.mdx)
  docs page covers the engine internals a contributor would actually look for.
- **Two Reference docs pages rewritten for accuracy** — [Supported SQL](src/pages/DocsContent/reference/sql.mdx)
  and [Engine limits](src/pages/DocsContent/reference/limits.mdx) still described the engine's
  original v0 scope (no `JOIN`, no `GROUP BY`, no writes, `<=`/`>=` rejected, one index, "no cost
  estimation") years after all of that shipped. Found while restructuring the README, since the
  same "describes v0, not what actually runs" problem turned out not to be limited to the README
  itself
- Raised the app's type floor: body 14→15px, label 12→13px, code 13→14px, heading 17→20px, display
  24→28px. The 11px `micro` step is retired; 13px is now the smallest text anywhere in the app.
  §16.1's instrument density is otherwise unchanged — verified against the densest panels (the
  eight-frame buffer grid, the compact B+Tree) where nothing overflows
- Tagline is now "Watch a SQL query become a B+Tree traversal." — concrete enough that reading the
  first screen tells you what the tool does
- Corner radius is constant (4px chrome, 2px inside diagrams) and the phone's sticky playback bar no
  longer uses `backdrop-blur`, per the design constraints in `plan.md` §16.1
- Every control now shows a pointer cursor. A `<button>` takes `cursor: default` from the user agent,
  so the cursor had been telling the user nothing
- The link-preview card is regenerated from a real trace at the first buffer eviction; its alt text
  said "four frames" through a change that made it eight
- The header's development-progress badge ("8/8 stages built") is replaced with a Docs link; the
  footer's Docs link now points at the real site instead of the README
- Grandfathered seven dependencies that were pinned inside the project's own 7-day
  `minimumReleaseAge` window before that policy could ever check them — invisible until now because
  CI only ever runs `--frozen-lockfile`, which does not re-resolve. See
  `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` for the list and the reasoning

### Removed
- The `@xyflow/react` dependency and its 19 transitive packages, its stylesheet import, and the dead
  `.react-flow__renderer` / `__pane` / `__attribution` overrides in `index.css`.
- Release-planning vocabulary from the shipped UI: the `M1`–`M6` milestone codes stageMeta used to
  print ("Arrives in M4") were a sentence about the backlog, not about databases, and unreadable to
  anyone outside the repository. The not-implemented guard they lived in stays — every stage is
  built today, but `STAGES`/`IMPLEMENTED_STAGES` remain separate lists on purpose

### Fixed
- **`og:url`/`og:image`/canonical pointed at a domain that has never resolved.**
  `vite.config.ts`'s `SITE_URL` fell back to `CF_PAGES_URL`, then a hardcoded
  `https://query-lens.pages.dev` — both wrong once the project turned out to run on the unified
  Workers-with-static-assets engine (previous entry) rather than classic Pages: Cloudflare sets no
  `CF_PAGES_URL`-equivalent for a Workers Builds deploy, and the hardcoded guess had never actually
  been checked against DNS — `query-lens.pages.dev` does not resolve at all. Every social/canonical
  tag silently pointed at a dead domain until the real deployed URL
  (`query-lens.1234naveenboddepalli.workers.dev`) was checked by hand post-deploy. The hardcoded
  fallback now names that real, live URL instead of a placeholder; `VITE_SITE_URL` remains the
  override for a future custom domain. Verified live: `og:url`/`og:image`/canonical now resolve,
  `og.png` serves correctly, and securityheaders.com's real scan of the live deploy reports **A+**
- **The deploy step itself now clears Cloudflare's `_redirects` validator.** Once the build/install
  side was working (previous entry), the deploy failed differently: "Invalid _redirects
  configuration: Line 18: Infinite loop detected in this rule. This would cause a redirect to
  strip '.html' or '/index' and end up triggering this rule again." `public/_redirects`' SPA
  rewrite (`/*  /index.html  200`) and the platform's own automatic `.html`/`index` URL
  normalization formed a genuine cycle — confirmed real, since the deploy's own API calls
  (`/accounts/.../workers/scripts/query-lens/...`) show this project already runs on the newer
  unified Workers-with-static-assets engine, not classic Pages, and that engine validates
  `_redirects` against its own URL-handling rules rather than treating it as an opaque legacy file.
  Added `wrangler.jsonc` (`name: "query-lens"`, matching the existing script so this updates the
  same deployment rather than creating a new one; no `main`, since this project has no Worker code
  of its own) with `assets.not_found_handling: "single-page-application"` — Cloudflare's current
  documented replacement for exactly this pattern, scoped to navigation requests only rather than
  every unmatched path, which does not hit the cycle. `_redirects`' rule is gone, its comment
  redirected to explain where the behavior moved; `404.html` keeps its prior last-resort role
  unchanged.
- **The first real Cloudflare Pages deploy failed** with nothing more specific than "error occurred
  while running deploy command." Cloudflare's build step injects `wrangler` as a devDependency to
  actually publish `dist/` — this project has no Worker code of its own; wrangler is just the
  mechanism the newer unified Workers/Pages platform uses to serve `public/_headers`, `_redirects`
  and `404.html` — and wrangler pulls in `esbuild` and `workerd`, both of which need their
  postinstall scripts to fetch native binaries. `pnpm-workspace.yaml`'s `allowBuilds: []`
  (plan.md §14.1 item 7's supply-chain hardening) blocks install scripts project-wide, which is
  correct for this project's own dependency graph — confirmed empty — but also silently blocked
  Cloudflare's own deploy tooling. The first attempt at an exception (`allowBuilds: [esbuild,
  workerd]`, a YAML list) did not actually fix it: under the `pnpm@11.1.2` this project pins,
  `allowBuilds` is a *mapping*, not a list, and the list form parses without error but is silently
  treated as empty — Cloudflare's next build failed identically. Confirmed by reproducing the
  exact `[ERR_PNPM_IGNORED_BUILDS]` locally under the pinned pnpm version with the list form, then
  again with `allowBuilds: { esbuild: true, workerd: true }`, which actually runs both postinstall
  scripts
- Several routed pages — `/learn`, `/learn/:lessonId`, `/challenges`, `/tools`, and the
  `/tools/sort`, `/tools/planner`, `/tools/grammar` and `/tools/hash-join` sandboxes — were
  clipped on desktop with no way to reach the rest of their content. `Layout.tsx`'s app shell is
  deliberately one viewport tall (`lg:h-dvh lg:overflow-hidden`, plan.md §15.5) so a long
  Playground result scrolls inside its own panel instead of growing the page, but the `<div>`
  wrapping `<Outlet />` had no scroll of its own, so any page taller than the viewport — most of
  them plain prose with no internal scroll container — was simply cut off at the fold. `/stages`
  and `/docs` had already worked around this locally by putting `overflow-y-auto` on their own
  nested `<Outlet />` wrapper; that same `overflow-y-auto` now sits on the shared wrapper in
  `Layout.tsx` instead, so every routed page gets it once. Verified across every route at
  1440×900 that the shell height stays pinned to the viewport and, where content overflows, the
  wrapper — not the shell — is what scrolls; Playground, `/stages`, `/docs` and the Presenter
  overlay were unaffected, since each already sizes to fit or scrolls a nested panel of its own
- `optimize.ts`'s constant-folding rule mishandled two reflexive comparisons: `age <= age`
  and `age >= age` folded to `false` (they are always `true` — a column always satisfies
  `<=`/`>=` against itself), and `foldLiteralCompare`'s own `<=`/`>=` cases silently fell
  through to a `>` comparison instead of evaluating themselves. Both existed before `<=`/`>=`
  were reachable from SQL at all (plan.md §23.1 finally exercises them) and were caught by
  review, not a failing test
- `vite.config.ts`'s `output.advancedChunks` was deprecated by rolldown, printing a build-time
  warning on every `pnpm build`. Renamed to `output.codeSplitting`, same `groups` shape — no change
  in which modules land in which chunk
- The diagram tree arrived unframed in the panel's corner on some cold loads, and always when the
  page loaded into a background tab — the common case for a shared link. React Flow animates viewport
  moves with a d3-zoom transition, which is driven by `requestAnimationFrame` and so never advances
  in a tab that is not painting. The first framing is now instant, and no framing animates while the
  tab is hidden
- Tree framing measured the pane through React Flow's store, which reports `size.width || 500` — so a
  container measured at zero was indistinguishable from one 500px wide, and the tree was centred on a
  point that did not exist. `FlowTree` now measures its own pane with a `ResizeObserver` and computes
  the viewport transform itself, and the 60ms timeout that raced React Flow's mount is gone
- The favicon's third page bar dropped out at 16px, so the stack read as two

## [0.1.0] - 2026-09-03

### Added
- Complete MVP: Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result
- Recursive-descent SQL parser with AST visualization
- Rule-based query planner with predicate pushdown and index selection
- Buffer pool with pluggable replacement policies (LRU and clock sweep)
- B+Tree index with animated traversal, insert, and point/range lookup
- Volcano-style execution engine (SeqScan, IndexScan, Filter, Project)
- Page-level lock manager with crabbing for index descent
- Predict-then-reveal prompts at four pipeline stages
- Editable seed data with immediate re-execution
- Shareable URL state (query, policy, prediction mode, step index, custom rows)
- Light and dark themes with system preference detection
- Full keyboard navigation (Space, ←/→, Home, Mod+Enter)
- `prefers-reduced-motion` support
- Composited contrast sweep: zero elements below WCAG AA
- Error boundary with copyable crash repro
- CI pipeline (typecheck, lint, test, build) with SHA-pinned GitHub Actions
- Bundle budget enforcement (`pnpm budget`)
- End-to-end tests with Playwright and axe accessibility auditing
- Tested CSP security headers
- 326 unit tests, 14 end-to-end tests

[Unreleased]: https://github.com/Naveen-Boddepalli/query-lens/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Naveen-Boddepalli/query-lens/releases/tag/v1.0.0
[0.1.0]: https://github.com/Naveen-Boddepalli/QueryLens/releases/tag/v0.1.0
