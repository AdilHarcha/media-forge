import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { extname, join } from 'node:path';

// Chaque étape : (inputPath, params, workDir) => { path, mime }
const MIME = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', webm: 'video/webm' };

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`))));
  });
}

export const steps = {
  'image.resize': async (input, { width, height, fit = 'inside' }, dir) => {
    const out = join(dir, `resized${extname(input) || '.img'}`);
    await sharp(input).rotate().resize({ width, height, fit, withoutEnlargement: true }).toFile(out);
    return { path: out, mime: MIME[extname(input).slice(1)] };
  },

  'image.convert': async (input, { format = 'webp', quality = 80 }, dir) => {
    if (!['webp', 'avif', 'jpeg', 'png'].includes(format)) throw new Error(`format image inconnu: ${format}`);
    const out = join(dir, `converted.${format}`);
    await sharp(input).rotate().toFormat(format, { quality }).toFile(out);
    return { path: out, mime: MIME[format] };
  },

  'video.transcode': async (input, { codec = 'h264', crf = 26, maxHeight = 1080, preset = 'medium' }, dir) => {
    const cfg = {
      h264: { v: ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)], a: ['-c:a', 'aac', '-b:a', '128k'], ext: 'mp4', extra: ['-movflags', '+faststart'] },
      av1:  { v: ['-c:v', 'libsvtav1', '-preset', '8', '-crf', String(crf)], a: ['-c:a', 'libopus', '-b:a', '128k'], ext: 'webm', extra: [] },
      vp9:  { v: ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0'], a: ['-c:a', 'libopus', '-b:a', '128k'], ext: 'webm', extra: [] },
    }[codec];
    if (!cfg) throw new Error(`codec inconnu: ${codec}`);
    const out = join(dir, `transcoded.${cfg.ext}`);
    await ffmpeg(['-i', input, '-vf', `scale=-2:'min(${maxHeight},ih)'`, ...cfg.v, ...cfg.a, ...cfg.extra, out]);
    return { path: out, mime: MIME[cfg.ext] };
  },

  'video.thumbnail': async (input, { at = 1, width = 640 }, dir) => {
    const out = join(dir, 'thumb.webp');
    await ffmpeg(['-ss', String(at), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, out]);
    return { path: out, mime: MIME.webp };
  },
};
