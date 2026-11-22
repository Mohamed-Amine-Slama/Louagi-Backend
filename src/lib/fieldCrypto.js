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
// Reads: db.js decrypts every `enc:v1:` value centrally (decryptValue), so
// query code sees plaintext. Writes: wrap each personal / user-authored value
// in encryptField (text) or encryptJson (jsonb) at the insert/update site.
//
// Encrypted: users.full_name/phone_number/email/payment_account/
// admin_totp_secret, drivers.id_card_number/license_number/payout_account/
// rejection_reason, messages.content, support_tickets.message, reviews.comment,
// delivery.item_description/driver_notes, notifications + notification_campaigns
// title/body, audit_log.ip_address/metadata (new rows; old rows are immutable),
// user_sessions + driver_sessions device/ip. Phone and email also get a keyed
// blind index (users.phone_hash/email_hash) for exact-match lookup + uniqueness.
// Passwords are bcrypt-hashed in SQL (extensions.crypt), never encrypted.
//
// What is deliberately NOT encrypted (SQL filters, joins or public data):
//   * ids, foreign keys, enums, timestamps, prices, seat counts, ratings.
//   * drivers.plate_number — SQL uniqueness check, street-visible.
//   * routes/cities, driver_locations coordinates — public map/search data.
//   * push_tokens.token — upsert key; notifications.data — deep-link ids only.

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

// jsonb columns: store the encrypted JSON text as a jsonb string scalar.
// Bind as `${encryptJson(v)}::jsonb` — postgres-js JSON-serializes ::jsonb
// params itself, so return the raw value (never a pre-stringified literal).
export function encryptJson(value) {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  const enc = encryptField(json);
  return enc === json ? value : enc; // no key → plain jsonb
}

const JSON_OIDS = new Set([114, 3802]); // json, jsonb

// postgres-js `transform.value.from` hook (see db.js): decrypt any encrypted
// value on the way out; jsonb columns get their JSON parsed back.
export function decryptValue(value, column) {
  if (!isEncrypted(value)) return value;
  const plain = decryptField(value);
  return plain !== null && JSON_OIDS.has(column?.type) ? JSON.parse(plain) : plain;
}

let cachedIndexKey;

// Deterministic keyed hash (HMAC-SHA256) for exact-match lookup / uniqueness
// on encrypted columns. Normalised (trim + lowercase) so emails match
// case-insensitively. Subkey is derived so the AES key is never reused as-is.
export function blindIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  if (cachedIndexKey === undefined) {
    const key = loadKey();
    cachedIndexKey = key ? crypto.createHmac('sha256', key).update('louagi:blind-index:v1').digest() : null;
  }
  const normalized = String(value).trim().toLowerCase();
  // shortcut: without a key (dev) this is unkeyed SHA-256, guessable for phone numbers; production must set PII_ENCRYPTION_KEY.
  return cachedIndexKey
    ? crypto.createHmac('sha256', cachedIndexKey).update(normalized).digest('hex')
    : crypto.createHash('sha256').update(normalized).digest('hex');
}
