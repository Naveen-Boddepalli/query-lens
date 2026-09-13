# The §9 validation study

Materials for the post-test validation study plan.md §9 describes and has not yet run: does QueryLens
teach the mechanism better than a good text explanation of the same material, for someone who could
not answer the mechanism questions before?

**This file is deliberately not part of the docs site build** (nothing under `src/` imports it). The
in-app quiz caveat at plan.md §22.4 applies here too, in reverse: the mechanism questions below *are*
the study instrument, so they must never be shown to a participant before the test, never linked from
the app, and never posted publicly before the study runs. Treat this file as participant-blind
material, not a docs page.

**Recruitment, control group, and post-test logistics — the "how do I actually run this" side of
§9 — are handled outside this file** (a survey tool, a recruitment post, a spreadsheet). This file
covers only the three artifacts a survey/form tool can't generate for you: the control-group reading
material, the five mechanism questions, and the scoring rubric.

---

## 1. Control-group reading material

Give this section — and only this section — to the control arm. It is self-contained prose: no links,
no instructions to open anything, nothing to click. Matching this constraint is what makes it a fair
control against an interactive tool; a "text explanation" that tells the reader to go click around in
QueryLens would stop measuring what §9 is built to measure. It covers the same two mechanisms the
treatment arm encounters through the app: buffer pool eviction (LRU vs. clock sweep) and B+Tree splits.
Reading time target: 10–12 minutes.

> Copy everything between the two `<!-- CONTROL TEXT -->` markers verbatim into whatever the control
> arm actually reads from (a printed handout, a plain page, a PDF) — don't summarize or shorten it,
> since the whole point is a fair fight against the same content the app teaches.

<!-- CONTROL TEXT START -->

### How a database decides what to keep in memory

Reading from disk is slow compared to reading memory that's already loaded — often by several orders
of magnitude. Because of this, a database keeps a fixed number of memory slots, called **frames**,
each holding one copy of an on-disk page. When a query needs a page, the database checks memory first.
If the page is already there, that's a **hit**, and the read is nearly free. If it isn't, that's a
**miss**, and the database must fetch the page from disk, which is slow — and if every frame is
already in use, one of them has to be **evicted** (thrown out) to make room for the new page.

The question of *which* page to evict matters enormously, because the wrong choice means fetching that
same page from disk again a moment later. Two rules for making this choice are common:

**LRU (least recently used)** evicts whichever page was accessed longest ago, out of all the pages
currently in memory. The reasoning is straightforward: a page nobody has touched in a while is the
safest one to throw away, because it's less likely to be needed again soon. LRU's rule looks only at
*the single most recent access* to each page — how many times a page has been read in total doesn't
matter, only when it was last read. So a page that was read five times in a row, a while ago, is
treated as "cold" the moment something else gets accessed more recently — its earlier reads don't
count for anything once a newer access has happened elsewhere.

**Clock sweep** is a different, cheaper way of approximating the same idea. Each frame carries a small
usage counter, starting at zero. Every time a page is accessed, its counter is set to 1 (its "used"
bit). A pointer — the "clock hand" — sweeps through the frames in a circle. When the hand reaches a
frame, it checks that frame's counter: if the counter is 1, the hand resets it to 0 and gives the page
a "second chance," moving on without evicting it. If the counter is already 0, the hand evicts that
page. Because of this, a page that keeps getting re-accessed keeps its counter refreshed to 1 before
the hand ever comes back around to it, so it survives sweep after sweep — even if, at any single
instant, it isn't the single most-recently-touched page in the pool. A page that is read once and then
left alone will have its counter swept down to 0 and evicted the next time the hand passes it.

The key practical difference: **LRU only ever looks at the single most recent access.** A page read
many times in the past, but not the *most* recently, looks exactly as "cold" to LRU as a page read
only once. **Clock sweep, by contrast, gives a repeatedly-accessed page repeated chances to survive**
— every time it's touched, its counter resets, buying it another full sweep before it can be evicted.
On an access pattern where every page is touched about equally often, the two rules tend to agree,
because nothing is meaningfully "hotter" than anything else. They diverge specifically when one page
is accessed much more often than the others: LRU can still evict that hot page, if something else
happens to be touched more *recently*, while clock sweep's repeated "second chances" are more likely
to keep it resident.

