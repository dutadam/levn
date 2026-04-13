"""Levn — her renk kodu için bir temsili görsel indir.

Strateji:
  1. Tercih: tek renk ürün (PLAIN ya da bu kodu YALNIZCA içeren ürün)
  2. 2. tercih: bu kod SKU'da ilk sırada (ana renk) olan ürün
  3. Fallback: bu kodu içeren herhangi bir ürün

Çıktı:
  assets/colors/<code>.jpg   # ürünün tam görseli
  data/color_assets.json     # kod → {file, product_id, mode (plain/primary/fallback)}
"""
from __future__ import annotations
import json
import time
import sys
import urllib.request
import urllib.error
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from sources import USER_AGENT, REQUEST_DELAY_SEC

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
ASSETS_DIR = ROOT / "assets" / "colors"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)


def download(url: str, dest: Path, retries: int = 2) -> bool:
    if dest.exists() and dest.stat().st_size > 1024:
        return True
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if len(data) < 1024:
                # 404 placeholder or broken
                return False
            dest.write_bytes(data)
            return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            if attempt == retries - 1:
                print(f"  ✗ FAIL: {url} — {e}", file=sys.stderr)
                return False
            time.sleep(1)
    return False


def pick_best_product(code: str, products: list[dict]) -> tuple[dict, str] | None:
    """En iyi temsili ürünü seç: plain > primary > fallback."""
    candidates = []
    for p in products:
        sku = p.get("sku_parsed") or {}
        codes = sku.get("codes") or []
        if code not in codes:
            continue
        unique = list(dict.fromkeys(codes))
        is_single = len(unique) == 1
        is_primary = len(unique) > 0 and unique[0] == code
        # Image URL mutlaka olsun
        if not p.get("img_url"):
            continue
        candidates.append((p, is_single, is_primary))

    if not candidates:
        return None

    # Önce tek renk, sonra ana renk (ilk pozisyon), sonra fallback
    for p, is_single, is_primary in candidates:
        if is_single:
            return p, "plain_single"
    for p, is_single, is_primary in candidates:
        if is_primary:
            return p, "primary"
    return candidates[0][0], "fallback"


def main():
    raw = json.loads((DATA_DIR / "_raw.json").read_text(encoding="utf-8"))
    color_db = json.loads((DATA_DIR / "color_db.json").read_text(encoding="utf-8"))

    assets = {}
    stats = defaultdict(int)
    total = len(color_db)
    print(f"Toplam renk kodu: {total}")
    print()

    for i, (code, v) in enumerate(sorted(color_db.items()), 1):
        pick = pick_best_product(code, raw)
        if not pick:
            print(f"  [{i:3d}/{total}] {code:5s} {v['name_tr']:25s} — ürün bulunamadı")
            stats["no_product"] += 1
            continue
        product, mode = pick
        img_url = product["img_url"]
        # CDN cdn-cgi/image prefix'li URL'leri orijinale çevir (daha yüksek kalite)
        if "cdn-cgi/image/" in img_url:
            img_url = img_url.split("cdn-cgi/image/")[1]
            # format: "width=-,quality=99/59097/..." → "59097/..."
            img_url = "https://static.ticimax.cloud/" + img_url.split("/", 1)[1]

        # Dosya uzantısı
        ext = ".jpg"
        if img_url.lower().endswith((".png", ".jpeg", ".webp")):
            ext = "." + img_url.rsplit(".", 1)[-1].lower()
            if ext == ".jpeg":
                ext = ".jpg"

        dest = ASSETS_DIR / f"{code}{ext}"
        ok = download(img_url, dest)
        if ok:
            assets[code] = {
                "file": f"assets/colors/{code}{ext}",
                "product_id": product["product_id"],
                "product_title": product["title"],
                "source_url": img_url,
                "mode": mode,
            }
            stats[mode] += 1
            marker = "★" if mode == "plain_single" else ("+" if mode == "primary" else "·")
            print(f"  [{i:3d}/{total}] {code:5s} {v['name_tr']:25s} {marker} {mode}")
        else:
            stats["download_fail"] += 1
            print(f"  [{i:3d}/{total}] {code:5s} {v['name_tr']:25s} ✗ indirme başarısız")
        time.sleep(REQUEST_DELAY_SEC)

    (DATA_DIR / "color_assets.json").write_text(
        json.dumps(assets, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    print()
    print("=== ÖZET ===")
    for k, v in sorted(stats.items()):
        print(f"  {k:20s} {v}")
    print(f"Toplam indirildi: {len(assets)} / {total}")
    print(f"Dizin: {ASSETS_DIR}")


if __name__ == "__main__":
    main()
