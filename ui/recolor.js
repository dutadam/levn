/* Levn — canvas tabanlı renk değiştirme motoru (Faz 5a MVP).
 *
 * Akış:
 *   const eng = new RecolorEngine(palette);
 *   await eng.loadImage(url);     // img → offscreen canvas + örneklenmiş piksel buffer
 *   eng.segment(k);               // k-means → her piksele küme etiketi
 *   eng.matchSlots(codes);        // kümeleri original renk kodlarıyla eşle (LAB δE)
 *   eng.recolor(slotIdx, code);   // o slotun kümesini yeni renkle boya (L-koruyarak)
 *   eng.drawTo(canvas);           // final'i hedef canvas'a çiz
 *
 * Not: Ana thread. Gerekirse ileride Worker'a taşınır (Faz 5b).
 */

// -------- sRGB ↔ LAB ------------------------------------------------------
function srgbToLinear(u) {
  u /= 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}
function linearToSrgb(u) {
  const v = u <= 0.0031308 ? u * 12.92 : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function rgbToLab(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.0;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const finv = (t) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x = finv(fx) * 0.95047;
  const y = finv(fy) * 1.0;
  const z = finv(fz) * 1.08883;
  const rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const gl = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}
function deltaE(lab1, lab2) {
  // Basit Euclidean CIE76 — yeterli; ilerde CIEDE2000 eklenebilir
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// -------- K-means (LAB uzayında) ------------------------------------------
function kmeans(labs, k, { maxIter = 15, seed = 42 } = {}) {
  const n = labs.length / 3;
  // k-means++ seed
  const centers = new Float32Array(k * 3);
  let rng = mulberry32(seed);
  // İlk merkez rastgele
  const first = Math.floor(rng() * n);
  centers[0] = labs[first * 3];
  centers[1] = labs[first * 3 + 1];
  centers[2] = labs[first * 3 + 2];
  const distSq = new Float32Array(n);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let j = 0; j < c; j++) {
        const dL = labs[i * 3] - centers[j * 3];
        const da = labs[i * 3 + 1] - centers[j * 3 + 1];
        const db = labs[i * 3 + 2] - centers[j * 3 + 2];
        const d = dL * dL + da * da + db * db;
        if (d < best) best = d;
      }
      distSq[i] = best;
      total += best;
    }
    // Proportional pick
    let r = rng() * total;
    let pickIdx = 0;
    for (let i = 0; i < n; i++) {
      r -= distSq[i];
      if (r <= 0) { pickIdx = i; break; }
    }
    centers[c * 3] = labs[pickIdx * 3];
    centers[c * 3 + 1] = labs[pickIdx * 3 + 1];
    centers[c * 3 + 2] = labs[pickIdx * 3 + 2];
  }

  const labels = new Uint8Array(n);
  const sums = new Float64Array(k * 3);
  const counts = new Uint32Array(k);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const L = labs[i * 3], a = labs[i * 3 + 1], b = labs[i * 3 + 2];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const dL = L - centers[j * 3];
        const da = a - centers[j * 3 + 1];
        const db = b - centers[j * 3 + 2];
        const d = dL * dL + da * da + db * db;
        if (d < bestD) { bestD = d; best = j; }
      }
      if (labels[i] !== best) { labels[i] = best; changed++; }
    }
    if (iter > 0 && changed === 0) break;

    // Update
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const lbl = labels[i];
      sums[lbl * 3] += labs[i * 3];
      sums[lbl * 3 + 1] += labs[i * 3 + 1];
      sums[lbl * 3 + 2] += labs[i * 3 + 2];
      counts[lbl]++;
    }
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        centers[j * 3] = sums[j * 3] / counts[j];
        centers[j * 3 + 1] = sums[j * 3 + 1] / counts[j];
        centers[j * 3 + 2] = sums[j * 3 + 2] / counts[j];
      }
    }
  }

  return { labels, centers };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------- RecolorEngine ---------------------------------------------------
