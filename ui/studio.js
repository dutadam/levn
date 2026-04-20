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
} from "./shared.js?v=16";
import { openPalette } from "./palette.js?v=16";
import { RecolorEngine, DEFAULT_CONFIG, rgbToLab } from "./recolor.js?v=16";

const studio = {
  // Picker (rug list)
  search: "",
  collectionFilter: "",

  // Editor
  currentRug: null,
  workingCodes: [],

  // Recolor engine state (Faz 5a)
  recolor: {
    engine: null,
    ready: false,
    busy: false,
    loadToken: 0,      // selectRug çağrıları yarıştığında en sonuncusu kazanır
    scores: [],
    hasFailed: false,  // CORS/yükleme hatası
  },

  // Görsel görüntüleme UI state
  view: {
    fsOpen: false,
  },

  // Admin panel (test amaçlı parametre tuning; ?admin=1 ile açılır)
  admin: {
    enabled: false,
    config: { ...DEFAULT_CONFIG },
    intensity: 1.0,
    // Optimizer robot state
    opt: {
      running: false,
      stop: false,
      targetLab: null,     // Float32Array n*3 — cached LAB target, downsampled
      targetW: 0,
      targetH: 0,
      targetImgURL: null,
    },
  },
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
  // Mobilde: picker'ı daralt, editor'ü aç + scroll
  if (window.innerWidth <= 900) {
    document.querySelector(".picker-pane")?.classList.add("collapsed");
    document.querySelector(".editor-pane")?.classList.remove("collapsed");
    setTimeout(() => {
      const el = document.querySelector(".editor-header") || document.getElementById("editorContent");
      if (el) {
        const y = el.getBoundingClientRect().top + window.scrollY - 8;
        window.scrollTo({ top: y, behavior: "smooth" });
      }
    }, 120);
  }
}

function renderEditor() {
  const rug = studio.currentRug;
  const bar = $("editorCollapsedBar");
  if (!rug) {
    $("editorEmpty").hidden = false;
    $("editorContent").hidden = true;
    if (bar) { bar.hidden = true; $("ecbLabel").textContent = "Bir halı seçin"; }
    return;
  }
  $("editorEmpty").hidden = true;
  $("editorContent").hidden = false;
  if (bar) { bar.hidden = false; $("ecbLabel").textContent = `▸ ${rug.title || "Halı düzenleyici"}`; }

  const parsed = rug.sku_parsed || {};

  $("editorTitle").textContent = rug.title || "";
  $("editorCollection").textContent = collectionLabel(rug.collection);
  $("editorProductLink").href = rug.product_url || "#";
  const origImg = $("previewOrigImg");
  if (origImg) origImg.src = rug.img_url || "";
  $("skuOriginal").textContent = `Orijinal: ${parsed.raw || rug.sku_raw || ""}`;

  // Faz 5a: recolor engine'i başlat
  initRecolorFor(rug);

  renderSkuAndSlots();
  renderModifiedIndicator();
  renderExistingMatch();
  renderSimilar();
}

/* ============ RECOLOR (Faz 5a MVP) ============ */

function ensureCanvas() {
  const host = $("rugPreviewImage");
  if (!host) return null;
  let canvas = host.querySelector("canvas.recolor-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "recolor-canvas";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);
  }
  return canvas;
}

function showCanvas(show) {
  const host = $("rugPreviewImage");
  if (!host) return;
  host.classList.toggle("recolor-active", !!show);
}

async function initRecolorFor(rug) {
  const token = ++studio.recolor.loadToken;
  studio.recolor.ready = false;
  studio.recolor.hasFailed = false;
  studio.recolor.scores = [];
  showCanvas(false);
  showPreviewTools(false);
  const warn = $("recolorQualityWarn");
  if (warn) warn.hidden = true;
  showRecolorSpinner(true);

  const codes = (rug.sku_parsed && rug.sku_parsed.codes) || [];
  if (!codes.length || !rug.img_url || !Object.keys(state.palette).length) {
    showRecolorSpinner(false);
    return;
  }

  try {
    const eng = new RecolorEngine(state.palette, studio.admin.config);
    studio.recolor.engine = eng;
    await eng.loadImage(rug.img_url);
    // Sırada başka halı seçildi mi? Bu yarışı kaybettiysek çık.
    if (token !== studio.recolor.loadToken) return;
    const { drift } = eng.segment(codes);
    if (token !== studio.recolor.loadToken) return;
    studio.recolor.scores = drift;
    studio.recolor.ready = true;
    // İlk render: orijinal (workingCodes = orig codes)
    applyRecolor();
  } catch (e) {
    if (token !== studio.recolor.loadToken) return;
    console.warn("[recolor] init failed:", e);
    studio.recolor.hasFailed = true;
    studio.recolor.ready = false;
  } finally {
    if (token === studio.recolor.loadToken) showRecolorSpinner(false);
  }
}

