#!/usr/bin/env python3
"""Generate the application icons from the source logo.

The source artwork carries a large transparent border, which would make the icon
look undersized next to every other icon in the taskbar. This crops to the
artwork, re-pads it to a square with a small uniform margin, and writes:

  apps/desktop/build/icon.png                     512x512, source for the window icon
  apps/desktop/build/icon.ico                     multi-resolution, for the packaged .exe
  apps/desktop/src/renderer/src/assets/logo.png   small, for the in-app header

Small sizes are downscaled individually with a high quality filter rather than
letting the ICO writer resize a single image, because a 16x16 produced by a
nearest-neighbour path is visibly mushy in the taskbar.

Usage: python tools/generate-icons.py [source.png]
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "logo.png"
OUTPUT_DIR = ROOT / "apps" / "desktop" / "build"
RENDERER_ASSET_DIR = ROOT / "apps" / "desktop" / "src" / "renderer" / "src" / "assets"

# Windows picks the closest entry for the surface it is drawing; supplying the
# whole ladder avoids it scaling one for you.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_SIZE = 512
# The header draws it at about 22 CSS pixels; 96 keeps it crisp at 200% scaling
# without shipping the full-size artwork into the renderer bundle.
RENDERER_LOGO_SIZE = 96

# Fraction of the artwork's longest edge left as breathing room on each side.
# Windows icons are conventionally drawn nearly edge to edge.
MARGIN_RATIO = 0.05


def square_with_margin(image: Image.Image) -> Image.Image:
    """Crop to the visible artwork and centre it on a square transparent canvas."""
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit("Source image is fully transparent")
    cropped = image.crop(bbox)

    longest = max(cropped.size)
    canvas_size = round(longest * (1 + 2 * MARGIN_RATIO))
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.paste(
        cropped,
        (
            (canvas_size - cropped.width) // 2,
            (canvas_size - cropped.height) // 2,
        ),
    )
    return canvas


def verify_ico(path: Path, expected: list[int]) -> None:
    """Read back the ICO directory and confirm every size is present.

    Cheap insurance: a silently truncated icon set is invisible until someone
    looks at the taskbar on a different DPI.
    """
    data = path.read_bytes()
    reserved, image_type, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or image_type != 1:
        raise SystemExit(f"{path} is not a valid ICO")
    found = []
    for index in range(count):
        offset = 6 + index * 16
        width = data[offset] or 256
        found.append(width)
    missing = sorted(set(expected) - set(found))
    if missing:
        raise SystemExit(f"{path} is missing sizes: {missing}")
    print(f"  {path.relative_to(ROOT)}  entries: {sorted(found)}")


def main() -> None:
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source_path.exists():
        raise SystemExit(f"Source image not found: {source_path}")

    source = Image.open(source_path).convert("RGBA")
    squared = square_with_margin(source)
    print(f"Source {source.size[0]}x{source.size[1]} -> squared {squared.size[0]}x{squared.size[1]}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    png_path = OUTPUT_DIR / "icon.png"
    squared.resize((PNG_SIZE, PNG_SIZE), Image.Resampling.LANCZOS).save(png_path, format="PNG")
    print(f"  {png_path.relative_to(ROOT)}  {PNG_SIZE}x{PNG_SIZE}")

    # Resize each entry ourselves so every size gets the good filter.
    layers = [
        squared.resize((size, size), Image.Resampling.LANCZOS) for size in sorted(ICO_SIZES)
    ]
    RENDERER_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    renderer_logo = RENDERER_ASSET_DIR / "logo.png"
    squared.resize(
        (RENDERER_LOGO_SIZE, RENDERER_LOGO_SIZE), Image.Resampling.LANCZOS
    ).save(renderer_logo, format="PNG", optimize=True)
    print(f"  {renderer_logo.relative_to(ROOT)}  {RENDERER_LOGO_SIZE}x{RENDERER_LOGO_SIZE}")

    ico_path = OUTPUT_DIR / "icon.ico"
    largest = layers[-1]
    largest.save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in sorted(ICO_SIZES)],
        append_images=layers[:-1],
    )
    verify_ico(ico_path, ICO_SIZES)


if __name__ == "__main__":
    main()
