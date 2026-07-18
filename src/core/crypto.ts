import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

const KMS_PREFIX = 'kms:';
const PLAIN_PREFIX = 'plain:';

let kms: KMSClient | undefined;
function kmsClient(): KMSClient {
  if (!kms) kms = new KMSClient({});
  return kms;
}

/**
 * Encrypts a secret for storage in DynamoDB. Uses KMS when KMS_KEY_ID is set;
 * otherwise falls back to a base64 "plain:" encoding (local dev only — the
 * value is NOT protected, it just avoids accidental shoulder-surfing in logs).
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) {
    return PLAIN_PREFIX + Buffer.from(plaintext, 'utf8').toString('base64');
  }
  const res = await kmsClient().send(
    new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(plaintext, 'utf8') }),
  );
  return KMS_PREFIX + Buffer.from(res.CiphertextBlob!).toString('base64');
}

export async function decryptSecret(stored: string): Promise<string> {
  if (stored.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
  }
  if (stored.startsWith(KMS_PREFIX)) {
    const res = await kmsClient().send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(stored.slice(KMS_PREFIX.length), 'base64'),
      }),
    );
    return Buffer.from(res.Plaintext!).toString('utf8');
  }
  // Legacy/unknown format — treat as plaintext.
  return stored;
}
