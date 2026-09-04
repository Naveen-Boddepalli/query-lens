---
title: FAQ
description: Is this a real database? Where is my data stored? Can I use this in my course?
---

### Is this a real database?

No. QueryLens is a **simplified educational model** — a self-built toy engine written to teach the
*shape* of how a query moves through a real one. It is not Postgres, MySQL, SQLite, or anything you
would run in production, and it does not aim to be. Every number the app shows is true to its own
engine, not to any specific real one.

Concretely, that means things like: a single global B+Tree index with a fixed fan-out, exactly two
eviction policies (LRU and clock sweep) rather than a real system's tuning knobs, and a lock manager
that draws page-level locks on screen but never actually blocks a second query — because QueryLens
only ever runs one. See [Engine limits](/reference/limits/) for the specific numbers, and each
[Concepts](/concepts/buffer-pool/) page for where that particular piece diverges from a real engine
and why.

### Where is my data stored?

Nowhere but your browser. There is no server, no account, no database behind QueryLens — the entire
engine runs as JavaScript in the tab you have open. The seed data and any edits you make to it live
in memory for that page load; a shareable link encodes your query, settings and any customised rows
directly in the URL, not on a server. There is no telemetry, no analytics, and no cookies — nothing
you do here is sent anywhere.

### Can I use this in my course?

Yes. The code is MIT-licensed and this documentation is CC BY 4.0 — between them: use it in a
course, fork it, screenshot it, put it behind a university login, translate it. Attribution is the
only ask. See the [licence](https://github.com/Naveen-Boddepalli/query-lens/blob/main/LICENSE) for
the exact terms.

### How accurate is the buffer pool / B+Tree / locking model?

Accurate to the *concept*, simplified in the *numbers and the mechanism*. The
[Concepts](/concepts/buffer-pool/) pages are explicit about each divergence — for example, real
locking separates a short-lived latch on a buffer frame from a transaction-length lock on the data,
and QueryLens collapses both into one page-level read lock, because it never has a second, competing
query to protect anything from.

### Can I embed QueryLens in my own page?

Not via `<iframe>` — the app's own security headers (`frame-ancestors 'none'`) refuse to be framed,
which is a deliberate choice rather than an oversight. The supported way in is a
[shareable link](/reference/url-parameters/): it opens the real app at an exact query and step, which
is how this documentation itself links out to worked examples.

### Why no joins, subqueries, or `GROUP BY`?

They are out of scope for this release, not forgotten — see [Supported SQL](/reference/sql/) for
what runs today. QueryLens's parser recognises the keywords for all of them and tells you so directly
rather than failing with a generic syntax error, which is usually the fastest way to find out whether
a query you typed is simply not supported yet.
