import { verifyToken } from '../auth/tokens.js';
import { sql } from '../db.js';
import { getSession, setSession } from '../cache/redis.js';

export async function actorFromRequest(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const claims = verifyToken(match[1]);
  if (!claims?.sub) return null;

  // Try Redis cache first
  const cached = await getSession(claims.sub);
  if (cached) {
    return {
      ...cached,
      impersonatedBy: claims.impersonatedBy ?? null,
    };
  }

  const rows = await sql`
    select
      u.id,
      u.role,
      u.full_name,
      u.is_active,
      d.status as driver_status
    from public.users u
    left join public.drivers d on d.user_id = u.id
    where u.id = ${claims.sub}::uuid
    limit 1
  `;
  const profile = rows[0];
  if (!profile || profile.is_active === false) return null;

  const actor = {
    id: profile.id,
    role: profile.role,
    name: profile.full_name,
    driverStatus: profile.driver_status ?? null,
  };

  // Cache the result (don't cache impersonation details)
  await setSession(claims.sub, actor);

  return {
    ...actor,
    impersonatedBy: claims.impersonatedBy ?? null,
  };
}

export async function requireAuth(req, res, next) {
  const actor = await actorFromRequest(req);
  if (!actor) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
  req.actor = actor;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.actor) {
      return res.status(401).json({ ok: false, error: 'Unauthenticated' });
    }
    if (!roles.includes(req.actor.role)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    next();
  };
}
