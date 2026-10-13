import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { db, ensureBucket, getFile, putFile, migrate } from './lib.js';
import { steps } from './steps/index.js';
import { detect } from './detect.js';
import { resolvePlan } from './pipeline.js';
import { purgeExpired, reapAbandoned } from './purge.js';
import { deliverWebhook } from './webhook.js';

const STALE_AFTER = '15 minutes';
const MAX_PARALLEL = Number(process.env.GRAPH_PARALLEL || 2);   // branches d'un même job exécutées en parallèle
const log = (jobId, step, message) =>
  db.query('INSERT INTO job_logs (job_id, step, message) VALUES ($1,$2,$3)', [jobId, step, message]);

// Réserve un job : SKIP LOCKED permet à N workers de piocher sans collision.
// Récupère aussi les jobs "running" abandonnés (worker crashé).
async function claim() {
  const { rows } = await db.query(`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE (status = 'queued' OR (status = 'running' AND locked_at < now() - interval '${STALE_AFTER}'))
        AND attempts < max_attempts
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`);
  return rows[0];
}

// Exécute le graphe : à chaque tour, tous les nœuds dont la source est prête (par paquets de MAX_PARALLEL).
async function runGraph(job, nodes, inputPath, dir) {
  const results = new Map([['input', { path: inputPath }]]);
  let pending = nodes.slice(), done = 0;
  while (pending.length) {
    const ready = pending.filter((n) => results.has(n.from));
    if (!ready.length) throw new Error('graphe bloqué (cycle ou source manquante)');
    for (let i = 0; i < ready.length; i += MAX_PARALLEL) {
      await Promise.all(ready.slice(i, i + MAX_PARALLEL).map(async (n) => {
        const step = steps[n.type];
        if (!step) throw new Error(`étape inconnue: ${n.type}`);
        const t0 = Date.now();
        const nodeDir = await mkdtemp(join(dir, `${n.id}-`));
        const r = await step(results.get(n.from).path, n.params, nodeDir);
        results.set(n.id, r);
        await log(job.id, null, `[${n.id}] ${n.type} ok en ${Date.now() - t0} ms${r.info ? ' — ' + r.info : ''}`);
        await db.query('UPDATE jobs SET step_index = $2, locked_at = now() WHERE id = $1', [job.id, ++done]);
      }));
    }
    pending = pending.filter((n) => !results.has(n.id));
  }
  return results;
}

async function run(job) {
  const { rows: [wf] } = await db.query('SELECT definition FROM workflows WHERE id = $1', [job.workflow_id]);
  const dir = await mkdtemp(join(tmpdir(), 'mf-'));
  let finalStatus;
  try {
    const input = join(dir, 'input' + (job.input_key.match(/\.[a-z0-9]+$/i)?.[0] ?? ''));
    await getFile(job.input_key, input);
    const detected = await detect(input);
    const { label, nodes } = resolvePlan(wf.definition, detected);
    await log(job.id, null, `détecté ${detected.format} (${detected.kind}) → ${label}: ${nodes.map((n) => `${n.id}=${n.type}`).join(', ')}`);

    const results = await runGraph(job, nodes, input, dir);

    // un job relancé repart de zéro : on remplace d'éventuelles sorties d'une tentative précédente
    let mainKey = null;
    for (const n of nodes.filter((x) => x.output)) {
      const r = results.get(n.id);
      const key = `output/${job.id}/${n.id}${extname(r.path)}`;
      await putFile(key, r.path, r.mime);
      await db.query(
        `INSERT INTO job_outputs (job_id, name, key, mime, size) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (job_id, name) DO UPDATE SET key = $3, mime = $4, size = $5`,
        [job.id, n.id, key, r.mime, (await stat(r.path)).size]);
      if (n.id === 'main' || !mainKey) mainKey = key;
    }
    await db.query(`UPDATE jobs SET status='done', output_key=$2, finished_at=now(), error=NULL WHERE id=$1`, [job.id, mainKey]);
    finalStatus = 'done';
  } catch (e) {
    const final = job.attempts >= job.max_attempts;
    await log(job.id, null, `erreur (tentative ${job.attempts}/${job.max_attempts}): ${e.message}`);
    await db.query(
      `UPDATE jobs SET status=$2::job_status, error=$3, finished_at=CASE WHEN $2::job_status = 'failed' THEN now() END WHERE id=$1`,
      [job.id, final ? 'failed' : 'queued', e.message]);
    if (final) finalStatus = 'failed';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // webhook seulement pour un état définitif (pas pour une tentative qui sera rejouée)
  if (finalStatus) await deliverWebhook(job.id).catch((e) => console.error('webhook:', e.message));
}

async function loop() {
  await migrate();
  await ensureBucket();
  const listener = await db.connect();
  let wake = () => {};
  listener.on('notification', () => wake());
  await listener.query('LISTEN new_job');

  const maintenance = () => Promise.all([purgeExpired(), reapAbandoned()]).catch((e) => console.error('maintenance:', e.message));
  maintenance();
  setInterval(maintenance, 10 * 60 * 1000).unref();   // purge de rétention + jobs abandonnés, toutes les 10 min

  console.log('worker prêt');
  for (;;) {
    const job = await claim();
    if (job) {
      // une erreur inattendue ne doit jamais tuer le worker : le job sera repris par le filet "stale" (15 min)
      await run(job).catch((e) => console.error(`job ${job.id}:`, e.message));
      continue;
    }
    // rien à faire : dormir jusqu'à NOTIFY ou 30 s (filet de sécurité)
    await new Promise((r) => { wake = r; setTimeout(r, 30_000); });
  }
}

loop().catch((e) => { console.error(e); process.exit(1); });
