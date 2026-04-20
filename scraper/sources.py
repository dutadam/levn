"""Levn scraper — collection definitions.

Tüm bmhome.com.tr koleksiyonları. URL slug'ları test edildi.
Yeni koleksiyon eklemek için sadece bu listeye ekle.
"""

COLLECTIONS = [
    {"slug": "plain",       "priority": "high",   "note": "tek renk, renk kodu doğrulama için altın kaynak"},
    {"slug": "amorph",      "priority": "high",   "note": "çok renkli, SERENITY serisi sıralı renk adları veriyor"},
    {"slug": "marquise",    "priority": "high",   "note": "çok renkli"},
    {"slug": "oriental",    "priority": "high",   "note": "çok renkli (53 halı) — 2026'da homepage nav'a eklendi"},
    {"slug": "coral",       "priority": "medium", "note": "çok renkli"},
    {"slug": "crystal",     "priority": "medium", "note": "çok renkli"},
    {"slug": "istanbul",    "priority": "medium", "note": "çok renkli"},
    {"slug": "monochrome",  "priority": "medium", "note": "tek/çift renk"},
    {"slug": "shell",       "priority": "medium", "note": "minimal renk"},
    {"slug": "art-deco-56", "priority": "medium", "note": "nav'dan tespit edildi (kategori id=56)"},
    {"slug": "mystic-81",   "priority": "medium", "note": "nav'dan tespit edildi (kategori id=81)"},
    {"slug": "cok-renkli-77","priority": "low",   "note": "nav'dan: muhtemelen filtre/etiket kategorisi"},
]

BASE_URL = "https://www.bmhome.com.tr"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
REQUEST_DELAY_SEC = 0.6  # rate limit: yönergede 500ms öneriliyordu, biraz üstüne
