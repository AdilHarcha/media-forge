import { open } from 'node:fs/promises';
import { extname } from 'node:path';

const EXT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', svg: 'svg',
  mp4: 'mp4', m4v: 'mp4', mov: 'mov', webm: 'webm', mkv: 'mkv' };

// Détection par signature (magic bytes), l'extension n'est qu'un repli : un .jpg qui est un PNG doit être traité en PNG.
export async function detect(path) {
  const fh = await open(path, 'r');
  const buf = Buffer.alloc(512);
  const { bytesRead } = await fh.read(buf, 0, 512, 0);
  await fh.close();
  const b = buf.subarray(0, bytesRead);
  const ascii = (s, e) => b.subarray(s, e).toString('latin1');

  let format;
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') format = 'png';
  else if (b[0] === 0xff && b[1] === 0xd8) format = 'jpeg';
  else if (ascii(0, 3) === 'GIF') format = 'gif';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') format = 'webp';
  else if (ascii(4, 8) === 'ftyp') format = /avif|avis/.test(ascii(8, 12)) ? 'avif' : ascii(8, 12).startsWith('qt') ? 'mov' : 'mp4';
  else if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) format = 'webm'; // matroska/webm
  else if (/<svg[\s>]/i.test(b.toString('utf8')) || /^\s*<\?xml/.test(b.toString('utf8'))) format = 'svg';
  else format = EXT[extname(path).slice(1).toLowerCase()];

  if (!format) throw new Error('format de fichier non reconnu');
  const kind = ['mp4', 'mov', 'webm', 'mkv'].includes(format) ? 'video' : 'image';
  return { format, kind };
}
