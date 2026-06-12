// Application-layer field encryption for PII at rest (AES-256-GCM).
//
// Encrypted values are self-describing: `enc:v1:<base64(iv|tag|ciphertext)>`.
// decryptField() passes anything without the prefix through untouched, so
// legacy plaintext rows keep working and the one-time migration
// (scripts/encrypt-pii.js) can run whenever ops is ready.
//
// Key: PII_ENCRYPTION_KEY env — 32 bytes as 64 hex chars or base64. Without a
// key, encryptField is a no-op (plaintext) so development needs no setup;
// production logs a warning at boot (see config.js).
//
// What is deliberately NOT encrypted:
//   * users.phone_number — exact-match login lookup and admin partial search
//     both query it in SQL; encrypting it breaks those features without a
//     blind-index redesign.
//   * drivers.plate_number — used in SQL uniqueness checks and is public
//     street-visible data.

import crypto from 'crypto';

import { config } from '../config.js';

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey;
let warnedNoKey = false;

function loadKey() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = config.piiEncryptionKey;
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
  }
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) {
    cachedKey = b64;
    return cachedKey;
  }
  throw new Error('PII_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptField(value) {
  if (value === null || value === undefined || value === '') return value;
  if (isEncrypted(value)) return value; // already encrypted — idempotent
  const key = loadKey();
  if (!key) {
    if (!warnedNoKey && config.env === 'production') {
      warnedNoKey = true;
      // eslint-disable-next-line no-console
      console.warn('[fieldCrypto] no PII_ENCRYPTION_KEY — storing PII in plaintext');
    }
    return value;
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptField(value) {
  if (!isEncrypted(value)) return value; // legacy plaintext or non-string
  const key = loadKey();
  if (!key) {
    // eslint-disable-next-line no-console
    console.error('[fieldCrypto] encrypted value present but no key configured');
    return null;
  }
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext — surface as missing, never as garbage.
    // eslint-disable-next-line no-console
    console.error('[fieldCrypto] decryption failed (wrong key or corrupted value)');
    return null;
  }
}
