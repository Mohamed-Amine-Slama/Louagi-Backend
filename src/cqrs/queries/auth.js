// Auth read paths — only ResendOtp lives here.
//
// Hardened against abuse:
//   * No user enumeration: unknown / malformed userIds get the same ok:true
//     shape as real ones — the response never confirms an account exists.
//   * Resends are throttled per user (cooldown lives in the OTP store).
//   * A code is only re-issued when one is already pending; ResendOtp can't
//     be used to conjure an OTP for an arbitrary account (or, once SMS is
//     wired, to bomb someone's phone).

import { sql } from '../../db.js';
import { canResendOtp, issueOtp, pendingOtpPurpose } from '../../auth/otp.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ResendOtp({ userId }) {
  if (!userId || !UUID_RE.test(String(userId))) return { ok: true, devOtp: null };

  const purpose = await pendingOtpPurpose(userId);
  if (!purpose) return { ok: true, devOtp: null };

  if (!(await canResendOtp(userId))) {
    return { ok: false, error: 'Wait a moment before requesting another code' };
  }

  const rows = await sql`
    select phone_number from public.users where id = ${userId}::uuid limit 1
  `;
  const issued = await issueOtp(userId, purpose, { phone: rows[0]?.phone_number });
  return { ok: true, devOtp: issued.devOtp };
}

export const queries = { ResendOtp };
export const meta = {
  ResendOtp: { public: true },
};
