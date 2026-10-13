import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, ensureBucket, getFile, putFile } from './lib.js';
import { steps } from './steps/index.js';

const STALE_AFTER = '15 minutes';
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

async function run(job) {
  const { rows: [wf] } = await db.query('SELECT definition FROM workflows WHERE id = $1', [job.workflow_id]);
  const dir = await mkdtemp(join(tmpdir(), 'mf-'));
  try {
    let current = join(dir, 'input' + (job.input_key.match(/\.[a-z0-9]+$/i)?.[0] ?? ''));
    await getFile(job.input_key, current);
    let mime;
    for (let i = 0; i < wf.definition.length; i++) {
      const { type, params = {} } = wf.definition[i];
      if (!steps[type]) throw new Error(`étape inconnue: ${type}`);
      const t0 = Date.now();
      const stepDir = await mkdtemp(join(dir, `s${i}-`));
      ({ path: current, mime } = await steps[type](current, params, stepDir));
      await log(job.id, i, `${type} ok en ${Date.now() - t0} ms`);
      await db.query('UPDATE jobs SET step_index = $2, locked_at = now() WHERE id = $1', [job.id, i + 1]);
    }
    const outKey = `output/${job.id}${current.match(/\.[a-z0-9]+$/i)?.[0] ?? ''}`;
    await putFile(outKey, current, mime);
    await db.query(`UPDATE jobs SET status='done', output_key=$2, finished_at=now(), error=NULL WHERE id=$1`, [job.id, outKey]);
  } catch (e) {
    const final = job.attempts >= job.max_attempts;
    await log(job.id, null, `erreur (tentative ${job.attempts}/${job.max_attempts}): ${e.message}`);
    await db.query(
      `UPDATE jobs SET status=$2, error=$3, finished_at=CASE WHEN $2='failed' THEN now() END WHERE id=$1`,
      [job.id, final ? 'failed' : 'queued', e.message]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loop() {
  await ensureBucket();
  const listener = await db.connect();
  let wake = () => {};
  listener.on('notification', () => wake());
  await listener.query('LISTEN new_job');
  console.log('worker prêt');
  for (;;) {
    const job = await claim();
    if (job) { await run(job); continue; }
    // rien à faire : dormir jusqu'à NOTIFY ou 30 s (filet de sécurité)
    await new Promise((r) => { wake = r; setTimeout(r, 30_000); });
  }
}

loop().catch((e) => { console.error(e); process.exit(1); });
