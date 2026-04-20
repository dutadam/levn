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
export function rgbToLab(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.0;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToRgb(L, a, b) {
  // Gamut-safe: LAB clamp + chroma pullback (sRGB dışı noktaları renk bütünlüğü koruyarak iç sınıra çek)
  L = L < 0 ? 0 : L > 100 ? 100 : L;
  // İlk deneme
  let rl, gl, bl;
  let lo = 0, hi = 1, iter = 0;
  // sRGB gamut'u binary search ile bul: mevcut (a,b) → 0..1 ölçeğinde kaç oranı iç kalıyor?
  while (iter++ < 8) {
    const mid = (lo + hi) / 2;
    const aT = a * mid, bT = b * mid;
    const fy = (L + 16) / 116;
    const fx = aT / 500 + fy;
    const fz = fy - bT / 200;
    const finv = (t) => {
      const t3 = t * t * t;
      return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
    };
    const x = finv(fx) * 0.95047;
    const y = finv(fy) * 1.0;
    const z = finv(fz) * 1.08883;
    rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
    gl = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
    bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
    const inGamut = rl >= -0.001 && rl <= 1.001 && gl >= -0.001 && gl <= 1.001 && bl >= -0.001 && bl <= 1.001;
    if (inGamut) lo = mid; else hi = mid;
  }
  // Son pass: lo oranıyla hesapla (garantili iç gamut)
  const aFinal = a * lo, bFinal = b * lo;
  const fy2 = (L + 16) / 116;
  const fx2 = aFinal / 500 + fy2;
  const fz2 = fy2 - bFinal / 200;
  const finv2 = (t) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x2 = finv2(fx2) * 0.95047;
  const y2 = finv2(fy2) * 1.0;
  const z2 = finv2(fz2) * 1.08883;
  const rlF = x2 * 3.2404542 + y2 * -1.5371385 + z2 * -0.4985314;
  const glF = x2 * -0.9692660 + y2 * 1.8760108 + z2 * 0.0415560;
  const blF = x2 * 0.0556434 + y2 * -0.2040259 + z2 * 1.0572252;
  return [linearToSrgb(rlF), linearToSrgb(glF), linearToSrgb(blF)];
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
/**
 * Seed edilmiş k-means: opsiyonel Mahalanobis mesafesi (her cluster kendi std'sine göre).
 * @param {Float32Array} labs
 * @param {number[][]} seeds  [[L,a,b], ...]
 * @param {object} opts
 * @param {number[][]} [opts.seedStds]  [[σL,σa,σb], ...] — palette'den plain halı std. null = isotropic.
 */
function seededKMeans(labs, seeds, { maxIter = 12, chromaWeight = 1.0, maxDrift = 18, seedStds = null } = {}) {
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

  // Mahalanobis ters-σ² tabloları (her cluster için). Plain halı std'den gelir.
  // Küçük std'yi clamp et (tek piksel = 0 olmasın).
  const invVarL = new Float32Array(k);
  const invVarA = new Float32Array(k);
  const invVarB = new Float32Array(k);
  const useMaha = !!seedStds;
  if (useMaha) {
    for (let j = 0; j < k; j++) {
      const s = seedStds[j] || [3, 1, 1];
      const sL = Math.max(1.5, s[0] || 3);
      const sA = Math.max(0.8, s[1] || 1);
      const sB = Math.max(0.8, s[2] || 1);
      invVarL[j] = 1 / (sL * sL);
      invVarA[j] = 1 / (sA * sA);
      invVarB[j] = 1 / (sB * sB);
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const L = labs[i * 3], a = labs[i * 3 + 1], b = labs[i * 3 + 2];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const dL = L - centers[j * 3];
        const da = a - centers[j * 3 + 1];
        const db = b - centers[j * 3 + 2];
        let d;
        if (useMaha) {
          // Mahalanobis: her eksen kendi σ²'siyle normalize
          d = dL * dL * invVarL[j] + chromaWeight * (da * da * invVarA[j] + db * db * invVarB[j]);
        } else {
          d = dL * dL + chromaWeight * (da * da + db * db);
        }
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
        let nL = sums[j * 3] / counts[j];
        let nA = sums[j * 3 + 1] / counts[j];
        let nB = sums[j * 3 + 2] / counts[j];
        // ★ DRIFT CLAMP: merkez seed'den maxDrift (LAB) uzağa gitmesin.
        // Bu, 7141↔9811 gibi yakın renk swaplarını engeller (slot semantiği korunur).
        if (maxDrift > 0) {
          const sL = initCenters[j * 3], sA = initCenters[j * 3 + 1], sB = initCenters[j * 3 + 2];
          const d = Math.sqrt((nL - sL) ** 2 + (nA - sA) ** 2 + (nB - sB) ** 2);
          if (d > maxDrift) {
            const frac = maxDrift / d;
            nL = sL + (nL - sL) * frac;
            nA = sA + (nA - sA) * frac;
            nB = sB + (nB - sB) * frac;
          }
        }
        centers[j * 3] = nL;
        centers[j * 3 + 1] = nA;
        centers[j * 3 + 2] = nB;
      }
    }
  }

  // Son güvence: swap detection — hâlâ bir merkez "yanlış seed'e daha yakın" ise seed'e sıfırla
  for (let j = 0; j < k; j++) {
    const cL = centers[j * 3], cA = centers[j * 3 + 1], cB = centers[j * 3 + 2];
    let bestSeed = j;
    let bestDist = Infinity;
    for (let kk = 0; kk < k; kk++) {
      const sL = initCenters[kk * 3], sA = initCenters[kk * 3 + 1], sB = initCenters[kk * 3 + 2];
      const d = (cL - sL) ** 2 + (cA - sA) ** 2 + (cB - sB) ** 2;
      if (d < bestDist) { bestDist = d; bestSeed = kk; }
    }
    if (bestSeed !== j) {
      // Bu merkez başka seed'e daha yakın → swap olmuş. Seed'e resetle.
      centers[j * 3] = initCenters[j * 3];
      centers[j * 3 + 1] = initCenters[j * 3 + 1];
      centers[j * 3 + 2] = initCenters[j * 3 + 2];
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

// -------- Config ---------------------------------------------------------
// Varsayılan değerler 6088-M gibi yakın-renk halılarda ve genel halılarda
// iyi sonuç veren dengeli ayarlardır. Admin panelde değiştirilebilir.
export const DEFAULT_CONFIG = {
  maxSide: 1536,          // Canvas downscale sınırı (yüksek = daha detay, daha yavaş)
  sigma2Mult: 0.35,       // Soft assignment σ² katsayısı — 0.25-0.40 arası dengeli
  sigma2Min: 25,
  sigma2Max: 400,
  minScale: 0.9,          // Histogram spec std clamp — dar (0.9-1.1) = güvenli, doku korunur
  maxScale: 1.1,
  smoothLo: 0.05,         // smoothstep blend
  smoothHi: 0.45,
  topM: 3,
  kmeansMaxIter: 10,      // Az tut — seed'e sadık kalsın
  sampleStride: 3,
  blurSigma: 2.0,         // Cluster atama için LAB blur
  chromaWeight: 3.5,      // Yakın renkleri chroma ile ayır (7141/5621/9811 için kritik)
  shiftBlurSigma: 2.0,    // Render shift map blur (salt-pepper siler, organik geçiş)
  preserveUnchanged: 0.75,// Sıkı koruma — değişmemiş renklere bleed olmaz
  maxKmeansDrift: 6,      // Düşük — cluster swap matematiksel olarak imkânsız
  useMahalanobis: true,   // ★ Her rengin plain halısındaki σ ile eşleşme (lab_std'dan)
};

/**
 * Ayrılabilir (separable) 1D Gaussian blur — LAB float dizisi (n*3) üstünde.
 * Doku seviyesi pikselden piksele gürültüyü bastırır, cluster membership'i
 * yumuşatır.
 */
function gaussianBlurLab(lab, w, h, sigma) {
  if (sigma <= 0.01) return new Float32Array(lab); // no-op copy
  const n = w * h;
  const out = new Float32Array(lab.length);
  const temp = new Float32Array(lab.length);
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const ksize = radius * 2 + 1;
  const kernel = new Float32Array(ksize);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < ksize; i++) kernel[i] /= ksum;

  // Horizontal pass → temp
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sL = 0, sa = 0, sb = 0;
      for (let k = -radius; k <= radius; k++) {
        let xk = x + k;
        if (xk < 0) xk = 0; else if (xk >= w) xk = w - 1;
        const idx = (y * w + xk) * 3;
        const kv = kernel[k + radius];
        sL += kv * lab[idx];
        sa += kv * lab[idx + 1];
        sb += kv * lab[idx + 2];
      }
      const oi = (y * w + x) * 3;
      temp[oi] = sL; temp[oi + 1] = sa; temp[oi + 2] = sb;
    }
  }
  // Vertical pass → out
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sL = 0, sa = 0, sb = 0;
      for (let k = -radius; k <= radius; k++) {
        let yk = y + k;
        if (yk < 0) yk = 0; else if (yk >= h) yk = h - 1;
        const idx = (yk * w + x) * 3;
        const kv = kernel[k + radius];
        sL += kv * temp[idx];
        sa += kv * temp[idx + 1];
        sb += kv * temp[idx + 2];
      }
      const oi = (y * w + x) * 3;
      out[oi] = sL; out[oi + 1] = sa; out[oi + 2] = sb;
    }
  }
  return out;
}

