/* Levn — paylaşılan renk paleti popover. Studio slot tıklandığında açılır. */

import { state, assetUrl, escapeHtml, normalize, verifiedSortedColors, colorFamily } from "./shared.js?v=25";

let resolveFn = null;
let currentSlotIndex = -1;
let currentRugTip = null;  // Halının SKU tip harfi (A/C/M/E) — swatch varyantı için
let searchQ = "";
let verifiedOnly = true;

function $(id) { return document.getElementById(id); }

function render() {
  const grid = $("paletteGrid");
  const q = normalize(searchQ.trim());
  grid.innerHTML = "";

  const codes = verifiedSortedColors();
  const visible = [];
  for (const code of codes) {
    const c = state.colors[code];
    if (verifiedOnly && !c.verified) continue;
    if (q) {
      const hay = normalize(c.name_tr + " " + code);
      if (!hay.includes(q)) continue;
    }
    visible.push(code);
  }
  const famCounts = {};
  for (const code of visible) {
    const f = colorFamily(code);
    famCounts[f.key] = (famCounts[f.key] || 0) + 1;
  }
  let currentFamily = null;
  let n = 0;
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
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-card" + (c.verified ? "" : " unverified");
    btn.dataset.code = code;
    // ★ Tip-aware swatch: halının SKU tipine göre doğru varyant (7141_M vs 7141_C vs 7141_A)
    btn.innerHTML = `
      <div class="swatch" style="background-image:url('${assetUrl(code, currentRugTip)}')"></div>
      <div class="meta">
        <span class="name">${escapeHtml(c.name_tr)}</span>
        <span class="code">${code}</span>
      </div>`;
    btn.addEventListener("click", () => finish(code));
    grid.appendChild(btn);
    n++;
  }
  if (!n) {
    grid.innerHTML = `<div class="palette-empty">Eşleşme yok.</div>`;
  }
}

function finish(code) {
  const r = resolveFn;
  resolveFn = null;
  close();
  if (r) r({ slotIndex: currentSlotIndex, code });
}

function close() {
  $("palettePopover").hidden = true;
  if (resolveFn) {
    const r = resolveFn;
    resolveFn = null;
    r(null);
  }
}

export function openPalette({ slotIndex, title, currentCode, rugTip }) {
  currentSlotIndex = slotIndex;
  currentRugTip = rugTip || null;  // halının SKU tip harfi — swatch için
  $("paletteTitle").textContent = title || "Renk seç";
  $("paletteSearch").value = "";
  searchQ = "";
  render();
  $("palettePopover").hidden = false;
  setTimeout(() => $("paletteSearch").focus(), 50);
  return new Promise((resolve) => { resolveFn = resolve; });
}

export function initPalette() {
  $("paletteClose").addEventListener("click", close);
  $("paletteBackdrop").addEventListener("click", close);
  $("paletteSearch").addEventListener("input", (e) => {
    searchQ = e.target.value;
    render();
  });
  $("paletteVerifiedOnly").addEventListener("change", (e) => {
    verifiedOnly = e.target.checked;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("palettePopover").hidden) close();
  });
}
