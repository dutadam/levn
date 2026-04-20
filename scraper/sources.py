"""Levn scraper — collection definitions.

Tüm bmhome.com.tr koleksiyonları. URL slug'ları test edildi.
Yeni koleksiyon eklemek için sadece bu listeye ekle.
"""

COLLECTIONS = [
    # 17 gerçek koleksiyon — bmhome.com.tr anasayfasından alfabetik sıra
    {"slug": "amorph",      "priority": "high",   "note": "çok renkli, SERENITY serisi sıralı renk adları veriyor"},
    {"slug": "coral",       "priority": "medium", "note": "çok renkli"},
    {"slug": "crystal",     "priority": "medium", "note": "çok renkli"},
    {"slug": "ethnique",    "priority": "high",   "note": "2026 NEW — ~140 halı, etnik desenler"},
    {"slug": "istanbul",    "priority": "medium", "note": "çok renkli"},
    {"slug": "marquise",    "priority": "high",   "note": "çok renkli"},
    {"slug": "marrakesh",   "priority": "high",   "note": "2026 NEW — ~160 halı"},
    {"slug": "monochrome",  "priority": "medium", "note": "tek/çift renk"},
    {"slug": "mystic-81",   "priority": "medium", "note": "UI label 'MYSTIC', slug /mystic-81 (kategori id=81)"},
    {"slug": "oriental",    "priority": "high",   "note": "2026 NEW — ~135 halı, oriental desenler"},
    {"slug": "patch",       "priority": "medium", "note": "2026 NEW — ~13 halı, patchwork"},
    {"slug": "pearl",       "priority": "medium", "note": "2026 NEW — ~55 halı"},
    {"slug": "plain",       "priority": "high",   "note": "tek renk, renk kodu doğrulama için altın kaynak"},
    {"slug": "sapphire",    "priority": "low",    "note": "2026 NEW — ~18 halı"},
    {"slug": "shell",       "priority": "medium", "note": "minimal renk"},
    {"slug": "trinity",     "priority": "low",    "note": "2026 NEW — ~6 halı"},
    {"slug": "vintage",     "priority": "high",   "note": "2026 NEW — ~165 halı"},
    # Filter/tag kategoriler — gerçek koleksiyon olmayan ama ticimax id'li sayfalar.
    # Genelde diğer koleksiyonlarla çakışır (dedup ile halledilir).
    {"slug": "art-deco-56", "priority": "low",    "note": "tag page id=56 (Art Deco), muhtemelen filtre"},
    {"slug": "cok-renkli-77","priority": "low",   "note": "tag page id=77 (Çok Renkli), muhtemelen filtre"},
]

BASE_URL = "https://www.bmhome.com.tr"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
REQUEST_DELAY_SEC = 0.6  # rate limit: yönergede 500ms öneriliyordu, biraz üstüne
