"""Manuel inceleme gereken kodları markdown olarak dök.

Çıktı: data/REVIEW.md
  1. Tek kaynaktan gelen doğrulanmamış kodlar
  2. Name conflict'leri olan kodlar
  3. Unnamed accent kodları (title'da yazılmamış vurgu rengi)

Her satır şunları içerir: kod, önerilen isim, ilk-görülen ürün URL'si,
asset görsel yolu (varsa), manuel karar kutusu.
"""
from __future__ import annotations
import json
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"

color_db = json.loads((DATA / "color_db.json").read_text(encoding="utf-8"))
flags = json.loads((DATA / "_flags.json").read_text(encoding="utf-8"))
raw = json.loads((DATA / "_raw.json").read_text(encoding="utf-8"))
assets = json.loads((DATA / "color_assets.json").read_text(encoding="utf-8"))

# Index: kod → ilk örnek ürün
first_product_for_code: dict[str, dict] = {}
for r in raw:
    for m in r.get("color_mapping", []):
        code = m.get("code")
        if code and code not in first_product_for_code:
            first_product_for_code[code] = r

lines = ["# Levn — Manuel İnceleme Listesi",
         "",
         "> Bu dosya otomatik üretilir. Her bölüm için karar verip dosyada işaretleyin.",
         "> Doğrulayınca color_db'de `verified: true` olarak güncellenir (ileride yapılacak).",
         ""]

# --- 1. Doğrulanmamış tek-kaynak kodlar ---
unverified = sorted([(c, v) for c, v in color_db.items() if not v["verified"]])
lines.append(f"## 1. Doğrulanmamış Kodlar ({len(unverified)} adet)")
lines.append("")
lines.append("Bu kodlar sitede yalnızca TEK üründe görülmüş ve isim doğrulaması yapılmadı.")
lines.append("")
lines.append("| Kod | Önerilen Ad | Görsel | Ürün | Karar |")
lines.append("|-----|------|--------|------|-------|")
for code, v in unverified:
    name = v["name_tr"]
    asset = assets.get(code, {})
    asset_path = asset.get("file", "")
    product = first_product_for_code.get(code, {})
    title = (product.get("title") or "")[:50]
    url = product.get("product_url", "")
    lines.append(f"| `{code}` | {name} | [gör]({asset_path}) | [{title}]({url}) | ☐ onay / ☐ düzelt: ________ |")

# --- 2. Name conflict'ler ---
ncs = [f for f in flags if f["type"] == "name_conflict"]
lines.append("")
lines.append(f"## 2. İsim Çakışmaları ({len(ncs)} adet)")
lines.append("")
lines.append("Aynı kod birden fazla renk adıyla geçmiş. TOP en sık gelen ad, ALT alternatifler.")
lines.append("")
lines.append("| Kod | TOP (sık) | Alternatifler | Karar |")
lines.append("|-----|-----------|---------------|-------|")
for f in sorted(ncs, key=lambda x: -x["top_count"]):
    alts = ", ".join(f"{a['name']} ({a['count']}x)" for a in f["alternatives"])
    lines.append(f"| `{f['code']}` | {f['top_name']} ({f['top_count']}x) | {alts} | ☐ TOP onayla / ☐ ________ |")

# --- 3. Unnamed accent — özet istatistik ---
uas = [f for f in flags if f["type"] == "unnamed_accent"]
# Accent code frekansı
accent_counter = Counter(f["accent_code"] for f in uas)
lines.append("")
lines.append(f"## 3. Adlandırılmamış Vurgu Kodları ({len(accent_counter)} benzersiz kod, {len(uas)} olay)")
lines.append("")
lines.append("Bu kodlar çok renkli halıların SKU'sunda var ama ürün adında yazılmamış.")
lines.append("Frekans yüksekse büyük olasılıkla gerçek renk kodu, az görülüyorsa noise olabilir.")
lines.append("")
lines.append("| Kod | Frekans | color_db'de var mı | Örnek başlık |")
lines.append("|-----|---------|--------------------|---------------|")
for code, count in accent_counter.most_common():
    in_db = "✓" if code in color_db else "✗ (yeni kod adayı)"
    example = next((f["title"] for f in uas if f["accent_code"] == code), "")[:50]
    lines.append(f"| `{code}` | {count}x | {in_db} | {example} |")

# --- 4. Shared-name multi-code ---
sncs = [f for f in flags if f["type"] == "shared_name_multi_code"]
if sncs:
    lines.append("")
    lines.append(f"## 4. Ortak-İsimli Çoklu Kod ({len(sncs)} olay)")
    lines.append("")
    lines.append("Tek bir ürün adı birden fazla koda atandı (PLAIN C/M varyantları gibi).")
    lines.append("Bu kodlar aynı rengin farklı iplik batch'leri olabilir.")
    lines.append("")
    # Her ad için tüm kodları grupla
    name_to_codes: dict[str, set] = defaultdict(set)
    for f in sncs:
        name_to_codes[f["name"]].update(f["codes_unique"])
    for name, codes in sorted(name_to_codes.items()):
        lines.append(f"- **{name}**: {', '.join(sorted(codes))}")

# Yaz
out = DATA / "REVIEW.md"
out.write_text("\n".join(lines), encoding="utf-8")
print(f"Yazıldı: {out}")
print(f"  Doğrulanmamış kod: {len(unverified)}")
print(f"  Name conflict: {len(ncs)}")
print(f"  Unnamed accent (benzersiz): {len(accent_counter)}")
print(f"  Shared-name multi-code: {len(sncs)}")
