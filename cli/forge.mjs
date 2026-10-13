#!/usr/bin/env node
// Client en ligne de commande, sans dépendance (Node ≥ 20).
//   FORGE_URL=https://forge.exemple.fr FORGE_KEY=… node cli/forge.mjs <workflow> <fichier…> [--out dossier] [--parallel 4]
// Envoie les fichiers, attend la fin des jobs et télécharge toutes les sorties dans --out (défaut : ./forge-out).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); if (i < 0) return def; const [, v] = args.splice(i, 2); return v; };
const out = opt('out', 'forge-out');
const parallel = Number(opt('parallel', 4));
const [workflow, ...files] = args;
const BASE = (process.env.FORGE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const KEY = process.env.FORGE_KEY || '';

if (!workflow || !files.length) {
  console.error('usage : FORGE_URL=… FORGE_KEY=… forge.mjs <workflow> <fichier…> [--out dossier] [--parallel 4]');
  process.exit(2);
}
const call = (path, init = {}) => fetch(BASE + path, { ...init, headers: { 'x-api-key': KEY, ...(init.headers || {}) } });
const kb = (n) => (n / 1024).toFixed(n > 1048576 ? 0 : 1) + ' Ko';

async function processFile(file) {
  const fd = new FormData();
  fd.append('file', new Blob([await readFile(file)]), basename(file));
  const r = await call(`/jobs?workflow=${encodeURIComponent(workflow)}`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`${file}: envoi refusé (${r.status}) ${(await r.json().catch(() => ({}))).error ?? ''}`);
  const { id } = await r.json();
  for (;;) {
    const j = await (await call(`/jobs/${id}`)).json();
    if (j.status === 'failed') throw new Error(`${file}: échec — ${j.error}`);
    if (j.status === 'done') {
      const stem = basename(file, extname(file));
      for (const o of j.outputs) {
        const res = await fetch(BASE + o.download_url);          // lien signé : sans clé
        const ext = { 'image/webp': '.webp', 'image/avif': '.avif', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm' }[o.mime] ?? '';
        const dest = join(out, `${stem}${o.name === 'main' ? '' : '.' + o.name}${ext}`);
        await writeFile(dest, Buffer.from(await res.arrayBuffer()));
        console.log(`✔ ${file} → ${dest} (${kb(o.size)})`);
      }
      return;
    }
    await new Promise((r2) => setTimeout(r2, 1500));
  }
}

await mkdir(out, { recursive: true });
const queue = [...files];
let failures = 0;
await Promise.all(Array.from({ length: Math.min(parallel, files.length) }, async () => {
  for (let f; (f = queue.shift()); ) await processFile(f).catch((e) => { failures++; console.error('✘ ' + e.message); });
}));
process.exit(failures ? 1 : 0);
