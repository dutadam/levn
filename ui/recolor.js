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
    this.maxSide = 1024;
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

    // Alt-örnekleme: k-means drift skoru için (assignment'a ETKİSİ YOK)
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
    this.k = seeds.length;
    this.slotScores = drift;
    this.clusterCounts = counts;

    // ★ K-means center'lar ile assignment yap (seeds sadece başlangıç).
    // K-means center'lar halıdaki gerçek piksel dağılımını yansıtır; palette
    // seeds çok farklı düşebilir (swatch ≠ halı dokusu). Render formülünde
    // shift = target_LAB - cluster_center_LAB kullanılır.
    const k = this.k;
    this.centers = centers;

    // Adaptive sigma: minimum inter-CENTER mesafesine göre.
    let minInterCenter2 = Infinity;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const dL = centers[i * 3] - centers[j * 3];
        const da = centers[i * 3 + 1] - centers[j * 3 + 1];
        const db = centers[i * 3 + 2] - centers[j * 3 + 2];
        const d2 = dL * dL + da * da + db * db;
        if (d2 < minInterCenter2) minInterCenter2 = d2;
      }
    }
    // sigma² ölçeği: minDist²'nin yarısı → δE=minDist'te weight ≈ exp(-2) ≈ 0.135
    // Bu, yakın renklerde orta düzey bleed sağlar (çok keskin olursa doku kaybı olur).
    const sigma2 = Math.max(16, Math.min(256, minInterCenter2 * 0.5));

    // Tam piksel soft-assignment: TOP-M cluster + Gaussian ağırlıklar (alpha matting).
    const M = Math.min(3, k);
    this.topM = M;
    this.labelsM = new Uint8Array(n * M);
    this.weightsM = new Float32Array(n * M);
    for (let i = 0; i < n; i++) {
      const L = this.origLab[i * 3], A = this.origLab[i * 3 + 1], B = this.origLab[i * 3 + 2];
      // Mini insertion sort ile top-M bul — k-means centers'a göre
      const bestD = new Float32Array(M); bestD.fill(Infinity);
      const bestJ = new Int32Array(M);
      for (let j = 0; j < k; j++) {
        const dL = L - centers[j * 3];
        const da = A - centers[j * 3 + 1];
        const db = B - centers[j * 3 + 2];
        const d = dL * dL + da * da + db * db;
        for (let m = 0; m < M; m++) {
          if (d < bestD[m]) {
            for (let s = M - 1; s > m; s--) { bestD[s] = bestD[s - 1]; bestJ[s] = bestJ[s - 1]; }
            bestD[m] = d; bestJ[m] = j;
            break;
          }
        }
      }
      // Gaussian weights — adaptive sigma
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

    // Std ölçek clamp'leri: çok büyük/küçük amplifikasyonları engelle
    const MIN_SCALE = 0.6, MAX_SCALE = 1.8;

    for (let i = 0; i < n; i++) {
      const L = this.origLab[i * 3];
      const A = this.origLab[i * 3 + 1];
      const B = this.origLab[i * 3 + 2];

      // Soft-blend: her cluster'ın histogram-spec shift'ini ham weight ile karıştır.
      // Normalization YAPMA — weight doğal olarak sınır piksellerini yumuşatır.
      // (Normalize edilirse: w=0.05'teki sınır pikseli bile tam shift alır → sert kenar)
      let shiftL = 0, shiftA = 0, shiftB = 0;
      let anyContrib = false;
      for (let m = 0; m < M; m++) {
        const j = this.labelsM[i * M + m];
        const w = this.weightsM[i * M + m];
        if (w < 0.02) continue; // ihmal edilebilir katkı
        if (!hasTarget[j] || !changed[j]) continue;
        anyContrib = true;
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
        // Ham weight: top-1 cluster ~0.9 → neredeyse tam shift; sınır piksel ~0.3 → kısmi shift
        shiftL += w * (remapL - L);
        shiftA += w * (remapA - A);
        shiftB += w * (remapB - B);
      }
      if (!anyContrib) continue;

      const newL = L + shiftL * intensity;
      const newA = A + shiftA * intensity;
      const newB = B + shiftB * intensity;

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