/** Separable Gaussian blur — 3 kanallı float array (n*3). Shift haritası blur için. */
function gaussianBlur3(arr, w, h, sigma) {
  return gaussianBlurLab(arr, w, h, sigma);
}

// -------- RecolorEngine ---------------------------------------------------
export class RecolorEngine {
  /**
   * @param {Object<string,{rgb:number[], lab:number[]}>} palette
   * @param {Partial<typeof DEFAULT_CONFIG>} [config]
   */
  constructor(palette, config = {}) {
    this.palette = palette || {};
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.img = null;
    this.w = 0; this.h = 0;
    this.origPixels = null;
    this.origLab = null;
    this.k = 0;
    this.centers = null;
    this.slotTargetLab = [];
    this.slotTargetCodes = [];
    this.label1 = null;
    this.label2 = null;
    this.weight1 = null;
    this.slotScores = [];
    this.clusterCounts = [];
    this.maxSide = this.config.maxSide;
    this._srcCanvas = null;
    this._srcCtx = null;
  }

  setConfig(partial) {
    this.config = { ...this.config, ...partial };
    this.maxSide = this.config.maxSide;
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
  segment(codes, opts = {}) {
    const sampleStride = opts.sampleStride ?? this.config.sampleStride;
    if (!this.origPixels) throw new Error("loadImage çağrılmadı");
    const n = this.w * this.h;
    const chromaW = this.config.chromaWeight;

    // ★ Cluster atama için LAB'ı önce blur et — fiber dokusu/JPEG gürültüsü
    // cluster'ı bozmasın. Shift hesabı hâlâ origLab'dan (doku korunsun).
    this.segLab = gaussianBlurLab(this.origLab, this.w, this.h, this.config.blurSigma);

    // Seed hazırla: her slot için palette LAB; yoksa k-means++ ile doldur
    const seeds = [];
    const seedStds = []; // Plain halıdan öğrenilen per-axis std (Mahalanobis için)
    for (const code of codes) {
      const pal = this.palette[code];
      if (pal && pal.lab) {
        seeds.push(pal.lab.slice());
        seedStds.push(pal.lab_std ? pal.lab_std.slice() : null);
      } else {
        seeds.push(null);
        seedStds.push(null);
      }
    }
    let rng = mulberry32(42);
    for (let j = 0; j < seeds.length; j++) {
      if (seeds[j]) continue;
      const pi = Math.floor(rng() * n);
      seeds[j] = [
        this.segLab[pi * 3],
        this.segLab[pi * 3 + 1],
        this.segLab[pi * 3 + 2],
      ];
      seedStds[j] = null;
    }
    // Eğer HERHANGİ biri std'siz ise Mahalanobis'i kapat (tutarsızlığı önle)
    const hasAllStds = seedStds.every((s) => s && s.length >= 3);
    const useMaha = this.config.useMahalanobis && hasAllStds;

    // Alt-örnekleme: BLUR'lu LAB'dan örnekle (cluster atama için)
    const sampledLabs = [];
    for (let i = 0; i < n; i += sampleStride) {
      const a = this.origPixels[i * 4 + 3];
      if (a < 32) continue;
      sampledLabs.push(
        this.segLab[i * 3],
        this.segLab[i * 3 + 1],
        this.segLab[i * 3 + 2],
      );
    }
    const labs = Float32Array.from(sampledLabs);
    const { centers, drift, counts } = seededKMeans(labs, seeds, {
      maxIter: this.config.kmeansMaxIter,
      chromaWeight: chromaW,
      maxDrift: this.config.maxKmeansDrift,
      seedStds: useMaha ? seedStds : null,
    });
    // Mahalanobis k-means içinde kullanıldı; soft assignment Euclidean. Dead code temizlendi.
    this.useMahalanobis = useMaha;
    this.k = seeds.length;
    this.slotScores = drift;
    this.clusterCounts = counts;
    const k = this.k;
    this.centers = centers;

    // ★ Soft assignment Euclidean + chromaWeight kullanıyor (Mahalanobis SADECE k-means'te).
    // Neden: Mahalanobis σ plain halıdan geliyor, multi-color halıda σ daha geniş.
    // Örn: 5621 (krem) σ_b=0.3 çok dar → 5621 basin'i b ekseninde çok daralıyor,
    // tesadüfi nötr pikseller yanlış atanıyor, cluster semantiği bozuluyor.
    // Euclidean ile basin'ler üniform → boundary davranışı öngörülebilir.
    let minInterCenter2 = Infinity;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const dL = centers[i * 3] - centers[j * 3];
        const da = centers[i * 3 + 1] - centers[j * 3 + 1];
        const db = centers[i * 3 + 2] - centers[j * 3 + 2];
        const d2 = dL * dL + chromaW * (da * da + db * db);
        if (d2 < minInterCenter2) minInterCenter2 = d2;
      }
    }
    const sigma2 = Math.max(this.config.sigma2Min, Math.min(this.config.sigma2Max,
      minInterCenter2 * this.config.sigma2Mult));

