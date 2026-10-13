import dns from 'node:dns/promises';
import net from 'node:net';
import { db, hmac, signedDownloadPath } from './lib.js';

// Plages non routables : un webhook ne doit jamais viser le réseau interne (postgres, stockage, autres stacks du serveur).
const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./,
  /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./i];

export async function assertSafeWebhook(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL de webhook invalide'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('webhook: http(s) uniquement');
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === '1') return u;
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => PRIVATE.some((re) => re.test(a.address)))) throw new Error('webhook: adresse privée interdite');
  return u;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Notifie la fin d'un job (done ou failed définitif) : POST JSON signé HMAC (x-forge-signature), 3 essais.
export async function deliverWebhook(jobId) {
  const { rows: [job] } = await db.query('SELECT id, status, error, webhook_url FROM jobs WHERE id = $1', [jobId]);
  if (!job?.webhook_url) return;
  const { rows: outs } = await db.query('SELECT name, mime, size FROM job_outputs WHERE job_id = $1 ORDER BY id', [jobId]);
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const body = JSON.stringify({
    id: job.id, status: job.status, error: job.error,
    outputs: outs.map((o) => ({ ...o, url: base + signedDownloadPath(job.id, o.name, 86400) })),
  });
  let last = '';
  for (const delay of [0, 2000, 10000]) {
    if (delay) await wait(delay);
    try {
      const u = await assertSafeWebhook(job.webhook_url);
      const r = await fetch(u, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'x-forge-signature': 'sha256=' + hmac(body) },
        body,
      });
      if (r.ok) { await db.query(`UPDATE jobs SET webhook_status = 'delivered' WHERE id = $1`, [jobId]); return; }
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.message; }
  }
  await db.query(`UPDATE jobs SET webhook_status = $2 WHERE id = $1`, [jobId, `failed: ${last}`.slice(0, 200)]);
}
