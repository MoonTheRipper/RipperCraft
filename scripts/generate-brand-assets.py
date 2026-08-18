#!/usr/bin/env python3
"""Derive the served brand assets from the master RipperCraft logo.

The dashboard ships with no build step and no runtime dependencies, so the
generated PNGs are committed rather than produced at install time. This script
exists to make that regeneratable: point it at a new master logo, re-run it, and
commit what it writes.

    python3 scripts/generate-brand-assets.py

Requires Pillow (`pip install pillow`), which is a developer tool only - nothing
at runtime imports it.

Why the master is not simply served as-is: it is a 1024x1024, 1.4MB PNG whose
subject occupies a landscape band with a lot of empty canvas above and below.
Scaled straight down to 16px the scythe becomes a few unreadable pixels. Every
square output here is therefore cropped to the artwork's actual bounds and
re-centred, so the subject fills the frame at every size.
"""

import pathlib
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - developer tooling
    sys.exit("Pillow is required: pip install pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "RipperCraftLogo.png"
PUBLIC = ROOT / "public"

# Matches --c-bg / theme_color. Icons that land on an OS surface (tab strip,
# home screen, task switcher) need an opaque plate; a transparent logo picks up
# whatever is behind it and the red glow disappears against a dark tab bar.
PLATE = (15, 19, 23, 255)

# Alpha below this is the outer glow fading to nothing. Cropping on it rather
# than on any non-zero pixel keeps a faint halo tail from padding the box out.
ALPHA_FLOOR = 8
# Kept around the cropped subject so the glow is not sliced flat at the edge.
GLOW_MARGIN = 24


def trimmed_subject(image):
    """The artwork's real bounds, plus a little room for its glow."""
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value >= ALPHA_FLOOR else 0)
    box = mask.getbbox()
    if not box:
        sys.exit(f"{SOURCE} appears to be fully transparent")

    left, top, right, bottom = box
    width, height = image.size
    return image.crop(
        (
            max(0, left - GLOW_MARGIN),
            max(0, top - GLOW_MARGIN),
            min(width, right + GLOW_MARGIN),
            min(height, bottom + GLOW_MARGIN),
        )
    )


def square(subject, size, pad_ratio, plate=None):
    """Centre the subject on a square canvas, scaled to leave `pad_ratio` free."""
    side = max(subject.size)
    canvas_side = int(round(side * (1 + 2 * pad_ratio)))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), plate or (0, 0, 0, 0))
    canvas.alpha_composite(
        subject,
        ((canvas_side - subject.width) // 2, (canvas_side - subject.height) // 2),
    )
    return canvas.resize((size, size), Image.LANCZOS)


def save(image, name):
    target = PUBLIC / name
    image.save(target, optimize=True)
    print(f"  {name:28} {target.stat().st_size / 1024:6.1f} KB  {image.size[0]}x{image.size[1]}")


def main():
    if not SOURCE.exists():
        sys.exit(f"master logo not found: {SOURCE}")

    master = Image.open(SOURCE).convert("RGBA")
    subject = trimmed_subject(master)
    print(f"master {master.size[0]}x{master.size[1]} -> subject {subject.size[0]}x{subject.size[1]}")

    # In-app brand mark. Transparent, because it sits on the dashboard's own
    # surface and has to work in both the light and dark themes.
    wide = subject.copy()
    wide.thumbnail((512, 512), Image.LANCZOS)
    save(wide, "logo.png")

    # Progressive web app icons. "any" keeps a normal margin; the maskable
    # variant holds the 20% safe zone launchers crop into a circle or squircle.
    save(square(subject, 512, 0.08, PLATE), "icon-512.png")
    save(square(subject, 192, 0.08, PLATE), "icon-192.png")
    save(square(subject, 512, 0.22, PLATE), "icon-maskable-512.png")

    # iOS home screen. Always composited onto an opaque rounded rect, so it is
    # rendered on the plate rather than left transparent.
    save(square(subject, 180, 0.10, PLATE), "apple-touch-icon.png")

    # Browser tabs. Tighter padding: at 16px every pixel of subject counts.
    save(square(subject, 32, 0.04, PLATE), "favicon-32.png")
    save(square(subject, 16, 0.04, PLATE), "favicon-16.png")

    # A real .ico as well: some browsers and most bookmark/pinned-tile paths ask
    # for /favicon.ico directly regardless of the declared link tags.
    ico = square(subject, 64, 0.04, PLATE)
    ico.save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  {'favicon.ico':28} {(PUBLIC / 'favicon.ico').stat().st_size / 1024:6.1f} KB  16/32/48")


if __name__ == "__main__":
    main()
