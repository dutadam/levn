/* Levn — canvas tabanlı renk değiştirme motoru (Faz 5a v2).
 *
 * v2 iyileştirmeleri:
 *   • Seeded k-means: küme merkezleri SKU kodlarının palette LAB'ları ile
 *     başlar. Sonuç: cluster `i` ↔ slot `i` 1:1 (greedy matching gereksiz).
 *   • Soft pixel assignment: top-2 yakın kümeye δE ağırlıklı karışım —
 *     cluster sınırlarında sert kenar olmaz, geçişler yumuşar.
 *   • Adaptive L blend: hedef-orig L farkına göre blend oranı ölçeklenir
 *     (krem→siyah gibi büyük geçişlerde karanlık yeterince karanlık olur).
 *   • Seed drift score: her slotun eşleşme kalitesi (düşük=iyi, yüksek=
 *     halıda o renk pek yok demek).
 *
 * Akış:
 *   const eng = new RecolorEngine(palette);
 *   await eng.loadImage(url);
 *   eng.segment(codes);              // seed edilmiş k-means
 *   eng.render();                    // ImageData (orijinal)
 *   eng.setSlot(i, newCode);
 *   eng.render();                    // güncellenmiş
 *   eng.drawTo(canvas, imageData);
 *
 * Yan çıktılar:
 *   eng.slotScores  — slot bazlı eşleme kalitesi (δE drift)
 *   eng.renderOriginal() — canvas için bozulmamış orijinal ImageData
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
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// -------- Seeded k-means (LAB uzayında) -----------------------------------
/**
 * Seed edilmiş k-means: başlangıç merkezleri dışarıdan gelir (her slotun
 * palette LAB'ı). İterasyonlar sonucu merkez "seed"e yakın kalırsa iyi
 * eşleme, çok drift ederse kötü eşleme (halıda o renk yok demek).
 *
 * @param {Float32Array} labs alt-örneklenmiş piksel LAB'ları (n*3)
 * @param {number[][]} seeds  k adet başlangıç merkezi [[L,a,b], ...]
 * @returns {{centers:Float32Array, drift:number[]}}
 */
function seededKMeans(labs, seeds, { maxIter = 12 } = {}) {
  const k = seeds.length;
  const centers = new Float32Array(k * 3);
  const initCenters = new Float32Array(k * 3);
  for (let j = 0; j < k; j++) {
    centers[j * 3] = seeds[j][0];
    centers[j * 3 + 1] = seeds[j][1];
    centers[j * 3 + 2] = seeds[j][2];
    initCenters[j * 3] = seeds[j][0];
    initCenters[j * 3 + 1] = seeds[j][1];
    initCenters[j * 3 + 2] = seeds[j][2];
  }
  const n = labs.length / 3;
  const labels = new Uint8Array(n);
  const sums = new Float64Array(k * 3);
  const counts = new Uint32Array(k);

  for (let iter = 0; iter < maxIter; iter++) {
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
      // Eğer kümeye hiç piksel düşmediyse merkezi seed'de bırak — drift sonsuz olmasın
    }
  }

  // Drift = initial seed vs son center arasındaki δE
  const drift = new Array(k);
  for (let j = 0; j < k; j++) {
    drift[j] = deltaE(
      [initCenters[j * 3], initCenters[j * 3 + 1], initCenters[j * 3 + 2]],
      [centers[j * 3], centers[j * 3 + 1], centers[j * 3 + 2]]
    );
  }

  return { centers, drift, counts: Array.from(counts) };
}

