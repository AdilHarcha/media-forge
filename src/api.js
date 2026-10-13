import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { db, ensureBucket, putStream, presign } from './lib.js';
import { steps } from './steps/index.js';

const app = Fastify({ logger: true });
await app.register(multipart, { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 ** 3) } });

// Auth minimale par clé API (à remplacer par ton SSO / Authelia si besoin)
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (process.env.API_KEY && req.headers['x-api-key'] !== process.env.API_KEY) {
    return reply.code(401).send({ error: 'clé API invalide' });
  }
});

app.get('/health', async () => ({ ok: true }));
app.get('/steps', async () => Object.keys(steps));

app.get('/workflows', async () => (await db.query('SELECT id, name, definition FROM workflows ORDER BY name')).rows);

app.post('/workflows', async (req, reply) => {
  const { name, definition } = req.body ?? {};
  if (!name || !Array.isArray(definition) || !definition.length) return reply.code(400).send({ error: 'name + definition[] requis' });
  const unknown = definition.find((s) => !steps[s.type]);
  if (unknown) return reply.code(400).send({ error: `étape inconnue: ${unknown.type}` });
  const { rows: [wf] } = await db.query(
    'INSERT INTO workflows (name, definition) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET definition = $2 RETURNING *',
    [name, JSON.stringify(definition)]);
  return wf;
});

// POST /jobs?workflow=image-web  (multipart, champ "file")
app.post('/jobs', async (req, reply) => {
  const { rows: [wf] } = await db.query('SELECT id FROM workflows WHERE name = $1 OR id::text = $1', [req.query.workflow]);
  if (!wf) return reply.code(404).send({ error: 'workflow introuvable' });
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'fichier manquant (champ "file")' });
  const key = `input/${randomUUID()}${extname(file.filename).toLowerCase()}`;
  await putStream(key, file.file, file.mimetype);
  if (file.file.truncated) return reply.code(413).send({ error: 'fichier trop volumineux' });
  const { rows: [job] } = await db.query('INSERT INTO jobs (workflow_id, input_key) VALUES ($1,$2) RETURNING id, status', [wf.id, key]);
  return reply.code(202).send(job);
});

app.get('/jobs/:id', async (req, reply) => {
  const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return reply.code(404).send({ error: 'job introuvable' });
  const { rows: logs } = await db.query('SELECT step, message, at FROM job_logs WHERE job_id = $1 ORDER BY id', [job.id]);
  return { ...job, logs, download_url: job.output_key ? await presign(job.output_key) : null };
});

await ensureBucket();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3000) });
