#!/usr/bin/env python3
"""
Rasterise the QueryLens mark (plan.md §16.2 item 8).

    python3 scripts/build-icons.py

`public/favicon.svg` is the source of truth for the mark and stays the icon
modern browsers use. What it cannot be is an `apple-touch-icon`: iOS ignores SVG
there and falls back to screenshotting the page, which produces a home-screen
tile of grey text. So one PNG is generated from the same geometry, and — because
two files holding the same drawing is how they drift — the geometry lives here
once and the script asserts it still matches the SVG's numbers.

Outputs:
  public/apple-touch-icon.png   180×180, no alpha, square (iOS masks corners)
  public/icon-192.png           192×192 and 512×512: the manifest's install icons (plan.md §H1)
  public/icon-512.png
  build/icon-16.png             a legibility check, not shipped

Requires Pillow, which is also what the check renders through. No rasteriser
(rsvg, Inkscape, ImageMagick) is needed, because the mark is four rectangles, a
circle and a line — drawing it directly is more faithful than shelling out to a
renderer that may not be installed.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "public" / "favicon.svg"
PUBLIC = ROOT / "public"
CHECK_DIR = ROOT / "build"

# The mark, in the SVG's own 32×32 coordinate space. Kept here so the drawing
# below is readable; verified against favicon.svg by `check_svg_matches()`, so
# an edit to one without the other fails the build rather than shipping two
# different logos.
BG = "#090913"
PAGE = "#ae94ff"
LENS = "#ffa264"

PAGES = [  # x, y, w, h, radius, opacity — the storage layer the product is about
    (7, 7.0, 13, 4, 1.4, 1.00),
    (7, 13.5, 13, 4, 1.4, 0.62),
    (7, 20.0, 13, 4, 1.4, 0.45),
]
LENS_CIRCLE = (20.5, 18, 6.4, 2.1)  # cx, cy, r, stroke
LENS_HANDLE = (25, 22.5, 28, 25.5, 2.1)  # x1, y1, x2, y2, stroke


def check_svg_matches() -> None:
    """Fail loudly if favicon.svg has moved on without this file."""
    svg = SVG.read_text()
    expected = [
        f'fill="{BG}"',
        f'fill="{PAGE}"',
        f'stroke="{LENS}"',
        f'cx="{LENS_CIRCLE[0]}" cy="{LENS_CIRCLE[1]}" r="{LENS_CIRCLE[2]}"',
    ]
    missing = [token for token in expected if token not in svg]
    if missing:
        sys.exit(
            "favicon.svg no longer matches the geometry in this script:\n  "
            + "\n  ".join(missing)
            + "\n\nUpdate scripts/build-icons.py to match, then re-run."
        )

    # The three page bars, read back out of the SVG rather than trusted.
    bars = re.findall(r'<rect x="7" y="([\d.]+)"', svg)
    if [float(y) for y in bars] != [p[1] for p in PAGES]:
        sys.exit(f"page bar positions differ: svg={bars} script={[p[1] for p in PAGES]}")


def blend(hex_colour: str, opacity: float, over: str) -> tuple[int, int, int]:
    """Flatten an opacity onto the background.

    The SVG uses `opacity` on the lower two page bars; a PNG for iOS must have
    no alpha at all (a transparent apple-touch-icon renders black on the home
    screen), so the blend happens here instead of in the compositor.
    """
    fg = tuple(int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))
    bg = tuple(int(over[i : i + 2], 16) for i in (1, 3, 5))
    return tuple(round(f * opacity + b * (1 - opacity)) for f, b in zip(fg, bg))


def render(size: int, *, rounded: bool) -> Image.Image:
    """Draw the mark at `size`, supersampled 8× and resampled down.

    Supersampling rather than antialiased primitives because Pillow's drawing
    is aliased: at 16px the difference between this and a direct draw is the
    difference between a legible mark and a handful of stray pixels.
    """
    scale = 8
    px = size * scale
    unit = px / 32  # SVG user units → device pixels

    image = Image.new("RGB", (px, px), BG)
    draw = ImageDraw.Draw(image)

    if rounded:
        # The SVG's own rx=7. Only for the favicon check; iOS applies its own
        # mask to apple-touch-icon and a second radius shows as a dark fringe.
        mask = Image.new("L", (px, px), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, px - 1, px - 1), radius=7 * unit, fill=255
        )
    else:
        mask = None

    for x, y, w, h, radius, opacity in PAGES:
        draw.rounded_rectangle(
            (x * unit, y * unit, (x + w) * unit, (y + h) * unit),
            radius=radius * unit,
            fill=blend(PAGE, opacity, BG),
        )

    cx, cy, r, stroke = LENS_CIRCLE
    draw.ellipse(
        ((cx - r) * unit, (cy - r) * unit, (cx + r) * unit, (cy + r) * unit),
        outline=LENS,
        width=round(stroke * unit),
    )

    x1, y1, x2, y2, stroke = LENS_HANDLE
    draw.line(
        (x1 * unit, y1 * unit, x2 * unit, y2 * unit), fill=LENS, width=round(stroke * unit)
    )
    # Pillow has no line-cap option; the SVG's `stroke-linecap="round"` is two
    # dots at the ends.
    for ex, ey in ((x1, y1), (x2, y2)):
        rr = stroke * unit / 2
        draw.ellipse((ex * unit - rr, ey * unit - rr, ex * unit + rr, ey * unit + rr), fill=LENS)

    image = image.resize((size, size), Image.LANCZOS)
    if mask is not None:
        flat = Image.new("RGB", (size, size), BG)
        flat.paste(image, (0, 0), mask.resize((size, size), Image.LANCZOS))
        image = flat
    return image


def main() -> None:
    check_svg_matches()

    # 180×180 is the size current iPhones ask for; iOS downsamples for every
    # other slot, and shipping one file beats shipping eight that rot.
    touch = PUBLIC / "apple-touch-icon.png"
    render(180, rounded=False).save(touch, optimize=True)
    print(f"  ✓ {touch.relative_to(ROOT)}  {touch.stat().st_size / 1024:.1f} kB")

    # Chrome asks for both sizes before it will offer an install; the manifest names them.
    for size in (192, 512):
        out = PUBLIC / f"icon-{size}.png"
        render(size, rounded=False).save(out, optimize=True)
        print(f"  ✓ {out.relative_to(ROOT)}  {out.stat().st_size / 1024:.1f} kB")

    # plan.md §16.2 item 8 asks for a check that the mark still reads at 16px —
    # "most marks do not". Written where it can be looked at, not shipped.
    CHECK_DIR.mkdir(exist_ok=True)
    for size in (16, 32, 64):
        out = CHECK_DIR / f"icon-{size}.png"
        render(size, rounded=True).resize((size * 8, size * 8), Image.NEAREST).save(out)
        print(f"  ✓ {out.relative_to(ROOT)}  (shown at 8× for inspection)")


if __name__ == "__main__":
    main()
