/* Levn — Finder modu: renk seç → uyumlu halılar (eski ana mod). */

import { state, assetUrl, escapeHtml, normalize, sortedByFamily, collectionLabel, colorFamily } from "./shared.js?v=10";

const finder = {
  selected: new Set(),
  verifiedOnly: true,
  search: "",
};

function $(id) { return document.getElementById(id); }

function renderGrid() {
  const grid = $("colorGrid");
  grid.innerHTML = "";
  const q = normalize(finder.search.trim());

  const codes = sortedByFamily();

  // First filter to visible list so we can group + count per family
  const visible = [];
  for (const code of codes) {
    const c = state.colors[code];
    if (finder.verifiedOnly && !c.verified) continue;
    if (q && !normalize(c.name_tr + " " + code).includes(q)) continue;
    visible.push(code);
  }

  let currentFamily = null;
  let n = 0;
  // Precompute family groupings for count per header
  const famCounts = {};
  for (const code of visible) {
    const f = colorFamily(code);
    famCounts[f.key] = (famCounts[f.key] || 0) + 1;
  }

  for (const code of visible) {
    const c = state.colors[code];
    const fam = colorFamily(code);
    if (fam.key !== currentFamily) {
      currentFamily = fam.key;
      const header = document.createElement("div");
      header.className = "family-group-header";
      header.innerHTML = `
        <span class="fg-title">${escapeHtml(fam.label || fam.key)}</span>
        <span class="fg-count">${famCounts[fam.key]}</span>`;
      grid.appendChild(header);
    }
    const asset = state.assets[code];
    const card = document.createElement("button");
    card.type = "button";
    card.className = "color-card"
      + (finder.selected.has(code) ? " selected" : "")
      + (c.verified ? "" : " unverified");
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", finder.selected.has(code));
    card.dataset.code = code;
    const fb = asset && asset.mode === "fallback" ? " fallback" : "";
    card.innerHTML = `
      <div class="swatch${fb}" style="background-image:url('${assetUrl(code)}')"></div>
      <div class="meta">
        <span class="name" title="${escapeHtml(c.name_tr)}">${escapeHtml(c.name_tr)}</span>
        <span class="code">${code}</span>
      </div>`;
    card.addEventListener("click", () => toggle(code));
    grid.appendChild(card);
    n++;
  }
  if (!n) {
    grid.innerHTML = `<div class="grid-empty">Renk bulunamadı.</div>`;
  }
}

function toggle(code) {
  if (finder.selected.has(code)) finder.selected.delete(code);
  else finder.selected.add(code);
  renderGrid();
  renderChips();
  renderRugs();
}

function renderChips() {
  const chips = $("selectedChips");
  chips.innerHTML = "";
  const clearBtn = $("clearBtn");
  if (!finder.selected.size) {
    clearBtn.hidden = true;
    return;
  }
  clearBtn.hidden = false;
  for (const code of finder.selected) {
    const c = state.colors[code];
    if (!c) continue;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `
      <span class="chip-swatch" style="background-image:url('${assetUrl(code)}')"></span>
      <span>${escapeHtml(c.name_tr)}</span>
      <span class="chip-remove">×</span>`;
    chip.addEventListener("click", () => toggle(code));
    chips.appendChild(chip);
  }
}

/* AND filter: halı TÜM seçili renkleri barındırmalı. Sıralama: primary match
 * bonus + "daha odaklı palet" (az toplam renk) önce. */
function scoreRug(rug) {
  const codes = (rug.sku_parsed && rug.sku_parsed.codes) || [];
  if (!codes.length || !finder.selected.size) return 0;
  const set = new Set(codes);
  for (const c of finder.selected) if (!set.has(c)) return 0; // AND
  let s = 10;
  if (finder.selected.has(codes[0])) s += 2;     // primary match bonus
  s += finder.selected.size / codes.length;       // daha odaklı palet önce
  return s;
}

function updateFab(rugCount) {
  const fab = document.getElementById("listRugsFab");
  if (!fab) return;
  const isMobile = window.innerWidth <= 900;
  const rugsPane = document.querySelector(".rugs-pane");
  const rugsOpen = rugsPane && !rugsPane.classList.contains("collapsed");
  // Show FAB only on mobile, when user has selected colors, and rugs-pane is collapsed
  if (isMobile && finder.selected.size > 0 && !rugsOpen) {
    fab.hidden = false;
    const lrfCount = document.getElementById("lrfCount");
    if (lrfCount) lrfCount.textContent = String(rugCount || 0);
  } else {
    fab.hidden = true;
  }
}