### How an index turns a search into a handful of pointer follows

Without an index, finding a specific row in a table means checking every page of that table one by
one — a **sequential scan**. This works, but its cost grows directly with the size of the table: a
table with a thousand pages requires up to a thousand page reads to find one row (or to confirm no
such row exists).

A **B+Tree index** avoids this by organizing keys into a tree structure that can be searched with a
short walk from the root to a leaf. Every **internal node** in the tree holds a small number of
**separator keys**, each of which routes a search toward exactly one child: comparing the key being
searched for against the node's separator values tells you which single child to follow next. This
repeats, one level at a time, until the search reaches a **leaf node** — the level of the tree that
actually holds real data (in a table index, a leaf entry pairs a key with a pointer to that key's row).
For a table with thousands of rows, this turns "check every page" into "follow three or four pointers"
— a large, structural difference in cost, not just a small optimization.

### Why a B+Tree needs two different splitting rules — and why mixing them up breaks the tree silently

Every node in a B+Tree has a maximum number of keys it can hold — its **fan-out**. When a node would
exceed that limit, it **splits** into two nodes, and one key has to move up into the parent node to
serve as the new separator between the two halves. The subtlety is that **leaf nodes and internal
nodes must handle this "move a key up" step differently**, because they hold fundamentally different
kinds of information.

**A leaf node's keys are data — each one pairs with an actual row.** When a leaf splits, the key that
becomes the new separator must be **copied** up to the parent, not removed from the leaf. It has to
stay physically present in whichever leaf it belongs to, because that leaf entry is still someone's
row; removing it would silently delete a real, valid entry from the tree just because it happened to
sit at a split boundary. This is the **copy-up** rule: the separator exists in two places afterward —
once as a routing key in the parent, and once as an actual entry in the leaf it came from.

**An internal node's keys, by contrast, are pure routing information — they don't correspond to any
row at all.** An internal node with *N* keys always has exactly *N+1* children: each key is a boundary
between two adjacent children, nothing more. When an internal node splits, its middle key is **pushed**
up to the parent and **removed** from both halves of the split. It must not remain behind in either
child, because an internal node's correctness depends on always having exactly one more child than it
has keys; leaving a stray copy of the pushed key behind would break that count, corrupting the node's
own internal structure.

If someone implementing a B+Tree applies the wrong rule to the wrong kind of node, the result is not a
crash — the tree keeps a fully plausible shape, with the right number of levels and the right-looking
node sizes. But it silently starts returning wrong answers. Removing (instead of copying) a key during
a leaf split deletes a real row's index entry, so a later search for that exact key reports "not found"
even though that row genuinely exists — it just descended past its own entry looking for it, because
the parent's separator still routes searches to the correct side, but the leaf no longer actually holds
the key it's supposed to hold. Copying (instead of removing) a key during an internal split leaves a
stray, duplicate key sitting in a node whose child count no longer matches, so searches for keys near
that duplicate boundary get routed to the wrong child entirely — again silently, again without any
error being reported anywhere. Both mistakes look completely fine to a casual inspection of the tree's
shape; only checking that every internal node's key count and child count actually line up, and that
every inserted key can genuinely still be found, would catch either one.

<!-- CONTROL TEXT END -->

---

## 2. The five mechanism questions

Ask every participant — both arms — the same five questions, in this order, after their reading or
app session ends. Give a fixed time budget (5 minutes is enough; these are recall-and-apply, not
essay questions) and do not let participants go back to the material while answering — that's what
turns this into a post-test rather than an open-book lookup.

**Q1 — Index vs. scan, mechanism not vocabulary.**
> A `users` table is stored across 12 disk pages. `SELECT * FROM users WHERE id = 5` runs with an
> index on `id`. `SELECT * FROM users WHERE age > 30` runs with no index on `age`. Which query reads
> more pages from disk to do its job, and *what specifically does each query have to do* to find its
> matching row(s)?

**Q2 — A concrete eviction, LRU.**
> A buffer pool has 4 frames, currently holding pages `7, 2, 9, 3` — in that order from most to least
> recently accessed (page 7 was touched most recently, page 3 longest ago). The next page requested is
> page 5, which is not currently in the pool. Under LRU, which page gets evicted to make room?

**Q3 — Why LRU and clock sweep can disagree.**
> Over the course of a trace, page A gets read 5 separate times. Pages B and C are each read exactly
> once — and both of those single reads happen *after* A's most recent read. The pool is now full and
> a new page arrives, forcing an eviction among A, B, and C. Under LRU, which page is evicted, and
> why? Is clock sweep guaranteed to evict the same one? Explain in one or two sentences.

**Q4 — Leaf split, copy-up.**
> A B+Tree leaf holds the keys `[10, 20, 30]` and is exactly at its maximum capacity of 3 keys. A new
> key, `25`, is inserted, forcing the leaf to split. After the split, is the key that becomes the new
> separator between the two resulting leaves still physically present inside one of those leaves, or
> is it removed and kept only in the parent? If it's still present, which leaf holds it?

**Q5 — Misapplying the split rule.**
> Someone builds a B+Tree where *every* split — leaf or internal — copies the middle key up and also
> leaves a copy of it behind in the node it split from. What specifically goes wrong the first time an
> *internal* node splits this way, and why might the tree still look structurally normal (right number
> of levels, right-looking node sizes) even after it's broken?

---

## 3. Scoring rubric

Score blind: strip the participant's name and arm/group label before grading, and use one scorer (or
two, reconciling disagreements) across every response so both arms are held to the same bar. 12 points
total across the 5 questions.