function applyRecolor() {
  const { engine, ready } = studio.recolor;
  if (!engine || !ready) return;
  // Güncel workingCodes ile engine slot'larını eşitle
  studio.workingCodes.forEach((code, i) => engine.setSlot(i, code));
  const imgData = engine.render({ intensity: studio.admin.intensity });
  const canvas = ensureCanvas();
  if (!canvas) return;
  canvas.width = engine.w;
  canvas.height = engine.h;
  engine.drawTo(canvas, imgData);
  showCanvas(true);
  showPreviewTools(true);
  updateQualityWarn();

  // Fullscreen açıksa oraya da aynı render'ı yansıt
  if (studio.view.fsOpen) {
    const fsCanvas = $("fsCanvas");
    if (fsCanvas) {
      fsCanvas.width = engine.w;
      fsCanvas.height = engine.h;
      engine.drawTo(fsCanvas, imgData);
    }
  }
}

function showPreviewTools(show) {
  const tools = $("previewTools");
  if (tools) tools.hidden = !show;
}

function updateQualityWarn() {
  const warn = $("recolorQualityWarn");
  const txt = $("recolorQualityWarnText");
  if (!warn) return;
  const scores = studio.recolor.scores || [];
  if (!scores.length) { warn.hidden = true; return; }

  // Drift eşik: >30 δE ciddi, >22 hafif uyarı
  const SOFT = 22, HARD = 35;
  let softCount = 0, hardCount = 0;
  const badSlots = [];
  scores.forEach((d, i) => {
    if (d > HARD) { hardCount++; badSlots.push(i + 1); }
    else if (d > SOFT) { softCount++; }
  });
  const anyMod = isModified();
  if (!anyMod || (hardCount === 0 && softCount === 0)) {
    warn.hidden = true;
    return;
  }
  warn.hidden = false;
  if (hardCount > 0) {
    warn.style.background = "rgba(220, 130, 80, 0.94)";
    if (txt) txt.textContent = `Slot ${badSlots.join(", ")} bu halıda net karşılığını bulamadı — sonuç yaklaşıktır.`;
  } else {
    warn.style.background = "rgba(255, 190, 90, 0.94)";
    if (txt) txt.textContent = "Bazı renkler halıda kısmi temsil ediliyor — sonuç yaklaşıktır.";
  }
}

function showRecolorSpinner(show) {
  const host = $("rugPreviewImage");
  if (!host) return;
  let spinner = host.querySelector(".recolor-spinner");
  if (show) {
    if (!spinner) {
      spinner = document.createElement("div");
      spinner.className = "recolor-spinner";
      spinner.innerHTML = `
        <div class="spinner-ring"></div>
        <div class="spinner-label">Renkler uygulanıyor…</div>`;
      host.appendChild(spinner);
    }
    spinner.hidden = false;
    host.classList.add("is-loading");
  } else {
    if (spinner) spinner.hidden = true;
    host.classList.remove("is-loading");
  }
}

/* ============ FULLSCREEN MODAL ============ */

function openFullscreen() {
  const modal = $("fullscreenModal");
  const fsCanvas = $("fsCanvas");
  const { engine, ready } = studio.recolor;
  if (!modal || !fsCanvas) return;

  studio.view.fsOpen = true;
  modal.setAttribute("open", "");
  document.body.style.overflow = "hidden";

  // Orijinal görseli fs-orig-img'e yükle
  const fsOrigImg = $("fsOrigImg");
  const rug = studio.currentRug;
  if (fsOrigImg && rug && rug.img_url) {
    fsOrigImg.src = rug.img_url;
  }

  // Fullscreen toggle state sıfırla
  const fsStage = fsCanvas.closest(".fs-stage");
  if (fsStage) fsStage.classList.remove("show-original");
  const fsOrigBtn = $("fsOrigBtn");
  if (fsOrigBtn) {
    fsOrigBtn.setAttribute("aria-pressed", "false");
    const lbl = $("fsOrigLabel");
    if (lbl) lbl.textContent = "Orijinal";
  }

  if (engine && ready) {
    fsCanvas.width = engine.w;
    fsCanvas.height = engine.h;
    const data = engine.render({ intensity: studio.admin.intensity });
    engine.drawTo(fsCanvas, data);
  } else {
    // Recolor yoksa orijinal görseli canvas'a da çiz
    if (!rug || !rug.img_url) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      fsCanvas.width = img.naturalWidth;
      fsCanvas.height = img.naturalHeight;
      const ctx = fsCanvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
    };
    img.onerror = () => {
      fsCanvas.style.backgroundImage = `url('${rug.img_url}')`;
      fsCanvas.style.backgroundSize = "contain";
      fsCanvas.style.backgroundRepeat = "no-repeat";
      fsCanvas.style.backgroundPosition = "center";
    };
    img.src = rug.img_url;
  }
}

