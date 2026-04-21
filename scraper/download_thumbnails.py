"""Levn — her (renk_kodu, tip_harfi) çifti için temsili görsel indir.

YAPISAL KEŞİF (2026-04):
  Plain halılar aynı kodla farklı tip harflerinde (A, C, M, E, D) ayrı TON
  varyantları olarak üretiliyor. Örn:
    2025-A-7141 → BUZ MAVİSİ koyu soğuk
    2025-M-7141 → BUZ MAVİSİ açık hafif yeşil
    (ΔE fark ≈ 12.8 — çok büyük!)

  Multi-color halının SKU'sundaki tip harfi (6088-**M**-...) hangi varyant
  paletinin kullanıldığını belirliyor.

Strateji:
  Her (code, tip) kombinasyonu için PLAIN tek-renk halısını bul ve indir.
  Plain'i yoksa fallback: o tipteki ana-renk (ilk kod) ürünü.

Çıktı:
  assets/colors/<code>_<tip>.jpg   # örn: 7141_M.jpg, 7141_A.jpg
  data/color_assets.json           # {code: {tip: {file, product_id, ...}}}
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
                return False
            dest.write_bytes(data)
            return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            if attempt == retries - 1:
                print(f"  ✗ FAIL: {url} — {e}", file=sys.stderr)
                return False
            time.sleep(1)
    return False


def normalize_img_url(url: str) -> str:
    """CDN cdn-cgi/image prefix → orijinal (daha yüksek kalite)."""
    if "cdn-cgi/image/" in url:
        url = url.split("cdn-cgi/image/")[1]
        url = "https://static.ticimax.cloud/" + url.split("/", 1)[1]
    return url


def collect_variants(raw: list[dict]) -> dict:
    """{code: {tip: [list of products]}} şeklinde grupla.

    3 kaynak tipi:
      1. plain_single: 'plain' koleksiyonu + saf tek-renk SKU (örn. 2025-A-7141)
      2. plain_primary: 'plain' koleksiyonu + ilk kod eşleşen ama 2+ kod
         (örn. 2025-M-6451-8333 'PLAIN MERCAN (M) HALI' — 8333 küçük accent,
         ana renk 6451). Title "PLAIN" ile başlar ve 1 renk adı geçer.
      3. primary: diğer koleksiyonlardaki ilk-kod-eşleşen ürünler (en son çare)
    """
    plain_single = defaultdict(dict)    # {code: {tip: product}}
    plain_primary = defaultdict(dict)   # {code: {tip: product}}  ← YENİ
    primary_by_tip = defaultdict(lambda: defaultdict(list))

    for p in raw:
        sku_raw = p.get("sku_raw", "") or ""
        parts = sku_raw.split("-")
        if len(parts) < 3:
            continue
        tip = parts[1].upper()
        codes = (p.get("sku_parsed") or {}).get("codes") or []
        if not codes:
            continue
        first_code = codes[0]
        collection = p.get("collection", "")
        title = (p.get("title") or "").upper()

        if collection == "plain":
            if len(codes) == 1:
                plain_single[first_code][tip] = p
            # PLAIN başlıklı çok-kodlu halılar: "PLAIN MERCAN (M) HALI" gibi
            # (2. kod accent). Bunlar da ana renk için güvenilir kaynak.
            elif title.startswith("PLAIN"):
                # Aynı (code,tip) için zaten plain_primary varsa ilki kalsın
                if tip not in plain_primary[first_code]:
                    plain_primary[first_code][tip] = p
        else:
            # Diğer koleksiyonlar → genel primary
            primary_by_tip[first_code][tip].append(p)

    return plain_single, plain_primary, primary_by_tip


def main():
    raw = json.loads((DATA_DIR / "_raw.json").read_text(encoding="utf-8"))
    rugs = json.loads((DATA_DIR / "rug_db.json").read_text(encoding="utf-8"))

    # Rug'larda kullanılan (code, tip) çiftleri — indirmemiz gereken setler
    needed = set()  # {(code, tip)}
    for r in rugs:
        sku = r.get("sku_parsed") or {}
        codes = sku.get("codes") or []
        sku_raw = r.get("sku_raw", "") or ""
        parts = sku_raw.split("-")
        if len(parts) < 3:
            continue
        tip = parts[1].upper()
        for code in codes:
            needed.add((code, tip))

    print(f"Halılardan çıkarılan (code, tip) çifti: {len(needed)}")

    plain_single, plain_primary, primary_by_tip = collect_variants(raw)

    assets = {}  # {code: {tip: {...}}}
    stats = defaultdict(int)
    total = len(needed)

    # Sıralı indir (progress gösterimi için)
    for i, (code, tip) in enumerate(sorted(needed), 1):
        product = None
        mode = None
        # Öncelik 1: saf plain tek-renk (1 kodlu), aynı tip
        if tip in plain_single.get(code, {}):
            product = plain_single[code][tip]
            mode = "plain_single"
        # Öncelik 2: PLAIN halısı (title "PLAIN..." ama SKU'da 2+ kod), ana renk bu
        elif tip in plain_primary.get(code, {}):
            product = plain_primary[code][tip]
            mode = "plain_primary"
        # Öncelik 3: aynı tip, ilk kod konumunda diğer koleksiyonlar
        elif tip in primary_by_tip.get(code, {}):
            product = primary_by_tip[code][tip][0]
            mode = "primary"
        # Öncelik 4: farklı tipte plain (TON UYUMSUZ — son çare)
        elif code in plain_single:
            other_tips = sorted(plain_single[code].keys())
            product = plain_single[code][other_tips[0]]
            mode = f"fallback_tip_{other_tips[0]}"
        elif code in plain_primary:
            other_tips = sorted(plain_primary[code].keys())
            product = plain_primary[code][other_tips[0]]
            mode = f"fallback_plain_{other_tips[0]}"
        elif code in primary_by_tip:
            other_tips = sorted(primary_by_tip[code].keys())
            product = primary_by_tip[code][other_tips[0]][0]
            mode = f"fallback_primary_{other_tips[0]}"

        if not product:
            print(f"  [{i:3d}/{total}] {code}_{tip} — ürün bulunamadı")
            stats["no_product"] += 1
            continue

        img_url = normalize_img_url(product["img_url"])
        ext = ".jpg"
        dest = ASSETS_DIR / f"{code}_{tip}{ext}"
        ok = download(img_url, dest)
        if ok:
            if code not in assets:
                assets[code] = {}
            assets[code][tip] = {
                "file": f"assets/colors/{code}_{tip}{ext}",
                "product_id": product["product_id"],
                "product_title": product["title"],
                "source_url": img_url,
                "mode": mode,
            }
            stats[mode] += 1
            marker = "★" if mode == "plain_single" else ("+" if mode == "primary" else "·")
            print(f"  [{i:3d}/{total}] {code}_{tip:2s} {marker} {mode}")
        else:
            stats["download_fail"] += 1
            print(f"  [{i:3d}/{total}] {code}_{tip} ✗ indirme başarısız")
        time.sleep(REQUEST_DELAY_SEC)

    (DATA_DIR / "color_assets.json").write_text(
        json.dumps(assets, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    print()
    print("=== ÖZET ===")
    for k, v in sorted(stats.items()):
        print(f"  {k:28s} {v}")
    # Kaç unique kod, kaç tip var?
    n_codes = len(assets)
    n_pairs = sum(len(v) for v in assets.values())
    print(f"Kod sayısı: {n_codes}  |  (code, tip) çifti: {n_pairs}")
    print(f"Dizin: {ASSETS_DIR}")


if __name__ == "__main__":
    main()
