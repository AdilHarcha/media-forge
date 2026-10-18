import { randomUUID } from 'node:crypto';
import { db, putStream, deleteObject, getObject, signedDownloadPath, verifyDownload } from './lib.js';

/*
 * Génération d'images via un « pont » : un petit agent (bridge/forge-bridge.mjs) tourne sur la machine de l'utilisateur,
 * déjà connecté à SON abonnement par le CLI officiel (Codex → ChatGPT). Il interroge ce serveur, génère, puis renvoie les images.
 * Le serveur ne voit jamais de jeton d'abonnement : il ne fait que tenir la file.
 */

export const PROVIDERS = ['chatgpt'];                 // gemini : l'extension Nano Banana exige une clé API → non pris en charge
const ASPECTS = ['1:1', '3:2', '2:3', '16:9'];
const ONLINE_SECONDS = 90;                            // un pont est « connecté » s'il s'est manifesté depuis moins de 90 s
const STALE = '20 minutes';                           // une génération réservée mais jamais terminée est remise en file

export const publicPaths = ['/dlg/', '/bridge/forge-bridge.mjs'];

export function registerGenerations(app) {
  const touch = (name, providers) => db.query(
    `INSERT INTO bridges (name, providers, seen_at) VALUES ($1,$2,now())
     ON CONFLICT (name) DO UPDATE SET providers = $2, seen_at = now()`, [String(name || 'bridge').slice(0, 60), providers]);

  const onlineProviders = async () => (await db.query(
    `SELECT DISTINCT unnest(providers) AS p FROM bridges WHERE seen_at > now() - make_interval(secs => $1)`, [ONLINE_SECONDS])).rows.map((r) => r.p);

  // ───────── côté interface ─────────
  app.get('/bridge/status', async () => ({ online: await onlineProviders(), providers: PROVIDERS }));

  app.post('/generations', async (req, reply) => {
    const { provider = 'chatgpt', prompt, count = 1, aspect = '1:1' } = req.body ?? {};
    if (!PROVIDERS.includes(provider)) return reply.code(400).send({ error: `fournisseur non pris en charge (${provider})` });
    if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 4000) return reply.code(400).send({ error: 'prompt requis (3 à 4000 caractères)' });
    if (!Number.isInteger(count) || count < 1 || count > 4) return reply.code(400).send({ error: 'count doit valoir 1 à 4' });
    if (!ASPECTS.includes(aspect)) return reply.code(400).send({ error: `aspect inconnu (${ASPECTS.join(', ')})` });
    if (!(await onlineProviders()).includes(provider)) {
      return reply.code(409).send({ error: 'aucun pont connecté : lancez forge-bridge sur votre ordinateur (voir la fiche de l\'étape)' });
    }
    const { rows: [g] } = await db.query(
      'INSERT INTO generations (provider, prompt, count, aspect) VALUES ($1,$2,$3,$4) RETURNING id, status', [provider, prompt.trim(), count, aspect]);
    return reply.code(202).send(g);
  });

  app.get('/generations/:id', async (req, reply) => {
    const { rows: [g] } = await db.query('SELECT id, status, error, keys, count FROM generations WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }));
    if (!g) return reply.code(404).send({ error: 'génération introuvable' });
    return { id: g.id, status: g.status, error: g.error, count: g.count,
      outputs: g.keys.map((_, i) => ({ index: i, download_url: signedDownloadPath(g.id, String(i), 3600, '/dlg') })) };
  });

  // lien signé, utilisable sans clé API (même principe que /dl)
  app.get('/dlg/:id', async (req, reply) => {
    const out = String(req.query.out ?? '0');
    if (!verifyDownload(req.params.id, out, req.query.exp, req.query.sig)) return reply.code(403).send({ error: 'lien invalide ou expiré' });
    const { rows: [g] } = await db.query('SELECT keys FROM generations WHERE id = $1 AND status = \'done\'', [req.params.id]).catch(() => ({ rows: [] }));
    const key = g?.keys?.[Number(out)];
    if (!key) return reply.code(404).send({ error: 'image indisponible (purgée ou inexistante)' });
    const obj = await getObject(key);
    return reply.header('content-type', obj.ContentType || 'image/png').header('content-length', obj.ContentLength).send(obj.Body);
  });

  // ───────── côté pont ─────────
  app.post('/bridge/ping', async (req) => { await touch(req.body?.name, (req.body?.providers ?? []).filter((p) => PROVIDERS.includes(p))); return { ok: true }; });

  // réserve la plus ancienne demande que ce pont sait traiter ; 204 s'il n'y en a pas
  app.post('/bridge/claim', async (req, reply) => {
    const providers = (req.body?.providers ?? []).filter((p) => PROVIDERS.includes(p));
    await touch(req.body?.name, providers);
    if (!providers.length) return reply.code(204).send();
    const { rows: [g] } = await db.query(
      `UPDATE generations SET status = 'running', claimed_at = now(), error = NULL
       WHERE id = (SELECT id FROM generations
                   WHERE provider = ANY($1) AND (status = 'queued' OR (status = 'running' AND claimed_at < now() - interval '${STALE}'))
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, provider, prompt, count, aspect`, [providers]);
    return g ? g : reply.code(204).send();
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
        if (!/^image\/(png|jpeg|webp)$/.test(part.mimetype)) { part.file.resume(); throw new Error(`type refusé (${part.mimetype})`); }
        const key = `gen/${g.id}/${randomUUID()}.${part.mimetype.split('/')[1].replace('jpeg', 'jpg')}`;
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

// Rétention : mêmes règles que les jobs (RETENTION_DAYS) ; la ligne reste, les images disparaissent.
export async function purgeGenerations(days) {
  if (!days) return 0;
  const { rows } = await db.query(
    `SELECT id, keys FROM generations WHERE purged_at IS NULL AND status IN ('done','failed')
     AND finished_at < now() - make_interval(days => $1) LIMIT 100`, [days]);
  for (const g of rows) {
    for (const k of g.keys) await deleteObject(k).catch((e) => { if (e.name !== 'NoSuchKey') throw e; });
    await db.query(`UPDATE generations SET purged_at = now(), keys = '{}' WHERE id = $1`, [g.id]);
  }
  return rows.length;
}
