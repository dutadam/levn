#!/usr/bin/env python3
"""Levn Faz 5 — Renk swatch'lerinden sayısal palet üret (v2).

v2 iyileştirmeleri:
  • Dominant RGB: LAB uzayında trimlenmiş ortalama (histogram bucket mode
    yerine). Daha stabil, renk algısıyla tutarlı.
  • L_std, a_std, b_std: swatch'ın LAB dağılımının genişliği — histogram
    spec için runtime'da kullanılır (mean+std matching).
  • Trim %5-%95: aşırı aydınlık/karanlık vignette ve noise dışlanır.

Her color_assets.json girişindeki swatch JPEG'inin merkez %60 bölgesinden
robust istatistik çıkarır; HSL ve LAB dönüşümleri + dağılım genişliğini
kaydeder. Bu veri runtime'da k-means küme → renk kodu eşlemesi ve
histogram-spec renk değişimi için kullanılır.

Çıktı: data/color_palette.json
{
  "1621": {
    "rgb": [232, 220, 200],
    "hsl": [36, 0.28, 0.85],
    "lab": [88.2, 2.1, 14.3],
    "lab_std": [4.1, 0.8, 1.5],
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


def dominant_lab_stats(img_path: Path):
    """Swatch'ın LAB uzayında trimlenmiş ortalamasını ve std'lerini döndür.

    Returns: ((L,a,b) mean, (L,a,b) std, (r,g,b) mean) veya None.
    """
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

    # Her piksel için LAB hesapla
    labs = [rgb_to_lab(r, g, b) for r, g, b in pixels]
    labs.sort(key=lambda t: t[0])  # L'ye göre sırala, outlier kırpma için
    lo = int(len(labs) * 0.05)
    hi = int(len(labs) * 0.95)
    trimmed = labs[lo:hi] if hi > lo else labs
    n = len(trimmed)
    # Mean
    sumL = sum(t[0] for t in trimmed)
    suma = sum(t[1] for t in trimmed)
    sumb = sum(t[2] for t in trimmed)
    meanL, meana, meanb = sumL / n, suma / n, sumb / n
    # Std
    varL = sum((t[0] - meanL) ** 2 for t in trimmed) / n
    vara = sum((t[1] - meana) ** 2 for t in trimmed) / n
    varb = sum((t[2] - meanb) ** 2 for t in trimmed) / n
    stdL, stda, stdb = math.sqrt(varL), math.sqrt(vara), math.sqrt(varb)
    # LAB mean → RGB geri dönüş (hex için)
    r, g, b = lab_to_rgb(meanL, meana, meanb)
    return (
        (round(meanL, 2), round(meana, 2), round(meanb, 2)),
        (round(stdL, 2), round(stda, 2), round(stdb, 2)),
        (r, g, b),
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


def lab_to_rgb(L: float, a: float, b_: float) -> tuple[int, int, int]:
    """D65 LAB → sRGB 8-bit. recolor.js'teki ile aynı math."""
    fy = (L + 16) / 116
    fx = a / 500 + fy
    fz = fy - b_ / 200

    def finv(t: float) -> float:
        t3 = t ** 3
        return t3 if t3 > 0.008856 else (t - 16 / 116) / 7.787

    x = finv(fx) * 0.95047
    y = finv(fy) * 1.0
    z = finv(fz) * 1.08883
    rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
    gl = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
    bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252

    def linear_to_srgb(u: float) -> int:
        u = max(0.0, min(1.0, u))
        v = u * 12.92 if u <= 0.0031308 else 1.055 * (u ** (1 / 2.4)) - 0.055
        return max(0, min(255, round(v * 255)))

    return linear_to_srgb(rl), linear_to_srgb(gl), linear_to_srgb(bl)


def hex_of(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def main() -> int:
    if not COLOR_ASSETS_JSON.exists():
        print(f"[err] {COLOR_ASSETS_JSON} yok", file=sys.stderr)
        return 1

    assets = json.loads(COLOR_ASSETS_JSON.read_text("utf-8"))
    palette: dict[str, dict] = {}  # {code: {tip: {rgb, hsl, lab, lab_std, hex, source}}}
    missing = 0
    total_pairs = 0

    # Yeni yapı: assets[code] = {tip: {file, mode, ...}} (tip-aware)
    for code, per_tip in assets.items():
        # Legacy: bazı girişler eski flat formatta olabilir (yalnız backward-compat)
        if not isinstance(per_tip, dict) or "file" in per_tip:
            # Eski flat format — yok sayılır, migrate edilmeli
            print(f"[warn] {code}: eski flat format, migrate edin", file=sys.stderr)
            continue

        code_entry: dict[str, dict] = {}
        for tip, info in per_tip.items():
            total_pairs += 1
            file_rel = info.get("file") if isinstance(info, dict) else None
            if not file_rel:
                file_rel = f"assets/colors/{code}_{tip}.jpg"
            img_path = ROOT / file_rel
            if not img_path.exists():
                print(f"[skip] {code}_{tip}: {file_rel} bulunamadı", file=sys.stderr)
                missing += 1
                continue

            stats = dominant_lab_stats(img_path)
            if stats is None:
                missing += 1
                continue

            (lab_mean, lab_std, rgb_mean) = stats
            # ★ Kalite kontrol: σ_a veya σ_b > 6 ise görsel heterojen (multi-color),
            # tek-renk swatch değil. Bu LAB güvenilmez → atla, residual extraction alsın.
            # Sadece plain_primary/primary gibi güvensiz mod'lar için kontrol et
            # (plain_single σ'lar genelde düşük = düz renk).
            mode = info.get("mode") if isinstance(info, dict) else None
            if mode and mode != "plain_single":
                if lab_std[1] > 6.0 or lab_std[2] > 6.0:
                    print(f"[skip] {code}_{tip}: heterojen görsel (σ_a={lab_std[1]:.1f}, σ_b={lab_std[2]:.1f}, mode={mode})", file=sys.stderr)
                    missing += 1
                    continue

            r, g, b = rgb_mean
            code_entry[tip] = {
                "rgb": [r, g, b],
                "hsl": list(rgb_to_hsl(r, g, b)),
                "lab": list(lab_mean),
                "lab_std": list(lab_std),
                "hex": hex_of(r, g, b),
                "source": mode,
            }
        if code_entry:
            palette[code] = code_entry

    OUTPUT_JSON.write_text(
        json.dumps(palette, ensure_ascii=False, indent=2, sort_keys=True), "utf-8"
    )
    n_codes = len(palette)
    n_pairs = sum(len(v) for v in palette.values())
    print(f"[ok] {n_codes} kod, {n_pairs} (code,tip) çifti → {OUTPUT_JSON.relative_to(ROOT)} ({missing} eksik)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
