/* Levn — Studio modu: halı seç → renk slotlarını değiştir → yeni SKU üret.
 *
 * Akış:
 *   1. Sol panelde halı arama + grid
 *   2. Halı seçilince middle panel editör açılır
 *      - orijinal görsel (referans)
 *      - renk slotları (tıklanabilir) → palette popover
 *      - canlı SKU (kopyala butonu)
 *      - "bu kombinasyon stoklu mu" kontrolü (aynı desen üstünde)
 *   3. Alt panelde benzer halılar:
 *      - aynı desenin diğer renk varyantları
 *      - aynı palet, farklı desen
 */

import {
  state, assetUrl, colorName, escapeHtml, normalize, buildSku, findExactMatch,
  collectionLabel, allCollectionsSorted,
} from "./shared.js";
import { openPalette } from "./palette.js";

const studio = {
  // Picker (rug list)
  search: "",
  collectionFilter: "",

  // Editor
  currentRug: null,
  workingCodes: [],
};

function $(id) { return document.getElementById(id); }

/* ============ PICKER (sol panel) ============ */

function renderPicker() {
  const grid = $("rugPickerGrid");
  const count = $("studioPickerCount");
  grid.innerHTML = "";
  const q = normalize(studio.search.trim());

  // Dedup by product_id (cok-renkli overlap)
  const seen = new Set();
  let matches = [];
  for (const rug of state.rugs) {
    if (rug.product_id && seen.has(rug.product_id)) continue;
    if (studio.collectionFilter && rug.collection !== studio.collectionFilter) continue;
    if (q) {
      const hay = normalize(
        (rug.title || "") + " " +
        (rug.sku_raw || "") + " " +
        (rug.collection || "")
      );
      if (!hay.includes(q)) continue;
    }
    if (rug.product_id) seen.add(rug.product_id);
    matches.push(rug);
  }

  count.textContent = `${matches.length} halı`;

  // Limit render for perf; lazy-load images to avoid network stampede
  const SHOW = 60;
  for (const rug of matches.slice(0, SHOW)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "picker-card";
    if (studio.currentRug && studio.currentRug.product_id === rug.product_id) {
      card.classList.add("active");
    }
    const codes = (rug.sku_parsed && rug.sku_parsed.codes) || [];
    const dots = codes.map((c) =>
      `<span class="palette-dot" style="background-image:url('${assetUrl(c)}')"></span>`
    ).join("");
    card.innerHTML = `
      <div class="picker-img">
        <img loading="lazy" decoding="async" src="${escapeHtml(rug.img_url || "")}" alt="">
      </div>
      <div class="picker-info">
        <div class="picker-title">${escapeHtml(rug.title || "")}</div>
        <div class="picker-sku">
          <span class="picker-collection">${escapeHtml(collectionLabel(rug.collection))}</span>
          <span>${escapeHtml(rug.sku_raw || "")}</span>
        </div>
        <div class="picker-dots">${dots}</div>
      </div>`;
    card.addEventListener("click", () => selectRug(rug));
    grid.appendChild(card);
  }
  if (matches.length > SHOW) {
    const more = document.createElement("div");
    more.className = "picker-more";
    more.textContent = `+${matches.length - SHOW} daha… aramayı daraltın`;
    grid.appendChild(more);
  }
  if (!matches.length) {
    grid.innerHTML = `<div class="grid-empty">Eşleşme yok.</div>`;
  }
}

function populateCollectionFilter() {
  const sel = $("rugCollectionFilter");
  for (const c of allCollectionsSorted()) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = collectionLabel(c);
    sel.appendChild(o);
  }
}

/* ============ EDITOR (orta panel) ============ */

function selectRug(rug) {
  studio.currentRug = rug;
  const codes = (rug.sku_parsed && rug.sku_parsed.codes) || [];
  studio.workingCodes = [...codes];
  renderPicker();     // re-render to highlight active
  renderEditor();
}

function renderEditor() {
  const rug = studio.currentRug;
  if (!rug) {
    $("editorEmpty").hidden = false;
    $("editorContent").hidden = true;
    return;
  }
  $("editorEmpty").hidden = true;
  $("editorContent").hidden = false;

  const parsed = rug.sku_parsed || {};

  $("editorTitle").textContent = rug.title || "";
  $("editorCollection").textContent = collectionLabel(rug.collection);
  $("editorProductLink").href = rug.product_url || "#";
  $("rugPreviewImage").style.backgroundImage = `url('${rug.img_url || ""}')`;
  $("skuOriginal").textContent = `Orijinal: ${parsed.raw || rug.sku_raw || ""}`;

  renderSkuAndSlots();
  renderModifiedIndicator();
  renderExistingMatch();
  renderSimilar();
}

