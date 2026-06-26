// Per-user one-time-password store.
//
// Every OTP is random (in production), bound to a purpose ('login' |
// 'register' | 'password'), single-use, expiring, and attempt-limited. The
// previous implementation compared against a single static code shared by
// every user — which meant anyone who knew a userId could mint a session.
//
// Storage: Redis when available, an in-process Map otherwise (single-binary
// deployment; the fallback loses OTPs on restart, which only forces a resend).
//
// In non-production the code is the fixed DEV_OTP_CODE so the dev loop stays
// simple — but it is still stored, purpose-bound, single-use, and
// attempt-limited, so the verify path is identical in every environment.
//
// Delivery goes through lib/sms.js (SMS_PROVIDER env). The code is NEVER
// returned to the client in production — only out-of-band.

import crypto from 'crypto';

import { config } from '../config.js';
import { getRedis, isRedisReady } from '../cache/redis.js';
import { sendSms } from '../lib/sms.js';
import { sendEmail, passwordOtpEmail } from '../lib/email.js';

const OTP_TTL_SEC = 300;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 30;

// Password-reset deep-link token: longer-lived than a 6-digit OTP and the sole
// credential for a logged-out reset, so it is long, random, single-use, and
// stored only as a hash.
const RESET_TTL_SEC = 1800; // 30 minutes
const RESET_COOLDOWN_SEC = 60;

export const OTP_PURPOSES = ['login', 'register', 'password'];

const otpKey = (userId) => `otp:code:${userId}`;
const cooldownKey = (userId) => `otp:cooldown:${userId}`;
const resetKey = (tokenHash) => `pwreset:token:${tokenHash}`;
const resetCooldownKey = (userId) => `pwreset:cooldown:${userId}`;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ─── In-memory fallback ─────────────────────────────────────────────────────
const memStore = new Map(); // key -> { value, expiresAt }

function memGc() {
  const now = Date.now();
  for (const [k, v] of memStore) {
    if (v.expiresAt <= now) memStore.delete(k);
  }
}

async function storeGet(key) {
  if (isRedisReady()) {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  }
  memGc();
  const hit = memStore.get(key);
  return hit && hit.expiresAt > Date.now() ? hit.value : null;
}

async function storeSet(key, value, ttlSec) {
  if (isRedisReady()) {
    await getRedis().set(key, JSON.stringify(value), 'EX', Math.max(1, Math.ceil(ttlSec)));
    return;
  }
  memGc();
  memStore.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

async function storeDel(key) {
  if (isRedisReady()) {
    await getRedis().del(key);
    return;
  }
  memStore.delete(key);
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Generate, store, and send an OTP. Returns { devOtp } — the code itself
// outside production, null in production where it only travels out-of-band.
// Deliver via { email } (password-change flow) or { phone } (login/register);
// delivery failures are logged, never fatal (the user can hit resend).
export async function issueOtp(userId, purpose, { phone, email } = {}) {
  if (!OTP_PURPOSES.includes(purpose)) throw new Error(`Unknown OTP purpose: ${purpose}`);
  const code =
    config.env === 'production'
      ? String(crypto.randomInt(100000, 1000000))
      : config.devOtpCode;

  await storeSet(
    otpKey(userId),
    { hash: sha256(code), purpose, attempts: MAX_ATTEMPTS, expiresAt: Date.now() + OTP_TTL_SEC * 1000 },
    OTP_TTL_SEC
  );

  if (email) {
    await sendEmail({ to: email, ...passwordOtpEmail(code) });
  } else if (phone) {
    await sendSms(phone, `Louagi: votre code de vérification est ${code}. Valable 5 minutes.`);
  } else if (config.env === 'production') {
    // eslint-disable-next-line no-console
    console.warn(`[otp] code issued for user ${userId} (${purpose}) without a delivery channel`);
  }

  return { devOtp: config.env === 'production' ? null : code };
}

// Validate and consume an OTP. Single-use: deleted on success. Wrong codes
// burn an attempt; running out of attempts deletes the record.
export async function consumeOtp(userId, purpose, code) {
  const record = await storeGet(otpKey(userId));
  if (!record || record.expiresAt <= Date.now()) {
    return { ok: false, error: 'Code expired — request a new one' };
  }
  if (record.purpose !== purpose) return { ok: false, error: 'OTP failed' };

  const expected = Buffer.from(record.hash, 'hex');
  const provided = Buffer.from(sha256(code), 'hex');
  const match = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);

  if (!match) {
    record.attempts -= 1;
    if (record.attempts <= 0) {
      await storeDel(otpKey(userId));
      return { ok: false, error: 'Too many attempts — request a new code' };
    }
    await storeSet(otpKey(userId), record, (record.expiresAt - Date.now()) / 1000);
    return { ok: false, error: 'OTP failed' };
  }

  await storeDel(otpKey(userId));
  return { ok: true };
}

// Resend throttle: one re-issue per cooldown window per user.
export async function canResendOtp(userId) {
  if (await storeGet(cooldownKey(userId))) return false;
  await storeSet(cooldownKey(userId), 1, RESEND_COOLDOWN_SEC);
  return true;
}

// Purpose of the user's outstanding OTP, if any — lets ResendOtp re-issue
// for the right flow without trusting client input.
export async function pendingOtpPurpose(userId) {
  const record = await storeGet(otpKey(userId));
  return record && record.expiresAt > Date.now() ? record.purpose : null;
}

// ─── Password-reset token (deep link) ───────────────────────────────────────

// Reset throttle: one reset email per cooldown window per user, so the forgot
// flow can't be used to bomb a known address.
export async function canIssueResetToken(userId) {
  if (await storeGet(resetCooldownKey(userId))) return false;
  await storeSet(resetCooldownKey(userId), 1, RESET_COOLDOWN_SEC);
  return true;
}

// Mint a single-use reset token for the user. The raw token is returned (to be
// emailed); only its hash is stored, keyed by the hash so it can be looked up
// from the link alone.
export async function issueResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await storeSet(
    resetKey(sha256(token)),
    { userId, expiresAt: Date.now() + RESET_TTL_SEC * 1000 },
    RESET_TTL_SEC
  );
  return token;
}

// Validate and consume a reset token. Single-use: deleted on success. Returns
// the userId it was minted for, or null if missing/expired.
export async function consumeResetToken(token) {
  if (!token) return null;
  const key = resetKey(sha256(token));
  const record = await storeGet(key);
  if (!record || record.expiresAt <= Date.now()) return null;
  await storeDel(key);
  return record.userId;
}