function closeFullscreen() {
  const modal = $("fullscreenModal");
  if (!modal) return;
  studio.view.fsOpen = false;
  modal.removeAttribute("open");
  document.body.style.overflow = "";
  const fsCanvas = $("fsCanvas");
  if (fsCanvas) {
    fsCanvas.style.backgroundImage = "";
  }
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
  const recolorActive = studio.recolor.ready && !studio.recolor.hasFailed;
  if (caption) {
    if (!mod) {
      caption.textContent = "Referans görsel (orijinal renklerle)";
    } else if (recolorActive) {
      caption.textContent = "Canlı önizleme · yeni renk kombinasyonu (yaklaşık)";
    } else {
      caption.textContent = "⚠︎ Görsel orijinal renklerle — seçili kombinasyon farklı";
    }
  }
  const badge = $("previewBadge");
  if (badge) {
    // Canvas aktif ve modified ise badge gizli (canvas gerçeği gösteriyor).
    // Canvas pasifse (CORS/fail) eski uyarıyı göster.
    badge.hidden = !(mod && !recolorActive);
  }
  updateQualityWarn();
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
        applyRecolor();               // canlı görsel güncelle
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

  // Recolor engine aktif + modifiye → canvas'ın dataURL'ini kullan (canlı render'ı bas).
  // Değilse orijinal CDN görseline düş.
  const { engine, ready, hasFailed } = studio.recolor;
  const modified = isModified();
  let printImgSrc = rug.img_url || "";
  let printImgCap = "Referans halı görseli (orijinal renklerle)";
  if (engine && ready && !hasFailed) {
    try {
      // Güncel render'ı garanti et: slot'ları eşitle, _srcCanvas'a yaz, dataURL al.
      work.forEach((code, i) => engine.setSlot(i, code));
      const data = modified ? engine.render({ intensity: studio.admin.intensity }) : engine.renderOriginal();
      // drawTo yan etki olarak _srcCanvas'a putImageData yapıyor → toDataURL fresh.
      const tmp = document.createElement("canvas");
      tmp.width = engine.w; tmp.height = engine.h;
      engine.drawTo(tmp, data);
      printImgSrc = engine.toDataURL("image/jpeg", 0.92);
      printImgCap = modified
        ? "Canlı önizleme · yeni renk kombinasyonu (yaklaşık)"
        : "Referans halı görseli (orijinal renklerle)";
    } catch (e) {
      console.warn("[print] toDataURL failed, falling back to CDN image", e);
    }
  }

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
        <img src="${escapeHtml(printImgSrc)}" alt="" crossorigin="anonymous">
        <div class="print-cap">${escapeHtml(printImgCap)}</div>
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
  applyRecolor();                // canvas'ı da orijinale döndür
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

  // Preview tools
  const fsBtn = $("previewFullscreenBtn");
  if (fsBtn) {
    fsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFullscreen();
    });
  }
  // Orijinal toggle butonu
  const origBtn = $("previewOriginalBtn");
  if (origBtn) {
    origBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const imgHost = $("rugPreviewImage");
      const isShowing = imgHost.classList.toggle("show-original");
      origBtn.classList.toggle("active", isShowing);
      origBtn.setAttribute("aria-pressed", isShowing ? "true" : "false");
      const lbl = $("previewOriginalLabel");
      if (lbl) lbl.textContent = isShowing ? "Yeni Renk" : "Orijinal";
    });
  }

  // Preview alanına direkt tıkla → fullscreen
  const host = $("rugPreviewImage");
  if (host) {
    host.addEventListener("click", (e) => {
      if (e.target.closest(".preview-tool-btn")) return;
      if (!studio.currentRug) return;
      openFullscreen();
    });
  }

  // Fullscreen orijinal toggle
  const fsOrigBtn = $("fsOrigBtn");
  if (fsOrigBtn) {
    fsOrigBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const fsStage = $("fsCanvas").closest(".fs-stage");
      const isShowing = fsStage.classList.toggle("show-original");
      fsOrigBtn.setAttribute("aria-pressed", isShowing ? "true" : "false");
      fsOrigBtn.classList.toggle("active", isShowing);
      const lbl = $("fsOrigLabel");
      if (lbl) lbl.textContent = isShowing ? "Yeni Renk" : "Orijinal";
    });
  }

  // Fullscreen modal
  const fsClose = $("fsCloseBtn");
  if (fsClose) fsClose.addEventListener("click", closeFullscreen);
  const fsModal = $("fullscreenModal");
  if (fsModal) {
    fsModal.addEventListener("click", (e) => {
      if (e.target === fsModal) closeFullscreen();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (studio.view.fsOpen && e.key === "Escape") closeFullscreen();
    // Alt+A → admin paneli toggle
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      toggleAdminPanel();
    }
  });

  initAdminPanel();
}

