#!/usr/bin/env python3
"""
Build the self-hosted webfonts in `public/fonts/` (plan.md §16.2 item 1).

    python3 scripts/build-fonts.py

Why this file exists at all
---------------------------
`src/index.css` named 'JetBrains Mono' for a year while shipping no font file,
so the typeface only appeared for visitors who happened to have installed it —
a population that skews to exactly the developers who would notice, which is
why it survived. `public/_headers` sets `font-src 'self'`, so a Google Fonts
link is blocked by the project's own CSP, correctly. Self-hosting is the only
route, and self-hosting means *distributing*, which brings the OFL obligations
handled below.

Why Python rather than the `scripts/*.ts` next door
---------------------------------------------------
Subsetting and variable-axis pinning are fontTools, and fontTools is Python.
The alternative is a JS subsetter as a permanent devDependency for a job that
runs when a typeface changes — roughly never. This script is not part of
`pnpm build`; its output is committed, because the eleven visitors a day should
not be paying for a Python toolchain in CI. Re-run it by hand and commit the
result when a face or the glyph set changes.

Requirements: `pip install 'fonttools[woff]' brotli`.

The OFL, applied rather than assumed
------------------------------------
Both faces are SIL OFL 1.1, and a subset is a Modified Version. Clause 3 bars a
Modified Version from using a *Reserved Font Name* — and the two faces differ
on whether they declare one, so they are treated differently rather than
uniformly:

  * IBM Plex Sans declares `Reserved Font Name "Plex"`. Its subset therefore
    ships as **QueryLens Sans**, with "Plex" gone from every name-table record.
  * JetBrains Mono declares **no** RFN (its copyright line names the project,
    not a reserved name). Its subset keeps the family name, because accurate
    attribution beats an invented one when the licence does not require it.

Both keep their copyright strings, both ship `OFL.txt` beside the files, and
`public/fonts/README.md` records this reasoning where the next person will look.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "fonts"
UPSTREAM = "https://raw.githubusercontent.com/google/fonts/main/ofl"

# ---------------------------------------------------------------------------
# The glyph set.
#
# Counted from `src/`, not guessed: every non-ASCII character the application
# renders was extracted from the source before this list was written. Anything
# outside it falls back to the OS, which is the correct outcome for the two
# emoji (🔒 👉) — an emoji is a colour font and has no business in a 30 kB text
# subset.
# ---------------------------------------------------------------------------

RANGES: list[tuple[int, int, str]] = [
    (0x0020, 0x007E, "Basic Latin — the whole printable block"),
    (0x00A0, 0x00FF, "Latin-1 Supplement — § · × and accented names in prose"),
    (0x2018, 0x201D, "Curly quotes and apostrophes (§16.3's typographic pass)"),
]

SINGLES: dict[int, str] = {
    0x2013: "en dash",
    0x2014: "em dash — the narration uses it heavily",
    0x2022: "bullet",
    0x2026: "ellipsis",
    0x2009: "thin space",
    0x202F: "narrow no-break space — joins values to units, 4 KB",
    0x2190: "← step back",
    0x2191: "↑",
    0x2192: "→ the pipeline tracker's separator",
    0x2193: "↓",
    0x21B5: "↵ the Run shortcut hint",
    0x21BA: "↺ reset",
    0x2212: "− zoom out (a minus, not a hyphen)",
    0x2260: "≠",
    0x2264: "≤",
    0x2265: "≥ hit-target copy",
    0x00B1: "±",
    0x2318: "⌘ the Run shortcut on Apple hardware",
    0x2500: "─ box drawing",
    0x2502: "│ playback controls and box drawing",
    0x250C: "┌",
    0x2510: "┐",
    0x2514: "└ trace printer",
    0x2518: "┘",
    0x251C: "├",
    0x252C: "┬",
    0x2534: "┴",
    0x253C: "┼",
    0x25A0: "■",
    0x25B6: "▶ play",
    0x25C0: "◀ step back",
    0x25CB: "○",
    0x25CF: "●",
    0x25D0: "◐ the theme toggle's system setting",
    0x2600: "☀ light theme",
    0x263E: "☾ dark theme",
    0x2713: "✓ index hit",
    0x2717: "✗ index miss",
    0x275A: "❚ pause",
}


def codepoints() -> list[int]:
    seen: set[int] = set()
    for lo, hi, _ in RANGES:
        seen.update(range(lo, hi + 1))
    seen.update(SINGLES)
    return sorted(seen)


# ---------------------------------------------------------------------------
# The two faces.
# ---------------------------------------------------------------------------


@dataclass
class Face:
    slug: str
    """Upstream directory under google/fonts/ofl."""
    upstream_file: str
    out_stem: str
    """Output basename. `querylens-*` per plan.md §17.3, so a subset is never
    mistaken for the complete upstream file it was cut from."""
    family: str
    """The family name the subset ships under — see the module docstring."""
    rename_from: str | None = None
    """Set only when the upstream declares a Reserved Font Name."""
    pin: dict[str, float] = field(default_factory=dict)
    """Variable axes to pin, dropping them from the file."""
    wght: tuple[int, int] = (400, 700)
    """The weight range kept. One variable file covers every weight in it."""
    fallback_local: str = "Arial"
    """The system face the adjusted-fallback @font-face binds to with `local()`.

    A `size-adjust` is a *ratio*, so it is only meaningful against the face the
    browser will really substitute during the swap. Measuring a monospace
    against Arial — which the first draft of this script did — produces a
    number that is arithmetically fine and physically meaningless."""
    fallback_file: str = "/System/Library/Fonts/Supplemental/Arial.ttf"
    """Where that face lives on this machine, so the ratio is measured rather
    than copied from a blog post. macOS paths: this script runs by hand."""


FACES = [
    Face(
        slug="jetbrainsmono",
        upstream_file="JetBrainsMono%5Bwght%5D.ttf",
        out_stem="querylens-mono",
        family="JetBrains Mono",
        # Courier New is the one monospace present on effectively every
        # platform, and Linux fontconfig maps it to the metric-compatible
        # Liberation Mono. Menlo would be a better *look* and a worse
        # reference: it does not exist off macOS.
        fallback_local="Courier New",
        fallback_file="/System/Library/Fonts/Supplemental/Courier New.ttf",
        # 400 regular through 700; the app's heaviest mono is 500.
        wght=(400, 700),
    ),
    Face(
        slug="ibmplexsans",
        upstream_file="IBMPlexSans%5Bwdth,wght%5D.ttf",
        out_stem="querylens-sans",
        family="QueryLens Sans",
        rename_from="Plex",
        # The width axis is never varied, and pinning it drops a whole axis of
        # deltas from a file that is otherwise the largest thing the page loads.
        pin={"wdth": 100.0},
        wght=(400, 700),
    ),
]


def fetch(url: str, dest: Path) -> None:
    with urlopen(url, timeout=60) as response:  # noqa: S310 — pinned host
        dest.write_bytes(response.read())


def run(*args: str) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"{args[0]} failed:\n{result.stdout}\n{result.stderr}")


# Records that keep the upstream wording even when the family is renamed.
#
#   0  copyright  — OFL clause 1 requires the notice to survive intact.
#  13  licence    — the OFL text itself.
#  14  licence URL
#   7  trademark  — "IBM Plex® is a trademark of IBM Corp" is a true statement
#                   about the upstream, and it is not ours to delete. It does
#                   not claim this file *is* Plex; the family name it might have
#                   claimed that with is the thing clause 3 makes us change, and
#                   that one does change, below.
KEEP_VERBATIM = frozenset({0, 7, 13, 14})

# PostScript-shaped records hold the compact, space-free spelling. 6 is the
# PostScript name, 25 the variations prefix, and everything from 256 up is a
# named-instance record — four of which (Regular/Medium/SemiBold/Bold) carried
# the reserved name straight through the first build of this script.
POSTSCRIPT_SHAPED = frozenset({3, 6, 20, 25})


def rename_family(path: Path, face: Face) -> None:
    """Strip a Reserved Font Name from every name-table record.

    OFL 1.1 clause 3 is about the *name*, not the file, so renaming the file
    alone would not comply. The name table spreads that name across a dozen
    records in two spellings — "IBM Plex Sans" in the human-readable ones and
    "IBMPlexSans" in the PostScript-shaped ones — plus one per named instance,
    and a Unique ID that also carries the vendor prefix. Missing any of them
    leaves the reserved name in a shipped file.
    """
    from fontTools.ttLib import TTFont

    font = TTFont(path)
    compact = face.family.replace(" ", "")

    # Longest first, so "IBM Plex Sans" is consumed before "IBM Plex" can take
    # a bite out of it and leave a stray "Sans" behind.
    spaced = [("IBM Plex Sans", face.family), ("IBM Plex", face.family)]
    tight = [("IBMPlexSans", compact), ("IBMPlex", compact)]

    renamed = 0
    for record in font["name"].names:
        value = str(record)
        if face.rename_from not in value or record.nameID in KEEP_VERBATIM:
            continue

        # A named instance is 256+; those are PostScript-shaped too.
        shaped = record.nameID in POSTSCRIPT_SHAPED or record.nameID >= 256
        for old, new in (tight + spaced) if shaped else (spaced + tight):
            value = value.replace(old, new)

        # nameID 3 is "VENDOR;PostScriptName;version;year" — the bare vendor
        # field survives both passes above and would still read "IBM".
        if record.nameID == 3:
            value = value.replace("IBM;", "QueryLens;", 1)

        record.string = value
        renamed += 1

    residual = [str(r) for r in font["name"].names if face.rename_from in str(r)]
    unexpected = [
        r for r in font["name"].names
        if face.rename_from in str(r) and r.nameID not in KEEP_VERBATIM
    ]
    if unexpected:
        sys.exit(
            f"{face.out_stem}: reserved name '{face.rename_from}' survives in "
            f"nameIDs {sorted({r.nameID for r in unexpected})} — the OFL clause 3 "
            f"rename is incomplete, refusing to ship it."
        )

    font.save(path)
    print(
        f"    renamed {renamed} name records → {face.family}; "
        f"{len(residual)} kept verbatim (copyright/trademark/licence)"
    )

    font.save(path)


def metrics(path: Path) -> dict[str, float]:
    """The numbers the fallback @font-face needs to avoid reflow on swap.

    Vertical shift comes from the ascent/descent/line-gap disagreeing between
    the fallback and the real face; horizontal shift comes from their average
    advance widths disagreeing. Both are measured here rather than copied from
    a blog post, because they change when the subset does.
    """
    from fontTools.ttLib import TTFont

    font = TTFont(path)
    upem = font["head"].unitsPerEm
    hhea = font["hhea"]

    # The alphabet weighted the way English actually uses it. A flat average
    # over every glyph in the file would be dominated by box-drawing characters
    # that appear once in the whole app.
    sample = "etaoinshrdlcumwfgypbvkjxqz ETAOINSHRDLCUMWFGYPBVKJXQZ0123456789"
    hmtx = font["hmtx"]
    cmap = font.getBestCmap()
    widths = [
        hmtx[cmap[ord(c)]][0] for c in sample if ord(c) in cmap and cmap[ord(c)] in hmtx.metrics
    ]

    return {
        "upem": float(upem),
        "ascent": hhea.ascender / upem,
        "descent": abs(hhea.descender) / upem,
        "line_gap": hhea.lineGap / upem,
        "avg_width": (sum(widths) / len(widths)) / upem,
    }


def local_avg_width(path: Path, index: int = 0) -> float:
    """Average advance width of a system fallback, on the same sample."""
    from fontTools.ttLib import TTFont

    font = TTFont(path, fontNumber=index) if path.suffix == ".ttc" else TTFont(path)
    upem = font["head"].unitsPerEm
    sample = "etaoinshrdlcumwfgypbvkjxqz ETAOINSHRDLCUMWFGYPBVKJXQZ0123456789"
    hmtx = font["hmtx"]
    cmap = font.getBestCmap()
    widths = [
        hmtx[cmap[ord(c)]][0] for c in sample if ord(c) in cmap and cmap[ord(c)] in hmtx.metrics
    ]
    return (sum(widths) / len(widths)) / upem


def build(face: Face, work: Path) -> dict[str, float]:
    source = work / f"{face.slug}.ttf"
    print(f"  ↓ {face.slug}", flush=True)
    fetch(f"{UPSTREAM}/{face.slug}/{face.upstream_file}", source)
    fetch(f"{UPSTREAM}/{face.slug}/OFL.txt", OUT / f"{face.out_stem}-OFL.txt")

    staged = work / f"{face.slug}-staged.ttf"
    shutil.copy(source, staged)

    # Pin the axes we never vary, and clamp the one we do. `varLib.instancer`
    # rewrites the deltas rather than merely ignoring them, so the weight we do
    # not ship stops costing bytes.
    limits = [f"{axis}={value}" for axis, value in face.pin.items()]
    limits.append(f"wght={face.wght[0]}:{face.wght[1]}")
    run(
        sys.executable, "-m", "fontTools.varLib.instancer",
        str(staged), *limits, "-o", str(staged),
    )

    if face.rename_from:
        rename_family(staged, face)

    stats = metrics(staged)

    unicodes = ",".join(f"U+{cp:04X}" for cp in codepoints())
    out_file = OUT / f"{face.out_stem}.woff2"
    run(
        sys.executable, "-m", "fontTools.subset",
        str(staged),
        f"--unicodes={unicodes}",
        # `tnum` is the reason this flag is explicit: plan.md §16.2 item 7 puts
        # `font-variant-numeric: tabular-nums` on every changing number, and
        # pyftsubset's default feature list drops it. Keeping everything costs
        # little on a set this small and cannot silently break a feature later.
        "--layout-features=*",
        "--flavor=woff2",
        "--desubroutinize",
        "--name-IDs=*",
        "--drop-tables+=DSIG",
        f"--output-file={out_file}",
    )

    kb = out_file.stat().st_size / 1024
    print(f"  ✓ {out_file.name}  {kb:.1f} kB  ({len(codepoints())} codepoints)")
    return stats


def main() -> None:
    try:
        import fontTools  # noqa: F401
    except ImportError:
        sys.exit("fontTools is required:  pip install 'fonttools[woff]' brotli")

    OUT.mkdir(parents=True, exist_ok=True)

    print("Building QueryLens webfonts")
    print(f"  glyph set: {len(codepoints())} codepoints")

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        stats = {face.out_stem: build(face, work) for face in FACES}

    # The fallback metrics, printed rather than written: they belong in
    # index.css beside the @font-face rules they adjust, where a reader can see
    # them, not in a generated file nobody opens.
    print("\nAdjusted-fallback metrics for src/index.css:")
    for face in FACES:
        m = stats[face.out_stem]
        reference = Path(face.fallback_file)
        print(f"  @font-face {{ font-family: '{face.family} Fallback';")
        print(f"    src: local('{face.fallback_local}');")
        print(f"    ascent-override: {m['ascent'] * 100:.2f}%;")
        print(f"    descent-override: {m['descent'] * 100:.2f}%;")
        print(f"    line-gap-override: {m['line_gap'] * 100:.2f}%;")
        if reference.exists():
            ratio = m["avg_width"] / local_avg_width(reference)
            print(f"    size-adjust: {ratio * 100:.2f}%;   /* measured vs {face.fallback_local} */")
        else:
            print(f"    /* {face.fallback_local} not found at {reference}; size-adjust omitted */")
        print("  }")

    print("\nCommit public/fonts/. Update public/fonts/README.md if a face changed.")


if __name__ == "__main__":
    main()
