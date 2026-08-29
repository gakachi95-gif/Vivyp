/**
 * lib/storage.js
 *
 * File storage for cover images and paid PDFs, using Cloudflare R2
 * (S3-compatible API, no egress fees, generous free tier). Any
 * S3-compatible provider works with the same code.
 *
 * Cover images: uploaded PUBLIC, referenced by direct URL — fine, they're
 * just marketing images.
 * PDFs: uploaded PRIVATE. Only the object key is ever stored (in the
 * products table's file_key column) — never a public URL. A download
 * link is only ever produced by getSignedDownloadUrl(), which expires in
 * 10 minutes. This is what keeps a paid PDF from being a predictable,
 * permanently-public URL.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

export async function uploadCoverImage(buffer, slug, contentType) {
  const ext = (contentType && contentType.split('/')[1]) || 'jpg';
  const key = `covers/${slug}-${Date.now()}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType, ACL: 'public-read' }));
  return { key, url: `${(PUBLIC_BASE_URL || '').replace(/\/$/, '')}/${key}` };
}

export async function uploadPrivatePdf(buffer, slug, contentType) {
  const key = `pdfs/${slug}-${Date.now()}.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType || 'application/pdf' }));
  return { key }; // no public URL, on purpose
}

export async function getSignedDownloadUrl(key, expiresInSeconds) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds || 600 });
}

export async function deleteObject(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    // best-effort cleanup only
  }
}
