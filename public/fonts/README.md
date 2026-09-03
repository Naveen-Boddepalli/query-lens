<!--
SPDX-License-Identifier: OFL-1.1
This file documents the fonts in this directory. The fonts are OFL-1.1; the
rest of QueryLens is MIT (see /LICENSE).
-->

# Fonts

Two subset variable webfonts, built by [`scripts/build-fonts.py`](../../scripts/build-fonts.py)
and committed rather than generated at build time. Re-run that script and commit
its output when a face or the glyph set changes.

| File | Family it ships as | Cut from | Licence |
|---|---|---|---|
| `querylens-mono.woff2` | `JetBrains Mono` | [JetBrains Mono][jbm] 2.304 | [OFL 1.1](./querylens-mono-OFL.txt) |
| `querylens-sans.woff2` | `QueryLens Sans` | [IBM Plex Sans][plex] 3.201 | [OFL 1.1](./querylens-sans-OFL.txt) |

[jbm]: https://github.com/JetBrains/JetBrainsMono
[plex]: https://github.com/IBM/plex

Both are variable fonts carrying a single `wght` axis from 400 to 700, so one
file covers every weight the application uses. Both are subset to the 235
codepoints `src/` actually renders — Latin, punctuation, the arrows and box
drawing the diagrams use — which is why they are ~30 kB each instead of ~200 kB.
Anything outside that set falls back to the operating system, which is the right
answer for the two emoji in the UI (🔒 👉): an emoji is a colour font and has no
business inside a text subset.

## Why they are self-hosted

`public/_headers` sets `font-src 'self'`. A Google Fonts `<link>` is blocked by
the project's own CSP — correctly — so self-hosting is the only route. Before
this directory existed, `src/index.css` named `'JetBrains Mono'` and shipped no
font file at all, so the typeface appeared only for visitors who happened to
have it installed locally. See plan.md §16.2 item 1.

## Why one is renamed and the other is not

Both faces are SIL OFL 1.1, and a subset is a **Modified Version** under that
licence. Clause 3 bars a Modified Version from using a *Reserved Font Name* — and
the two upstreams differ on whether they declare one, so they are treated
differently rather than uniformly:

- **IBM Plex Sans** declares `Reserved Font Name "Plex"` in its copyright line.
  Its subset therefore ships as **QueryLens Sans**, with `Plex` removed from
  every name-table record — family, subfamily, full name, PostScript name, the
  variations prefix, the Unique ID, and each of the four named instances.
  Renaming the *file* alone would not comply; clause 3 is about the name the
  font declares, not the name on disk.
- **JetBrains Mono** declares **no** reserved font name — its copyright line
  names the project, not a reserved name. Its subset keeps the family name,
  because accurate attribution beats an invented one when the licence does not
  require the change.

Two things are preserved verbatim in both files: the copyright notice
(nameID 0), which OFL clause 1 requires, and the licence records (nameIDs 13
and 14). `querylens-sans.woff2` also keeps IBM's trademark notice (nameID 7).
That notice is a true statement about the upstream and is not ours to delete; it
does not claim this file *is* Plex, and the record that would have made that
claim — the family name — is exactly what clause 3 made us change.

The build script asserts the rename is complete and refuses to write a file that
still carries a reserved name outside those preserved records.

## Filenames

`querylens-*` rather than `jetbrains-mono-*` / `ibm-plex-sans-*`, per plan.md
§17.3, so a partial subset is never mistaken for the complete upstream file it
was cut from — by a person or by a licence scanner.
