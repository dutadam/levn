# Levn — BM Home Halı Renk Atölyesi

Showroom'da müşterinin bir halı seçip renk slotlarını değiştirerek
kendi kombinasyonunu kurabildiği, sonucu fabrika SKU'su olarak
kopyalayıp paylaşabildiği statik bir web aracı. BM Home için
Levn Otomation tarafından geliştirilmiştir.

## Canlı demo

GitHub Pages: `https://<kullanici>.github.io/<repo-adi>/`
(Kök `index.html` otomatik olarak `/ui/` altına yönlendirir.)

## Yerelde çalıştırma

```bash
python3 -m http.server 8765
open http://localhost:8765/ui/
```

Google Drive CloudStorage klasöründe çalışıyorsan `sync.sh` ile
`/tmp/levn` altına aynalayıp oradan servis et (sandbox izinleri için).

## İki mod

- **Studio** — halı seç → renk slotlarını değiştir → canlı SKU üret →
  kopyala veya PDF al. "Aynı desenin varyantları" ve "aynı paletle uyumlu
  diğer halılar" otomatik önerilir. Aynı kombin zaten varsa halı kartı çıkar.
- **Renk → Halı (Finder)** — bir veya birden fazla renk seç, onları
  **hepsini birden** barındıran halılar listelenir. Kartlara tıklayınca
  halı otomatik Studio'da açılır.

## Yapı

```
ui/               Statik arayüz (ES modules, vanilla JS + CSS)
  index.html
  style.css
  app.js          orchestrator
  shared.js       veri + yardımcılar
  studio.js       Studio modu
  finder.js       Renk → Halı modu
  palette.js      renk seçim popover'ı
data/             color_db, rug_db, color_assets JSON'ları
assets/colors/    88 renk swatch görseli
assets/brand/     marka logoları (opsiyonel)
scraper/          scraper + veri üretim araçları
sync.sh           Drive → /tmp aynalayıcı (yerel dev için)
```

## Scraper (veri güncelleme)

```bash
python3 scraper/run.py                    # ürün + SKU taraması
python3 scraper/download_thumbnails.py    # renk görselleri
python3 scraper/build_review_list.py      # REVIEW.md
```

## Yol haritası

- **Faz 4 (tamamlandı)** — Atelier/Butik Sıcak UI redesign (Inter + Fraunces)
- **Faz 5 (planlanan)** — AI ile halı görselinde gerçek renk değişimi
  (şu an editor'de "AI ile Renklendir · Yakında" kilitli buton yer tutucu)
- **Faz 6** — bmhome.com.tr eklentisi olarak embed

## Notlar

- Renkler gerçek halı görselinden gösteriliyor (hex tahminleri değil).
- "Fallback" rozetli kodlar: o kod için PLAIN tek-renk ürün bulunamadığından
  çok renkli halıdan kırpılan görsel.
- `999` kodu BEYAZ için özel 3 haneli koddur (diğerleri 4 haneli).

---

© Levn Otomation · BM Home için geliştirilmiştir.
