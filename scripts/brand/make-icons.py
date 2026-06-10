#!/usr/bin/env python3
"""Generate the complete Rocky brand asset set from one faceted-rock mark.

Usage:
    python3 scripts/brand/make-icons.py <repo-root>

Writes:
    core/packages/desktop/assets/        icon.icns / icon.ico / linux PNGs
    core/packages/app/assets/images/     expo icon, splash, android, favicons
    core/packages/app/public/            pwa icons, apple-touch-icon
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

BASE = 1024

# Warm charcoal tile behind the copper rock (matches app theme surface0 #1B1916)
BG_TOP = (43, 38, 32)
BG_BOTTOM = (20, 17, 14)

# Asymmetric faceted peak — same geometry as RockyLogo (rocky-logo.tsx),
# copper palette graded by facet opacity (light from upper-left).
ROCK_FACES = [
    # polygon (normalized coords), fill
    ([(0.44, 0.10), (0.22, 0.44), (0.48, 0.54)], (247, 170, 96)),   # apex left (highlight)
    ([(0.44, 0.10), (0.48, 0.54), (0.74, 0.32)], (226, 142, 66)),   # apex right
    ([(0.22, 0.44), (0.14, 0.80), (0.48, 0.54)], (236, 156, 80)),   # left flank
    ([(0.48, 0.54), (0.14, 0.80), (0.58, 0.88)], (204, 120, 48)),   # bottom-left
    ([(0.74, 0.32), (0.48, 0.54), (0.88, 0.74)], (178, 98, 36)),    # right flank
    ([(0.48, 0.54), (0.88, 0.74), (0.58, 0.88)], (150, 78, 26)),    # bottom-right
]

STATUS_COLORS = {
    "running": (59, 130, 246),    # blue
    "attention": (245, 158, 11),  # amber
}


def draw_rock(draw: ImageDraw.ImageDraw, size: int, mono: tuple[int, int, int] | None = None) -> None:
    for i, (points, fill) in enumerate(ROCK_FACES):
        if mono is not None:
            # opacity-stepped mono variant (matches RockyLogo facet opacities)
            opacities = [255, 217, 230, 184, 158, 122]
            fill = mono + (opacities[i],)
        draw.polygon([(x * size, y * size) for x, y in points], fill=fill)


def rounded_tile(size: int, radius_ratio: float = 0.225) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel(
            (0, y),
            tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,),
        )
    grad = grad.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    img.paste(grad, (0, 0), mask)
    draw_rock(ImageDraw.Draw(img), size)
    return img


def bare_rock(size: int, mono: tuple[int, int, int] | None = None) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_rock(ImageDraw.Draw(img), size, mono=mono)
    return img


def favicon(size: int, scheme: str, status: str | None) -> Image.Image:
    mono = (245, 245, 244) if scheme == "dark" else (26, 24, 20)
    img = bare_rock(size, mono=mono)
    if status:
        draw = ImageDraw.Draw(img)
        r = size * 0.18
        cx = cy = size * 0.78
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=STATUS_COLORS[status] + (255,))
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
    root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.cwd()
    desktop = root / "core/packages/desktop/assets"
    images = root / "core/packages/app/assets/images"
    public = root / "core/packages/app/public"
    for d in (desktop, images, public):
        d.mkdir(parents=True, exist_ok=True)

    master = rounded_tile(BASE)

    # Desktop (electron-builder)
    master.resize((512, 512), Image.LANCZOS).save(desktop / "icon.png")
    for size in (32, 64, 128):
        master.resize((size, size), Image.LANCZOS).save(desktop / f"{size}x{size}.png")
    master.resize((256, 256), Image.LANCZOS).save(desktop / "128x128@2x.png")
    master.save(
        desktop / "icon.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    make_icns(master, desktop / "icon.icns")

    # Expo app images
    master.resize((1024, 1024), Image.LANCZOS).save(images / "icon.png")
    master.resize((48, 48), Image.LANCZOS).save(images / "favicon.png")
    bare_rock(1024).resize((512, 512), Image.LANCZOS).save(images / "android-icon-foreground.png")
    bare_rock(1024, mono=(255, 255, 255)).resize((96, 96), Image.LANCZOS).save(
        images / "notification-icon.png"
    )
    # splash: bare rock centered on transparent canvas
    splash = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    rock = bare_rock(640)
    splash.paste(rock, ((1024 - 640) // 2, (1024 - 640) // 2), rock)
    splash.save(images / "splash-icon.png")

    # Status favicons (web tab indicator)
    for scheme in ("dark", "light"):
        for status in (None, "running", "attention"):
            suffix = f"-{status}" if status else ""
            favicon(96, scheme, status).resize((48, 48), Image.LANCZOS).save(
                images / f"favicon-{scheme}{suffix}.png"
            )

    # PWA / web public
    master.resize((192, 192), Image.LANCZOS).save(public / "pwa-icon-192.png")
    master.resize((512, 512), Image.LANCZOS).save(public / "pwa-icon-512.png")
    master.resize((180, 180), Image.LANCZOS).save(public / "apple-touch-icon.png")

    print(f"wrote Rocky brand assets under {root}")


if __name__ == "__main__":
    main()