// -------- RecolorEngine ---------------------------------------------------
export class RecolorEngine {
  /**
   * @param {Object<string,{rgb:number[], lab:number[]}>} palette
   */
  constructor(palette) {
    this.palette = palette || {};
    this.img = null;
    this.w = 0; this.h = 0;
    this.origPixels = null;       // Uint8ClampedArray RGBA
    this.origLab = null;           // Float32Array n*3 LAB (hızlı erişim)
    this.k = 0;
    this.centers = null;           // Float32Array k*3 (orig küme merkezleri)
    this.slotTargetLab = [];       // slot idx → hedef LAB
    this.slotTargetCodes = [];
    // Soft assignment: her piksel için top-2 cluster + primary weight
    this.label1 = null;            // Uint8Array primary cluster
    this.label2 = null;            // Uint8Array secondary cluster
    this.weight1 = null;            // Float32Array primary weight [0..1]
    this.slotScores = [];          // drift/küme-başı metrik
    this.clusterCounts = [];
    this.maxSide = 640;
    this._srcCanvas = null;
    this._srcCtx = null;
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
    // Tam piksel LAB precompute — render döngüsünde hız için kritik
    const n = this.w * this.h;
    this.origLab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = this.origPixels[i * 4];
      const g = this.origPixels[i * 4 + 1];
      const b = this.origPixels[i * 4 + 2];
      const [L, A, B] = rgbToLab(r, g, b);
      this.origLab[i * 3] = L;
      this.origLab[i * 3 + 1] = A;
      this.origLab[i * 3 + 2] = B;
    }
  }

  /**
   * Seed edilmiş segmentasyon. codes[i] = slot i'nin orijinal renk kodu.
   * Palette'te olmayan kodlar için fallback seed üretilir.
   */
  segment(codes, { sampleStride = 3 } = {}) {
    if (!this.origPixels) throw new Error("loadImage çağrılmadı");
    const n = this.w * this.h;

    // Seed hazırla: her slot için palette LAB; yoksa k-means++ ile doldur
    const seeds = [];
    for (const code of codes) {
      const pal = this.palette[code];
      if (pal && pal.lab) seeds.push(pal.lab.slice());
      else seeds.push(null); // fallback
    }
    // Null seed'leri rastgele piksel ile doldur (deterministic seed=42)
    let rng = mulberry32(42);
    for (let j = 0; j < seeds.length; j++) {
      if (seeds[j]) continue;
      const pi = Math.floor(rng() * n);
      seeds[j] = [
        this.origLab[pi * 3],
        this.origLab[pi * 3 + 1],
        this.origLab[pi * 3 + 2],
      ];
    }

    // Alt-örnekleme: k-means için daha hızlı
    const sampledLabs = [];
    for (let i = 0; i < n; i += sampleStride) {
      const a = this.origPixels[i * 4 + 3];
      if (a < 32) continue;
      sampledLabs.push(
        this.origLab[i * 3],
        this.origLab[i * 3 + 1],
        this.origLab[i * 3 + 2],
      );
    }
    const labs = Float32Array.from(sampledLabs);
    const { centers, drift, counts } = seededKMeans(labs, seeds, { maxIter: 10 });
    this.centers = centers;
    this.k = seeds.length;
    this.slotScores = drift;
    this.clusterCounts = counts;

    // Tam piksel soft-assignment: top-2 cluster + primary weight
    this.label1 = new Uint8Array(n);
    this.label2 = new Uint8Array(n);
    this.weight1 = new Float32Array(n);
    const k = this.k;
    for (let i = 0; i < n; i++) {
      const L = this.origLab[i * 3], A = this.origLab[i * 3 + 1], B = this.origLab[i * 3 + 2];
      let d1 = Infinity, d2 = Infinity;
      let l1 = 0, l2 = 0;
      for (let j = 0; j < k; j++) {
        const dL = L - centers[j * 3];
        const da = A - centers[j * 3 + 1];
        const db = B - centers[j * 3 + 2];
        const d = dL * dL + da * da + db * db;
        if (d < d1) { d2 = d1; l2 = l1; d1 = d; l1 = j; }
        else if (d < d2) { d2 = d; l2 = j; }
      }
      this.label1[i] = l1;
      this.label2[i] = l2;
      // Weight hesaplama: softmax-benzeri 1/(d+eps) ağırlıklı
      // Yumuşatma: primary çok yakınsa w1→1; eşit mesafede w1→0.5
      const eps = 4; // LAB² birimi
      const w1raw = 1 / (d1 + eps);
      const w2raw = 1 / (d2 + eps);
      this.weight1[i] = w1raw / (w1raw + w2raw);
    }

    // Slot hedef LAB'ları (başlangıç: orijinal = palette LAB)
    this.slotOriginalCodes = codes.slice();   // değişiklik tespiti için sabit
    this.slotTargetCodes = codes.slice();
    this.slotTargetLab = codes.map((c) => (this.palette[c] && this.palette[c].lab) || null);

    return {
      drift,
      counts,
      // UI için: drift>25 uyarı, drift>45 ciddi uyarı
    };
  }

  setSlot(slotIdx, newCode) {
    if (slotIdx < 0 || slotIdx >= this.slotTargetCodes.length) return;
    this.slotTargetCodes[slotIdx] = newCode;
    this.slotTargetLab[slotIdx] = (this.palette[newCode] && this.palette[newCode].lab) || null;
  }

  /** Güncel slot hedeflerine göre tüm ImageData'yı üret. */
  render({ intensity = 0.9 } = {}) {
    if (!this.origLab) throw new Error("loadImage çağrılmadı");
    const n = this.w * this.h;
    const out = new Uint8ClampedArray(this.origPixels);
    const k = this.k;

    // Cluster j için hedef LAB ve orig center LAB
    // KRİTİK: shift hedef = (palette_LAB - cluster_center_LAB). Bu, değişen
    // slot'lar için "hedefe yolculuk", DEĞİŞMEYENLER için de seed drift
    // (saf palette ↔ gerçek ortalama farkı) demek. Değişmemiş slot'lara
    // shift UYGULAMIYORUZ — aksi halde dokunulmayan renkler de palette'e
    // doğru kayar. `changed[j]` mask'i bunu engelliyor.
    const targetL = new Float32Array(k);
    const targetA = new Float32Array(k);
    const targetB = new Float32Array(k);
    const origL = new Float32Array(k);
    const origA = new Float32Array(k);
    const origB = new Float32Array(k);
    const hasTarget = new Uint8Array(k);
    const changed = new Uint8Array(k);
    for (let j = 0; j < k; j++) {
      const tgt = this.slotTargetLab[j];
      if (tgt) {
        targetL[j] = tgt[0]; targetA[j] = tgt[1]; targetB[j] = tgt[2];
        origL[j] = this.centers[j * 3];
        origA[j] = this.centers[j * 3 + 1];
        origB[j] = this.centers[j * 3 + 2];
        hasTarget[j] = 1;
      }
      const origCode = (this.slotOriginalCodes && this.slotOriginalCodes[j]);
      const curCode = this.slotTargetCodes[j];
      changed[j] = (origCode !== undefined && curCode !== origCode) ? 1 : 0;
    }
    // Hiç değişiklik yoksa orijinali aynen döndür — gereksiz hesap yok
    let anyChanged = false;
    for (let j = 0; j < k; j++) if (changed[j]) { anyChanged = true; break; }
    if (!anyChanged) return new ImageData(out, this.w, this.h);

    for (let i = 0; i < n; i++) {
      const L = this.origLab[i * 3];
      const A = this.origLab[i * 3 + 1];
      const B = this.origLab[i * 3 + 2];
      const l1 = this.label1[i];
      const l2 = this.label2[i];
      const w1 = this.weight1[i];
      const w2 = 1 - w1;

      // Her iki cluster için (L,a,b) kayma hesapla — SADECE değişmişlere.
      let shiftL = 0, shiftA = 0, shiftB = 0;
      if (hasTarget[l1] && changed[l1]) {
        const dLslot = targetL[l1] - origL[l1];
        const absD = Math.abs(dLslot);
        const lBlend = clamp01(0.2 + absD * 0.007); // 0 fark → 0.2, 80 fark → 0.76
        shiftL += w1 * (dLslot * intensity * lBlend);
        shiftA += w1 * ((targetA[l1] - origA[l1]) * intensity);
        shiftB += w1 * ((targetB[l1] - origB[l1]) * intensity);
      }
      if (hasTarget[l2] && changed[l2]) {
        const dLslot = targetL[l2] - origL[l2];
        const absD = Math.abs(dLslot);
        const lBlend = clamp01(0.2 + absD * 0.007);
        // Secondary katkıyı biraz zayıflat (bleed azalt): 0.6x
        shiftL += w2 * 0.6 * (dLslot * intensity * lBlend);
        shiftA += w2 * 0.6 * ((targetA[l2] - origA[l2]) * intensity);
        shiftB += w2 * 0.6 * ((targetB[l2] - origB[l2]) * intensity);
      }
      if (shiftL === 0 && shiftA === 0 && shiftB === 0) continue;

      const newL = L + shiftL;
      const newA = A + shiftA;
      const newB = B + shiftB;

      const [nr, ng, nb] = labToRgb(newL, newA, newB);
      out[i * 4] = nr;
      out[i * 4 + 1] = ng;
      out[i * 4 + 2] = nb;
    }
    return new ImageData(out, this.w, this.h);
  }

  /** Orijinal görseli ImageData olarak döndür (slider karşılaştırması için). */
  renderOriginal() {
    const copy = new Uint8ClampedArray(this.origPixels);
    return new ImageData(copy, this.w, this.h);
  }

  /** Render çıktısını hedef canvas'a scale çizer. */
  drawTo(targetCanvas, imageData) {
    const ctx = targetCanvas.getContext("2d");
    this._srcCtx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(this._srcCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
  }

  /** PDF/download için: güncel render'ı JPEG dataURL olarak döndür. */
  toDataURL(type = "image/jpeg", quality = 0.9) {
    return this._srcCanvas.toDataURL(type, quality);
  }
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
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

function loadHTMLImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Görsel yüklenemedi: ${url}`));
    img.src = url;
  });
}
