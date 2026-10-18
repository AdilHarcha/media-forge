#!/usr/bin/env node
/*
 * forge-bridge — génère des images avec VOTRE abonnement, depuis VOTRE ordinateur, pour MediaForge.
 *
 *   node forge-bridge.mjs --url https://forge.geospherique.com          (clé API : variable FORGE_KEY)
 *
 * Fonctionnement : le pont interroge MediaForge (connexion sortante uniquement, aucun port à ouvrir), réserve une demande de
 * génération, lance le CLI officiel déjà connecté à votre abonnement (Codex → ChatGPT), puis renvoie les images.
 * Aucun jeton d'abonnement, mot de passe ou cookie ne quitte votre machine.
 *
 * Prérequis : Node 18+, et pour ChatGPT : Codex CLI (npm i -g @openai/codex) puis `codex login` (« Sign in with ChatGPT »).
 * Les générations consomment le quota de votre forfait et peuvent durer plusieurs minutes. Usage personnel, selon les
 * conditions d'OpenAI : n'exposez pas ce pont à d'autres personnes que vous.
 *
 * Options : --url <url> · --name <nom du pont> · --mock (fournisseur de test, sans abonnement) · --once (une demande puis sortie)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, homedir } from 'node:os';
import { join, extname } from 'node:path';
import { deflateSync } from 'node:zlib';

// CRC-32 local : zlib.crc32 n'existe qu'à partir de Node 20.15 / 22.2
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const URL_BASE = (opt('url', process.env.FORGE_URL || '')).replace(/\/$/, '');
const KEY = process.env.FORGE_KEY || '';
const NAME = opt('name', `${hostname()}`);
const MOCK = flag('mock');
const ONCE = flag('once');
const TIMEOUT_MS = Number(process.env.FORGE_GEN_TIMEOUT_MS || 12 * 60_000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!URL_BASE) { console.error('Indiquez l\'adresse de MediaForge : --url https://… (et la clé API dans FORGE_KEY)'); process.exit(2); }

const call = (path, init = {}) => fetch(URL_BASE + path, { ...init, headers: { 'x-api-key': KEY, ...(init.headers || {}) } });
const json = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ───────────── fournisseurs ─────────────

const ASPECT_TEXT = { '1:1': 'square (1:1)', '3:2': 'landscape (3:2)', '2:3': 'portrait (2:3)', '16:9': 'wide landscape (16:9)' };
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Codex peut ranger l'image ailleurs que dans le dossier courant : on cherche partout où il écrit les images générées
async function walk(dir, since, acc = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, since, acc);
    else if (IMG_EXT.has(extname(e.name).toLowerCase())) { const st = await stat(p); if (st.mtimeMs >= since && st.size > 1000) acc.push({ path: p, mtime: st.mtimeMs }); }
  }
  return acc;
}

// Windows : codex est un .cmd, il faut un shell, et Node déconseille shell + tableau d'arguments → une seule chaîne (arguments fixes)
const WIN = process.platform === 'win32';
const q = (a) => (/[s&|<>^]/.test(a) ? `"${a}"` : a);   // chemins avec espaces
const codexSpawn = (args, opts = {}) => (WIN ? spawn(`codex ${args.map(q).join(' ')}`, { ...opts, shell: true }) : spawn('codex', args, opts));
const codexSync = (args) => (WIN ? spawnSync(`codex ${args.join(' ')}`, { encoding: 'utf8', shell: true }) : spawnSync('codex', args, { encoding: 'utf8' }));
function runCodex(cwd, prompt, refPaths = []) {
  return new Promise((resolve, reject) => {
    // -i (images de référence) en tête, suivi d'une option : la liste de fichiers de -i ne doit pas avaler le « - » final
    const p = codexSpawn(['exec', ...refPaths.flatMap((f) => ['-i', f]), '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-'], { cwd });   // le prompt passe par stdin
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-1500); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    const timer = setTimeout(() => { p.kill(); reject(new Error(`délai dépassé (${Math.round(TIMEOUT_MS / 60000)} min)`)); }, TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`codex a échoué (code ${code}) : ${tail.trim().split('\n').slice(-4).join(' | ')}`)); });
    p.stdin.end(prompt);
  });
}

const chatgpt = {
  name: 'chatgpt',
  check() {
    const r = codexSync(['login', 'status']);
    if (r.error || r.status === null) return 'Codex CLI introuvable : npm i -g @openai/codex';
    const out = `${r.stdout}${r.stderr}`;
    if (!/logged in/i.test(out) || /not logged in/i.test(out)) return 'Codex n\'est pas connecté : lancez « codex login » et choisissez « Sign in with ChatGPT »';
    if (!/chatgpt/i.test(out)) return 'Codex est connecté par clé API, pas par ChatGPT : refaites « codex login » avec votre compte ChatGPT (sinon la génération serait facturée à l\'API)';
    return null;
  },
  async generate({ prompt, aspect, refPaths = [] }) {
    const dir = await mkdtemp(join(tmpdir(), 'forge-gen-'));
    const since = Date.now() - 1000;
    try {
      await runCodex(dir, [
        'Use your image generation tool to create exactly ONE image for the description below.',
        `Aspect ratio: ${ASPECT_TEXT[aspect] ?? 'square (1:1)'}.`,
        'When it is done, make sure the resulting image file is saved in the current directory as out.png (copy it there if the tool stored it elsewhere).',
        'Do nothing else: no other files, no explanations.',
        ...(refPaths.length ? ['The attached image(s) are reference material: use them as guidance (subject, style, composition) for the new image.'] : []),
        '', 'Description:', prompt,
      ].join('\n'), refPaths);
      const found = [...await walk(dir, since), ...await walk(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images'), since)];
      if (!found.length) throw new Error('Codex a terminé sans produire d\'image (outil de génération indisponible ou quota atteint ?)');
      found.sort((a, b) => (b.path.endsWith('out.png') - a.path.endsWith('out.png')) || b.mtime - a.mtime);
      const buf = await readFile(found[0].path);
      return { buf, mime: MIME[extname(found[0].path).toLowerCase()] };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  },
};

// Fournisseur de test : un dégradé PNG, pour valider toute la chaîne sans consommer d'abonnement
const mock = {
  name: 'chatgpt',
  check: () => null,
  async generate({ prompt, aspect }) {
    const [aw, ah] = aspect.split(':').map(Number);
    const w = 384, h = Math.round((w * ah) / aw);
    const row = (y) => { const r = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { r[1 + x * 3] = (x * 255 / w) | 0; r[2 + x * 3] = (y * 255 / h) | 0; r[3 + x * 3] = (prompt.length * 37) % 256; } return r; };
    const raw = Buffer.concat(Array.from({ length: h }, (_, y) => row(y)));
    const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([l, b, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return { buf: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]), mime: 'image/png' };
  },
};

// ───────────── boucle principale ─────────────

const provider = MOCK ? mock : chatgpt;
const problem = provider.check();
if (problem) { console.error('✗ ' + problem); process.exit(1); }
log(`pont « ${NAME} » → ${URL_BASE} · fournisseur ${MOCK ? 'TEST (mock)' : 'ChatGPT via Codex'}`);

const ping = () => json('/bridge/ping', { name: NAME, providers: [provider.name] }).catch(() => {});
let stop = false;
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; log('arrêt demandé, fin de la demande en cours…'); });

async function handle(g) {
  log(`demande ${g.id.slice(0, 8)} : ${g.count} image(s), ${g.aspect} — « ${g.prompt.slice(0, 70)} »`);
  const beat = setInterval(ping, 20_000);                 // reste « connecté » pendant les longues générations
  const refDir = await mkdtemp(join(tmpdir(), 'forge-ref-'));
  try {
    const refPaths = [];
    for (const [i, path] of (g.refs ?? []).entries()) {       // images de référence jointes par l'utilisateur
      const r = await call(path);
      if (!r.ok) throw new Error(`référence ${i + 1} introuvable (${r.status})`);
      const type = r.headers.get('content-type') || 'image/png';
      const file = join(refDir, `ref${i + 1}.${type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png'}`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
      refPaths.push(file);
    }
    if (refPaths.length) log(`  ${refPaths.length} référence(s) jointe(s)`);
    const form = new FormData();
    for (let i = 1; i <= g.count; i++) {
      log(`  génération ${i}/${g.count}…`);
      const { buf, mime } = await provider.generate({ ...g, refPaths });
      form.append('file', new Blob([buf], { type: mime }), `image-${i}.${mime.split('/')[1].replace('jpeg', 'jpg')}`);
    }
    const r = await call(`/bridge/${g.id}/results`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`envoi refusé (${r.status}) : ${(await r.json().catch(() => ({}))).error ?? ''}`);
    log(`  ✓ ${g.count} image(s) envoyée(s)`);
  } catch (e) {
    log(`  ✗ ${e.message}`);
    await json(`/bridge/${g.id}/fail`, { error: e.message }).catch(() => {});
  } finally { clearInterval(beat); await rm(refDir, { recursive: true, force: true }).catch(() => {}); }
}

while (!stop) {
  let g = null;
  try {
    const r = await json('/bridge/claim', { name: NAME, providers: [provider.name] });
    if (r.status === 401) { console.error('✗ clé API refusée (variable FORGE_KEY)'); process.exit(1); }
    if (r.status === 200) g = await r.json();
  } catch (e) { log('serveur injoignable, nouvel essai…', e.message); }
  if (g) { await handle(g); if (ONCE) break; continue; }
  if (ONCE && MOCK) { await sleep(1000); continue; }
  await sleep(3000);
}
