import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, basename } from 'node:path';
import archiver from 'archiver';
import { readFile } from 'node:fs/promises';
import { db, ensureBucket, migrate, putStream, deleteObject, getObject, signedDownloadPath, verifyDownload } from './lib.js';
import { steps } from './steps/index.js';
import { validateDefinition } from './pipeline.js';
import { assertSafeWebhook } from './webhook.js';
import { registerGenerations, publicPaths } from './generations.js';

// Clés API : API_KEY et/ou API_KEYS (liste séparée par des virgules, une par application pour pouvoir la révoquer seule)
const KEYS = [process.env.API_KEY, ...(process.env.API_KEYS || '').split(',')].map((k) => k?.trim()).filter(Boolean);
if (KEYS.length && !process.env.DL_SECRET && !process.env.API_KEY) throw new Error('DL_SECRET requis quand seul API_KEYS est défini (signature des liens)');

const app = Fastify({ logger: true });
await app.register(multipart, { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 ** 3) } });

const sameKey = (given = '') => {
  const x = Buffer.from(String(given));
  return KEYS.reduce((ok, k) => { const y = Buffer.from(k); return (x.length === y.length && timingSafeEqual(x, y)) || ok; }, false);
};

// Auth par clé API ; la page, /health et les liens signés /dl/* sont publics
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health' || req.url === '/' || req.url.startsWith('/dl/') || req.url.startsWith('/dlz/') || publicPaths.some((p) => req.url.startsWith(p))) return;
  if (KEYS.length && !sameKey(req.headers['x-api-key'])) return reply.code(401).send({ error: 'clé API invalide' });
});

const page = await readFile(new URL('../public/index.html', import.meta.url));
app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
app.get('/health', async () => ({ ok: true }));

// le pont (agent local de génération d'images) se télécharge depuis le serveur
const bridgeScript = await readFile(new URL('../bridge/forge-bridge.mjs', import.meta.url));
app.get('/bridge/forge-bridge.mjs', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('content-disposition', 'attachment; filename="forge-bridge.mjs"').send(bridgeScript));
registerGenerations(app);
app.get('/steps', async () => Object.keys(steps));

app.get('/workflows', async () => (await db.query('SELECT id, name, definition FROM workflows ORDER BY name')).rows);

app.post('/workflows', async (req, reply) => {
  const { name, definition } = req.body ?? {};
  const err = !name ? 'name requis' : validateDefinition(definition);
  if (err) return reply.code(400).send({ error: err });
  const { rows: [wf] } = await db.query(
    'INSERT INTO workflows (name, definition) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET definition = $2 RETURNING *',
    [name, JSON.stringify(definition)]);
  return wf;
});

app.delete('/workflows/:name', async (req, reply) => {
  const r = await db.query('DELETE FROM workflows WHERE name = $1', [req.params.name]).catch(() => null);
  if (!r) return reply.code(409).send({ error: 'workflow utilisé par des jobs' });
  return r.rowCount ? { deleted: req.params.name } : reply.code(404).send({ error: 'workflow introuvable' });
});

// POST /jobs?workflow=smart-web[&webhook=https://…]  (multipart, champ "file")
app.post('/jobs', async (req, reply) => {
  const { rows: [wf] } = await db.query('SELECT id FROM workflows WHERE name = $1 OR id::text = $1', [req.query.workflow]);
  if (!wf) return reply.code(404).send({ error: 'workflow introuvable' });
  const webhook = req.query.webhook || null;
  if (webhook) { try { await assertSafeWebhook(webhook); } catch (e) { return reply.code(400).send({ error: e.message }); } }
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'fichier manquant (champ "file")' });
  const batch = req.query.batch || null;
  if (batch && !(await db.query('SELECT 1 FROM batches WHERE id = $1', [batch]).catch(() => ({ rowCount: 0 }))).rowCount) {
    return reply.code(404).send({ error: 'lot introuvable' });
  }
  const key = `input/${randomUUID()}${extname(file.filename).toLowerCase()}`;
  await putStream(key, file.file, file.mimetype);
  if (file.file.truncated) { await deleteObject(key); return reply.code(413).send({ error: 'fichier trop volumineux' }); }
  const { rows: [job] } = await db.query(
    'INSERT INTO jobs (workflow_id, input_key, webhook_url, batch_id, input_name) VALUES ($1,$2,$3,$4,$5) RETURNING id, status',
    [wf.id, key, webhook, batch, basename(file.filename).slice(0, 200)]);
  return reply.code(202).send(job);
});