/* Changed? */
function isModified() {
  const rug = studio.currentRug;
  if (!rug) return false;
  const orig = (rug.sku_parsed && rug.sku_parsed.codes) || [];
  if (orig.length !== studio.workingCodes.length) return true;
  return orig.some((c, i) => c !== studio.workingCodes[i]);
}

function modifiedSlotIndices() {
  const rug = studio.currentRug;
  const orig = (rug && rug.sku_parsed && rug.sku_parsed.codes) || [];
  const out = [];
  studio.workingCodes.forEach((c, i) => { if (c !== orig[i]) out.push(i); });
  return out;
}

function renderModifiedIndicator() {
  const mod = isModified();
  const container = $("editorContent");
  container.classList.toggle("is-modified", mod);
  const caption = $("rugPreviewCaption");
  if (caption) {
    caption.textContent = mod
      ? "⚠︎ Görsel orijinal renklerle — seçili kombinasyon farklı"
      : "Referans görsel (orijinal renklerle)";
  }
  const badge = $("previewBadge");
  if (badge) badge.hidden = !mod;
}

function renderSkuAndSlots() {
  const rug = studio.currentRug;
  const parsed = rug.sku_parsed || {};
  const origCodes = parsed.codes || [];
  const newSku = buildSku(parsed.desen, parsed.tip, studio.workingCodes);
  $("skuValue").textContent = newSku;
  $("skuValue").classList.toggle("is-modified", isModified());

  const slots = $("slotsGrid");
  slots.innerHTML = "";
  studio.workingCodes.forEach((code, i) => {
    const c = state.colors[code];
    const asset = state.assets[code];
    const changed = code !== origCodes[i];
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "slot"
      + (asset && asset.mode === "fallback" ? " fallback" : "")
      + (changed ? " changed" : "");
    const origName = changed
      ? (state.colors[origCodes[i]] ? state.colors[origCodes[i]].name_tr : origCodes[i])
      : "";
    slot.innerHTML = `
      <div class="slot-index">${i + 1}</div>
      ${changed ? `<div class="slot-changed-badge">değişti</div>` : ""}
      <div class="slot-swatch" style="background-image:url('${assetUrl(code)}')"></div>
      <div class="slot-meta">
        <span class="slot-name">${escapeHtml((c && c.name_tr) || "—")}</span>
        <span class="slot-code">${escapeHtml(code)}</span>
        ${changed ? `<span class="slot-orig">orijinal: ${escapeHtml(origName)}</span>` : ""}
      </div>
      <div class="slot-edit-hint">${changed ? "tekrar değiştir" : "değiştir"}</div>
    `;
    slot.addEventListener("click", async () => {
      const res = await openPalette({
        slotIndex: i,
        title: `Slot ${i + 1} — renk seç`,
        currentCode: code,
      });
      if (res && res.code) {
        studio.workingCodes[i] = res.code;
        renderSkuAndSlots();
        renderModifiedIndicator();
        renderExistingMatch();
        renderSimilar();
      }
    });
    slots.appendChild(slot);
  });
}

