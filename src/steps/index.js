import { spawn } from 'node:child_process';
import { stat, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { optimize as svgo } from 'svgo';
import { extname, join } from 'node:path';
import { makeReference } from '../quality.js';

// Chaque étape : (inputPath, params, workDir) => { path, mime, info? }
const MIME = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm' };

// Retourne { stdout, stderr } (ffmpeg écrit ses scores sur stderr)
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-500)}`))));
  });
}
const ffmpeg = (args, level = 'error') => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', level, ...args]);

// ───────────────────────── Images ─────────────────────────

const encoders = {
  webp: (q) => ({ quality: q, effort: 5 }),
  avif: (q) => ({ quality: q, effort: 4 }),
  jpeg: (q) => ({ quality: q, mozjpeg: true }),
  png:  (q) => ({ quality: q, palette: true, compressionLevel: 9, effort: 7 }),
};

/*
 * Encodage image avec objectifs :
 *  - minSsim  (0-1)  : qualité mesurée minimale → on cherche la PLUS BASSE qualité encodeur qui la respecte (recherche dichotomique)
 *  - maxBytes        : poids cible → sinon, la qualité descend par paliers depuis `quality` jusqu'à `minQuality`
 *  - minQuality      : plancher du réglage encodeur
 *  - strict          : échoue si un objectif n'est pas atteint (sinon avertissement + meilleur résultat)
 * Si minSsim et maxBytes entrent en conflit, la qualité l'emporte.
 */
async function encodeImage(input, { format, quality = 80, minQuality = 40, minSsim, maxBytes, qualityStep = 5, strict = false, width, height, fit = 'inside' }, dir) {
  if (!encoders[format]) throw new Error(`format image inconnu: ${format}`);
  const base = () => {
    let img = sharp(input, input.endsWith('.svg') ? { density: 192 } : undefined).rotate();
    if (width || height) img = img.resize({ width, height, fit, withoutEnlargement: true });
    return img;
  };
  const floor = Math.min(minQuality, quality);
  const ref = await makeReference(base());
  const cache = new Map();
  let tries = 0;
  const attempt = async (q) => {
    if (cache.has(q)) return cache.get(q);
    const path = join(dir, `out-q${q}.${format}`);
    await base().toFormat(format, encoders[format](q)).toFile(path);
    tries++;
    const r = { q, path, size: (await stat(path)).size, ssim: await ref.measure(path) };
    cache.set(q, r);
    return r;
  };

  let best;
  const warnings = [];
  if (minSsim) {
    // plus basse qualité dont le SSIM ≥ cible, dans [floor, 100]
    let lo = floor, hi = 100;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await attempt(mid);
      if (r.ssim >= minSsim) { best = r; hi = mid - 1; } else lo = mid + 1;
    }
    if (!best) { best = await attempt(100); warnings.push(`SSIM ${minSsim} non atteint même à q=100 (${best.ssim.toFixed(4)})`); }
    if (maxBytes && best.size > maxBytes) warnings.push(`poids ${best.size} > objectif ${maxBytes} (la qualité prime)`);
  } else {
    let q = quality;
    for (;;) {
      best = await attempt(q);
      if (!maxBytes || best.size <= maxBytes || q <= floor) break;
      q = Math.max(floor, q - qualityStep);
    }
    if (maxBytes && best.size > maxBytes) warnings.push(`objectif ${maxBytes} octets non atteint au plancher q=${floor}`);
  }
  if (strict && warnings.length) throw new Error(`objectif non atteint (strict): ${warnings.join('; ')}`);

  const before = (await stat(input)).size;
  const info = `${format} q=${best.q} ssim=${best.ssim.toFixed(4)} ${before}→${best.size} octets (${Math.round((1 - best.size / before) * 100)}%), ${tries} essai(s)` +
    (warnings.length ? ` ⚠ ${warnings.join('; ')}` : '');
  return { path: best.path, mime: MIME[format], info };
}

// ───────────────────────── Vidéo ─────────────────────────

const probeDuration = async (input) =>
  parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input])).stdout);

let vmafAvailable;
async function hasVmaf() {
  vmafAvailable ??= (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout.includes('libvmaf');
  return vmafAvailable;
}

const CODECS = (preset) => ({
  h264: { v: ['-c:v', 'libx264', '-preset', preset], crf: (c) => ['-crf', String(c)], a: ['-c:a', 'aac', '-b:a', '128k'], ext: 'mp4', extra: ['-movflags', '+faststart'] },
  av1:  { v: ['-c:v', 'libsvtav1', '-preset', '8'], crf: (c) => ['-crf', String(c)], a: ['-c:a', 'libopus', '-b:a', '128k'], ext: 'webm', extra: [] },
  vp9:  { v: ['-c:v', 'libvpx-vp9'], crf: (c) => ['-crf', String(c), '-b:v', '0'], a: ['-c:a', 'libopus', '-b:a', '128k'], ext: 'webm', extra: [] },
});

// Score de qualité (VMAF 0-100 ou SSIM 0-1) d'un échantillon encodé contre l'original (même fenêtre temporelle, même échelle)
async function scoreVideo(distorted, original, start, len, vf, useVmaf) {
  const ref = `[1:v]${vf},setpts=PTS-STARTPTS[r]`;
  const dis = `[0:v]setpts=PTS-STARTPTS[d]`;
  const graph = useVmaf ? `${dis};${ref};[d][r]libvmaf=n_threads=2` : `${dis};${ref};[d][r]ssim`;
  const { stderr } = await ffmpeg(['-i', distorted, '-ss', String(start), '-t', String(len), '-i', original, '-lavfi', graph, '-f', 'null', '-'], 'info');
  const m = useVmaf ? stderr.match(/VMAF score:\s*([\d.]+)/) : stderr.match(/SSIM[^\n]*All:([\d.]+)/);
  if (!m) throw new Error('score qualité introuvable dans la sortie ffmpeg');
  return parseFloat(m[1]);
}

/*
 * Transcodage vidéo avec objectifs :
 *  - minVmaf (0-100) / minSsim (0-1) : qualité mesurée minimale → recherche du CRF le plus élevé (= fichier le plus léger)
 *    qui la respecte, sur un échantillon de 12 s au milieu de la vidéo, puis encodage complet à ce CRF
 *  - maxBytes (sans cible qualité)   : débit calculé depuis la durée
 *  - crf                             : réglage direct
 */
async function transcodeVideo(input, { codec = 'h264', crf = 26, maxHeight = 1080, preset = 'medium', maxBytes, minVmaf, minSsim, strict = false }, dir) {
  const cfg = CODECS(preset)[codec];
  if (!cfg) throw new Error(`codec inconnu: ${codec}`);
  const vf = `scale=-2:'min(${maxHeight},ih)'`;
  const dur = await probeDuration(input);
  const warnings = [];
  let rate, mode;

  if (minVmaf || minSsim) {
    const useVmaf = !!minVmaf;
    if (useVmaf && !(await hasVmaf())) throw new Error('libvmaf indisponible dans ce ffmpeg : utiliser minSsim');
    const target = useVmaf ? minVmaf : minSsim;
    const len = Math.min(12, dur), start = Math.max(0, dur / 2 - len / 2);
    const sample = async (c) => {
      const out = join(dir, `sample-crf${c}.${cfg.ext}`);
      await ffmpeg(['-ss', String(start), '-t', String(len), '-i', input, '-vf', vf, ...cfg.v, ...cfg.crf(c), '-an', out]);
      return scoreVideo(out, input, start, len, vf, useVmaf);
    };
    let lo = 16, hi = 40, chosen = lo;
    while (lo <= hi) {                      // plus grand CRF dont le score ≥ cible
      const mid = (lo + hi) >> 1;
      const score = await sample(mid);
      if (score >= target) { chosen = mid; lo = mid + 1; } else hi = mid - 1;
    }
    crf = chosen;
    rate = cfg.crf(crf);
    mode = `${useVmaf ? 'vmaf' : 'ssim'}≥${target} → crf ${crf}`;
  } else if (maxBytes) {
    const bitrate = Math.floor((maxBytes * 8 * 0.95) / dur - 128_000);
    if (bitrate < 50_000) throw new Error(`maxBytes=${maxBytes} irréaliste pour cette durée`);
    rate = ['-b:v', String(bitrate), '-maxrate', String(Math.floor(bitrate * 1.5)), '-bufsize', String(bitrate * 2)];
    mode = `cible ${maxBytes} octets (~${Math.round(bitrate / 1000)} kb/s)`;
  } else {
    rate = cfg.crf(crf);
    mode = `crf ${crf}`;
  }

  const out = join(dir, `out.${cfg.ext}`);
  await ffmpeg(['-i', input, '-vf', vf, ...cfg.v, ...rate, ...cfg.a, ...cfg.extra, out]);
  const size = (await stat(out)).size, before = (await stat(input)).size;
  if (maxBytes && size > maxBytes) warnings.push(`poids ${size} > objectif ${maxBytes}`);
  if (strict && warnings.length) throw new Error(`objectif non atteint (strict): ${warnings.join('; ')}`);
  return { path: out, mime: MIME[cfg.ext], info: `${codec} ${mode}: ${before}→${size} octets` + (warnings.length ? ` ⚠ ${warnings.join('; ')}` : '') };
}

export const steps = {
  'image.resize': async (input, { width, height, fit = 'inside' }, dir) => {
    const out = join(dir, `resized${extname(input) || '.img'}`);
    await sharp(input).rotate().resize({ width, height, fit, withoutEnlargement: true }).toFile(out);
    return { path: out, mime: MIME[extname(input).slice(1)] };
  },

  'image.convert': encodeImage,

  // svg → svg : optimisation sans perte visuelle
  'svg.optimize': async (input, _p, dir) => {
    const src = await readFile(input, 'utf8');
    const { data } = svgo(src, { multipass: true });
    const out = join(dir, 'out.svg');
    await writeFile(out, data);
    return { path: out, mime: MIME.svg, info: `svgo ${Buffer.byteLength(src)}→${Buffer.byteLength(data)} octets` };
  },

  'video.transcode': transcodeVideo,

  'video.thumbnail': async (input, { at = 1, width = 640 }, dir) => {
    const out = join(dir, 'thumb.webp');
    await ffmpeg(['-ss', String(at), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, out]);
    return { path: out, mime: MIME.webp };
  },
};
