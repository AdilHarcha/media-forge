import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { db, putStream, deleteObject, getObject, signedDownloadPath, verifyDownload } from './lib.js';

/*
 * Génération d'images, deux modes de connexion :
 *
 *  - « chatgpt »    : abonnement. Un petit agent (bridge/forge-bridge.mjs) tourne sur la machine de l'utilisateur, déjà connecté à
 *                     SON abonnement par le CLI officiel (Codex → ChatGPT). Il interroge ce serveur, génère, renvoie les images.
 *                     Le serveur ne voit jamais de jeton d'abonnement : il ne fait que tenir la file.
 *  - « openai-api » : clé API OpenAI. Le serveur appelle directement l'API Images (génération, ou édition si des références sont
 *                     jointes). La clé vient de la requête (utilisée une fois, jamais stockée ni journalisée) ou, si l'administrateur
 *                     l'a configurée, de OPENAI_API_KEY sur le serveur.
 *
 * Les images de référence jointes par l'utilisateur guident le résultat dans les deux modes.
 */

export const PROVIDERS = ['chatgpt', 'openai-api'];      // gemini : l'extension Nano Banana exige une clé API Google → non pris en charge
const ASPECTS = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '16:9': '1536x1024' };   // 16:9 → paysage le plus proche
const ONLINE_SECONDS = 90;                               // un pont est « connecté » s'il s'est manifesté depuis moins de 90 s
const STALE = '20 minutes';                              // une génération réservée mais jamais terminée est remise en file
const MAX_REFS = 4, MAX_REF_BYTES = 10 * 1024 * 1024;
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export const publicPaths = ['/dlg/', '/bridge/forge-bridge.mjs'];

const putBuffer = (key, buf, mime) => putStream(key, Readable.from(buf), mime);

