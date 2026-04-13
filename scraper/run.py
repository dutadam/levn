"""Levn scraper — entry point.

Tüm koleksiyonları gezer, her üründen:
  - SKU (image alt'tan, örn. '6050-C-1841-2721-...')
  - Ürün adı (title attribute'tan)
  - Ürün URL, ID, görsel URL, fiyat

Sonra ürün adından sıralı renk adlarını çıkarır ve SKU'daki
kod sırasıyla eşler. Çakışmaları flag'ler.

Çıktı:
  data/color_db.json    - renk kodu → Türkçe ad (frekans bazlı çoğunluk)
  data/rug_db.json      - tüm ürünler
  data/_flags.json      - manuel inceleme gereken durumlar
  data/_raw.json        - her ürün için tüm parse edilmiş ham veri
"""
from __future__ import annotations

import json
import re
import time
import sys
import urllib.request
import urllib.error
from pathlib import Path
from html import unescape
from collections import defaultdict, Counter, OrderedDict

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
from sources import COLLECTIONS, BASE_URL, USER_AGENT, REQUEST_DELAY_SEC

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# ----- HTTP -----

def fetch(url: str, retries: int = 3) -> str | None:
    """GET with retries and UA header."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            if attempt == retries - 1:
                print(f"  ✗ FETCH FAIL: {url} — {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
    return None

# ----- Parsing -----

# SKU: [desen]-[tip_harfi]-[kod1]-[kod2]-...
# Renk kodları 4-haneli; TEK istisna: 999 (BEYAZ) 3-haneli özel kod.
# Diğer 3-haneli "kodlar" aslında image URL'sindeki hash fragmanları (false positive).
_CODE = r"(?:999|\d{4})"
SKU_RE = re.compile(rf"^(\d{{3,5}})-([A-Za-z])((?:-{_CODE}){{1,10}})$")
IMG_SKU_RE = re.compile(rf"/(?:buyuk|thumb|orta|kucuk)/(\d{{3,5}})-([a-z])((?:-{_CODE}){{1,10}})", re.IGNORECASE)

def parse_sku(raw: str):
    """'6050-C-1841-2721-6941' → {desen, tip, codes: [1841,2721,6941]}"""
    if not raw:
        return None
    raw = raw.strip()
    m = SKU_RE.match(raw)
    if not m:
        return None
    desen, tip, codes_part = m.group(1), m.group(2).upper(), m.group(3)
    codes = codes_part.strip("-").split("-")
    return {"desen": desen, "tip": tip, "codes": codes, "raw": raw}


def extract_color_names_from_title(title: str, collection_slug: str, tip: str) -> list[str]:
    """
    Ürün adından sıralı Türkçe renk adlarını çıkar.

    Örnekler:
      'PLAIN AÇIK GRİ (A) HALI'                         → ['AÇIK GRİ']
      'SERENITY AÇIK GRİ - BEJ - KOYU GRİ HALI'         → ['AÇIK GRİ', 'BEJ', 'KOYU GRİ']
      'AURORA KOYU GRİ HALI'                            → ['KOYU GRİ']
    """
    if not title:
        return []
    t = title.strip().upper()

    # '(A)', '(M)', '(C)', '(D)', '(E)' gibi tip işaretçilerini kaldır
    t = re.sub(r"\s*\([AMCDE]\)\s*", " ", t)

    # Baştaki koleksiyon/desen adını atla (1-2 kelime)
    # Desen adları tek kelime (PLAIN, SERENITY, AURORA, MEDALLION, ...) VEYA
    # iki kelime ("MONARCH ERA", "SPLENDOR ERA", "X BORDER", "Y ANGELES")
    SECOND_WORD_DESIGN_SUFFIX = {"ERA", "BORDER", "ANGELES"}
    tokens = t.split()
    if not tokens:
        return []
    skip = 1
    if len(tokens) >= 3 and tokens[1] in SECOND_WORD_DESIGN_SUFFIX:
        skip = 2
    remainder = " ".join(tokens[skip:])

    # Sondaki 'HALI' kaldır
    remainder = re.sub(r"\s+HALI\s*$", "", remainder).strip()
    if not remainder:
        return []

    # Renkleri ' - ' ile ayır (hem '-' hem ' - ' deneyelim)
    # Bazı ürünlerde tek renk, bazılarında çoklu: 'GRİ - BEJ - MAVİ'
    parts = re.split(r"\s*-\s*", remainder)
    names = [p.strip() for p in parts if p.strip()]
    return names


def parse_collection_page(html: str, collection_slug: str) -> list[dict]:
    """Bir koleksiyon sayfasındaki tüm ürün kartlarını parse et."""
    soup = BeautifulSoup(html, "html.parser")
    products = []
    # Ürün kartları: <div class="productItem"> içinde detailLink olan link
    for card in soup.select("div.productItem"):
        link = card.select_one("a.detailLink[href]")
        if not link:
            continue
        href = link.get("href", "").strip()
        if not href:
            continue
        product_url = href if href.startswith("http") else BASE_URL + href
        title = unescape(link.get("title", "").strip())
        data_id = link.get("data-id", "").strip()

        # İlk img src/data-src
        img = card.select_one("img.productSliderImage")
        img_url = ""
        img_alt = ""
        if img:
            img_url = img.get("data-src") or img.get("src") or ""
            img_alt = unescape(img.get("alt", "").strip())

        # SKU: önce alt attribute, yoksa img URL'den
        sku_raw = ""
        if img_alt and SKU_RE.match(img_alt):
            sku_raw = img_alt
        elif img_url:
            m = IMG_SKU_RE.search(img_url)
            if m:
                sku_raw = f"{m.group(1)}-{m.group(2).upper()}{m.group(3)}"

        # Fiyat
        price_el = card.select_one(".discountPriceSpan, .sellingPriceSpan")
        price_text = price_el.get_text(strip=True) if price_el else ""

        products.append({
            "product_id": data_id,
            "title": title,
            "product_url": product_url,
            "img_url": img_url,
            "img_alt": img_alt,
            "sku_raw": sku_raw,
            "price_text": price_text,
            "collection": collection_slug,
        })
    return products


def scrape_collection(slug: str, max_pages: int = 50) -> list[dict]:
    """
    Bir koleksiyonun tüm sayfalarını çek.
    Sayfa boş dönene veya önceki sayfanın aynısı gelene kadar ilerle.
    """
    first_url = f"{BASE_URL}/{slug}"
    html = fetch(first_url)
    if not html:
        return []

    all_products = parse_collection_page(html, slug)
    print(f"  [{slug}] sayfa 1: {len(all_products)} ürün")
    seen_ids = {p["product_id"] for p in all_products if p["product_id"]}

    for page in range(2, max_pages + 1):
        time.sleep(REQUEST_DELAY_SEC)
        url = f"{first_url}?sayfa={page}"
        html = fetch(url)
        if not html:
            break
        page_products = parse_collection_page(html, slug)
        if not page_products:
            print(f"  [{slug}] sayfa {page}: boş, durduruldu")
            break
        new_products = [p for p in page_products if p["product_id"] and p["product_id"] not in seen_ids]
        if not new_products:
            print(f"  [{slug}] sayfa {page}: yeni ürün yok, durduruldu")
            break
        for p in new_products:
            seen_ids.add(p["product_id"])
        all_products.extend(new_products)
        print(f"  [{slug}] sayfa {page}: +{len(new_products)} ürün (toplam {len(all_products)})")

    return all_products


# ----- DB Builder -----

def build_databases(all_products: list[dict]):
    """
    color_db: her renk kodu için, geldiği isimler ve frekans.
    rug_db:   ürün listesi (sku parse edilmiş + renk kodu→ad eşlemesi).
    _flags:   uyuşmazlıklar (kod sayısı ≠ ad sayısı, çakışan isimler, vs).
    """
    color_candidates = defaultdict(list)  # code → [(name, source_product_id), ...]
    rugs = []
    flags = []
    raw_dump = []

    for p in all_products:
        sku = parse_sku(p["sku_raw"])
        names = extract_color_names_from_title(p["title"], p["collection"], sku["tip"] if sku else "")

        entry = {
            **p,
            "sku_parsed": sku,
            "color_names_parsed": names,
            "color_mapping": [],
        }

        if not sku:
            flags.append({
                "type": "sku_parse_fail",
                "product_id": p["product_id"],
                "title": p["title"],
                "sku_raw": p["sku_raw"],
                "img_alt": p["img_alt"],
            })
            raw_dump.append(entry)
            rugs.append(entry)
            continue

        codes = sku["codes"]
        # Aynı kod tekrarlanıyorsa unique'e indir (AURORA gibi tek-renk çoklu-pozisyon)
        unique_codes = list(OrderedDict.fromkeys(codes))
        # İsimleri de unique'e indir (title'da tekrarlı yazım noise'ını çöz)
        unique_names = list(OrderedDict.fromkeys(names))

        matched = False

        # Case 1: Perfect match (dedup sonrası)
        if len(unique_names) == len(unique_codes) and len(unique_names) > 0:
            for code, name in zip(unique_codes, unique_names):
                color_candidates[code].append({
                    "name": name,
                    "product_id": p["product_id"],
                    "source": "title+sku_order",
                    "collection": p["collection"],
                })
                entry["color_mapping"].append({"code": code, "name": name})
            matched = True

        # Case 2: Tek isim, 1+ kod (PLAIN varyantları vs.)
        elif len(unique_names) == 1 and len(unique_codes) >= 1:
            for code in unique_codes:
                color_candidates[code].append({
                    "name": unique_names[0],
                    "product_id": p["product_id"],
                    "source": "title+sku_shared_name" if len(unique_codes) > 1 else "title+sku_single",
                    "collection": p["collection"],
                })
                entry["color_mapping"].append({"code": code, "name": unique_names[0]})
            if len(unique_codes) > 1:
                flags.append({
                    "type": "shared_name_multi_code",
                    "product_id": p["product_id"],
                    "title": p["title"],
                    "sku": sku["raw"],
                    "codes_unique": unique_codes,
                    "name": unique_names[0],
                })
            matched = True

        # Case 3: N ad vs N+1 kod — son kod "unnamed_accent" (title'da yazılmamış vurgu rengi)
        elif len(unique_names) >= 1 and len(unique_codes) == len(unique_names) + 1:
            for code, name in zip(unique_codes[:-1], unique_names):
                color_candidates[code].append({
                    "name": name,
                    "product_id": p["product_id"],
                    "source": "title+sku_order_partial",
                    "collection": p["collection"],
                })
                entry["color_mapping"].append({"code": code, "name": name})
            last_code = unique_codes[-1]
            entry["color_mapping"].append({"code": last_code, "name": None, "note": "unnamed_accent"})
            flags.append({
                "type": "unnamed_accent",
                "product_id": p["product_id"],
                "title": p["title"],
                "sku": sku["raw"],
                "accent_code": last_code,
                "reason": f"{len(unique_codes)} kod, {len(unique_names)} ad — son kod vurgu rengi olarak işaretlendi",
            })
            matched = True

        if not matched:
            flags.append({
                "type": "count_mismatch",
                "product_id": p["product_id"],
                "title": p["title"],
                "sku": sku["raw"],
                "codes_unique": unique_codes,
                "names_parsed": names,
                "names_unique": unique_names,
                "reason": f"{len(unique_codes)} unique kod vs {len(unique_names)} unique ad",
            })

        raw_dump.append(entry)
        rugs.append(entry)

    # color_db: her kod için en sık gelen adı seç, alternatifleri ve çakışmaları kaydet
    color_db = {}
    for code, candidates in color_candidates.items():
        name_counter = Counter(c["name"] for c in candidates)
        top_name, top_freq = name_counter.most_common(1)[0]
        total = sum(name_counter.values())
        is_verified = top_freq >= 2  # en az 2 ürün aynı adı veriyorsa doğrulanmış say
        alternatives = [
            {"name": n, "count": c}
            for n, c in name_counter.most_common()
            if n != top_name
        ]
        color_db[code] = {
            "name_tr": top_name,
            "verified": is_verified,
            "occurrence_count": total,
            "top_frequency": top_freq,
            "alternatives": alternatives,
            "sources": candidates[:10],  # ilk 10 kaynak referansı
        }
        # Çakışma varsa flag
        if alternatives:
            flags.append({
                "type": "name_conflict",
                "code": code,
                "top_name": top_name,
                "top_count": top_freq,
                "alternatives": alternatives,
            })

    return color_db, rugs, flags, raw_dump


# ----- Main -----

def main():
    start = time.time()
    print("=== LEVN scraper başlıyor ===")
    print(f"Koleksiyon sayısı: {len(COLLECTIONS)}")
    print()

    all_products = []
    per_collection_counts = {}

    for coll in COLLECTIONS:
        slug = coll["slug"]
        print(f"→ {slug} ({coll['priority']}) — {coll['note']}")
        items = scrape_collection(slug)
        per_collection_counts[slug] = len(items)
        all_products.extend(items)
        time.sleep(REQUEST_DELAY_SEC)
        print()

    print(f"Toplam çekilen ürün: {len(all_products)}")
    print()
    print("=== Veritabanı oluşturuluyor ===")
    color_db, rugs, flags, raw_dump = build_databases(all_products)

    # Kaydet
    with open(DATA_DIR / "color_db.json", "w", encoding="utf-8") as f:
        json.dump(color_db, f, ensure_ascii=False, indent=2, sort_keys=True)
    with open(DATA_DIR / "rug_db.json", "w", encoding="utf-8") as f:
        json.dump(rugs, f, ensure_ascii=False, indent=2)
    with open(DATA_DIR / "_flags.json", "w", encoding="utf-8") as f:
        json.dump(flags, f, ensure_ascii=False, indent=2)
    with open(DATA_DIR / "_raw.json", "w", encoding="utf-8") as f:
        json.dump(raw_dump, f, ensure_ascii=False, indent=2)

    # Özet
    elapsed = time.time() - start
    verified = sum(1 for v in color_db.values() if v["verified"])
    print()
    print("=== ÖZET ===")
    print(f"Süre: {elapsed:.1f}s")
    print(f"Toplam ürün: {len(rugs)}")
    print(f"Toplam benzersiz renk kodu: {len(color_db)}")
    print(f"Doğrulanmış (≥2 ürün aynı adla): {verified}")
    print(f"Tek görülen (doğrulanmamış): {len(color_db) - verified}")
    print(f"Flag sayısı: {len(flags)}")
    print(f"  - name_conflict: {sum(1 for f in flags if f['type'] == 'name_conflict')}")
    print(f"  - count_mismatch: {sum(1 for f in flags if f['type'] == 'count_mismatch')}")
    print(f"  - sku_parse_fail: {sum(1 for f in flags if f['type'] == 'sku_parse_fail')}")
    print()
    print("Koleksiyon başına ürün:")
    for slug, count in per_collection_counts.items():
        print(f"  {slug:15s} {count:4d}")
    print()
    print(f"Çıktılar: {DATA_DIR}/")


if __name__ == "__main__":
    main()
