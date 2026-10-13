import { spawn } from 'node:child_process';
import { stat, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { optimize as svgo } from 'svgo';
import { extname, join } from 'node:path';

// Chaque étape : (inputPath, params, workDir) => { path, mime, info? }
const MIME = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm' };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-500)}`))));
  });
}
const ffmpeg = (args) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

// Options sharp par format ; "quality" pilote la boucle de compression (png → quantification palette)
const encoders = {
  webp: (q) => ({ quality: q, effort: 5 }),
  avif: (q) => ({ quality: q, effort: 4 }),
  jpeg: (q) => ({ quality: q, mozjpeg: true }),
  png:  (q) => ({ quality: q, palette: true, compressionLevel: 9, effort: 7 }),
};

// Encode UNE fois par essai, en baissant la qualité par paliers tant que le poids cible n'est pas atteint,
// sans jamais descendre sous minQuality (objectif de qualité = plancher).
async function encodeImage(input, { format, quality = 80, minQuality = 40, maxBytes, qualityStep = 5, width, height, fit = 'inside' }, dir) {
  if (!encoders[format]) throw new Error(`format image inconnu: ${format}`);
  const out = join(dir, `out.${format}`);
  const floor = Math.min(minQuality, quality);
  let q = quality, tries = 0, size;
  for (;;) {
    let img = sharp(input, input.endsWith('.svg') ? { density: 192 } : undefined).rotate();
    if (width || height) img = img.resize({ width, height, fit, withoutEnlargement: true });
    await img.toFormat(format, encoders[format](q)).toFile(out);
    size = (await stat(out)).size;
    tries++;
    if (!maxBytes || size <= maxBytes || q <= floor) break;
    q = Math.max(floor, q - qualityStep);
  }
  const before = (await stat(input)).size;
  const reached = !maxBytes || size <= maxBytes;
  const info = `${format} q=${q} ${before}→${size} octets (${Math.round((1 - size / before) * 100)}%), ${tries} essai(s)` +
    (reached ? '' : ` ⚠ objectif ${maxBytes} octets non atteint au plancher q=${floor}`);
  return { path: out, mime: MIME[format], info };
}

async function duration(input) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input]);
  return parseFloat(out);
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

  'video.transcode': async (input, { codec = 'h264', crf = 26, maxHeight = 1080, preset = 'medium', maxBytes }, dir) => {
    const cfg = {
      h264: { v: ['-c:v', 'libx264', '-preset', preset], rate: ['-crf', String(crf)], a: ['-c:a', 'aac', '-b:a', '128k'], ext: 'mp4', extra: ['-movflags', '+faststart'] },
      av1:  { v: ['-c:v', 'libsvtav1', '-preset', '8'], rate: ['-crf', String(crf)], a: ['-c:a', 'libopus', '-b:a', '128k'], ext: 'webm', extra: [] },
      vp9:  { v: ['-c:v', 'libvpx-vp9'], rate: ['-crf', String(crf), '-b:v', '0'], a: ['-c:a', 'libopus', '-b:a', '128k'], ext: 'webm', extra: [] },
    }[codec];
    if (!cfg) throw new Error(`codec inconnu: ${codec}`);
    let rate = cfg.rate, mode = `crf ${crf}`;
    if (maxBytes) {
      // objectif de poids : débit vidéo = (poids cible × 8 / durée) − audio, avec 5 % de marge
      const bitrate = Math.floor((maxBytes * 8 * 0.95) / (await duration(input)) - 128_000);
      if (bitrate < 50_000) throw new Error(`maxBytes=${maxBytes} irréaliste pour cette durée`);
      rate = ['-b:v', String(bitrate), '-maxrate', String(Math.floor(bitrate * 1.5)), '-bufsize', String(bitrate * 2)];
      mode = `cible ${maxBytes} octets (~${Math.round(bitrate / 1000)} kb/s)`;
    }
    const out = join(dir, `out.${cfg.ext}`);
    await ffmpeg(['-i', input, '-vf', `scale=-2:'min(${maxHeight},ih)'`, ...cfg.v, ...rate, ...cfg.a, ...cfg.extra, out]);
    const size = (await stat(out)).size, before = (await stat(input)).size;
    return { path: out, mime: MIME[cfg.ext], info: `${codec} ${mode}: ${before}→${size} octets` };
  },

  'video.thumbnail': async (input, { at = 1, width = 640 }, dir) => {
    const out = join(dir, 'thumb.webp');
    await ffmpeg(['-ss', String(at), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, out]);
    return { path: out, mime: MIME.webp };
  },
};
