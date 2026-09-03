---
title: URL parameters
description: What a QueryLens link encodes, and how to build one by hand.
---

Every moment in the app — a query, a setting, a step — is reproducible from the URL alone. The app
writes it automatically (debounced, via `history.replaceState`, so stepping a trace doesn't fill your
back button with history entries), and the **Copy link to this step** button under the editor copies
the current one. This page is for building one by hand.

## Parameters

| Param | Meaning | Example |
|---|---|---|
| `q` | The SQL query | `q=SELECT * FROM users WHERE id = 5;` |
| `p` | Eviction policy — `lru` or `clock` | `p=clock` |
| `x` | Predict-then-reveal — `1` on, `0` off | `x=0` |
| `s` | The step to land on | `s=25` |
| `d` | Custom row data, only present when the seed rows have been edited | *(generated, not hand-written — see below)* |

A link that omits a parameter falls back to that setting's default, so the shortest working link is
just `?q=...`.

## An example, assembled

```
https://query-lens.pages.dev/?q=SELECT%20*%20FROM%20users%20WHERE%20age%20%3E%2030%3B&p=lru&x=0&s=91
```

That's `age > 30` under LRU, prediction off, landing on step 91 — the first buffer eviction in that
trace. Remember to URL-encode the query string itself (spaces, `*`, `>` and so on).

## Limits

The URL is treated as untrusted input — it's the one value in the app that can arrive from a
stranger — so every field is capped and anything malformed or out of range falls back to the default
rather than erroring:

- **`q`**: 2000 characters
- **`d`** (custom rows): 500 characters per cell, 500 rows
- **`s`**: an integer from 0 to 100,000

## Custom row data (`d`)

Only appears once you've edited the seed data through **Edit data**, so a link to the default table
stays short. It's a generated, compact encoding — not meant to be written by hand — that round-trips
through the app: edit rows, copy the link, and reopening it reproduces exactly that table.