/* ============ ADMIN PANEL ============ */

function initAdminPanel() {
  const params = new URLSearchParams(location.search);
  const urlAdmin = params.get("admin") === "1";
  const stored = localStorage.getItem("levn_admin_enabled");
  studio.admin.enabled = urlAdmin || stored === "1";

  // localStorage'tan kayıtlı config yükle (varsa) — admin aktif olmasa da config kalıcı
  try {
    const savedCfg = localStorage.getItem("levn_admin_config");
    if (savedCfg) {
      const parsed = JSON.parse(savedCfg);
      studio.admin.config = { ...DEFAULT_CONFIG, ...parsed };
      if (typeof parsed.intensity === "number") studio.admin.intensity = parsed.intensity;
    }
  } catch (e) { /* ignore */ }

  if (studio.admin.enabled) {
    localStorage.setItem("levn_admin_enabled", "1");
    const toggle = $("adminToggle");
    if (toggle) toggle.hidden = false;
  }

  syncAdminPanelUI();

  // Listeners
  const fields = [
    ["adminMaxSide", "adminMaxSideOut", "maxSide", parseInt],
    ["adminSigma", "adminSigmaOut", "sigma2Mult", parseFloat],
    ["adminBlur", "adminBlurOut", "blurSigma", parseFloat],
    ["adminChroma", "adminChromaOut", "chromaWeight", parseFloat],
    ["adminShiftBlur", "adminShiftBlurOut", "shiftBlurSigma", parseFloat],
    ["adminPreserve", "adminPreserveOut", "preserveUnchanged", parseFloat],
    ["adminSmoothLo", "adminSmoothLoOut", "smoothLo", parseFloat],
    ["adminSmoothHi", "adminSmoothHiOut", "smoothHi", parseFloat],
    ["adminMinScale", "adminMinScaleOut", "minScale", parseFloat],
    ["adminMaxScale", "adminMaxScaleOut", "maxScale", parseFloat],
    ["adminTopM", "adminTopMOut", "topM", parseInt],
    ["adminKIter", "adminKIterOut", "kmeansMaxIter", parseInt],
    ["adminStride", "adminStrideOut", "sampleStride", parseInt],
  ];
  for (const [inp, out, key, parse] of fields) {
    const el = $(inp);
    if (!el) continue;
    el.addEventListener("input", () => {
      const v = parse(el.value);
      studio.admin.config[key] = v;
      $(out).textContent = Number.isInteger(v) ? v : v.toFixed(2);
    });
  }
  const intens = $("adminIntensity");
  if (intens) {
    intens.addEventListener("input", () => {
      studio.admin.intensity = parseFloat(intens.value);
      $("adminIntensityOut").textContent = studio.admin.intensity.toFixed(2);
    });
  }

  $("adminClose")?.addEventListener("click", () => panel.hidden = true);
  $("adminToggle")?.addEventListener("click", toggleAdminPanel);

  $("adminApply")?.addEventListener("click", async () => {
    const eng = studio.recolor.engine;
    if (!eng) return;
    // maxSide değiştiyse loadImage'ı tekrar çalıştırmak gerek → tam init
    const needReload = eng.maxSide !== studio.admin.config.maxSide;
    eng.setConfig(studio.admin.config);
    if (needReload && studio.currentRug) {
      showRecolorSpinner(true);
      try {
        await eng.loadImage(studio.currentRug.img_url);
        eng.segment((studio.currentRug.sku_parsed && studio.currentRug.sku_parsed.codes) || []);
        studio.workingCodes.forEach((code, i) => eng.setSlot(i, code));
      } finally { showRecolorSpinner(false); }
    } else {
      eng.resegment();
    }
    applyRecolor();
    updateAdminStats();
    persistAdminConfig();
  });
  $("adminRenderOnly")?.addEventListener("click", () => {
    const eng = studio.recolor.engine;
    if (!eng) return;
    eng.setConfig(studio.admin.config);
    applyRecolor();
    updateAdminStats();
    persistAdminConfig();
  });
  $("adminReset")?.addEventListener("click", () => {
    studio.admin.config = { ...DEFAULT_CONFIG };
    studio.admin.intensity = 1.0;
    syncAdminPanelUI();
    persistAdminConfig();
  });
  $("adminCopyCfg")?.addEventListener("click", () => {
    const cfg = { ...studio.admin.config, intensity: studio.admin.intensity };
    navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
    const btn = $("adminCopyCfg");
    const orig = btn.textContent;
    btn.textContent = "✓ Kopyalandı";
    setTimeout(() => btn.textContent = orig, 1400);
  });

  // Optimizer setup
  initOptimizerUI();
}

/* ============ OPTIMIZER ROBOT ============ */

