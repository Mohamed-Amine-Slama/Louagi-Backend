import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { sql } from '../db.js';

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_SEC = 14 * 24 * 60 * 60;
const BIOMETRIC_TTL_SEC = 30 * 24 * 60 * 60;

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function issueToken(claims, { typ, ttlSec }) {
  const jti = claims.jti || randomId();
  const payload = { ...claims };
  delete payload.jti; // Remove to avoid conflict with jwtid option
  
  const token = jwt.sign(
    payload,
    config.appJwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: ttlSec,
      header: { typ },
      issuer: 'louagi-server',
      jwtid: jti,
    }
  );
  return { token, claims: jwt.decode(token) };
}

function issueRefreshToken(claims) {
  return issueToken(
    { ...claims, kind: claims.kind || 'refresh' },
    { typ: 'JWT-R', ttlSec: REFRESH_TTL_SEC }
  );
}

async function storeRefreshToken(claims, db = sql) {
  if (!claims?.jti || !claims?.sub || !claims?.exp) {
    throw new Error('Cannot persist refresh token without jti, sub, and exp claims');
  }

  await db`
    insert into public.refresh_tokens (
      jti,
      user_id,
      expires_at
    ) values (
      ${claims.jti},
      ${claims.sub}::uuid,
      ${new Date(claims.exp * 1000)}
    )
  `;
}

export function signAccessToken(claims) {
  return issueToken(claims, { typ: 'JWT', ttlSec: ACCESS_TTL_SEC }).token;
}

export async function signRefreshToken(claims) {
  const issued = issueRefreshToken(claims);
  await storeRefreshToken(issued.claims);
  return issued.token;
}

export function signBiometricTicket(claims) {
  return issueToken(
    { ...claims, kind: 'biometric' },
    { typ: 'JWT-B', ttlSec: BIOMETRIC_TTL_SEC }
  ).token;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, config.appJwtSecret, {
      algorithms: ['HS256'],
      issuer: 'louagi-server',
    });
  } catch {
    return null;
  }
}

export async function rotateRefreshToken(refreshToken) {
  const claims = verifyToken(refreshToken);
  if (!claims || claims.kind !== 'refresh' || !claims.jti || !claims.sub) return null;

  try {
    return await sql.begin(async (tx) => {
      const rows = await tx`
        select jti, user_id, revoked_at, expires_at
        from public.refresh_tokens
        where jti = ${claims.jti}
          and user_id = ${claims.sub}::uuid
        for update
      `;
      const stored = rows[0];
      if (!stored || stored.revoked_at || new Date(stored.expires_at).getTime() <= Date.now()) {
        return null;
      }

      const next = issueRefreshToken({
        sub: claims.sub,
        role: claims.role,
        name: claims.name,
        driverStatus: claims.driverStatus ?? null,
      });
      await storeRefreshToken(next.claims, tx);
      await tx`
        update public.refresh_tokens
        set revoked_at = now(),
            replaced_by_jti = ${next.claims.jti}
        where jti = ${claims.jti}
      `;

      return {
        claims,
        refreshToken: next.token,
      };
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] refresh rotation failed:', err.message);
    return null;
  }
}

export async function revokeRefreshToken(refreshToken) {
  const claims = verifyToken(refreshToken);
  if (!claims?.jti) return;
  try {
    await sql`
      update public.refresh_tokens
      set revoked_at = coalesce(revoked_at, now())
      where jti = ${claims.jti}
    `;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] refresh revocation failed:', err.message);
  }
}