    // Tam piksel soft-assignment: BLUR'lu LAB'dan → komşu pikseller benzer weight alır
    const M = Math.min(this.config.topM, k);
    this.topM = M;
    this.labelsM = new Uint8Array(n * M);
    this.weightsM = new Float32Array(n * M);
    for (let i = 0; i < n; i++) {
      // ★ Blur'lu LAB üstünden assign (smooth membership, no per-pixel noise)
      const L = this.segLab[i * 3], A = this.segLab[i * 3 + 1], B = this.segLab[i * 3 + 2];
      const bestD = new Float32Array(M); bestD.fill(Infinity);
      const bestJ = new Int32Array(M);
      for (let j = 0; j < k; j++) {
        const dL = L - centers[j * 3];
        const da = A - centers[j * 3 + 1];
        const db = B - centers[j * 3 + 2];
        // Euclidean + chromaWeight (soft assignment için öngörülebilir basin'ler)
        const d = dL * dL + chromaW * (da * da + db * db);
        for (let m = 0; m < M; m++) {
          if (d < bestD[m]) {
            for (let s = M - 1; s > m; s--) { bestD[s] = bestD[s - 1]; bestJ[s] = bestJ[s - 1]; }
            bestD[m] = d; bestJ[m] = j;
            break;
          }
        }
      }
      let wSum = 0;
      const ws = new Float32Array(M);
      for (let m = 0; m < M; m++) {
        ws[m] = Math.exp(-bestD[m] / sigma2);
        wSum += ws[m];
      }
      for (let m = 0; m < M; m++) {
        this.labelsM[i * M + m] = bestJ[m];
        this.weightsM[i * M + m] = wSum > 0 ? ws[m] / wSum : (m === 0 ? 1 : 0);
      }
    }

