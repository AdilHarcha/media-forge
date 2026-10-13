import sharp from 'sharp';

// SSIM moyen (fenêtres 8×8, pas 4) sur deux images en niveaux de gris de même taille. 1 = identique.
export function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, N = 64;
  let total = 0, count = 0;
  for (let y = 0; y + 8 <= h; y += 4) {
    for (let x = 0; x + 8 <= w; x += 4) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let j = 0; j < 8; j++) {
        const o = (y + j) * w + x;
        for (let i = 0; i < 8; i++) {
          const p = a[o + i], q = b[o + i];
          sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
        }
      }
      const ma = sa / N, mb = sb / N;
      const va = saa / N - ma * ma, vb = sbb / N - mb * mb, cov = sab / N - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

const gray = (img) => img.flatten({ background: '#ffffff' }).greyscale();

const toGrayRaw = (img) => gray(img).raw().toBuffer({ resolveWithObject: true });

// Réduit un buffer gris (1 canal) à w×h. Même chemin pour la référence et le test : sharp ressort 3 canaux après un
// resize d'entrée raw, d'où extractChannel(0), sinon les deux buffers ne sont pas alignés.
const shrink = (data, w0, h0, w, h) =>
  sharp(data, { raw: { width: w0, height: h0, channels: 1 } }).resize(w, h, { fit: 'fill' }).extractChannel(0).raw().toBuffer();

// Prépare une référence (image source après resize, aplatie sur blanc, ≤1024 px) puis mesure des fichiers encodés contre elle.
export async function makeReference(refPipeline) {
  const { data, info } = await toGrayRaw(refPipeline);
  const f = Math.min(1, 1024 / Math.max(info.width, info.height));
  const w = Math.max(8, Math.round(info.width * f)), h = Math.max(8, Math.round(info.height * f));
  const ref = await shrink(data, info.width, info.height, w, h);
  return {
    async measure(path) {
      const t = await toGrayRaw(sharp(path));
      return ssim(ref, await shrink(t.data, t.info.width, t.info.height, w, h), w, h);
    },
  };
}
