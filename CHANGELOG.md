# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Dependency updates** (Dependabot #22, the codemirror group): `@codemirror/language` 6.12.4 → 6.13.1 (it
  now depends on the new `@codemirror/streamparser` 6.0.0; QueryLens has no stream-parsed language),
  `@lezer/highlight` 1.2.3 → 1.2.5, and `@codemirror/view` → 6.43.14 with `@codemirror/state` → 6.7.6 —
  from 6.43.10 and 6.7.2, not from the 6.43.13 and 6.7.6 the PR shows, for the reason under *Fixed*. The
  lockfile is regenerated and deduplicated here rather than taken from the PR. Typecheck, lint, all 2,783
  unit tests, the build, the budget (`/playground` 332.1 / 340 kB) and all 609 Playwright tests pass.
- **Dependency updates** (Dependabot #24, the dev group): `vite` 8.3.0 → 8.3.4, `@vitejs/plugin-react` 6.1.1 →
  6.1.2, `@playwright/test` 1.63.0 → 1.64.0 (Chromium build 1248), `eslint` 10.11.0 → 10.12.0, `globals`
  17.12.0 → 17.13.0, `jsdom` 30.1.1 → 30.1.2. Lockfile regenerated and deduplicated here, as above. Typecheck,
  lint, all 2,783 unit tests, the build, the budget (`/playground` 332.3 / 340 kB) and all 609 Playwright tests
  pass unchanged.
- **Dependency update** (Dependabot #25): `@types/node` 26.4.1 → 26.6.5, which brings `undici-types` 8.3.0 →
  8.9.0. Types only; nothing in the bundle changes.

### Fixed

- **The editor shipped older CodeMirror than `package.json` said.** The overrides that keep exactly one copy
  of `@codemirror/view` and `@codemirror/state` live in `pnpm-workspace.yaml`, pinned to 6.43.10 and 6.7.2;
  a second copy of them in `package.json`'s `pnpm` field, which pnpm 11 does not read, is the one Dependabot
  kept raising. So `package.json` claimed 6.43.13 and 6.7.6 while production ran 6.43.10 and 6.7.2. The
  workspace overrides now name `$@codemirror/view` and `$@codemirror/state` — whatever `package.json` depends
  on — and the unread block is gone, so a bump there is the bump that installs.
- **Two copies of `@lezer/common` (1.5.2, 1.5.3) and of `style-mod` (4.1.3, 4.1.4) were bundled.** A plain
  install keeps an old resolution beside a new one when a caret range allows both — this update's own install
  left two `@codemirror/language`s — and `pnpm dedupe` leaves one of each. The codemirror chunk is
  6.4 kB smaller gzipped than production's (125.6 → 119.1 kB at `gzip -9`).
- **CI's e2e job ran out of time.** It ran every Playwright test on one runner, on a single worker (a
  private repository's runner has 2 vCPUs), against a 20-minute limit. After the v2 merge most runs were
  cancelled there at about 560 of 608 tests, and Playwright 1.64 made each test about a third slower again
  (the runs on it reached 400–479 of 609). The job is now a three-way matrix, `--shard=1/3` to `3/3`, 203
  tests each, every shard building and installing for itself. `ci-gate` still waits on all three, and a
  failing shard uploads its own `playwright-report-<shard>`.
- **One e2e shard ran twice as long as the other two** (CI #145: 6m34s, 11m57s, 6m31s). Playwright's own
  sharding gives each shard a run of consecutive tests, counted in tests, and the axe audits come first in
  file order. So shard 2 got all 68 of `auditStates.spec.ts`'s tests, each worth three or four ordinary
  ones. A reporter, `e2e/support/shards.ts`, now does the sharding instead, through Playwright 1.64's
  `preprocess` and `testRun.skipSharding()`: it deals the tests out in turn, so every shard gets a third of
  every file (92 route audits, 22–23 control audits) and stays even as files grow, and a `test.describe`
  block goes whole to one shard. Still 203 tests a shard, and together exactly the 609. Summed test time is
  5.8, 4.8 and 4.9 minutes locally, against 4.3, 7.0 and 4.1 for the old split timed the same way. On CI
  (#146) the shard jobs took 7m 9s, 8m 32s and 8m 28s, and the whole run 8m 40s, against #145's 12m 5s.

## [2.0.0-rc.2] - 2026-10-15

The release candidate for 2.0: everything built on `version/v2` since 1.0.0, merged with `main`. (It is the second
candidate: the first, rc.1, was deployed and withdrawn — see the first entry under *Fixed*.) It is a candidate,
not 2.0.0, because RELEASING.md holds 2.0.0 for the whole of plan.md §25.8's 2.0 checklist, and one item there —
the custom domain, the launch post, and the CLI, engine and MCP packages on npm — is still open (the owner's
decision, 2026-10-15). In short:

- **Answers checked against SQLite** — a differential oracle, metamorphic and ternary-logic tests, and a ledger of
  where the two dialects really differ (*How we know the answers are right*).
- **More SQL** — expressions, `OR`/`NOT`/`IN`/`LIKE`/`IS NULL`, `DISTINCT`, `HAVING`, `OFFSET`, `LEFT JOIN`,
  chains of joins, an uncorrelated `IN (subquery)`, and every clause combining with the others; non-unique,
  composite, unique and clustered indexes; `EXPLAIN [ANALYZE]` and the plan as relational algebra.
- **An optimizer that counts** — `ANALYZE` statistics, q-error, cost-based choices with a *Why not?*, and a
  Selinger join-order search.
- **Transactions and durability** — two-session schedules, locks and deadlocks, MVCC snapshots, the Hermitage
  isolation matrix against PostgreSQL's, SQL Server's and InnoDB's published results, five concurrency-control
  protocols, a write-ahead log and ARIES recovery.
- **Storage engines** — LSM trees, hash indexes, row vs. column layouts, latch crabbing, vector indexes, read-ahead
  and scan-resistant pools, each a sandbox with a lesson and a challenge.
- **A learning layer** — 31 lessons, 53 challenges, generated practice questions, a course map and an interview
  roadmap; an installable, offline-capable app; per-page titles and an automated accessibility audit of every
  route; a CLI and an MCP server over the same engine.

### Added
- **A preset with NULLs: `customers`, with a lesson and a challenge** (plan.md §26, Feature 3). No preset row held
  a NULL, so three-valued logic only showed after editing data — which is how `NULL NOT IN (∅)` stayed wrong until
  the oracle found it. `customers` is 20 hand-placed rows with no city for five, no referrer for eight and no
  discount for seven (and a discount of 0 for one). Its presets: `IS NULL`, `= NULL` finding nothing, `COUNT` and
  `AVG` skipping NULLs, and `NOT IN` meeting the NULL among the referrers and returning no one. The lesson *NULL is
  not a value* (`/learn/nulls`, five steps, each opening the Playground on `customers`, its numbers held by tests)
  and the challenge *Everyone not in Paris* (`/challenges/not-paris-either`: `city <> 'Paris'` loses the five with
  no city). The `employees` blurb said 200 rows; it has 250.
- **All eight replacement policies in the Playground** (plan.md §26, Feature 2). The *Eviction* picker, a shared
  link's `p=`, a saved default in Settings, a downloaded trace file and an assignment link now take FIFO,
  second-chance, optimal, midpoint LRU, LRU-2 and 2Q as well as LRU and clock sweep — the eviction narration
  and the buffer panel's note already explained each one.
- **`GROUP BY`, `HAVING` and aggregates over a `JOIN`** (plan.md §26, Feature 1 slice c — the last refusal between
  clauses the engine already had). `SELECT authors.name, COUNT(posts.id) FROM authors LEFT JOIN posts ON authors.id
  = posts.authorId GROUP BY authors.name ORDER BY COUNT(posts.id) DESC` counts each author's posts, zero for one
  with none, under every join algorithm and both aggregate strategies. Grouped columns, `HAVING` and an aggregate's
  argument are qualified, like every column in a join query. The cost model counts a grouped column's distinct
  values in its own table. All eight optional parts of a `SELECT` now run together; the grammar diagram lets
  `GROUP BY` and `ORDER BY` take a qualified column, and the grammar lesson and the *Seven clauses* challenge say
  what still refuses a query — meaning, not combination. The SQLite oracle generates grouped joins.
- **`ORDER BY` with `JOIN`** (plan.md §26, Feature 1 slice b). A query with a `JOIN` — a chain, `LEFT` steps
  included — can sort its rows by a qualified column: `SELECT authors.name, posts.title FROM authors LEFT JOIN
  posts ON authors.id = posts.authorId ORDER BY posts.title DESC` puts the author with no posts first, NULL
  descending as PostgreSQL does. The Sort sits above the whole chain, under the Project, whichever algorithm joins
  it; an unqualified or unknown key is refused the way any other column in a join query is. The SQLite oracle
  sorts its generated joins under every algorithm.
- **`ORDER BY` with `GROUP BY`** (plan.md §26, Feature 1 slice a). A query that groups can now sort its groups, by a
  grouped column or an aggregate — selected or not: `SELECT account FROM transactions GROUP BY account ORDER BY
  SUM(amount) DESC LIMIT 5` is the five biggest accounts. The plan puts the `Sort` above the aggregate and its
  `HAVING`, and says it is ordering groups (and, for an aggregate nobody selected, that the aggregate computes it
  so there is something to sort by). A sort aggregate and the `Sort` above it spill to scratch pages of their own.
  `ORDER BY` on a column the groups do not have one value of is refused the way PostgreSQL refuses it, and so is
  an aggregate in `ORDER BY` with nothing to group. The SQLite oracle generates these queries under both
  aggregate strategies. The *Six clauses in one SELECT* challenge becomes *Seven clauses* (`/challenges/every-clause`).
- **Recovery as a trace in three stages** (plan.md §25.4 E3). `/tools/recovery` and the Playground's Durability dialog show analysis, redo and undo as a strip of stages with a slider that walks a recovery one row at a time, in the order the machine took them, saying what each step was and marking it in the passes below. It rests at the end, where the three panels have always been.
- **An InnoDB column in the isolation matrix** (plan.md §25.4 D5). `/tools/isolation` runs the ten Hermitage anomalies on a third engine, built level by level from what MySQL's InnoDB does: dirty reads under locks at `READ UNCOMMITTED`, a snapshot for each statement at `READ COMMITTED`, and at `REPEATABLE READ` one snapshot for plain reads but the latest committed row for writes, so a lost update gets through where snapshots refuse it. It is held against what MySQL publishes — 19 of the 40 cells; the others are computed and marked *not published* — and agrees on all but one, declared.
- **An accessibility audit of each page's states, in both themes and at phone width** (plan.md §H6). `e2e/auditStates.spec.ts` presses Run on thirty-four pages, shows each chart as a table, and chooses each radio button and tab in turn, scanning with axe after every one. The route audit (`e2e/audit.spec.ts`) now runs each route in the light and the dark palette at 1280 and 360 px.
- **Optimistic lock coupling in `/tools/latch-crabbing`** (plan.md §25.4 F5). A third protocol beside naive latching and crabbing, on the same scripted inserts and the same real B+Tree: a thread reads each page on the way down without a latch, checks the parent it came through, and latches only the pages it will change; if a page it read has changed, or the one it wants is held, the insert restarts from the root, and the timeline says which. On four threads of six inserts it spends 18 ticks blocked where crabbing spends 148, for 8 restarts; with two threads on wide pages it loses, because a restart is a whole descent. The lesson has two more steps and there is a challenge, *Win despite the restarts*.
- **Read-ahead in the policy comparison** (plan.md §25.4 F7). `/compare`'s *policy vs. policy* mode takes the same read-ahead depth the buffer-pool sandbox does (off, 1, 2 or 4 pages) and gives it to both policies, so two replacement policies can be stepped side by side under prefetching, with each side's prefetched pages shown.
- **Lessons and challenges for the remaining tools** (plan.md release checklist §2.4). Five lessons: replaying a page-reference string through the buffer pool (a loop one page too big, what the optimal policy would do, more frames and more misses, a scan sweeping the hot set); from text to tokens to a tree (and why `AND` binds tighter than `OR`); reading the grammar diagram (and what the engine refuses that the grammar reads); why planner rewrite rules need each other; and the lock table (readers share, a writer waits and is promoted, a circle of waits, a deadlock on one page). Ten challenges: two lock scripts (a deadlock that uses only one page, and taking pages in the same order so nobody is aborted), six settings (a bigger pool with more misses, a clock that is not LRU, a scan that leaves the hot set alone, the lookup with two rewrite rules, a tree's third level from twelve keys or fewer, and the one anomaly the two engines disagree on at one isolation level) and two queries (where the `AND` lands, and six clauses in one `SELECT`) — the last two link to the Parser and to the select rule of the Grammar. The challenge index now groups by subject: the isolation-matrix challenge is listed with the transactions, not with the storage tools. Every number a lesson quotes, and every solution, near-miss and link, is run on the tool's own engine in the tests.
- **Challenges for the storage and execution tools** (plan.md release checklist §2.4). Ten, in a *Storage and execution* group on `/challenges`: sort in a single merge pass, give a hash join more memory and make it slower, pick the join order, find the smallest page that holds the rows, split a bucket that did not overflow, cheap writes and cheap reads, write less than you were asked to, make the column store pay off, make crabbing save a fifth of the time, and beat brute force four to one. Each one is a few numbers — the ones the tool itself takes — in a form, checked against what the tool's own driver makes of them, and a solved one links to the tool on the settings you chose. Each carries the belief it checks.
- **Lessons for the sort, the hash join, the join order and the storage structures** (plan.md release checklist §2.4). Nine lessons: how an external merge sort spends passes and what memory buys; what a Grace hash join costs when it fits and when it spills; why the same four tables cost five times as much in the order they were written; where a row lives on a page; what a hash index gives up (ranges) for one hop; the LSM tree's write, space and read amplification, tiered compaction and the Bloom filter; rows against columns, encodings and late materialization; latch crabbing; and exact, clustered and graph nearest-neighbour search. The index groups them into the pipeline, *Storage engines and access methods* and *Transactions and durability*. Every number a lesson quotes is run on the tool's own driver in the tests.
- **Lessons and challenges for the transaction and durability tools** (plan.md release checklist §2.4). Seven lessons — a dirty read and the locks that stop it, reading the isolation matrix, snapshots, the five concurrency-control protocols, why the log goes first, steal and force, and surviving a crash — and thirteen challenges, in a *Transactions and durability* group on `/learn` and `/challenges`. A challenge is a script rather than a query: a schedule of two sessions, or a write-ahead-log script, one step to a line, run on the engine and checked by what the engine did with it — read a value that never existed, make A the deadlock victim, commit what no serial order explains, make recovery redo a commit, start redo in the middle of the log. Each carries the belief it checks, shown once it is solved. Every link in a lesson is run on the real engine in the tests, against the sentence it supports.
- **Table views for the transaction and durability tools** (plan.md §H6). The same *Show as table* toggle the storage tools have, on the schedule lanes, the isolation matrix (all eighty cells as rows, with the published result beside each), the concurrency compare's run, a write-ahead-log step's effects, and a recovery's three passes as one table in the order they ran — in the Durability dialog too. A table wider than its panel is now reachable from the keyboard.
- **Practice**, `/practice` (plan.md §25.4 G4). Questions made fresh from a seed, each answered by the engine itself — which page the clock hand evicts, which key a B+Tree split copies up, which scan the planner picks, whether a row version is visible, what recovery's redo re-applies and which transactions it undoes — scheduled by a five-box Leitner rule kept in this browser. It is an experiment and says so: its only measurement is how you did the first time a skill came up against every later time. None of the questions is one the project's own study asks.
- **An essay on `REPEATABLE READ`** (plan.md §25.4 H2), `/docs/essays/repeatable-read`. The same level name keeps its promise two ways: with locks it lets phantoms through and not write skew, with snapshots the reverse. The table is read from the isolation matrix, each cell links to the run behind it, and the write-skew and phantom schedules open in the transaction tool under each engine. A test holds every claim in it against the engine.
- **Crash and recover from the Playground** (plan.md §25.4 E4). A *Durability* button keeps every `INSERT`, `UPDATE` and `DELETE` run there as the log a write-ahead log would have written for it. Commit one, leave another open, write a page, take a checkpoint, then crash: the pool, the log buffer and every open statement are gone, and a recovery rebuilds the table from the disk and the durable log. The dialog shows each row that differs between what the Playground held, what recovery rebuilt and what committed, and can replace the Playground's table with the rebuilt one.
- **Crash recovery**, `/tools/recovery` (plan.md §25.4 E3). Fuzzy checkpoints, a crash button that drops the pool, the log buffer and every transaction and keeps the disk and the durable log, and ARIES: analysis rebuilds the dirty page table and the transaction table from the last checkpoint and names the losers, redo repeats history and says which records it skipped and why, undo rolls the losers back writing a compensation record for each. A crash *during* recovery is resumed by the next restart, which follows the compensation records it finds and undoes nothing twice. With the log-before-data rule off the page shows a change recovery cannot undo.
- **Steal and force**, on the write-ahead log page (plan.md §25.4 E2). Two toggles — may the pool write a page that holds an uncommitted change, and does a commit write the pages it changed — and for any step the page says what a crash at that moment would find: cells on disk that nobody committed (to undo, which steal causes) and committed values that never reached disk (to redo, which no-force owes). The same script runs under all four combinations side by side. Under no-steal a transaction with changes on every frame cannot read another page; under force a commit pays for every page it touched.
- **A write-ahead log**, `/tools/wal` (plan.md §25.4 E1), the first piece of the durability subject. A disk, a buffer pool and a log, and the rule that ties them: a page may not reach disk before the log records that describe it are durable. Write a script of changes, commits and rollbacks and watch each step append a record (LSN, prevLSN), force the log at commit without writing a data page, flush the log through a page's LSN before the page is written, and undo with compensation records. Switch the rule off and the page names the change that reached disk with nothing to record it.
- **A concurrency-control compare**, `/tools/concurrency` (plan.md §25.4 D6). One schedule under five protocols — two-phase locking, timestamp ordering, optimistic validation, snapshots and serializable snapshots — each really running it, read back as a bill: who committed, who was aborted and why, who waited, how much work went with an abort, and what reached a transaction that was not aborted. *One at a time?* is computed by replaying the committed transactions serially in whatever order explains what each one read and wrote, so write skew is caught by what was read, not only by the table it leaves. Timestamp ordering and optimistic validation are new protocols in the schedule runner; neither ever waits.
- **An isolation matrix**, `/tools/isolation` (plan.md §25.4 D5). Ten anomalies from the Hermitage suite, each a schedule of three transactions, run at four isolation levels on both engines, so every cell is computed rather than looked up and opens the run behind it. A test holds the results against what PostgreSQL and SQL Server publish: 79 of 80 cells agree, and the one that does not is marked and explained.
- **Versions and snapshots in transaction schedules** (plan.md §25.4 D4). A third way to run a schedule: every row is a chain of versions stamped with the transaction that made (`xmin`) and removed (`xmax`) it, and readers take no lock — they see the versions their snapshot can see. Read committed takes a snapshot per statement; repeatable read takes one per transaction (snapshot isolation: reads repeat, no phantoms, first committer wins, write skew gets through); serializable checks at commit that nothing read has changed. A rollback undoes nothing, it just hides the versions, which stay as dead tuples until `VACUUM`. The page shows every version's `xmin` and `xmax`, asks *can this session see this version?* before revealing the answer against its snapshot, and runs three scans of the heap through the real buffer pool to show what the dead versions cost, as they are and after a `VACUUM`.
- **Isolation levels in transaction schedules** (plan.md §25.4 D3). Read uncommitted, read committed, repeatable read and serializable, defined the textbook way as how long a transaction holds its locks, and chosen for the whole schedule or per transaction with `BEGIN ISOLATION LEVEL …`. The page names each anomaly a level lets through: dirty reads, non-repeatable reads, lost updates and phantoms. Serializable adds a toy predicate lock, so an insert that would match another session's read waits. A lookup for a row another open transaction deleted or re-keyed now waits instead of reading an uncommitted change.
- **Enforced locking in transaction schedules** (plan.md §25.4 D2). Choose page or row locks and the same schedule runs under strict two-phase locking, enforced by the engine's lock table: a statement takes shared locks to read and exclusive locks to change, holds them to `COMMIT` or `ROLLBACK`, and waits when it cannot get one, with its session's later steps queued behind it. Two sessions waiting on each other is a deadlock, and the youngest is rolled back. At three accounts the planner scans, so a row lock covers the whole table; at twenty an id lookup touches one row and its neighbours are free. The locks sandbox's rules moved into the engine (`engine/locks/lockTable.ts`) and the sandbox is an adapter over them.
- **Transaction schedules**, `/tools/schedule` (plan.md §25.4 D1), the first piece of the transactions subject. Two sessions share one `accounts` table and you choose the interleaving: `BEGIN`, `COMMIT` and `ROLLBACK`, each transaction with a real undo log. There is no concurrency control yet, so one session can read another's uncommitted change or write over it, and the page names both (a dirty read, a dirty write). The schedule is the URL. `runSchedule` is a pure engine function; locks that block, isolation levels and MVCC build on it. In the Playground, `BEGIN` now says where transactions work instead of a parse error.
- **A scan-resistant ring buffer** (plan.md §25.4 F7). With `scanRing` set, a sequential scan of a table bigger than a quarter of the pool reads through its own few frames and reuses its oldest page for each new one, as PostgreSQL's bulk-read strategy does, instead of evicting everything else. Off by default, so no existing run changes. In the buffer-pool sandbox a range such as `10-50` in the reference string is one marked scan, with a *Scan ring* control. `0 1 2 3 4 10-50 0 1 2 3 4` at eight frames is 51 disk reads under LRU without a ring and 46 with one; inside a single query it changes little, and takes FIFO from 45 to 33 on a join of `comments` and `posts`.
- **Sequential read-ahead** in the buffer-pool sandbox (plan.md §25.4 F7). A scan that reads pages in order has the next pages read early, shown as prefetches with their I/O counted as disk reads; a later request for one is a hit.
- **Accessibility page and audit** (plan.md §H6). `/docs/accessibility` says what has been checked for WCAG 2.2 AA, how, and what has not; it is not a conformance claim. An automated audit of 50 routes runs in the test suite.
- **Three publishable packages, not yet published** (plan.md §H3). `@querylens/engine`, the `querylens` terminal CLI and `@querylens/mcp` build into their own `dist` directories and install cleanly from their tarballs. A tag-triggered workflow publishes them with provenance once the npm organisation and trusted publishing are in place.
- **2Q buffer replacement policy** (plan.md §25.4 F7, slice 2). A small FIFO for pages read once, promotion only on a re-read after leaving it, available in the buffer-pool sandbox, the pipeline and `/compare`. Its correlated-reference limit is recorded in the tests and the plan.
- **Saved queries** (plan.md §H7). The Workspaces dialog in Custom mode keeps a named copy of the editor's SQL in this browser, and loads it back into the editor without running it.
- **Table views of the v2 tools** (plan.md §H6). Hash index, LSM tree, join order and columnar storage each get a `Show as table` toggle with the same numbers as a real table that a screen reader can walk.
- **Named workspaces** (plan.md §H7). In Custom mode, a Workspaces dialog saves a database under a name in this browser's IndexedDB, opens or deletes it, and downloads it as a `.querylens.json` file that another browser can open. A file is checked in full before anything is opened. The live autosave still lives in `localStorage`.
- **Keyboard navigation for tree diagrams** (plan.md §H6). The parse tree, query plan and B+Tree are reachable from the keyboard: Tab enters one, the arrow keys walk its nodes and the view follows, and a screen reader announces each node's level and place among its siblings.
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
- **A flaky end-to-end test now fails CI instead of passing on its retry.** CI retries a failed Playwright test
  once; a test that then passed went green unnoticed, which is how the tour's hand-off race (*Fixed*, below) hid
  for a run in twenty-five. `failOnFlakyTests` is on in CI, and the job writes an HTML report beside the GitHub
  annotations, so the `playwright-report/` it already uploads on failure exists, with the retry's trace in it
  (with only the `github` reporter that folder was never written). Checked with a deliberately flaky test under
  `CI=1`: the run fails and says "1 flaky"; with the option off it passes.
- **The SQLite oracle now checks outer joins, join chains and subqueries.** Its generators built only a single
  inner `t JOIN u`; they now also build `LEFT JOIN`, two-step chains over a third table `w` (each step inner or
  left, either side of the `ON` first), `[NOT] IN (SELECT col FROM … [WHERE …])` as a predicate anywhere a WHERE
  or HAVING takes one — a quarter of them deliberately empty — and `(P) IS [NOT] NULL`. The NoREC reference
  resolves subqueries by filtering rows itself, without the planner, and the ternary-logic partitioning draws
  subqueries too. The coverage suite fails the build if LEFT joins, chains or empty subqueries stop returning
  rows. This found the two bugs under *Fixed*; with either fix reverted, two to four suites fail.
- **A settings challenge fetches only its own tool's checks.** The runner for the storage, execution and isolation challenges is split by tool (`src/pages/challenges/settings/*.ts`), and a challenge loads its tool's module when it opens, instead of every driver at once: the form and runner are 4.6 kB (they were 32.3 together with the drivers), and the largest single tool, the isolation matrix, is 12.4 kB. Running a challenge is asynchronous; if a tool's checks cannot be loaded the page says so and the next run asks again.
- **The lock sandbox keeps its script in the address.** What was requested and released is a list of steps (`?s=`), replayed into the same lock table on a reload or a pasted link, instead of only the state it ended in; the page reads the address defensively (at most 40 steps, four pages, two transactions, and a value that is not a script is no script). Lessons and challenges open the sandbox on the script they name.
- **`/learn` and `/progress` no longer load the lessons.** They list lessons from a small manifest (`src/pages/learn/lessonIndex.ts`: title, length, summary, group) and import neither the twenty-five lessons' steps nor the engine behind their Playground links. `/learn` drops from 182 to 116 kB gzip and `/progress` from 184 to 118. A lesson page still loads the steps, and the manifest is the one place a lesson's title and summary are written.
- The custom database's working copy autosaves to IndexedDB instead of `localStorage`, so it is no longer capped at about 5 MB. A copy from the old key moves across once, the first time it loads.
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
- **Dependency updates** (Dependabot #4, #10): `react`/`react-dom` 19.2.8 → 19.3.0 (with their `@types`),
  `vite` 8.2.2 → 8.3.0, `vitest` 5.0.0 → 5.0.1, `jsdom` 30.0.1 → 30.1.0, `eslint-plugin-react-refresh`
  0.5.6 → 0.5.7. Typecheck, lint, all unit tests, the CLI smoke steps and all 85 Playwright tests pass
  unchanged. React 19.3.0 is materially larger (`react-dom-client.production.js` +17% unminified;
  the `react` chunk went 54.2 → 62.5 kB gzip), which tripped the bundle budget on `main` — the
  `react` ceiling is raised 62 → 63 kB in `scripts/bundle-budget.ts`, with the measurement recorded
  beside it. Total is 392.2 of 424 kB.

### Fixed
- **`pnpm release-notes` cut its output at 64 kB when piped.** It wrote the notes and called `process.exit()`, which
  ends the process before a pipe has taken more than its first 64 kB — and these notes are 76 kB, so `… | gh release
  create --notes-file -` would have published two thirds of them. It now sets the exit code and lets the write finish.
- **Every visit after the first failed to load.** The service worker precached the app's shell as `/index.html` and
  answered every navigation with it. Cloudflare answers `/index.html` with a redirect to `/`, so what was cached was a
  redirect, and a browser refuses a redirected response for a navigation: once the worker had installed, the next
  load of any page ended in a network error. Every test passed, because they run against `vite preview`, which never
  redirects. The worker now caches the shell as `/`, never hands a navigation a redirected response, and leaves the
  platform's own `404.html` uncached; the preview server now redirects `/name.html` the way Cloudflare does, so the
  offline tests reproduce the failure with the old worker (all three failed with `net::ERR_FAILED`) and pass with
  the new one, and a new test holds that nothing the worker precaches is an `.html` path. A browser holding the
  broken worker fetches the new one on its next navigation (`sw.js` is served `max-age=0`) and recovers.
- **A query under the optimal policy behaved as FIFO, while its narration said otherwise.** Bélády's policy evicts
  the page whose next use is farthest away, so it needs the future; the sandbox is handed a reference string, but a
  query had none, and the policy fell back to evicting the oldest page — with every eviction still narrated as "its
  next use is farthest away". `/compare`, `/trace`, the CLI and the MCP server all offered it. A query under
  optimal is now run twice: once to record the pages it reads, in order (a query's reads come from its plan, so they
  are the same under any policy — a test holds this for all eight), and once for real, evicting by that record. On
  `SELECT * FROM orders WHERE total > 500 ORDER BY total` with four frames it misses 63 times; every other policy,
  and optimal before, 75. Read-ahead keeps to a scan's own pages under it, as under any other policy.
- **`SELECT name FROM users HAVING COUNT(*) > 1` answered with one row holding `name: null`.** `HAVING` with no
  `GROUP BY` makes the whole table one group, so a plain column beside it has no one value; the check that refuses
  `SELECT name, COUNT(*) FROM users` only looked at the SELECT list's own aggregates, not `HAVING`'s. It is now
  refused the way PostgreSQL refuses it (SQLite answers with an arbitrary row).
- **A sort's scratch pages could run past the buffer pool unseen.** The block of page ids reserved for a sort
  after a `JOIN` was sized for at most 20,000 rows, and the pool ignores a read or write past its last page, so a
  sort over a bigger join — a sort-based `DISTINCT`, then — gave the right rows with buffer counts that left out
  much of its spill (a 25,600-row sort lost about 35,000 events). The cap is gone; a block is only a range of ids.
  Separately, a `LEFT JOIN` onto an empty table reserved room for no rows in the step after it, though it still
  passes every row through padded, so a `sort-merge` step there sorted both its sides into the same page ids.
- **Docs the merge from `main` left behind.** `frontend.md` still described the per-chunk-group budget (a `react`
  ceiling of 63 kB, a 424 kB total) that the per-route budget replaced; it now says what `pnpm budget` checks. A
  comment in `scripts/bundle-budget.ts` had lost the end of a sentence in the merge, and gave the `react` chunk's
  growth as 54.2 → 64.8 kB, mixing the script's own measure (gzip level 9, in KiB: 62.5) with Vite's printout
  (64.8). The URL-parameter reference and `frontend.md` listed three preset datasets for `t=`; there are five.
- **Every page had the same browser title.** All sixty-seven routes kept `index.html`'s *QueryLens — watch a SQL
  query become a B+Tree traversal*, so tabs, history and bookmarks could not tell them apart and a screen reader
  announced the same name on every page (WCAG 2.4.2, *Page Titled*; axe does not flag it, because a `<title>`
  exists). Each page now names itself, then its section, then the site: *Crash recovery · Tools · QueryLens*,
  *FAQ · Docs · QueryLens*. `PageHeader` sets it from the heading it already shows (`src/ui/documentTitle.ts`);
  the docs use their sidebar label, and the landing page keeps the original. `e2e/titles.spec.ts` walks every
  audited route and fails on a default or a repeated title.
- **"Take the 60-second tour" was sometimes ignored, and a tour once taken could open again by itself.** The
  first-visit hint and the Playground hand the request over with a window event and a `sessionStorage` flag. The
  Playground read the flag while it rendered and started listening for the event only after it had committed, so
  a click in between reached neither: the tour did not open, and the flag stayed set. Separately, a request the
  Playground answered live never cleared the flag. Either way the tour then opened unprompted on the next visit
  to the Playground in that tab. `listenForTour` (`src/ui/firstVisit.ts`) now listens first and takes the flag
  second, and a live request takes its own flag, so every request is answered exactly once. The end-to-end test
  that tripped on the race about one run in twenty-five now passes repeatedly under CPU throttling; a new one
  covers the reopening.
- **`x NOT IN (subquery)` kept no NULL rows when the subquery found nothing.** SQL's rule is that an empty list
  holds nothing to be unknown against, so `NULL IN (∅)` is FALSE and `NULL NOT IN (∅)` is TRUE; the evaluator
  called a NULL operand UNKNOWN before looking at the list, so `DELETE FROM b WHERE y NOT IN (SELECT x FROM a)`
  with `a` empty left the rows whose `y` is NULL behind. A literal `IN ()` does not parse, and none of the preset
  datasets holds a NULL, so only a subquery over a custom database could show it. The WHERE narration now says
  what an empty subquery means for every row.
- **An `IN (subquery)` outside `AND`/`OR`/`NOT` in a WHERE clause was never run.** The parser accepts one under
  `IS [NOT] NULL`, inside a comparison, in a computed column, in `HAVING` and in an `UPDATE`'s `SET`, but only
  the WHERE clause's boolean connectives were searched for subqueries to resolve; the others ran as an empty list.
  `SELECT … WHERE (n IN (SELECT n FROM u)) IS NULL`, `… HAVING n IN (SELECT …)` and `SELECT n IN (SELECT …) AS x`
  all answered wrongly. Every expression in the statement is now searched, and a failing subquery in any of them
  is reported against its own text.
- **The 60-second tour's spotlight pointed at the wrong region, and the page scrolled to the bottom
  behind it.** `index.css` sets `scroll-behavior: smooth` on `<html>`, which `scrollIntoView` honours,
  so the tour read the target's rect while the scroll was still in flight and parked the spotlight where
  the target *used to be*; nothing re-measured it afterwards. It also centred every target
  unconditionally, which on desktop dragged the window down into the footer for regions that were
  already on screen. The tour now scrolls only when the target is not wholly in view, does it instantly
  (`behavior: 'instant'`), and keeps the spotlight on its target through scrolls, resizes and layout
  shifts (it glides on a step change but snaps while the page moves, so it never trails the content).
  Adds an e2e test at a phone viewport that asserts, for all five steps, that the spotlight's box is the
  target's box.
- **The route audit was sometimes scanning a loading screen, and ten real accessibility failures were behind it.** The scan waited for the page's outer shell, which is on screen before a lazy route's own content, so for some routes it passed for the wrong reason (and failed on the runs where the page was quick). It now waits for the network to settle and the page's first heading. Scanning properly, in both themes and at 360 px, found: the tables and code blocks of `/tools/page`, `/tools/latch-crabbing`, `/tools/vector-index`, `/tools/join-order`, `/examples`, `/docs/reference/sql` and `/docs/reference/url-parameters` that scroll but could not be reached from the keyboard (tables are now labelled, focusable regions, long code wraps, and a docs code block is a tab stop); an unnamed drop-down for a column's encoding on `/tools/columnar`; the planner's `rules:` label at a contrast of 2.9:1; and the check boxes of a challenge at 13 px, under the 24 px minimum target.
- **The “Solved” banner on a challenge page had too little contrast in the light theme** (4.28:1, against the 4.5:1 WCAG AA asks of body text). Found by running axe over a *solved* result, which nothing had done before; the banner's text is now the ordinary ink colour on the green border and tint, on the query, schedule, log and settings challenge pages alike.
- **Read-ahead in a query no longer reads past the heap into the index's pages.** A scan's last heap page prefetched the pages numbered after it, which are index pages, so `SELECT * FROM users` with read-ahead on read 14 pages for a 12-page heap. A sequential scan now says where its pages end and nothing reads ahead beyond that; a query that names no extent reads nothing ahead. Nothing in the app turned read-ahead on for a query, so no one saw it.
- **A lock upgrade could never be granted** in `/tools/locks`: a transaction holding a shared lock that asked for an exclusive one, once the other readers had let go, stayed waiting forever, because its own shared lock counted as a conflict. Found while moving the lock rules into the engine; fixed there, with a test.
- **A query run with read-ahead on now counts the pages it read ahead as disk reads** in the result it narrates (a `SELECT`'s, and an `INSERT`'s, `DELETE`'s and `UPDATE`'s). They said "from N disk reads" counting only requested pages, so the sentence disagreed with the panel and the scorecard. Nothing in the app turns read-ahead on for a query yet.
- **The buffer-pool concept page no longer says QueryLens has two replacement policies.** It has eight; the Playground's dropdown offers LRU and clock sweep, and the sandbox, Trace and Compare offer all of them. The page now names LRU-2 and 2Q, and Compare's "any two of the six" is "any two of the eight".
- **The Engine limits and Supported SQL pages no longer make claims the engine has outgrown.** They said an indexed column could never be `UNIQUE`, that an equality beat a range "by rule order, not a cost comparison", that cost estimates only justify narration, that two replacement policies exist, and that `DELETE`/`UPDATE` use an index only for an equality. Each is now stated as it is: cost declines an index that would not beat the scan, picks a join's algorithm and a chain's order, eight policies run, and the seed-table list includes `employees` and `transactions`.
- HNSW's layer-0 graph could leave points unreachable from the entry point, so a full-width search missed true neighbours. Layer 0 is now undirected and joined into one component. Found by a property test over random inputs.
- Midpoint LRU caps its young sublist at five-eighths of the buffer pool, as InnoDB does. Before, re-used pages could fill the pool and the policy became plain LRU on long traces.
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

## [2.0.0-rc.1] - 2026-10-15

Deployed to production at `c2b79e8` and withdrawn within the hour, never tagged or published: its service worker broke
every visit after the first. Everything it held is in 2.0.0-rc.2, above, with that fixed.

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

[Unreleased]: https://github.com/Naveen-Boddepalli/query-lens/compare/v2.0.0-rc.2...HEAD
[2.0.0-rc.2]: https://github.com/Naveen-Boddepalli/query-lens/releases/tag/v2.0.0-rc.2
[2.0.0-rc.1]: https://github.com/Naveen-Boddepalli/query-lens/commit/c2b79e8
[1.0.0]: https://github.com/Naveen-Boddepalli/query-lens/releases/tag/v1.0.0
[0.1.0]: https://github.com/Naveen-Boddepalli/QueryLens/releases/tag/v0.1.0
