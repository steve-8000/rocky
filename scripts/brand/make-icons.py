#!/usr/bin/env python3
"""Generate the Rocky icon set (macOS .icns, Windows .ico, Linux PNGs).

Draws a faceted rock mark on a dark rounded-square tile and writes every
size the vendored desktop build expects under packages/desktop/assets/.

Usage: python3 make-icons.py <desktop-assets-dir>
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

BASE = 1024
BG_TOP = (38, 42, 54)
BG_BOTTOM = (18, 20, 28)
ROCK_FACES = [
    # polygon (normalized coords), fill
    ([(0.50, 0.16), (0.78, 0.34), (0.50, 0.50)], (235, 137, 52)),
    ([(0.50, 0.16), (0.22, 0.34), (0.50, 0.50)], (255, 170, 80)),
    ([(0.22, 0.34), (0.18, 0.66), (0.50, 0.50)], (214, 116, 38)),
    ([(0.78, 0.34), (0.82, 0.66), (0.50, 0.50)], (188, 96, 28)),
    ([(0.18, 0.66), (0.50, 0.84), (0.50, 0.50)], (240, 148, 60)),
    ([(0.82, 0.66), (0.50, 0.84), (0.50, 0.50)], (164, 80, 22)),
]


def rounded_tile(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * 0.225)
    # vertical gradient
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel(
            (0, y),
            tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,),
        )
    grad = grad.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    for points, fill in ROCK_FACES:
        draw.polygon([(x * size, y * size) for x, y in points], fill=fill)
    return img


def make_icns(master: Image.Image, out_path: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "Rocky.iconset"
        iconset.mkdir()
        for pt in (16, 32, 128, 256, 512):
            master.resize((pt, pt), Image.LANCZOS).save(iconset / f"icon_{pt}x{pt}.png")
            master.resize((pt * 2, pt * 2), Image.LANCZOS).save(
                iconset / f"icon_{pt}x{pt}@2x.png"
            )
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(out_path)], check=True
        )


def main() -> None:
    assets = Path(sys.argv[1]).expanduser()
    assets.mkdir(parents=True, exist_ok=True)
    master = rounded_tile(BASE)

    master.resize((512, 512), Image.LANCZOS).save(assets / "icon.png")
    for size in (32, 64, 128):
        master.resize((size, size), Image.LANCZOS).save(assets / f"{size}x{size}.png")
    master.resize((256, 256), Image.LANCZOS).save(assets / "128x128@2x.png")
    master.save(
        assets / "icon.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    make_icns(master, assets / "icon.icns")
    print(f"wrote Rocky icons to {assets}")


if __name__ == "__main__":
    main()