    // Her cluster'ın tam-örnekleme LAB istatistikleri (histogram spec için orig std)
    this.clusterStdL = new Float32Array(k);
    this.clusterStda = new Float32Array(k);
    this.clusterStdb = new Float32Array(k);
    this.clusterMeanL = new Float32Array(k);
    this.clusterMeana = new Float32Array(k);
    this.clusterMeanb = new Float32Array(k);
    {
      const sumL = new Float64Array(k), suma = new Float64Array(k), sumb = new Float64Array(k);
      const cnt = new Uint32Array(k);
      for (let i = 0; i < n; i++) {
        const j = this.labelsM[i * M]; // primary cluster
        sumL[j] += this.origLab[i * 3];
        suma[j] += this.origLab[i * 3 + 1];
        sumb[j] += this.origLab[i * 3 + 2];
        cnt[j]++;
      }
      for (let j = 0; j < k; j++) {
        if (cnt[j] > 0) {
          this.clusterMeanL[j] = sumL[j] / cnt[j];
          this.clusterMeana[j] = suma[j] / cnt[j];
          this.clusterMeanb[j] = sumb[j] / cnt[j];
        } else {
          this.clusterMeanL[j] = centers[j * 3];
          this.clusterMeana[j] = centers[j * 3 + 1];
          this.clusterMeanb[j] = centers[j * 3 + 2];
        }
      }
      const vsL = new Float64Array(k), vsa = new Float64Array(k), vsb = new Float64Array(k);
      for (let i = 0; i < n; i++) {
        const j = this.labelsM[i * M];
        const dL = this.origLab[i * 3] - this.clusterMeanL[j];
        const da = this.origLab[i * 3 + 1] - this.clusterMeana[j];
        const db = this.origLab[i * 3 + 2] - this.clusterMeanb[j];
        vsL[j] += dL * dL; vsa[j] += da * da; vsb[j] += db * db;
      }
      for (let j = 0; j < k; j++) {
        const c = cnt[j] || 1;
        // std + küçük epsilon (divide-by-zero koru)
        this.clusterStdL[j] = Math.max(0.5, Math.sqrt(vsL[j] / c));
        this.clusterStda[j] = Math.max(0.3, Math.sqrt(vsa[j] / c));
        this.clusterStdb[j] = Math.max(0.3, Math.sqrt(vsb[j] / c));
      }
      this.clusterCountsPixel = Array.from(cnt);
    }