export class RecolorEngine {
  /**
   * @param {Object<string,{rgb:[number,number,number], lab:[number,number,number]}>} palette
   */
  constructor(palette) {
    this.palette = palette || {};
    this.img = null;          // HTMLImageElement
    this.w = 0; this.h = 0;   // downscaled canvas boyutu
    this.origPixels = null;   // Uint8ClampedArray (RGBA) — sub-sampled
    this.origL = null;        // Float32Array pixel L değerleri
    this.labels = null;       // Uint8Array küme etiketleri
    this.k = 0;
    this.centers = null;      // Float32Array k*3 LAB
    this.slotToCluster = [];  // slot idx → cluster idx
    this.slotTargetCodes = [];// slot idx → hedef renk kodu
    this.slotTargetLab = [];  // slot idx → hedef LAB (hızlı)
    this.slotOriginalCenterLab = []; // matching anındaki orig küme LAB
    this.maxSide = 640;       // downscale hedefi — mobil için yeterli
  }

  async loadImage(url) {
    const img = await loadHTMLImage(url);
    this.img = img;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.min(1, this.maxSide / Math.max(iw, ih));
    this.w = Math.max(1, Math.round(iw * scale));
    this.h = Math.max(1, Math.round(ih * scale));
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, this.w, this.h);
    const imgData = ctx.getImageData(0, 0, this.w, this.h);
    this.origPixels = imgData.data;
    this._srcCanvas = c;
    this._srcCtx = ctx;
    this._srcImageData = imgData;
    // Per-pixel L precompute (yaygın kullanım)
    const n = this.w * this.h;
    this.origL = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = this.origPixels[i * 4];
      const g = this.origPixels[i * 4 + 1];
      const b = this.origPixels[i * 4 + 2];
      this.origL[i] = rgbToLab(r, g, b)[0];
    }
  }

  segment(k, { sampleStride = 3 } = {}) {
    if (!this.origPixels) throw new Error("loadImage çağrılmadı");
    const n = this.w * this.h;
    // Alt-örnekleme ile k-means (hız için)
    const sampled = [];
    for (let i = 0; i < n; i += sampleStride) {
      const r = this.origPixels[i * 4];
      const g = this.origPixels[i * 4 + 1];
      const b = this.origPixels[i * 4 + 2];
      const a = this.origPixels[i * 4 + 3];
      if (a < 32) continue; // şeffaf pikselleri atla
      const [L, aa, bb] = rgbToLab(r, g, b);
      sampled.push(L, aa, bb);
    }
    const labs = Float32Array.from(sampled);
    const { centers } = kmeans(labs, k, { maxIter: 12 });
    this.centers = centers;
    this.k = k;
    // Full pixel assignment
    this.labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = this.origPixels[i * 4];
      const g = this.origPixels[i * 4 + 1];
      const b = this.origPixels[i * 4 + 2];
      const [L, aa, bb] = rgbToLab(r, g, b);
      let best = 0, bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const dL = L - centers[j * 3];
        const da = aa - centers[j * 3 + 1];
        const db = bb - centers[j * 3 + 2];
        const d = dL * dL + da * da + db * db;
        if (d < bestD) { bestD = d; best = j; }
      }
      this.labels[i] = best;
    }
    return { centers, k };
  }

  /**
   * Orijinal SKU kodlarını küme merkezlerine eşle.
   * Greedy: her koda en yakın (δE) serbest küme atanır.
   * @param {string[]} codes slot sırası ile renk kodları
   * @returns {{slotToCluster:number[], scores:number[]}}
   */
  matchSlots(codes) {
    if (!this.centers) throw new Error("segment çağrılmadı");
    const k = this.k;
    const freeClusters = new Set();
    for (let j = 0; j < k; j++) freeClusters.add(j);

    // Tüm (slot, cluster) δE matrisini hesapla
    const rows = codes.map((code) => {
      const pal = this.palette[code];
      if (!pal || !pal.lab) return null;
      return pal.lab;
    });

    const slotToCluster = new Array(codes.length).fill(-1);
    const scores = new Array(codes.length).fill(Infinity);

    // İterasyon: her turda en iyi (slot, cluster) çiftini bul, kilitle.
    const slotIdxRemaining = rows.map((r, i) => (r ? i : -1)).filter((x) => x >= 0);
    while (slotIdxRemaining.length && freeClusters.size) {
      let bestSlot = -1, bestCluster = -1, bestD = Infinity;
      for (const si of slotIdxRemaining) {
        if (slotToCluster[si] !== -1) continue;
        const lab = rows[si];
        for (const j of freeClusters) {
          const cL = this.centers[j * 3];
          const ca = this.centers[j * 3 + 1];
          const cb = this.centers[j * 3 + 2];
          const d = deltaE(lab, [cL, ca, cb]);
          if (d < bestD) { bestD = d; bestSlot = si; bestCluster = j; }
        }
      }
      if (bestSlot === -1) break;
      slotToCluster[bestSlot] = bestCluster;
      scores[bestSlot] = bestD;
      freeClusters.delete(bestCluster);
      const idx = slotIdxRemaining.indexOf(bestSlot);
      if (idx >= 0) slotIdxRemaining.splice(idx, 1);
    }

    this.slotToCluster = slotToCluster;
    this.slotTargetCodes = codes.slice();
    this.slotTargetLab = codes.map((c) => this.palette[c]?.lab || null);
    this.slotOriginalCenterLab = slotToCluster.map((j) => {
      if (j < 0) return null;
      return [this.centers[j * 3], this.centers[j * 3 + 1], this.centers[j * 3 + 2]];
    });
    return { slotToCluster, scores };
  }

  /** Kullanıcı slot[i]'yi `newCode`'a çevirdi. */
  setSlot(slotIdx, newCode) {
    if (slotIdx < 0 || slotIdx >= this.slotTargetCodes.length) return;
    this.slotTargetCodes[slotIdx] = newCode;
    this.slotTargetLab[slotIdx] = this.palette[newCode]?.lab || null;
  }

  /**
   * Güncel slot → renk eşlemesine göre tüm görüntüyü yeniden boya.
   * L-koruyarak: her pikselin orijinal L'si sabit, a/b hedef renge doğru kaydırılır.
   * @param {number} intensity 0..1 (1=tam boya, 0.8 önerilen — doku korunur)
   * @returns {ImageData}
   */
  render({ intensity = 0.85 } = {}) {
    if (!this.origPixels) throw new Error("loadImage çağrılmadı");
    const n = this.w * this.h;
    const out = new Uint8ClampedArray(this.origPixels);
    // Cluster → target Lab (kısa erişim)
    const clusterTarget = new Array(this.k).fill(null);
    const clusterOrigCenter = new Array(this.k).fill(null);
    for (let si = 0; si < this.slotToCluster.length; si++) {
      const cj = this.slotToCluster[si];
      if (cj < 0) continue;
      clusterTarget[cj] = this.slotTargetLab[si];
      clusterOrigCenter[cj] = this.slotOriginalCenterLab[si];
    }

    for (let i = 0; i < n; i++) {
      const lbl = this.labels[i];
      const tgt = clusterTarget[lbl];
      const origC = clusterOrigCenter[lbl];
      if (!tgt || !origC) continue; // slot eşlenmemiş cluster → dokunma

      const r = this.origPixels[i * 4];
      const g = this.origPixels[i * 4 + 1];
      const b = this.origPixels[i * 4 + 2];
      const [L, aa, bb] = rgbToLab(r, g, b);

      // Pikselin L'sini koru, a/b'yi hedef (cluster merkezine göre) kaydır.
      // newA = aa + (tgt.a - origC.a) * intensity
      // Bu, dokunun varyansını koruyup merkezini tgt'ye taşır.
      const newA = aa + (tgt[1] - origC[1]) * intensity;
      const newB = bb + (tgt[2] - origC[2]) * intensity;
      // L küçük bir kayma alabilir — çok koyu→çok açık geçişlerde tamamen L-kilit
      // hatalı hissediyor; %20 oranında hedef L'ye doğru kayalım.
      const newL = L + (tgt[0] - origC[0]) * intensity * 0.2;

      const [nr, ng, nb] = labToRgb(newL, newA, newB);
      out[i * 4] = nr;
      out[i * 4 + 1] = ng;
      out[i * 4 + 2] = nb;
    }
    return new ImageData(out, this.w, this.h);
  }

  /** Render sonucunu bir canvas'a (hedef boyutta) scale ederek çizer. */
  drawTo(targetCanvas, imageData) {
    const ctx = targetCanvas.getContext("2d");
    // Önce offscreen'e yaz, sonra scale çiz
    this._srcCtx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(this._srcCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
  }

  /** Kolaylık: tüm pipeline'ı tek fonksiyonda. */
  async init(url, codes) {
    await this.loadImage(url);
    this.segment(Math.max(2, codes.length));
    this.matchSlots(codes);
  }
}

function loadHTMLImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Görsel yüklenemedi: ${url}`));
    img.src = url;
  });
}