// Parametre arama uzayı (WIDE aralıklar)
const OPT_BOUNDS = {
  sigma2Mult:       [0.10, 0.70],
  blurSigma:        [0.0,  5.0],
  chromaWeight:     [0.5,  6.0],
  shiftBlurSigma:   [0.0,  4.0],
  smoothLo:         [0.0,  0.20],
  smoothHi:         [0.25, 0.90],
  minScale:         [0.4,  1.0],
  maxScale:         [1.0,  2.5],
  kmeansMaxIter:    [3,    25],
  preserveUnchanged:[0.35, 0.85], // Yüksek = diğer renkler daha çok korunur
};

function initOptimizerUI() {
  const fileInput = $("adminTargetFile");
  const clearBtn = $("adminTargetClear");
  const optBtn = $("adminOptimize");
  const stopBtn = $("adminOptStop");
  if (!fileInput) return;

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = await loadImgAsync(url);
    const cropped = cropLetterboxCanvas(img);
    // Downsample to 256 wide for fast comparison
    const tw = 256;
    const th = Math.max(32, Math.round(256 * cropped.height / cropped.width));
    const small = document.createElement("canvas");
    small.width = tw; small.height = th;
    const sctx = small.getContext("2d");
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(cropped, 0, 0, tw, th);
    const data = sctx.getImageData(0, 0, tw, th).data;
    const lab = new Float32Array(tw * th * 3);
    for (let i = 0; i < tw * th; i++) {
      const [L, a, b] = rgbToLab(data[i*4], data[i*4+1], data[i*4+2]);
      lab[i*3] = L; lab[i*3+1] = a; lab[i*3+2] = b;
    }
    studio.admin.opt.targetLab = lab;
    studio.admin.opt.targetW = tw;
    studio.admin.opt.targetH = th;
    studio.admin.opt.targetImgURL = url;

    // ★ Source LAB'ı da cache'le (engine.renderOriginal() → downsample → LAB)
    // Bu, "değişmemiş bölgelerde source'tan sapma" penalty'si için gerekli
    const eng = studio.recolor.engine;
    if (eng && eng.w) {
      const srcCanv = document.createElement("canvas");
      srcCanv.width = eng.w; srcCanv.height = eng.h;
      srcCanv.getContext("2d").putImageData(eng.renderOriginal(), 0, 0);
      const smallSrc = document.createElement("canvas");
      smallSrc.width = tw; smallSrc.height = th;
      const ssctx = smallSrc.getContext("2d");
      ssctx.imageSmoothingQuality = "high";
      ssctx.drawImage(srcCanv, 0, 0, tw, th);
      const sdata = ssctx.getImageData(0, 0, tw, th).data;
      const srcLab = new Float32Array(tw * th * 3);
      for (let i = 0; i < tw * th; i++) {
        const [L, a, b] = rgbToLab(sdata[i*4], sdata[i*4+1], sdata[i*4+2]);
        srcLab[i*3] = L; srcLab[i*3+1] = a; srcLab[i*3+2] = b;
      }
      studio.admin.opt.sourceLab = srcLab;
    }

    $("adminTargetImg").src = url;
    $("adminTargetPreview").hidden = false;
    $("adminOptimize").disabled = !studio.recolor.engine;
  });

  clearBtn?.addEventListener("click", () => {
    studio.admin.opt.targetLab = null;
    $("adminTargetPreview").hidden = true;
    fileInput.value = "";
    $("adminOptimize").disabled = true;
  });

  optBtn?.addEventListener("click", runOptimizer);
  stopBtn?.addEventListener("click", () => {
    studio.admin.opt.stop = true;
  });
}

function loadImgAsync(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/** Siyah letterbox bantlarını kırp — çoğu ürün fotoğrafında bu var. */
function cropLetterboxCanvas(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const isDark = (i) => (data[i] + data[i+1] + data[i+2]) < 90;

  // Top
  let top = 0;
  for (let y = 0; y < c.height; y++) {
    let hasContent = false;
    for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width / 64))) {
      if (!isDark((y * c.width + x) * 4)) { hasContent = true; break; }
    }
    if (hasContent) { top = y; break; }
  }
  // Bottom
  let bottom = c.height - 1;
  for (let y = c.height - 1; y > top; y--) {
    let hasContent = false;
    for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width / 64))) {
      if (!isDark((y * c.width + x) * 4)) { hasContent = true; break; }
    }
    if (hasContent) { bottom = y; break; }
  }
  // Left
  let left = 0;
  for (let x = 0; x < c.width; x++) {
    let hasContent = false;
    for (let y = top; y <= bottom; y += Math.max(1, Math.floor((bottom-top) / 64))) {
      if (!isDark((y * c.width + x) * 4)) { hasContent = true; break; }
    }
    if (hasContent) { left = x; break; }
  }
  // Right
  let right = c.width - 1;
  for (let x = c.width - 1; x > left; x--) {
    let hasContent = false;
    for (let y = top; y <= bottom; y += Math.max(1, Math.floor((bottom-top) / 64))) {
      if (!isDark((y * c.width + x) * 4)) { hasContent = true; break; }
    }
    if (hasContent) { right = x; break; }
  }
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw <= 0 || ch <= 0) return c;
  const out = document.createElement("canvas");
  out.width = cw; out.height = ch;
  out.getContext("2d").drawImage(c, left, top, cw, ch, 0, 0, cw, ch);
  return out;
}