app.get('/jobs', async (req) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return (await db.query(
    `SELECT j.id, j.status, j.created_at, j.finished_at, w.name AS workflow FROM jobs j JOIN workflows w ON w.id = j.workflow_id
     ORDER BY j.created_at DESC LIMIT $1`, [limit])).rows;
});

app.get('/jobs/:id', async (req, reply) => {
  const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return reply.code(404).send({ error: 'job introuvable' });
  const { rows: logs } = await db.query('SELECT step, message, at FROM job_logs WHERE job_id = $1 ORDER BY id', [job.id]);
  const { rows: outs } = await db.query('SELECT name, mime, size FROM job_outputs WHERE job_id = $1 ORDER BY id', [job.id]);
  const outputs = outs.map((o) => ({ ...o, download_url: signedDownloadPath(job.id, o.name) }));
  const main = outputs.find((o) => o.name === 'main') ?? outputs[0];
  return { ...job, logs, outputs, download_url: main?.download_url ?? null };
});

// Téléchargement : lien signé (HMAC) à durée limitée, sans clé API (utilisable dans un <a href> ou un webhook)
app.get('/dl/:id', async (req, reply) => {
  const out = req.query.out || 'main';
  if (!verifyDownload(req.params.id, out, req.query.exp, req.query.sig)) return reply.code(403).send({ error: 'lien invalide ou expiré' });
  const { rows: [o] } = await db.query(
    `SELECT o.key FROM job_outputs o JOIN jobs j ON j.id = o.job_id WHERE o.job_id = $1 AND o.name = $2 AND j.status = 'done'`, [req.params.id, out]);
  if (!o) return reply.code(404).send({ error: 'résultat indisponible (purgé ou inexistant)' });
  const obj = await getObject(o.key);
  const ext = extname(o.key);
  return reply
    .header('content-type', obj.ContentType || 'application/octet-stream')
    .header('content-length', obj.ContentLength)
    .header('content-disposition', `attachment; filename="${req.params.id.slice(0, 8)}-${out}${ext}"`)
    .send(obj.Body);
});

// ───────── Lots : plusieurs fichiers, un seul ZIP ─────────
app.post('/batches', async (_req, reply) => reply.code(201).send((await db.query('INSERT INTO batches DEFAULT VALUES RETURNING id')).rows[0]));

app.get('/batches/:id', async (req, reply) => {
  const { rows: jobs } = await db.query(
    'SELECT id, status, input_name, error FROM jobs WHERE batch_id = $1 ORDER BY created_at', [req.params.id]).catch(() => ({ rows: [] }));
  if (!jobs.length) return reply.code(404).send({ error: 'lot introuvable ou vide' });
  const count = (st) => jobs.filter((j) => j.status === st).length;
  const finished = jobs.every((j) => ['done', 'failed'].includes(j.status));
  return { id: req.params.id, total: jobs.length, done: count('done'), failed: count('failed'), finished, jobs,
    zip_url: finished && count('done') ? signedDownloadPath(req.params.id, 'zip', 3600, '/dlz') : null };
});

// ZIP des résultats : flux direct depuis le stockage, sans fichier temporaire (store : les médias sont déjà compressés)
app.get('/dlz/:id', async (req, reply) => {
  if (!verifyDownload(req.params.id, 'zip', req.query.exp, req.query.sig)) return reply.code(403).send({ error: 'lien invalide ou expiré' });
  const { rows } = await db.query(
    `SELECT j.input_name, j.id AS job_id, o.name, o.key FROM jobs j JOIN job_outputs o ON o.job_id = j.id
     WHERE j.batch_id = $1 AND j.status = 'done' ORDER BY j.created_at, o.id`, [req.params.id]).catch(() => ({ rows: [] }));
  if (!rows.length) return reply.code(404).send({ error: 'aucun résultat disponible (lot vide ou purgé)' });

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="lot-${req.params.id.slice(0, 8)}.zip"` });
  const zip = archiver('zip', { store: true });
  zip.on('error', (e) => { app.log.error(e); res.destroy(e); });
  zip.pipe(res);
  const used = new Set();
  for (const r of rows) {
    const stem = (r.input_name || r.job_id.slice(0, 8)).replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_');
    let name = `${stem}${r.name === 'main' ? '' : '.' + r.name}${extname(r.key)}`;
    for (let n = 2; used.has(name); n++) name = `${stem}-${n}${r.name === 'main' ? '' : '.' + r.name}${extname(r.key)}`;
    used.add(name);
    zip.append((await getObject(r.key)).Body, { name });
  }
  await zip.finalize();
});

await migrate();
await ensureBucket();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3000) });
