// Integration credentials are encrypted at rest and only decrypted inside a
// connector call. They are never logged, returned by the API, or given to the AI.
import crypto from 'node:crypto';

function key() {
  const secret = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY (32+ characters) is required to store integration credentials.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const [version, iv, tag, body] = stored.split(':');
  if (version !== 'v1') throw new Error('Unsupported credential format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'));
}