    // Slot hedef LAB + std'leri (başlangıç: orijinal = palette LAB)
    this.slotOriginalCodes = codes.slice();   // değişiklik tespiti için sabit
    this.slotTargetCodes = codes.slice();
    this.slotTargetLab = codes.map((c) => (this.palette[c] && this.palette[c].lab) || null);
    this.slotTargetStd = codes.map((c) => {
      const p = this.palette[c];
      return (p && p.lab_std) ? p.lab_std : null;
    });

    return {
      drift,
      counts,
      // UI için: drift>25 uyarı, drift>45 ciddi uyarı
    };
  }

  /** Aynı resmi tekrar segmente et (config değişince kullanılır). workingCodes korunur. */
  resegment() {
    if (!this.slotOriginalCodes) return null;
    const currentTargets = this.slotTargetCodes.slice();
    const origCodes = this.slotOriginalCodes.slice();
    const result = this.segment(origCodes);
    // Seg sonrası hedefleri geri yükle (slot-by-slot)
    currentTargets.forEach((code, i) => this.setSlot(i, code));
    return result;
  }

  setSlot(slotIdx, newCode) {
    if (slotIdx < 0 || slotIdx >= this.slotTargetCodes.length) return;
    this.slotTargetCodes[slotIdx] = newCode;
    const p = this.palette[newCode];
    this.slotTargetLab[slotIdx] = (p && p.lab) || null;
    this.slotTargetStd[slotIdx] = (p && p.lab_std) || null;
  }

  /** Güncel slot hedeflerine göre tüm ImageData'yı üret.
   *
   * Histogram specification (v3):
   *   Her cluster için pixel LAB dağılımını hedef renk dağılımına REMAP eder:
   *     newL = targetMeanL + (pixelL - clusterMeanL) * (targetStdL / clusterStdL)
   *   Aynı a, b için de. Std yoksa std-scaling skip → sadece mean shift.
   *
   *   Bu shift = target - center'dan daha güçlü: L varyasyonunun *amplitüdü*
   *   de hedef swatch'ın std'sine göre ölçeklenir. Texture korunur (relative
   *   rank), ama kontrast hedefe uyar.
   *
   * Alpha matting:
   *   Pixel'in top-M cluster'ına Gaussian-normalized weight ile karışık
   *   remap uygula → cluster sınırlarında yumuşak geçiş.
   *
   * Shift sadece `changed[j]` cluster'lara uygulanır (dokunulmamış renkler
   * orijinal kalır).
   */
  render({ intensity = 1.0 } = {}) {
    if (!this.origLab) throw new Error("loadImage çağrılmadı");
    const n = this.w * this.h;
    const out = new Uint8ClampedArray(this.origPixels);
    const k = this.k;
    const M = this.topM || 1;

    const targetL = new Float32Array(k);
    const targetA = new Float32Array(k);
    const targetB = new Float32Array(k);
    const tStdL = new Float32Array(k);
    const tStdA = new Float32Array(k);
    const tStdB = new Float32Array(k);
    const hasTarget = new Uint8Array(k);
    const hasStd = new Uint8Array(k);
    const changed = new Uint8Array(k);
    for (let j = 0; j < k; j++) {
      const tgt = this.slotTargetLab[j];
      if (tgt) {
        targetL[j] = tgt[0]; targetA[j] = tgt[1]; targetB[j] = tgt[2];
        hasTarget[j] = 1;
      }
      const tst = this.slotTargetStd && this.slotTargetStd[j];
      if (tst) {
        tStdL[j] = tst[0]; tStdA[j] = tst[1]; tStdB[j] = tst[2];
        hasStd[j] = 1;
      }
      const origCode = this.slotOriginalCodes && this.slotOriginalCodes[j];
      const curCode = this.slotTargetCodes[j];
      changed[j] = (origCode !== undefined && curCode !== origCode) ? 1 : 0;
    }
    let anyChanged = false;
    for (let j = 0; j < k; j++) if (changed[j]) { anyChanged = true; break; }
    if (!anyChanged) return new ImageData(out, this.w, this.h);

    // Std ölçek clamp'leri: config'ten
    const MIN_SCALE = this.config.minScale;
    const MAX_SCALE = this.config.maxScale;
    const SMOOTH_LO = this.config.smoothLo;
    const SMOOTH_HI = this.config.smoothHi;

    // ★ İKİ AŞAMALI RENDER ★
    // Aşama 1: Her piksel için (shiftL, shiftA, shiftB) vektörünü hesapla.
    // Aşama 2: Shift map'i Gaussian blur ile yumuşat (piksel gürültüsü siler).
    // Aşama 3: Shift map'i orijinal LAB'a uygula → doku korunur + organik geçiş.
    const shiftMap = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // ★ STRICT HARD-LOCK: primary cluster değişmediyse piksel dokunulmaz.
      // Soft edge effect → shiftBlur'dan geliyor (shiftBlurSigma=2.0), pixel-level
      // accumulation'dan değil. Bu sayede değişmeyen renklere sızma yok.
      const primaryJ = this.labelsM[i * M];
      if (!changed[primaryJ]) continue;

      const L = this.origLab[i * 3];
      const A = this.origLab[i * 3 + 1];
      const B = this.origLab[i * 3 + 2];
      let shiftL = 0, shiftA = 0, shiftB = 0;
      let changedW = 0;
      for (let m = 0; m < M; m++) {
        const j = this.labelsM[i * M + m];
        const w = this.weightsM[i * M + m];
        if (w < 0.01) continue;
        if (!hasTarget[j] || !changed[j]) continue;
        const cMeanL = this.clusterMeanL[j];
        const cMeanA = this.clusterMeana[j];
        const cMeanB = this.clusterMeanb[j];
        const cStdL = this.clusterStdL[j];
        const cStdA = this.clusterStda[j];
        const cStdB = this.clusterStdb[j];
        const sL = hasStd[j] ? clampScale(tStdL[j] / cStdL, MIN_SCALE, MAX_SCALE) : 1;
        const sA = hasStd[j] ? clampScale(tStdA[j] / cStdA, MIN_SCALE, MAX_SCALE) : 1;
        const sB = hasStd[j] ? clampScale(tStdB[j] / cStdB, MIN_SCALE, MAX_SCALE) : 1;
        const remapL = targetL[j] + (L - cMeanL) * sL;
        const remapA = targetA[j] + (A - cMeanA) * sA;
        const remapB = targetB[j] + (B - cMeanB) * sB;
        shiftL += w * (remapL - L);
        shiftA += w * (remapA - A);
        shiftB += w * (remapB - B);
        changedW += w;
      }
      if (changedW < 0.01) continue;
      // Normalize → doygunluk koru; smoothstep → sınırda yumuşak geçiş
      const blend = smoothstep(SMOOTH_LO, SMOOTH_HI, changedW);
      const normFactor = blend / changedW;
      shiftMap[i * 3]     = shiftL * normFactor * intensity;
      shiftMap[i * 3 + 1] = shiftA * normFactor * intensity;
      shiftMap[i * 3 + 2] = shiftB * normFactor * intensity;
    }

    // Aşama 2: Shift map'e blur uygula — boundary geçişleri için
    const blurredShift = this.config.shiftBlurSigma > 0.01
      ? gaussianBlur3(shiftMap, this.w, this.h, this.config.shiftBlurSigma)
      : shiftMap;

    // Aşama 3: Confidence-tabanlı blend — ham (sharp) vs blur (smooth)
    //
    // Problem 1: shift map blur, unchanged piksellerin ZERO shift'ini komşulardan
    // non-zero ile karıştırıp bleed yaratıyordu (strict hard-lock zayıflıyordu).
    //
    // Problem 2: blur interior pikselleri de yumuşatıyordu — deep cluster pikselleri
    // (primaryW≈0.95) gereksiz yere bulanıklaşıyor, netlik kayboluyordu.
    //
    // Çözüm:
    //   - Unchanged primary → shift = 0 (strict, blur bypass'lanır → bleed yok)
    //   - Changed primary:
    //       deep pixel (primaryW > 0.85): conf≈1 → ham shift (sharp, netlik)
    //       boundary (primaryW ≈ 0.5-0.7): conf≈0 → blurred shift (smooth geçiş)
    for (let i = 0; i < n; i++) {
      const primaryJ = this.labelsM[i * M];
      if (!changed[primaryJ]) continue; // STRICT: unchanged cluster → koşulsuz atla

      const primaryW = this.weightsM[i * M];
      const conf = smoothstep(0.5, 0.85, primaryW); // deep=1, boundary=0

      const rawL = shiftMap[i * 3];
      const rawA = shiftMap[i * 3 + 1];
      const rawB = shiftMap[i * 3 + 2];
      const blurL = blurredShift[i * 3];
      const blurA = blurredShift[i * 3 + 1];
      const blurB = blurredShift[i * 3 + 2];

      const sL = conf * rawL + (1 - conf) * blurL;
      const sA = conf * rawA + (1 - conf) * blurA;
      const sB = conf * rawB + (1 - conf) * blurB;
      if (sL === 0 && sA === 0 && sB === 0) continue;

      const L = this.origLab[i * 3];
      const A = this.origLab[i * 3 + 1];
      const B = this.origLab[i * 3 + 2];
      const [nr, ng, nb] = labToRgb(L + sL, A + sA, B + sB);
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

function smoothstep(lo, hi, x) {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function clampScale(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
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