export function registerGenerations(app) {
  const touch = (name, providers) => db.query(
    `INSERT INTO bridges (name, providers, seen_at) VALUES ($1,$2,now())
     ON CONFLICT (name) DO UPDATE SET providers = $2, seen_at = now()`, [String(name || 'bridge').slice(0, 60), providers]);

  const bridgeOnline = async () => (await db.query(
    `SELECT 1 FROM bridges WHERE seen_at > now() - make_interval(secs => $1) AND 'chatgpt' = ANY(providers) LIMIT 1`, [ONLINE_SECONDS])).rowCount > 0;

  // Un redémarrage interrompt les générations « clé API » en cours (elles vivent dans ce processus) : on les clôt proprement.
  db.query(`UPDATE generations SET status = 'failed', error = 'interrompue (redémarrage du serveur)', finished_at = now()
            WHERE provider = 'openai-api' AND status = 'running'`).catch(() => {});

  // ───────── côté interface ─────────
  app.get('/bridge/status', async () => ({
    online: (await bridgeOnline()) ? ['chatgpt'] : [],
    providers: PROVIDERS,
    server_api_key: !!process.env.OPENAI_API_KEY,         // l'administrateur a configuré une clé : le mode API n'exige pas celle de l'utilisateur
  }));

  // JSON, ou multipart (champs + fichiers « ref » : images de référence)
  async function readRequest(req) {
    if (!req.isMultipart()) return { fields: req.body ?? {}, refs: [] };
    const fields = {}, refs = [];
    for await (const part of req.parts({ limits: { fileSize: MAX_REF_BYTES, files: MAX_REFS } })) {
      if (part.type !== 'file') { fields[part.fieldname] = part.value; continue; }
      if (part.fieldname !== 'ref') { part.file.resume(); continue; }
      if (!MIME_EXT[part.mimetype]) { part.file.resume(); throw Object.assign(new Error(`pièce jointe refusée : type ${part.mimetype} (PNG, JPEG ou WebP)`), { status: 400 }); }
      const buf = await part.toBuffer();                    // lève si > MAX_REF_BYTES
      refs.push({ buf, mime: part.mimetype });
    }
    return { fields, refs };
  }

  app.post('/generations', async (req, reply) => {
    let parsed;
    try { parsed = await readRequest(req); }
    catch (e) { return reply.code(e.status || 413).send({ error: e.status ? e.message : `pièce jointe trop volumineuse (max ${MAX_REF_BYTES / 1048576} Mo, ${MAX_REFS} images)` }); }
    const { fields, refs } = parsed;
    const provider = fields.provider || 'chatgpt';
    const prompt = fields.prompt, count = Number(fields.count ?? 1), aspect = fields.aspect || '1:1';
    const model = fields.model ? String(fields.model) : null;

    if (!PROVIDERS.includes(provider)) return reply.code(400).send({ error: `fournisseur non pris en charge (${provider})` });
    if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 4000) return reply.code(400).send({ error: 'prompt requis (3 à 4000 caractères)' });
    if (!Number.isInteger(count) || count < 1 || count > 4) return reply.code(400).send({ error: 'count doit valoir 1 à 4' });
    if (!ASPECTS[aspect]) return reply.code(400).send({ error: `aspect inconnu (${Object.keys(ASPECTS).join(', ')})` });
    if (model && !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(model)) return reply.code(400).send({ error: 'nom de modèle invalide' });

    const apiKey = provider === 'openai-api' ? (String(fields.apiKey || '').trim() || process.env.OPENAI_API_KEY || '') : '';
    if (provider === 'openai-api' && !apiKey) return reply.code(400).send({ error: 'clé API OpenAI requise (ou à configurer sur le serveur : OPENAI_API_KEY)' });
    if (provider === 'chatgpt' && !(await bridgeOnline())) {
      return reply.code(409).send({ error: 'aucun pont connecté : lancez forge-bridge sur votre ordinateur (voir « Connexion » dans la fiche)' });
    }

    const id = randomUUID();
    const refKeys = [];
    for (const [i, r] of refs.entries()) {
      const key = `gen/${id}/ref${i}.${MIME_EXT[r.mime]}`;
      await putBuffer(key, r.buf, r.mime);
      refKeys.push(key);
    }
    const { rows: [g] } = await db.query(
      `INSERT INTO generations (id, provider, prompt, count, aspect, refs, model, status, claimed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8 = 'running' THEN now() END) RETURNING id, status`,
      [id, provider, prompt.trim(), count, aspect, refKeys, model, provider === 'openai-api' ? 'running' : 'queued']);

    if (provider === 'openai-api') {
      // exécuté dans ce processus ; la clé n'est ni stockée ni journalisée
      runApiGeneration({ id, prompt: prompt.trim(), count, aspect, model: model || DEFAULT_MODEL, refKeys, apiKey })
        .catch(async (e) => {
          app.log.warn({ generation: id, err: e.message }, 'génération (clé API) échouée');
          await db.query(`UPDATE generations SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [id, e.message.slice(0, 500)]).catch(() => {});
        });
    }
    return reply.code(202).send(g);
  });

  app.get('/generations/:id', async (req, reply) => {
    const { rows: [g] } = await db.query('SELECT id, status, error, keys, count FROM generations WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }));
    if (!g) return reply.code(404).send({ error: 'génération introuvable' });
    return { id: g.id, status: g.status, error: g.error, count: g.count,
      outputs: g.keys.map((_, i) => ({ index: i, download_url: signedDownloadPath(g.id, String(i), 3600, '/dlg') })) };
  });

  // lien signé (sans clé API), même principe que /dl : résultats (out=0,1…) et références du pont (out=ref0…)
  app.get('/dlg/:id', async (req, reply) => {
    const out = String(req.query.out ?? '0');
    if (!verifyDownload(req.params.id, out, req.query.exp, req.query.sig)) return reply.code(403).send({ error: 'lien invalide ou expiré' });
    const { rows: [g] } = await db.query('SELECT status, keys, refs FROM generations WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }));
    const isRef = out.startsWith('ref');
    const key = isRef ? g?.refs?.[Number(out.slice(3))] : (g?.status === 'done' ? g.keys?.[Number(out)] : null);
    if (!key) return reply.code(404).send({ error: 'image indisponible (purgée ou inexistante)' });
    const obj = await getObject(key);
    return reply.header('content-type', obj.ContentType || 'image/png').header('content-length', obj.ContentLength).send(obj.Body);
  });

  // ───────── côté pont ─────────
  app.post('/bridge/ping', async (req) => { await touch(req.body?.name, (req.body?.providers ?? []).filter((p) => p === 'chatgpt')); return { ok: true }; });

  // réserve la plus ancienne demande « abonnement » ; 204 s'il n'y en a pas
  app.post('/bridge/claim', async (req, reply) => {
    const providers = (req.body?.providers ?? []).filter((p) => p === 'chatgpt');
    await touch(req.body?.name, providers);
    if (!providers.length) return reply.code(204).send();
    const { rows: [g] } = await db.query(
      `UPDATE generations SET status = 'running', claimed_at = now(), error = NULL
       WHERE id = (SELECT id FROM generations
                   WHERE provider = ANY($1) AND (status = 'queued' OR (status = 'running' AND claimed_at < now() - interval '${STALE}'))
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, provider, prompt, count, aspect, refs`, [providers]);
    if (!g) return reply.code(204).send();
    const { refs, ...rest } = g;
    return { ...rest, refs: refs.map((k, i) => signedDownloadPath(g.id, `ref${i}`, 3600, '/dlg')) };
  });

  // images renvoyées par le pont (multipart, un champ "file" par image)
  app.post('/bridge/:id/results', async (req, reply) => {
    const { rows: [g] } = await db.query(`SELECT id, count FROM generations WHERE id = $1 AND status = 'running'`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!g) return reply.code(404).send({ error: 'génération introuvable ou non en cours' });
    const keys = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        if (keys.length >= g.count) { part.file.resume(); continue; }
        if (!MIME_EXT[part.mimetype]) { part.file.resume(); throw new Error(`type refusé (${part.mimetype})`); }
        const key = `gen/${g.id}/${randomUUID()}.${MIME_EXT[part.mimetype]}`;
        await putStream(key, part.file, part.mimetype);
        if (part.file.truncated) { await deleteObject(key); throw new Error('image trop volumineuse'); }
        keys.push(key);
      }
      if (!keys.length) throw new Error('aucune image reçue');
    } catch (e) {
      await Promise.all(keys.map((k) => deleteObject(k).catch(() => {})));
      return reply.code(400).send({ error: e.message });
    }
    await db.query(`UPDATE generations SET status = 'done', keys = $2, finished_at = now() WHERE id = $1`, [g.id, keys]);
    return { id: g.id, images: keys.length };
  });

  app.post('/bridge/:id/fail', async (req, reply) => {
    const { rowCount } = await db.query(
      `UPDATE generations SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'`,
      [req.params.id, String(req.body?.error || 'échec de la génération').slice(0, 500)]).catch(() => ({ rowCount: 0 }));
    return rowCount ? { ok: true } : reply.code(404).send({ error: 'génération introuvable ou non en cours' });
  });
}

// Mode clé API : API Images d'OpenAI (génération, ou édition quand des références sont jointes)
export async function runApiGeneration({ id, prompt, count, aspect, model, refKeys, apiKey }) {
  const size = ASPECTS[aspect];
  const headers = { authorization: `Bearer ${apiKey}` };
  let res;
  if (refKeys.length) {
    const form = new FormData();
    form.append('model', model); form.append('prompt', prompt); form.append('n', String(count)); form.append('size', size);
    for (const [i, key] of refKeys.entries()) {
      const obj = await getObject(key);
      const buf = Buffer.from(await obj.Body.transformToByteArray());
      form.append('image[]', new Blob([buf], { type: obj.ContentType || 'image/png' }), `ref${i}.${key.split('.').pop()}`);
    }
    res = await fetch(`${BASE_URL}/images/edits`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(6 * 60_000) });
  } else {
    res = await fetch(`${BASE_URL}/images/generations`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: count, size }), signal: AbortSignal.timeout(6 * 60_000) });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status} : ${body?.error?.message ?? 'erreur inconnue'}`.replaceAll(apiKey, '***'));
  const items = (body.data ?? []).filter((d) => d.b64_json);
  if (!items.length) throw new Error('OpenAI n\'a renvoyé aucune image');
  const keys = [];
  for (const d of items) {
    const key = `gen/${id}/${randomUUID()}.png`;
    await putBuffer(key, Buffer.from(d.b64_json, 'base64'), 'image/png');
    keys.push(key);
  }
  await db.query(`UPDATE generations SET status = 'done', keys = $2, finished_at = now() WHERE id = $1`, [id, keys]);
}

// Rétention : mêmes règles que les jobs (RETENTION_DAYS) ; la ligne reste, les images (résultats + références) disparaissent.
export async function purgeGenerations(days) {
  if (!days) return 0;
  const { rows } = await db.query(
    `SELECT id, keys, refs FROM generations WHERE purged_at IS NULL AND status IN ('done','failed')
     AND finished_at < now() - make_interval(days => $1) LIMIT 100`, [days]);
  for (const g of rows) {
    for (const k of [...g.keys, ...g.refs]) await deleteObject(k).catch((e) => { if (e.name !== 'NoSuchKey') throw e; });
    await db.query(`UPDATE generations SET purged_at = now(), keys = '{}', refs = '{}' WHERE id = $1`, [g.id]);
  }
  return rows.length;
}
