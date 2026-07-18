import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';

/**
 * Rendered card images live in S3 and reach Mailstream as public URLs —
 * their front_artwork/back_artwork HTML fields cap at 100k characters, so
 * inlining base64 image data is impossible.
 *
 * Keys are unguessable capability URLs, but DETERMINISTIC per message+side:
 * a retry re-uploads to the same key, keeping the Mailstream request payload
 * byte-identical so Idempotency-Key replay works instead of 422ing on
 * "reused with different payload". A lifecycle rule expires objects after
 * print history stops mattering.
 */

let s3: S3Client | undefined;

export function sniffMime(buf: Buffer): string {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return 'image/png';
}

export async function uploadArtwork(
  teamId: string,
  image: Buffer,
  keySeed: string,
): Promise<string> {
  const bucket = process.env.ARTWORK_BUCKET;
  if (!bucket) throw new Error('ARTWORK_BUCKET is not set');
  if (!s3) s3 = new S3Client({});
  const mime = sniffMime(image);
  const hash = createHash('sha256').update(`postie-artwork-v1:${keySeed}`).digest('hex').slice(0, 40);
  const key = `${teamId}/${hash}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: image,
      ContentType: mime,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  const region = process.env.AWS_REGION ?? 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
