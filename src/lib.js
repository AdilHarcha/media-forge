import pg from 'pg';
import { S3Client, GetObjectCommand, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export const BUCKET = process.env.S3_BUCKET || 'media';

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
});

export async function ensureBucket() {
  try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); }
  catch { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); }
}

export async function putFile(key, path, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(path), ContentType: contentType }));
}

export async function putStream(key, stream, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: stream, ContentType: contentType }));
}

export async function getFile(key, destPath) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await pipeline(res.Body, createWriteStream(destPath));
}

export const presign = (key, seconds = 3600) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: seconds });
