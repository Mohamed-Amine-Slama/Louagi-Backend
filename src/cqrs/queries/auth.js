// Auth read paths — only ResendOtp lives here. It returns the dev OTP without
// mutating state (no audit log, no session).

import { sql } from '../../db.js';
import { config } from '../../config.js';

async function ResendOtp({ userId }) {
  const rows = await sql`select id from public.users where id = ${userId}::uuid limit 1`;
  if (!rows.length) return { ok: false, error: 'User not found' };
  return { ok: true, devOtp: config.env === 'production' ? null : config.devOtpCode };
}

export const queries = { ResendOtp };
export const meta = {
  ResendOtp: { public: true },
};