function renderExistingMatch() {
  const rug = studio.currentRug;
  const parsed = rug.sku_parsed || {};
  const box = $("existingMatch");

  // Aynı desen + aynı code dizisi (sıra dahil) — kendisi de olabilir
  const match = findExactMatch(parsed.desen, studio.workingCodes, null);
  if (!match) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  const isSelf = match.product_id === rug.product_id;
  box.hidden = false;
  box.className = "existing-match" + (isSelf ? " self" : " dupe");
  box.innerHTML = `
    <div class="match-img" style="background-image:url('${escapeHtml(match.img_url || "")}')"></div>
    <div class="match-body">
      <div class="match-label">${isSelf ? "Bu orijinal kombinasyon" : "Bu kombinasyon zaten stoklu"}</div>
      <div class="match-title">${escapeHtml(match.title || "")}</div>
      <div class="match-sku">${escapeHtml(match.sku_raw || "")}</div>
      ${!isSelf ? `<a class="match-link" href="${escapeHtml(match.product_url || "#")}" target="_blank" rel="noopener">Ürünü aç ↗</a>` : ""}
    </div>
  `;
}

/* ============ SIMILAR (alt bölüm) ============ */

function renderSimilar() {
  renderSameDesign();
  renderSamePalette();
}

function renderSameDesign() {
  const rug = studio.currentRug;
  const parsed = rug.sku_parsed || {};
  const row = $("sameDesignRow");
  const count = $("sameDesignCount");
  row.innerHTML = "";

  const list = (state.rugsByDesign[parsed.desen] || [])
    .filter((r) => r.product_id !== rug.product_id);

  // Dedup by product_id (sometimes same product appears in multiple collections)
  const seen = new Set();
  const unique = [];
  for (const r of list) {
    if (r.product_id && seen.has(r.product_id)) continue;
    if (r.product_id) seen.add(r.product_id);
    unique.push(r);
  }

  count.textContent = unique.length ? `${unique.length} varyant` : "yok";
  if (!unique.length) {
    row.innerHTML = `<div class="grid-empty small">Bu desenin başka renk varyantı yok.</div>`;
    return;
  }
  for (const r of unique.slice(0, 30)) row.appendChild(similarCard(r));
}

function renderSamePalette() {
  const rug = studio.currentRug;
  const parsed = rug.sku_parsed || {};
  const row = $("samePaletteRow");
  const count = $("samePaletteCount");
  row.innerHTML = "";

  const selArr = studio.workingCodes;
  const selSet = new Set(selArr);
  if (!selSet.size) {
    count.textContent = "";
    return;
  }

  // AND: tüm seçili renkleri barındıranlar; sonra partial fallback.
  const andMatches = [];
  const partial = [];
  const seen = new Set();
  for (const r of state.rugs) {
    if (!r.sku_parsed || r.sku_parsed.desen === parsed.desen) continue;
    if (r.product_id && seen.has(r.product_id)) continue;
    const codes = r.sku_parsed.codes || [];
    if (!codes.length) continue;
    const rSet = new Set(codes);
    const overlap = selArr.filter((c) => rSet.has(c)).length;
    if (!overlap) continue;
    if (r.product_id) seen.add(r.product_id);

    const info = { rug: r, overlap, total: codes.length };
    if (overlap === selSet.size) {
      // Primary match bonus
      info.score = 10 + (rSet.has(selArr[0]) ? 1 : 0) + selSet.size / codes.length;
      andMatches.push(info);
    } else {
      info.score = overlap / codes.length + overlap * 0.2;
      partial.push(info);
    }
  }
  andMatches.sort((a, b) => b.score - a.score);
  partial.sort((a, b) => b.overlap - a.overlap || b.score - a.score);

  const shown = andMatches.length ? andMatches : partial.slice(0, 15);
  const label = andMatches.length
    ? `${andMatches.length} halı — hepsini birden barındırıyor`
    : (partial.length ? `Tam eşleşme yok — en yakın ${shown.length}` : "yok");
  count.textContent = label;

  if (!shown.length) {
    row.innerHTML = `<div class="grid-empty small">Bu paletle uyumlu başka halı yok.</div>`;
    return;
  }
  for (const s of shown.slice(0, 30)) row.appendChild(similarCard(s.rug, s));
}

function similarCard(rug, scoreInfo) {
  const codes = (rug.sku_parsed && rug.sku_parsed.codes) || [];
  const selSet = new Set(studio.workingCodes);
  const dots = codes.map((code) => {
    const m = selSet.has(code);
    return `<span class="palette-dot ${m ? "match" : ""}"
              title="${escapeHtml(colorName(code))}"
              style="background-image:url('${assetUrl(code)}')"></span>`;
  }).join("");

  const a = document.createElement("a");
  a.className = "similar-card";
  a.href = rug.product_url || "#";
  a.target = "_blank";
  a.rel = "noopener";
  const badge = scoreInfo
    ? `<span class="similar-badge">${scoreInfo.overlap}/${scoreInfo.total}</span>`
    : "";
  a.innerHTML = `
    <div class="similar-img">
      <img loading="lazy" decoding="async" src="${escapeHtml(rug.img_url || "")}" alt="">
      ${badge}
    </div>
    <div class="similar-body">
      <div class="similar-title">${escapeHtml(rug.title || "")}</div>
      <div class="similar-collection">${escapeHtml(collectionLabel(rug.collection))}</div>
    </div>
    <div class="similar-dots">${dots}</div>
  `;
  return a;
}

/* ============ COPY + RESET ============ */

async function copySku() {
  const sku = $("skuValue").textContent;
  const status = $("skuStatus");
  try {
    await navigator.clipboard.writeText(sku);
    status.textContent = "Kopyalandı ✓";
    status.className = "sku-status ok";
  } catch (e) {
    // Fallback: select range
    const r = document.createRange();
    r.selectNode($("skuValue"));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    status.textContent = "Seçildi — Cmd+C";
    status.className = "sku-status warn";
  }
  setTimeout(() => { status.textContent = ""; status.className = "sku-status"; }, 2200);
}

/* ============ PRINT / PDF ============ */

function buildPrintHTML() {
  const rug = studio.currentRug;
  if (!rug) return "";
  const parsed = rug.sku_parsed || {};
  const orig = parsed.codes || [];
  const work = studio.workingCodes;
  const newSku = buildSku(parsed.desen, parsed.tip, work);
  const date = new Date().toLocaleDateString("tr-TR");

  const slotRows = work.map((code, i) => {
    const o = orig[i];
    const oC = state.colors[o] || {};
    const nC = state.colors[code] || {};
    const changed = code !== o;
    return `
      <tr class="${changed ? "changed" : ""}">
        <td class="ix">${i + 1}</td>
        <td class="cell">
          <img class="sw" src="${assetUrl(o)}" alt="">
          <div><strong>${escapeHtml(oC.name_tr || o)}</strong><br><span class="mono">${escapeHtml(o)}</span></div>
        </td>
        <td class="arrow">${changed ? "→" : "="}</td>
        <td class="cell">
          <img class="sw" src="${assetUrl(code)}" alt="">
          <div><strong>${escapeHtml(nC.name_tr || code)}</strong><br><span class="mono">${escapeHtml(code)}</span></div>
        </td>
      </tr>`;
  }).join("");

  return `
    <header class="print-head">
      <div>
        <div class="print-brand">Levn — BM Home Halı Renk Studio</div>
        <h1>${escapeHtml(rug.title || "")}</h1>
        <div class="print-meta">
          ${escapeHtml(collectionLabel(rug.collection))} · ${date}
        </div>
      </div>
      <div class="print-sku-card">
        <div class="lbl">Üretim Kodu</div>
        <div class="val">${escapeHtml(newSku)}</div>
        <div class="lbl small">Orijinal: ${escapeHtml(parsed.raw || rug.sku_raw || "")}</div>
      </div>
    </header>

    <section class="print-cmp">
      <div class="print-img-card">
        <img src="${escapeHtml(rug.img_url || "")}" alt="" crossorigin="anonymous">
        <div class="print-cap">Referans halı görseli (orijinal renklerle)</div>
      </div>
      <div class="print-table-wrap">
        <h3>Renk Karşılaştırma</h3>
        <table class="print-table">
          <thead>
            <tr><th>#</th><th>Orijinal</th><th></th><th>Yeni</th></tr>
          </thead>
          <tbody>${slotRows}</tbody>
        </table>
      </div>
    </section>

    <footer class="print-foot">
      Bu kod fabrikaya iletilebilir. · Levn ${date}
    </footer>
  `;
}

function openPrint() {
  const sheet = $("printSheet");
  sheet.innerHTML = buildPrintHTML();
  document.body.classList.add("printing");

  // Wait for ALL images in the print sheet to load before opening the dialog,
  // otherwise Chrome/Safari may print blank slots.
  const imgs = [...sheet.querySelectorAll("img")];
  const ready = Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((res) => {
      img.addEventListener("load", res, { once: true });
      img.addEventListener("error", res, { once: true });
    });
  }));
  ready.then(() => {
    requestAnimationFrame(() => {
      window.print();
      setTimeout(() => document.body.classList.remove("printing"), 500);
    });
  });
}

function resetRug() {
  const rug = studio.currentRug;
  if (!rug) return;
  studio.workingCodes = [...((rug.sku_parsed && rug.sku_parsed.codes) || [])];
  renderSkuAndSlots();
  renderModifiedIndicator();
  renderExistingMatch();
  renderSimilar();
}

/* ============ INIT ============ */

/* Dış modüllerin Studio'ya halı göndermesi için köprü.
 * Ör. Finder sekmesinden bir halıya tıklandığında çağrılır. */
export function openRugInStudio(rugOrId) {
  let rug = rugOrId;
  if (typeof rugOrId === "string") {
    rug = state.rugs.find((r) => r.product_id === rugOrId);
  }
  if (!rug) return false;
  selectRug(rug);
  // editor'ün görünür olduğundan emin ol: search/filtre halıyı gizleyebilir
  // ama picker'da yoksa bile editör doğru halıyı gösteriyor.
  // Scroll'u en başa al
  document.getElementById("editorContent")?.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function handleAiLockClick() {
  const btn = document.getElementById("aiColorizeBtn");
  if (!btn) return;
  btn.classList.remove("shake");
  void btn.offsetWidth; // reflow → animation replay
  btn.classList.add("shake");
  const status = document.getElementById("aiStatus");
  if (status) {
    status.textContent = "Yakında · AI ile renk değişimi";
    status.classList.add("show");
    clearTimeout(handleAiLockClick._t);
    handleAiLockClick._t = setTimeout(() => status.classList.remove("show"), 2200);
  }
}

export function initStudio() {
  populateCollectionFilter();
  renderPicker();
  renderEditor();

  $("rugSearch").addEventListener("input", (e) => {
    studio.search = e.target.value;
    renderPicker();
  });
  $("rugCollectionFilter").addEventListener("change", (e) => {
    studio.collectionFilter = e.target.value;
    renderPicker();
  });
  $("skuCopy").addEventListener("click", copySku);
  $("editorReset").addEventListener("click", resetRug);
  $("editorPrint").addEventListener("click", openPrint);

  const aiBtn = document.getElementById("aiColorizeBtn");
  if (aiBtn) aiBtn.addEventListener("click", handleAiLockClick);
}