| Q | Points | Award for | Correct answer / key points |
|---|---|---|---|
| **Q1** | 2 | 1 pt: correctly says the sequential scan (no-index query) reads more pages. 1 pt: correctly explains *why* — the scan has no way to know which pages contain matches, so it must check all (or most) of the 12; the indexed lookup walks a short root-to-leaf path straight to the match without touching most of the table. | The scan reads (up to) all 12 pages; the indexed lookup reads only the handful of pages on its root-to-leaf path plus the matching row's page. |
| **Q2** | 2 | 1 pt: correctly identifies page 3. 1 pt: correctly reasons "least recently used" / "touched longest ago," not just "the oldest one" vaguely. | Page 3 — it was accessed longest ago of the four resident pages. |
| **Q3** | 3 | 1 pt: correctly says LRU evicts A. 1 pt: correctly says clock sweep is *not* guaranteed to evict A (i.e., correctly states the outcomes can differ). 1 pt: correct mechanism — LRU only looks at the single most recent touch (A's is oldest of the three), while clock sweep's usage counter gives a repeatedly-touched page like A repeated "second chances" that can let it survive. | LRU evicts A (its last access is oldest, despite 5 total reads). Clock sweep is not guaranteed to agree — A's repeated accesses may have kept its usage counter refreshed, letting it survive a sweep that evicts B or C instead. |
| **Q4** | 2 | 1 pt: correctly says the key is still present (copy-up, not removed). 1 pt: correctly identifies it lands in the **right** (new) leaf, matching the actual split boundary. | Still present — leaf splits copy the separator up rather than removing it. Post-split: left leaf `[10, 20]`, right leaf `[25, 30]`; key 25 is the separator and physically sits in the right leaf. |
| **Q5** | 3 | 1 pt: identifies that internal-node keys are pure routing information, not data, so they must not be duplicated. 1 pt: correctly describes the failure — a node with a duplicated key has more keys than its child count can account for, so descents for keys at or past that duplicate get routed to the wrong child, silently returning wrong or missing results. 1 pt: correctly explains why it still looks normal — node/level counts and overall shape are unaffected; the corruption is specifically in the key-count-vs-child-count relationship, invisible without checking that invariant directly. | An internal node must have exactly one more child than keys. Leaving a copy behind breaks that count, so lookups near the duplicated key get misrouted — silently, with no error, and the tree's outward shape (heights, node sizes) looks completely unaffected. |

**Reporting.** Compute each participant's total (out of 12), then compare the two arms' score
distributions (means, and the spread — 5–10 people per arm is too small for a significance test to
mean much, so report it descriptively rather than chasing a p-value). Report the result honestly
wherever §9 lands in the docs, including if the control arm matches or beats the app — that's the
entire reason this is a post-test and not a satisfaction survey.
