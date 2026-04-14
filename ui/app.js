/* Levn — orchestrator. Data yükler, modülleri başlatır, tab switching yönetir. */

import { loadAll } from "./shared.js";
import { initFinder } from "./finder.js";
import { initStudio, openRugInStudio } from "./studio.js";
import { initPalette } from "./palette.js";

function $(id) { return document.getElementById(id); }

function switchMode(mode) {
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.mode === mode;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("studioPanel").dataset.active = mode === "studio";
  $("finderPanel").dataset.active = mode === "finder";
}

async function init() {
  try {
    await loadAll();
    initPalette();
    initStudio();
    initFinder();

    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => switchMode(t.dataset.mode));
    });

    // Finder → Studio köprüsü: custom event dinle, tab'ı çevir, halıyı aç
    document.addEventListener("levn:openInStudio", (e) => {
      const { productId, rug } = e.detail || {};
      switchMode("studio");
      // küçük bir mikro-gecikme ile render sonrası seçim daha yumuşak
      requestAnimationFrame(() => openRugInStudio(rug || productId));
    });

    // Mobil: panel collapse toggle'ları + karşılıklı aç/kapa
    const pickerToggle = document.getElementById("pickerToggle");
    const colorsToggle = document.getElementById("colorsToggle");
    if (pickerToggle) {
      pickerToggle.addEventListener("click", () => {
        const picker = document.querySelector(".picker-pane");
        const editor = document.querySelector(".editor-pane");
        if (!picker) return;
        const opening = picker.classList.contains("collapsed");
        picker.classList.toggle("collapsed");
        // Picker açılıyorsa editor'ü collapse et, kapanıyorsa aç
        if (opening && editor) editor.classList.add("collapsed");
        else if (editor) editor.classList.remove("collapsed");
      });
    }
    if (colorsToggle) {
      colorsToggle.addEventListener("click", () => {
        const colors = document.querySelector(".colors-pane");
        const rugs = document.querySelector(".rugs-pane");
        if (!colors) return;
        const opening = colors.classList.contains("collapsed");
        colors.classList.toggle("collapsed");
        if (opening && rugs) rugs.classList.add("collapsed");
        else if (rugs) rugs.classList.remove("collapsed");
      });
    }

    // Mobilde başlangıçta alt panelleri collapse et
    if (window.innerWidth <= 900) {
      document.querySelector(".editor-pane")?.classList.add("collapsed");
      document.querySelector(".rugs-pane")?.classList.add("collapsed");
      const ecb = document.getElementById("editorCollapsedBar");
      if (ecb) ecb.hidden = false;

      // Alt panele tıklayınca: üstü kapat, altı aç
      const editorPane = document.querySelector(".editor-pane");
      const rugsPane = document.querySelector(".rugs-pane");
      if (editorPane) {
        editorPane.addEventListener("click", (e) => {
          if (!editorPane.classList.contains("collapsed")) return;
          editorPane.classList.remove("collapsed");
          document.querySelector(".picker-pane")?.classList.add("collapsed");
        });
      }
      if (rugsPane) {
        rugsPane.addEventListener("click", (e) => {
          if (!rugsPane.classList.contains("collapsed")) return;
          rugsPane.classList.remove("collapsed");
          document.querySelector(".colors-pane")?.classList.add("collapsed");
        });
      }
    }

    switchMode("studio");
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;">
      <h2>Veri yüklenemedi</h2>
      <p>Sunucu çalışıyor mu? Projenin kökünden:</p>
      <pre style="background:#f4f0e8;padding:12px;border-radius:6px;">python3 /tmp/levn_serve.py</pre>
      <p>Sonra <code>http://localhost:8765/ui/</code></p>
      <p style="color:#888;margin-top:30px;font-size:12px;">Hata: ${String(err && err.message)}</p>
    </div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
