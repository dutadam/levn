/* Levn — paylaşılan state, data load, yardımcılar */

export const state = {
  colors: {},        // code → {name_tr, verified, ...}
  assets: {},        // code → {file, mode, ...}
  palette: {},       // code → {rgb:[r,g,b], hsl, lab, hex} (Faz 5 recolor)
  rugs: [],          // rug list
  rugsByDesign: {},  // desen → [rug,...]
  collections: [],   // unique collection slugs (sorted)
};

export const DATA_BASE = "../data/";
export const ASSET_BASE = "../";

export async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Fetch failed: ${path} (${r.status})`);
  return r.json();
}

export async function loadAll() {
  const [colors, assets, rugs, palette] = await Promise.all([
    loadJSON(DATA_BASE + "color_db.json"),
    loadJSON(DATA_BASE + "color_assets.json"),
    loadJSON(DATA_BASE + "rug_db.json"),
    loadJSON(DATA_BASE + "color_palette.json").catch(() => ({})),
  ]);
  state.colors = colors;
  state.assets = assets;
  state.rugs = rugs;
  state.palette = palette || {};

  // Index by design code for fast "same design" lookup
  const byDesign = {};
  const collSet = new Set();
  for (const r of rugs) {
    const d = r.sku_parsed && r.sku_parsed.desen;
    if (d) (byDesign[d] = byDesign[d] || []).push(r);
    if (r.collection) collSet.add(r.collection);
  }
  state.rugsByDesign = byDesign;
  state.collections = [...collSet].sort();
}

export function assetUrl(code) {
  const a = state.assets[code];
  return a ? ASSET_BASE + a.file : "";
}

export function colorName(code) {
  const c = state.colors[code];
  return c ? c.name_tr : code;
}

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalize(s) {
  return (s || "")
    .toLocaleUpperCase("tr-TR")
    .replace(/İ/g, "I")
    .replace(/[ÇĞÖŞÜ]/g, (c) => ({ Ç: "C", Ğ: "G", Ö: "O", Ş: "S", Ü: "U" }[c] || c));
}

/* Build SKU string from parsed parts + codes array */
export function buildSku(desen, tip, codes) {
  const parts = [desen];
  if (tip) parts.push(tip);
  parts.push(...codes);
  return parts.join("-");
}

/* Find exact match rug (same design + exact same code sequence) */
export function findExactMatch(desen, codes, excludeId) {
  const list = state.rugsByDesign[desen] || [];
  const key = codes.join("|");
  return list.find((r) => {
    if (excludeId && r.product_id === excludeId) return false;
    const rc = (r.sku_parsed && r.sku_parsed.codes) || [];
    return rc.join("|") === key;
  });
}

/* ---- Koleksiyon isim formatı ---- */
const COLLECTION_DISPLAY = {
  "plain": "Plain",
  "marquise": "Marquise",
  "coral": "Coral",
  "crystal": "Crystal",
  "istanbul": "Istanbul",
  "monochrome": "Monochrome",
  "shell": "Shell",
  "amorph": "Amorph",
  "art-deco-56": "Art Deco",
  "mystic-81": "Mystic",
  "cok-renkli-77": "Çok Renkli",
};
export function collectionLabel(slug) {
  return COLLECTION_DISPLAY[slug] || (slug || "").replace(/-/g, " ");
}
export function allCollectionsSorted() {
  return [...state.collections].sort((a, b) =>
    collectionLabel(a).localeCompare(collectionLabel(b), "tr")
  );
}

/* ---- Renk aileleri (benzer renkler yan yana görünmesi için) ----
 * Hue wheel yakın sırada: beyaz → bej/toprak → sarı → turuncu → kırmızı →
 * pembe/mor → mavi → yeşil → kahve → gri → siyah.
 * Renk adı keyword'lerinden aile belirliyoruz (elimizde hex yok).
 */
const FAMILIES = [
  { key: "white",    label: "Beyazlar · Krem",   order: 0,  rx: /(BEYAZ|KREM|EKRU|KEMIK|FILDISI|BEJ BEYAZ)/ },
  { key: "beige",    label: "Bej · Kum",          order: 1,  rx: /(BEJ|VIZON|KUMTASI|SEPYA|TAS)/ },
  { key: "yellow",   label: "Sarılar · Altın",   order: 2,  rx: /(SARI|GOLD|HARDAL|SAFRAN|LIMON)/ },
  { key: "orange",   label: "Turuncu · Terra",   order: 3,  rx: /(KIREMIT|TURUNCU|SOMON|MERCAN|BAKIR|PAS|BRONZ|AMBER|TARCIN|TABA)/ },
  { key: "red",      label: "Kırmızılar",        order: 4,  rx: /(KIRMIZI|BORDO|SARAP|VISNE|NAR)/ },
  { key: "pink",     label: "Pembeler",          order: 5,  rx: /(PEMBE|FUSYA|GUL|ROSE|RUJ|DUSTY)/ },
  { key: "purple",   label: "Morlar · Lila",     order: 6,  rx: /(MOR|LILA|LAVANTA|EFLATUN|MENEKSE|MURDUM|LEYLAK)/ },
  { key: "blue",     label: "Maviler",           order: 7,  rx: /(LACIVERT|MAVI|PETROL|BUZ|INDIGO|KOBALT|DENIM|SAKS|CAM GOBEG)/ },
  { key: "green",    label: "Yeşiller",          order: 8,  rx: /(YESIL|CIMEN|KIVI|ZEYTIN|NIL|MINT|HAKI|CAM)/ },
  { key: "brown",    label: "Kahveler · Toprak", order: 9,  rx: /(KAHVE|FINDIK|KAKAO|CIKOLATA|KESTANE|CEVIZ|TOPRAK|HAZEL)/ },
  { key: "gray",     label: "Griler",            order: 10, rx: /(GRI|ANTRASIT|GUMUS)/ },
  { key: "black",    label: "Siyahlar",          order: 11, rx: /(SIYAH|KOMUR)/ },
  { key: "other",    label: "Diğer",             order: 99, rx: /.*/ },
];

export function colorFamily(code) {
  const c = state.colors[code];
  if (!c) return FAMILIES[FAMILIES.length - 1];
  const n = normalize(c.name_tr);
  for (const f of FAMILIES) {
    if (f.rx.test(n)) return f;
  }
  return FAMILIES[FAMILIES.length - 1];
}

/* Brightness proxy: "AÇIK" → 0, "KOYU" → 2, normal → 1. Aile içi sıra için. */
function brightness(code) {
  const c = state.colors[code];
  if (!c) return 1;
  const n = normalize(c.name_tr);
  if (/\bACIK\b/.test(n)) return 0;
  if (/\bKOYU\b/.test(n)) return 2;
  return 1;
}

/* Aileye göre sıralı renk kodları listesi.
 * Sıra: verified önce → aile.order → aile içinde brightness → sonra isim (tr). */
export function sortedByFamily({ verifiedOnly = false } = {}) {
  return Object.keys(state.colors)
    .filter((code) => !verifiedOnly || state.colors[code].verified)
    .sort((a, b) => {
      const va = state.colors[a], vb = state.colors[b];
      if (va.verified !== vb.verified) return va.verified ? -1 : 1;
      const fa = colorFamily(a).order, fb = colorFamily(b).order;
      if (fa !== fb) return fa - fb;
      const ba = brightness(a), bb = brightness(b);
      if (ba !== bb) return ba - bb;
      return va.name_tr.localeCompare(vb.name_tr, "tr");
    });
}

/* Backward-compat alias */
export function verifiedSortedColors() {
  return sortedByFamily({ verifiedOnly: false });
}
