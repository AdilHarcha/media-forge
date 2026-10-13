import pg from 'pg';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export const BUCKET = process.env.S3_BUCKET || 'media';

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
  // les checksums par défaut du SDK v3 ne sont pas gérés par tous les stockages S3-compatibles
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// Le bucket est créé par scripts/init-storage.sh ; on attend simplement qu'il soit prêt (démarrage en parallèle).
export async function ensureBucket(timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); return; }
    catch (e) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`bucket "${BUCKET}" inaccessible: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function putFile(key, path, contentType) {
  const { size } = await stat(path);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(path), ContentType: contentType, ContentLength: size }));
}

// Flux de taille inconnue (upload HTTP) → multipart
export async function putStream(key, stream, contentType) {
  await new Upload({ client: s3, params: { Bucket: BUCKET, Key: key, Body: stream, ContentType: contentType } }).done();
}

export const deleteObject = (key) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

export async function getFile(key, destPath) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await pipeline(res.Body, createWriteStream(destPath));
}

export const getObject = (key) => s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

// Liens de téléchargement signés (HMAC) servis par l'API : le stockage reste interne, jamais exposé.
const secret = () => process.env.DL_SECRET || process.env.API_KEY || 'dev-secret';
const sign = (id, exp) => createHmac('sha256', secret()).update(`${id}.${exp}`).digest('hex');
export function signedDownloadPath(id, seconds = 3600) {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `/dl/${id}?exp=${exp}&sig=${sign(id, exp)}`;
}
export function verifyDownload(id, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const a = Buffer.from(sign(id, exp)), b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}