/** Engine'in son render'ını hedefle karşılaştır — ağırlıklı ΔE (LAB).
 *
 * DÜAL LOSS:
 *   - "Değişmemiş bölgeler" (target ≈ source): render'ın source'tan sapması 2.5× penalize
 *     → robot "bleed" ile unchanged pikselleri hareket ettirmeye cesaret edemez
 *   - "Değişmiş bölgeler" (target ≠ source): render'ın target'a yakınlığı ödüllendirilir
 *
 * Bu, "bu renk okey ama diğerleri etkilenmesin" probleminin çözümüdür.
 */
function evaluateCurrentRender(eng) {
  const { targetLab, sourceLab, targetW, targetH } = studio.admin.opt;
  if (!targetLab) return Infinity;
  const cmp = document.createElement("canvas");
  cmp.width = targetW; cmp.height = targetH;
  const cctx = cmp.getContext("2d");
  cctx.imageSmoothingQuality = "medium";
  cctx.drawImage(eng._srcCanvas, 0, 0, targetW, targetH);
  const rgb = cctx.getImageData(0, 0, targetW, targetH).data;

  const UNCHANGED_THRESH = 4.0;   // δE(target, source) < bu → değişmemiş bölge
  const PRESERVE_WEIGHT = 2.5;    // Değişmemiş bölgelerde deviation penalty çarpanı
  let sum = 0, cnt = 0;
  for (let i = 0; i < targetW * targetH; i++) {
    const [L, a, b] = rgbToLab(rgb[i*4], rgb[i*4+1], rgb[i*4+2]);
    const tL = targetLab[i*3], tA = targetLab[i*3+1], tB = targetLab[i*3+2];

    if (sourceLab) {
      const sL = sourceLab[i*3], sA = sourceLab[i*3+1], sB = sourceLab[i*3+2];
      const dTS = Math.sqrt((tL-sL)**2 + (tA-sA)**2 + (tB-sB)**2);
      if (dTS < UNCHANGED_THRESH) {
        // Değişmemiş bölge: render source'a yakın kalmalı
        const dRS = Math.sqrt((L-sL)**2 + (a-sA)**2 + (b-sB)**2);
        sum += PRESERVE_WEIGHT * dRS;
        cnt += PRESERVE_WEIGHT;
        continue;
      }
    }
    // Değişmiş bölge: render target'a yakın olmalı
    const dRT = Math.sqrt((L-tL)**2 + (a-tA)**2 + (b-tB)**2);
    sum += dRT;
    cnt += 1;
  }
  return sum / Math.max(1, cnt);
}

async function evalConfig(eng, cfg) {
  eng.setConfig(cfg);
  eng.resegment();
  studio.workingCodes.forEach((code, i) => eng.setSlot(i, code));
  const data = eng.render({ intensity: studio.admin.intensity });
  eng._srcCtx.putImageData(data, 0, 0);
  return evaluateCurrentRender(eng);
}

