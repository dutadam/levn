#!/usr/bin/env python3
"""Levn Faz 5 — Renk swatch'lerinden sayısal palet üret.

Her color_assets.json girişindeki swatch JPEG'inin merkez %60 bölgesinden
histogram-dominant RGB çıkarır; ayrıca HSL ve LAB dönüşümlerini kaydeder.
Bu veri runtime'da k-means küme → renk kodu eşlemesi için kullanılır.

Çıktı: data/color_palette.json
{
  "1621": {
    "rgb": [232, 220, 200],
    "hsl": [36, 0.28, 0.85],
    "lab": [88.2, 2.1, 14.3],
    "hex": "#e8dcc8",
    "source": "plain_single"
  },
  ...
}

Kullanım:
  python3 scripts/extract_color_palette.py
"""
from __future__ import annotations

import colorsys
import json
import math
import os
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS_COLORS = ROOT / "assets" / "colors"
COLOR_ASSETS_JSON = ROOT / "data" / "color_assets.json"
OUTPUT_JSON = ROOT / "data" / "color_palette.json"

# Merkez crop oranı — kenarlardaki gölge/vignette'i dışlar
CENTER_FRAC = 0.6
# Histogram bucket boyutu — 16x16x16 = 4096 bucket (8-bit kanal bazında 4'er bit)
BUCKET_BITS = 4
BUCKET_SIZE = 1 << (8 - BUCKET_BITS)  # 16

# Örnekleme: büyük JPEG'lerde piksel sayısı azaltmak için thumbnail
MAX_SIDE = 200


def center_crop(img: Image.Image, frac: float = CENTER_FRAC) -> Image.Image:
    w, h = img.size
    cw, ch = int(w * frac), int(h * frac)
    x0 = (w - cw) // 2
    y0 = (h - ch) // 2
    return img.crop((x0, y0, x0 + cw, y0 + ch))


def dominant_rgb(img_path: Path) -> tuple[int, int, int] | None:
    try:
        with Image.open(img_path) as im:
            im = im.convert("RGB")
            im.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
            im = center_crop(im)
            pixels = list(im.getdata())
    except Exception as e:
        print(f"[warn] {img_path.name}: {e}", file=sys.stderr)
        return None

    if not pixels:
        return None

    # Bucket'la quantize ederek dominant bucket'ı bul
    buckets = Counter()
    for r, g, b in pixels:
        bk = (r // BUCKET_SIZE, g // BUCKET_SIZE, b // BUCKET_SIZE)
        buckets[bk] += 1

    # En kalabalık top 3 bucket'ın ağırlıklı ortalamasını al
    # (tek bucket çok kaba kaçar, histogram tepesi yumuşasın)
    top = buckets.most_common(3)
    total = sum(c for _, c in top)
    r_sum = g_sum = b_sum = 0
    for (r, g, b), c in top:
        # Bucket merkezine doğru kaydır
        r_sum += (r * BUCKET_SIZE + BUCKET_SIZE // 2) * c
        g_sum += (g * BUCKET_SIZE + BUCKET_SIZE // 2) * c
        b_sum += (b * BUCKET_SIZE + BUCKET_SIZE // 2) * c

    return (
        min(255, max(0, round(r_sum / total))),
        min(255, max(0, round(g_sum / total))),
        min(255, max(0, round(b_sum / total))),
    )


def rgb_to_hsl(r: int, g: int, b: int) -> tuple[float, float, float]:
    rn, gn, bn = r / 255.0, g / 255.0, b / 255.0
    h, l, s = colorsys.rgb_to_hls(rn, gn, bn)
    return (round(h * 360, 1), round(s, 3), round(l, 3))


def rgb_to_lab(r: int, g: int, b: int) -> tuple[float, float, float]:
    """sRGB → linear → XYZ → D65 LAB. Referans: CIE / EasyRGB."""
    def linearize(u: float) -> float:
        u /= 255.0
        return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4

    rl, gl, bl = linearize(r), linearize(g), linearize(b)
    # sRGB → XYZ (D65)
    x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
    y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
    z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
    # Normalize to D65 white (X=0.95047, Y=1.0, Z=1.08883)
    xn, yn, zn = x / 0.95047, y / 1.0, z / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t + 16 / 116)

    fx, fy, fz = f(xn), f(yn), f(zn)
    L = 116 * fy - 16
    a = 500 * (fx - fy)
    b_ = 200 * (fy - fz)
    return (round(L, 2), round(a, 2), round(b_, 2))


def hex_of(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def main() -> int:
    if not COLOR_ASSETS_JSON.exists():
        print(f"[err] {COLOR_ASSETS_JSON} yok", file=sys.stderr)
        return 1

    assets = json.loads(COLOR_ASSETS_JSON.read_text("utf-8"))
    palette: dict[str, dict] = {}
    missing = 0

    for code, info in assets.items():
        file_rel = info.get("file") if isinstance(info, dict) else None
        if not file_rel:
            # Fallback: code'dan türet
            file_rel = f"assets/colors/{code}.jpg"
        img_path = ROOT / file_rel
        if not img_path.exists():
            print(f"[skip] {code}: {file_rel} bulunamadı", file=sys.stderr)
            missing += 1
            continue

        rgb = dominant_rgb(img_path)
        if rgb is None:
            missing += 1
            continue

        r, g, b = rgb
        palette[code] = {
            "rgb": [r, g, b],
            "hsl": list(rgb_to_hsl(r, g, b)),
            "lab": list(rgb_to_lab(r, g, b)),
            "hex": hex_of(r, g, b),
            "source": info.get("mode") if isinstance(info, dict) else None,
        }

    OUTPUT_JSON.write_text(
        json.dumps(palette, ensure_ascii=False, indent=2, sort_keys=True), "utf-8"
    )
    print(f"[ok] {len(palette)} renk → {OUTPUT_JSON.relative_to(ROOT)} ({missing} eksik)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
