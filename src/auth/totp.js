// RFC 6238 TOTP (SHA-1, 6 digits, 30s steps) — no external dependencies.
//
// Used as the per-admin step-up factor for sensitive actions (impersonation).
// Secrets are standard base32 so any authenticator app (Google Authenticator,
// Aegis, 1Password…) can enroll via the otpauth:// URI.

import crypto from 'crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SEC = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit secret per RFC 4226
}

function hotp(keyBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', keyBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

// window=1 accepts the previous/current/next step (±30s clock skew).
export function verifyTotp(secret, code, { window = 1, now = Date.now() } = {}) {
  if (!/^\d{6}$/.test(code || '')) return false;
  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  if (!key.length) return false;
  const step = Math.floor(now / 1000 / STEP_SEC);
  const provided = Buffer.from(code);
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(hotp(key, step + i));
    if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
      return true;
    }
  }
  return false;
}

export function totpUri(secret, label, issuer = 'Louagi Admin') {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`
  );
}