function renderRugs() {
  const container = $("rugGrid");
  const empty = $("emptyState");
  const count = $("resultCount");
  const title = $("rugsTitle");
  container.innerHTML = "";

  if (!finder.selected.size) {
    empty.style.display = "";
    empty.textContent = "Başlamak için yukarıdan bir veya birkaç renk seçin.";
    container.style.display = "none";
    count.textContent = "";
    title.textContent = "Halılar";
    // Mobilde: renk seçimi temizlenince rugs-pane collapse et, colors aç, FAB gizle
    if (window.innerWidth <= 900) {
      document.querySelector(".rugs-pane")?.classList.add("collapsed");
      document.querySelector(".colors-pane")?.classList.remove("collapsed");
    }
    updateFab(0);
    return;
  }
  empty.style.display = "none";
  container.style.display = "";

  const scored = state.rugs
    .map((rug) => ({ rug, score: scoreRug(rug) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const needCount = finder.selected.size;
  count.textContent = scored.length
    ? `${scored.length} halı — her biri seçili ${needCount} rengi barındırıyor`
    : `Seçili ${needCount} rengin hepsini birden içeren halı yok`;
  title.textContent = "Uyumlu Halılar";

  // Mobilde: FAB göster (colors-pane açık kalır, kullanıcı daha fazla renk ekleyebilir)
  updateFab(scored.length);

  const seen = new Set();
  for (const { rug } of scored) {
    const id = rug.product_id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (seen.size > 120) break;

    const card = document.createElement("div");
    card.className = "rug-card";
    card.dataset.productId = rug.product_id || "";

    const codes = (rug.sku_parsed && rug.sku_parsed.codes) || [];
    const paletteDots = codes.map((code) => {
      const m = finder.selected.has(code);
      const name = (state.colors[code] && state.colors[code].name_tr) || code;
      return `<span class="palette-dot ${m ? "match" : ""}"
                title="${escapeHtml(name)}"
                style="background-image:url('${assetUrl(code)}')"></span>`;
    }).join("");

    const matched = codes.filter((c) => finder.selected.has(c)).length;
    const productUrl = rug.product_url || "";
    card.innerHTML = `
      <div class="rug-image" style="background-image:url('${rug.img_url}')">
        <div class="rug-overlay">
          <span class="rug-overlay-cta">Studio'da düzenle →</span>
        </div>
      </div>
      <div class="rug-info">
        <h3 class="rug-title">${escapeHtml(rug.title || "")}</h3>
        <div class="rug-meta">
          <span class="rug-collection">${escapeHtml(collectionLabel(rug.collection))}</span>
          <span class="rug-match">${matched}/${codes.length} renk</span>
        </div>
        <div class="rug-palette">${paletteDots}</div>
        <div class="rug-actions">
          <button class="rug-action-primary" type="button" data-action="studio">Studio'da düzenle</button>
          ${productUrl ? `<a class="rug-action-link" href="${escapeHtml(productUrl)}" target="_blank" rel="noopener" title="Ürün sayfası">↗</a>` : ""}
        </div>
      </div>`;

    // Kart tıklaması → Studio'ya aç (ürün linki hariç)
    card.addEventListener("click", (e) => {
      if (e.target.closest(".rug-action-link")) return; // dış link'e izin ver
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("levn:openInStudio", {
        detail: { productId: rug.product_id, rug },
      }));
    });
    container.appendChild(card);
  }
}

export function initFinder() {
  renderGrid();
  renderChips();
  renderRugs();

  $("colorSearch").addEventListener("input", (e) => {
    finder.search = e.target.value;
    renderGrid();
  });
  $("verifiedOnly").addEventListener("change", (e) => {
    finder.verifiedOnly = e.target.checked;
    renderGrid();
  });
  $("clearBtn").addEventListener("click", () => {
    finder.selected.clear();
    renderGrid();
    renderChips();
    renderRugs();
  });
}
