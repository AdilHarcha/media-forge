import { db, deleteObject } from './lib.js';

const DAYS = Number(process.env.RETENTION_DAYS || 7);

// Supprime les fichiers (source + sorties) des jobs terminés depuis plus de RETENTION_DAYS jours.
// La ligne du job est conservée (historique) ; seuls les objets S3 disparaissent. 0 = rétention désactivée.
export async function purgeExpired() {
  if (!DAYS) return 0;
  const c = await db.connect();
  let n = 0;
  try {
    await c.query('BEGIN');
    // SKIP LOCKED : plusieurs workers peuvent purger sans se marcher dessus
    const { rows } = await c.query(
      `SELECT id, input_key FROM jobs
       WHERE purged_at IS NULL AND status IN ('done','failed') AND finished_at < now() - make_interval(days => $1)
       ORDER BY finished_at LIMIT 100 FOR UPDATE SKIP LOCKED`, [DAYS]);
    for (const job of rows) {
      const { rows: outs } = await c.query('SELECT key FROM job_outputs WHERE job_id = $1', [job.id]);
      for (const key of [job.input_key, ...outs.map((o) => o.key)]) {
        await deleteObject(key).catch((e) => { if (e.name !== 'NoSuchKey') throw e; });
      }
      await c.query('DELETE FROM job_outputs WHERE job_id = $1', [job.id]);
      await c.query('UPDATE jobs SET purged_at = now(), output_key = NULL WHERE id = $1', [job.id]);
      n++;
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('purge:', e.message);
  } finally {
    c.release();
  }
  if (n) console.log(`purge: ${n} job(s) nettoyé(s) (rétention ${DAYS} j)`);
  return n;
}

// Un job "running" dont le worker a disparu ET qui a épuisé ses tentatives ne sera jamais repris par claim() : on le clôt en échec.
export async function reapAbandoned() {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'failed', error = COALESCE(error, 'abandonné (worker interrompu)'), finished_at = now()
     WHERE status = 'running' AND locked_at < now() - interval '15 minutes' AND attempts >= max_attempts`);
  if (rowCount) console.log(`reap: ${rowCount} job(s) abandonné(s) clos en échec`);
  return rowCount;
}
