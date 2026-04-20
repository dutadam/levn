#!/usr/bin/env python3
"""Levn — Eksik renk kodları için palette LAB çıkar (residual cluster yaklaşımı).

Problem:
  Halı başlıkları "CURVE AÇIK KAHVE - KAKAO HALI" gibi 2 renk ismi içerir
  ama SKU `3344-A-6921-4131-0126` 3 kod barındırır. Son kod (0126) bir
  "accent color" — plain halısı yok, ismi title'da geçmiyor.

  197 kodun 105'i bu durumda → recolor motoru bu kodlar için random seed
  kullanıyordu → kötü sonuç.

Çözüm (residual cluster):
  1. Eksik kod C için, C'yi içeren halıları bul
  2. Her halıda:
     a. Halı görselini thumbnail olarak indir
     b. k-means ile k=len(codes) cluster'a ayır
     c. Bilinen renkler için palette LAB'ı seed olarak kullan
     d. Eksik renkler için rastgele piksel seed
     e. K-means iterasyonları sonrası, bilinen renklerin cluster'larını
        palette LAB'a en yakın olanlarla eşle — kalan cluster = eksik renk
  3. C'nin tüm tahminlerini ağırlıklı (cluster piksel sayısına göre) ortala
  4. Sonuç: C için palette LAB + lab_std

Kullanım:
  python3 scripts/extract_missing_palette.py
"""
from __future__ import annotations

import colorsys
import json
import math
import sys
import time
import urllib.request
from pathlib import Path
from collections import defaultdict

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "assets" / "rug_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Parametreler
THUMB_SIDE = 512         # Halı görselinin indirileceği boyut (hız için)
KMEANS_ITER = 15
MAX_RUGS_PER_CODE = 3    # Her eksik kod için en fazla kaç halıdan örneklesin
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def srgb_to_lin(u):
    u = u / 255.0
    return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb):
    r, g, b = [srgb_to_lin(c) for c in rgb]
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.0
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883
    def f(t): return t ** (1/3) if t > 0.008856 else 7.787 * t + 16/116
    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def rgb_to_lab_arr(arr):
    """Vectorized RGB→LAB for Nx3 uint8 array."""
    rgb = arr.astype(np.float64) / 255.0
    # sRGB → linear
    mask = rgb <= 0.04045
    lin = np.where(mask, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[:, 0], lin[:, 1], lin[:, 2]
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.0
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883
    def f(t): return np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16/116)
    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=1)


def download_thumb(url: str, code: str, pid: str) -> Path | None:
    """Halı görselini cache'e indir."""
    fname = CACHE_DIR / f"{pid}.jpg"
    if fname.exists() and fname.stat().st_size > 2048:
        return fname
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
        if len(data) < 2048:
            return None
        fname.write_bytes(data)
        time.sleep(0.3)
        return fname
    except Exception as e:
        print(f"  [warn] download fail {code} {url}: {e}", file=sys.stderr)
        return None


def seeded_kmeans(pixels_lab, seeds, seeds_mask, max_iter=15):
    """K-means with fixed seeds for some clusters, random for others.

    pixels_lab: (N, 3) array
    seeds: (k, 3) initial cluster centers
    seeds_mask: (k,) bool — True = fixed (don't drift), False = free

    Returns: final centers (k, 3), labels (N,), counts (k,)
    """
    k = seeds.shape[0]
    centers = seeds.copy()
    n = len(pixels_lab)

    for it in range(max_iter):
        # Assign
        # Distance matrix (N, k)
        dists = np.sum((pixels_lab[:, None, :] - centers[None, :, :]) ** 2, axis=2)
        labels = np.argmin(dists, axis=1)
        # Update
        new_centers = centers.copy()
        for j in range(k):
            mask = labels == j
            if mask.sum() > 0:
                new_centers[j] = pixels_lab[mask].mean(axis=0)
        # Fixed seeds pull back toward original (soft anchor — max drift 8 ΔE)
        for j in range(k):
            if seeds_mask[j]:
                d = np.linalg.norm(new_centers[j] - seeds[j])
                if d > 8:
                    t = 8 / d
                    new_centers[j] = seeds[j] + (new_centers[j] - seeds[j]) * t
        if np.allclose(new_centers, centers, atol=0.1):
            break
        centers = new_centers

    # Final counts
    dists = np.sum((pixels_lab[:, None, :] - centers[None, :, :]) ** 2, axis=2)
    labels = np.argmin(dists, axis=1)
    counts = np.array([(labels == j).sum() for j in range(k)])
    return centers, labels, counts