function uniform(lo, hi) { return lo + Math.random() * (hi - lo); }
function uniformInt(lo, hi) { return Math.round(uniform(lo, hi)); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Phase 1: uniform wide sample. */
function sampleWide() {
  return {
    sigma2Mult:       uniform(...OPT_BOUNDS.sigma2Mult),
    blurSigma:        uniform(...OPT_BOUNDS.blurSigma),
    chromaWeight:     uniform(...OPT_BOUNDS.chromaWeight),
    shiftBlurSigma:   uniform(...OPT_BOUNDS.shiftBlurSigma),
    smoothLo:         uniform(...OPT_BOUNDS.smoothLo),
    smoothHi:         uniform(...OPT_BOUNDS.smoothHi),
    minScale:         uniform(...OPT_BOUNDS.minScale),
    maxScale:         uniform(...OPT_BOUNDS.maxScale),
    kmeansMaxIter:    uniformInt(...OPT_BOUNDS.kmeansMaxIter),
    preserveUnchanged:uniform(...OPT_BOUNDS.preserveUnchanged),
  };
}

/** Phase 2: Gaussian perturbation around best, narrowing over time. */
function sampleNarrow(best, narrow) {
  // narrow: 0..1, 0 = no noise, 1 = wide
  const g = (lo, hi) => {
    const range = (hi - lo) * narrow * 0.5;
    // 2 uniforms → approx. Gaussian
    const n = (Math.random() + Math.random() - 1);
    return n * range;
  };
  const b = OPT_BOUNDS;
  return {
    sigma2Mult:       clamp(best.sigma2Mult     + g(...b.sigma2Mult),     ...b.sigma2Mult),
    blurSigma:        clamp(best.blurSigma      + g(...b.blurSigma),      ...b.blurSigma),
    chromaWeight:     clamp(best.chromaWeight   + g(...b.chromaWeight),   ...b.chromaWeight),
    shiftBlurSigma:   clamp(best.shiftBlurSigma + g(...b.shiftBlurSigma), ...b.shiftBlurSigma),
    smoothLo:         clamp(best.smoothLo       + g(...b.smoothLo),       ...b.smoothLo),
    smoothHi:         clamp(best.smoothHi       + g(...b.smoothHi),       ...b.smoothHi),
    minScale:         clamp(best.minScale       + g(...b.minScale),       ...b.minScale),
    maxScale:         clamp(best.maxScale       + g(...b.maxScale),       ...b.maxScale),
    kmeansMaxIter:    clamp(Math.round(best.kmeansMaxIter + g(...b.kmeansMaxIter)), ...b.kmeansMaxIter),
    preserveUnchanged:clamp((best.preserveUnchanged ?? 0.6) + g(...b.preserveUnchanged), ...b.preserveUnchanged),
  };
}

async function runOptimizer() {
  const eng = studio.recolor.engine;
  const opt = studio.admin.opt;
  if (!eng || !opt.targetLab) { alert("Önce halı seç ve hedef görseli yükle."); return; }
  if (opt.running) return;

  const budget = parseInt($("adminOptBudget").value) || 40;
  const fastMode = $("adminOptFast").checked;
  const prog = $("adminOptProgress");
  const startBtn = $("adminOptimize");
  const stopBtn = $("adminOptStop");
  opt.running = true; opt.stop = false;
  startBtn.disabled = true;
  stopBtn.hidden = false;

  // Hızlı mod: çözünürlüğü düşür (optimization süresi 3-5x azalır)
  let savedMaxSide = eng.config.maxSide;
  if (fastMode && savedMaxSide > 768) {
    eng.setConfig({ ...studio.admin.config, maxSide: 768 });
    prog.textContent = `[init] Hızlı mod için ${savedMaxSide}→768 reload...\n`;
    await eng.loadImage(studio.currentRug.img_url);
  }

  // Başlangıç: current config
  let bestCfg = { ...studio.admin.config };
  bestCfg.maxSide = eng.config.maxSide; // current
  let bestScore = await evalConfig(eng, bestCfg);
  const startScore = bestScore;
  const log = [`[start] δE=${bestScore.toFixed(2)}  (budget=${budget}, fast=${fastMode})`];
  prog.textContent = log.join("\n");

  const phase1 = Math.ceil(budget / 2);
  for (let i = 0; i < budget; i++) {
    if (opt.stop) { log.push("[stop] kullanıcı durdurdu"); break; }
    const inPhase1 = i < phase1;
    // Narrow factor: phase2'de iterasyon arttıkça daralır
    const narrow = inPhase1 ? 1.0 : 1.0 - (i - phase1) / Math.max(1, (budget - phase1));
    const candCfg = inPhase1 ? sampleWide() : sampleNarrow(bestCfg, narrow * 0.6);
    candCfg.maxSide = eng.config.maxSide;
    // Fixed paramlar
    candCfg.sigma2Min = DEFAULT_CONFIG.sigma2Min;
    candCfg.sigma2Max = DEFAULT_CONFIG.sigma2Max;
    candCfg.topM = bestCfg.topM;
    candCfg.sampleStride = bestCfg.sampleStride;

    const t0 = performance.now();
    let score;
    try {
      score = await evalConfig(eng, candCfg);
    } catch (e) {
      score = Infinity;
    }
    const dt = (performance.now() - t0).toFixed(0);
    const phase = inPhase1 ? "W" : "N";
    const mark = score < bestScore ? " ★" : "";
    log.push(`[${String(i+1).padStart(3)}/${budget} ${phase}] δE=${score.toFixed(2)} (best=${bestScore.toFixed(2)}) ${dt}ms${mark}`);
    if (score < bestScore) {
      bestScore = score;
      bestCfg = { ...candCfg };
    }
    // Son 12 satırı göster (çok kalabalık olmasın)
    prog.textContent = log.slice(-14).join("\n");
    prog.scrollTop = prog.scrollHeight;
    // Tarayıcıyı düşürme — event loop'a soluk ver
    await new Promise(r => setTimeout(r, 0));
  }

  // Hızlı mod'dan tam çözünürlüğe geri dön
  if (fastMode && savedMaxSide > 768) {
    bestCfg.maxSide = savedMaxSide;
    eng.setConfig(bestCfg);
    prog.textContent = log.slice(-14).join("\n") + `\n[finalize] ${savedMaxSide}px ile tekrar render...`;
    await eng.loadImage(studio.currentRug.img_url);
    const finalScore = await evalConfig(eng, bestCfg);
    log.push(`[final-hires] δE=${finalScore.toFixed(2)}`);
  }

  // Best config'i uygula + kaydet
  studio.admin.config = { ...bestCfg };
  syncAdminPanelUI();
  eng.setConfig(bestCfg);
  eng.resegment();
  applyRecolor();
  updateAdminStats();
  persistAdminConfig();

  const improv = ((startScore - bestScore) / startScore * 100).toFixed(1);
  log.push(`[done] δE ${startScore.toFixed(2)}→${bestScore.toFixed(2)} (%${improv} iyileşme) — config kaydedildi`);
  prog.textContent = log.slice(-16).join("\n");

  opt.running = false;
  startBtn.disabled = false;
  stopBtn.hidden = true;
}


function toggleAdminPanel() {
  const panel = $("adminPanel");
  if (!panel) return;
  if (!studio.admin.enabled) {
    studio.admin.enabled = true;
    localStorage.setItem("levn_admin_enabled", "1");
    const toggle = $("adminToggle");
    if (toggle) toggle.hidden = false;
  }
  panel.hidden = !panel.hidden;
  if (!panel.hidden) updateAdminStats();
}

function syncAdminPanelUI() {
  const c = studio.admin.config;
  const set = (id, out, v) => {
    const el = $(id); if (el) el.value = v;
    const outEl = $(out); if (outEl) outEl.textContent = Number.isInteger(v) ? v : Number(v).toFixed(2);
  };
  set("adminMaxSide", "adminMaxSideOut", c.maxSide);
  set("adminSigma", "adminSigmaOut", c.sigma2Mult);
  set("adminBlur", "adminBlurOut", c.blurSigma);
  set("adminChroma", "adminChromaOut", c.chromaWeight);
  set("adminShiftBlur", "adminShiftBlurOut", c.shiftBlurSigma);
  set("adminPreserve", "adminPreserveOut", c.preserveUnchanged ?? 0.6);
  set("adminSmoothLo", "adminSmoothLoOut", c.smoothLo);
  set("adminSmoothHi", "adminSmoothHiOut", c.smoothHi);
  set("adminMinScale", "adminMinScaleOut", c.minScale);
  set("adminMaxScale", "adminMaxScaleOut", c.maxScale);
  set("adminTopM", "adminTopMOut", c.topM);
  set("adminKIter", "adminKIterOut", c.kmeansMaxIter);
  set("adminStride", "adminStrideOut", c.sampleStride);
  set("adminIntensity", "adminIntensityOut", studio.admin.intensity);
}

function persistAdminConfig() {
  const cfg = { ...studio.admin.config, intensity: studio.admin.intensity };
  localStorage.setItem("levn_admin_config", JSON.stringify(cfg));
}

function updateAdminStats() {
  const stats = $("adminStats");
  if (!stats) return;
  const eng = studio.recolor.engine;
  if (!eng || !eng.slotOriginalCodes) {
    stats.textContent = "";
    return;
  }
  const lines = [
    `Görsel: ${eng.w}×${eng.h} (${(eng.w*eng.h/1e6).toFixed(2)}MP)`,
    `Cluster: k=${eng.k} topM=${eng.config.topM}  Blur σ=${eng.config.blurSigma.toFixed(1)}px  Chroma×${eng.config.chromaWeight.toFixed(1)}`,
    `σ² katsayı=${eng.config.sigma2Mult.toFixed(2)}  std=[${eng.config.minScale},${eng.config.maxScale}]  shiftBlur=${eng.config.shiftBlurSigma.toFixed(1)}px`,
    `Smoothstep: [${eng.config.smoothLo.toFixed(2)}, ${eng.config.smoothHi.toFixed(2)}]`,
    `K-means iter=${eng.config.kmeansMaxIter}  stride=${eng.config.sampleStride}`,
    ``,
    `Slot Drift (δE seed→center):`,
  ];
  (eng.slotScores || []).forEach((d, i) => {
    const code = eng.slotOriginalCodes[i];
    const cur = eng.slotTargetCodes[i];
    const arrow = (cur && cur !== code) ? ` → ${cur}` : "";
    const flag = d > 45 ? " ⚠ YÜKSEK" : d > 25 ? " ⚠" : "";
    lines.push(`  [${i}] ${code}${arrow}  δE=${d.toFixed(1)}${flag}`);
  });
  if (eng.clusterCountsPixel) {
    lines.push(``, `Cluster piksel sayıları:`);
    eng.clusterCountsPixel.forEach((c, i) => {
      const pct = ((c / (eng.w*eng.h)) * 100).toFixed(1);
      lines.push(`  [${i}] ${c.toLocaleString()} (${pct}%)`);
    });
  }
  stats.textContent = lines.join("\n");
}