def main():
    rugs = json.load(open(DATA_DIR / "rug_db.json"))
    palette = json.load(open(DATA_DIR / "color_palette.json"))

    # Tüm kodları bul
    codes_in_rugs = set()
    for r in rugs:
        sp = r.get("sku_parsed")
        if not sp:
            continue
        for c in sp.get("codes") or []:
            codes_in_rugs.add(c)

    missing = sorted(codes_in_rugs - set(palette.keys()))
    print(f"Eksik kod: {len(missing)}  (toplam {len(codes_in_rugs)}'den)")

    # Her eksik kod için: o kodu içeren halılardan toplanan cluster center'lar
    estimates = defaultdict(list)  # code → list of (center_lab, count, std_lab)

    # Her eksik kod için kullanılacak halıları seç (öncelik: az sayıda eksik olanlar)
    for code in missing:
        candidates = []
        for r in rugs:
            sp = r.get("sku_parsed")
            if not sp:
                continue
            codes = sp.get("codes") or []
            if code not in codes:
                continue
            # Kaç tanesi palette'te var?
            known = sum(1 for c in codes if c in palette)
            unknown = len(codes) - known
            candidates.append((r, unknown, len(codes)))
        # Önce az eksikli halıları dene (daha az belirsiz)
        candidates.sort(key=lambda x: (x[1], x[2]))
        selected = candidates[:MAX_RUGS_PER_CODE]
        if not selected:
            print(f"  [skip] {code}: hiç halı bulunamadı")
            continue

        for rug, unknown_count, total_codes in selected:
            codes = rug["sku_parsed"]["codes"]
            url = rug.get("img_url")
            pid = rug.get("product_id", "x")
            if not url:
                continue

            thumb = download_thumb(url, code, pid)
            if not thumb:
                continue

            try:
                img = Image.open(thumb).convert("RGB")
                img.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.Resampling.LANCZOS)
                arr = np.array(img).reshape(-1, 3)
                # Aşırı karanlık (background) pikselleri ele
                brightness = arr.sum(axis=1)
                arr = arr[brightness > 30]
                if len(arr) < 1000:
                    continue
                pixels_lab = rgb_to_lab_arr(arr)

                # Seed'ler hazırla
                k = len(codes)
                seeds = np.zeros((k, 3))
                seeds_mask = np.zeros(k, dtype=bool)
                for i, c in enumerate(codes):
                    if c in palette:
                        seeds[i] = palette[c]["lab"]
                        seeds_mask[i] = True
                    else:
                        # Rastgele piksel
                        seeds[i] = pixels_lab[np.random.randint(len(pixels_lab))]
                        seeds_mask[i] = False

                centers, labels, counts = seeded_kmeans(
                    pixels_lab, seeds, seeds_mask, max_iter=KMEANS_ITER
                )

                # Eksik kodun cluster index'ini bul (seeds_mask=False olan)
                for i, c in enumerate(codes):
                    if c == code and not seeds_mask[i]:
                        if counts[i] < 200:  # çok küçük cluster → güvenilmez
                            continue
                        # Cluster std
                        cluster_px = pixels_lab[labels == i]
                        if len(cluster_px) < 50:
                            continue
                        std_lab = cluster_px.std(axis=0)
                        estimates[code].append((centers[i].tolist(), int(counts[i]), std_lab.tolist()))
                        break

            except Exception as e:
                print(f"  [err] {code} {pid}: {e}", file=sys.stderr)
                continue

    # Her eksik kod için: ağırlıklı ortalama
    print(f"\n=== SONUÇ ===")
    added = 0
    for code in missing:
        ests = estimates.get(code, [])
        if not ests:
            continue
        labs = np.array([e[0] for e in ests])
        counts = np.array([e[1] for e in ests], dtype=float)
        stds = np.array([e[2] for e in ests])
        # Piksel sayısı ağırlıklı mean
        weights = counts / counts.sum()
        mean_lab = (labs * weights[:, None]).sum(axis=0)
        # std: ortalama std (biraz üst sınır koy, çok düşük olmasın)
        mean_std = np.maximum((stds * weights[:, None]).sum(axis=0), [2.0, 0.8, 0.8])

        # RGB'ye geri çevir (yaklaşık)
        L, a, b = mean_lab
        fy = (L + 16) / 116
        fx = a / 500 + fy
        fz = fy - b / 200
        def finv(t):
            t3 = t ** 3
            return t3 if t3 > 0.008856 else (t - 16/116) / 7.787
        x = finv(fx) * 0.95047
        y = finv(fy) * 1.0
        z = finv(fz) * 1.08883
        rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
        gl = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
        bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252
        def linear_to_srgb(u):
            u = max(0, min(1, u))
            v = u * 12.92 if u <= 0.0031308 else 1.055 * u ** (1/2.4) - 0.055
            return max(0, min(255, round(v * 255)))
        rgb = [linear_to_srgb(rl), linear_to_srgb(gl), linear_to_srgb(bl)]
        r_, g_, b_ = [c/255.0 for c in rgb]
        h, l, s = colorsys.rgb_to_hls(r_, g_, b_)

        palette[code] = {
            "rgb": rgb,
            "hsl": [round(h*360, 1), round(s, 3), round(l, 3)],
            "lab": [round(v, 2) for v in mean_lab.tolist()],
            "lab_std": [round(v, 2) for v in mean_std.tolist()],
            "hex": f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}",
            "source": "residual_cluster",
            "n_samples": len(ests),
        }
        added += 1
        print(f"  {code}: RGB={rgb}  LAB=[{mean_lab[0]:.1f},{mean_lab[1]:.1f},{mean_lab[2]:.1f}]  ({len(ests)} halıdan)")

    # Kaydet
    json.dump(
        dict(sorted(palette.items())),
        open(DATA_DIR / "color_palette.json", "w"),
        ensure_ascii=False,
        indent=2,
    )
    print(f"\n→ {added} yeni kod eklendi  |  Toplam palette: {len(palette)}")


if __name__ == "__main__":
    main()
