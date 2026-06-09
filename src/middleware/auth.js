import { verifyToken } from '../auth/tokens.js';
import { sql } from '../db.js';
import { getCache, setCache, getRedis, isRedisReady } from '../cache/redis.js';
import { safeQuery } from '../lib/supabase/logger.js';
import { withRetry } from '../lib/supabase/withRetry.js';

// Cache actor profile + session validity for short bursts. 60s is long enough
// to absorb a screen's worth of back-to-back requests, short enough that a
// revoked session stops being honored within a minute.
const ACTOR_CACHE_TTL_SEC = 60;

function actorCacheKey(claims) {
  return `actor:${claims.sub}:${claims.jti || 'no-jti'}`;
}

// Invalidate every cached actor entry for a user (called on logout / role
// change / session revoke). Uses SCAN — the wildcard count per user is tiny
// (one per active jti) so the SCAN cost is bounded.
export async function clearActorCache(userId) {
  if (!isRedisReady()) return;
  try {
    const redis = getRedis();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `actor:${userId}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    // Cache invalidation is best-effort; the 60s TTL is the safety net.
  }
}

export async function actorFromRequest(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const claims = verifyToken(match[1]);
  if (!claims?.sub) return null;

  const cacheKey = actorCacheKey(claims);
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  // Postgres-backed session check
  const rows = await withRetry(
    () =>
      safeQuery(
        () =>
          sql`
            select
              u.id,
              u.role,
              u.full_name,
              u.is_active,
              d.status as driver_status,
              s.revoked_at,
              s.expires_at
            from public.users u
            left join public.user_sessions s on s.user_id = u.id and s.session_id = ${claims.jti || null}::uuid
            left join public.drivers d on d.user_id = u.id
            where u.id = ${claims.sub}::uuid
            limit 1
          `,
        { operation: 'actorFromRequest', userId: claims.sub }
      ).then(res => res.data),
    { label: 'actorFromRequest' }
  );

  const profile = rows[0];
  if (!profile || profile.is_active === false) return null;

  // If a session ID was in the token, verify it's not revoked and not expired
  if (claims.jti) {
    if (profile.revoked_at !== null || new Date(profile.expires_at).getTime() <= Date.now()) {
      return null;
    }
    // Bump last_active_at at most once a minute. Skipped entirely when the
    // actor came from cache (we don't reach this branch on a cache hit).
    safeQuery(
      () => sql`
        update public.user_sessions
        set last_active_at = now()
        where session_id = ${claims.jti}::uuid
          and last_active_at < now() - interval '60 seconds'
      `,
      { operation: 'updateLastActive' }
    );
  }

  const actor = {
    id: profile.id,
    role: profile.role,
    name: profile.full_name,
    driverStatus: profile.driver_status ?? null,
    impersonatedBy: claims.impersonatedBy ?? null,
  };
  await setCache(cacheKey, actor, ACTOR_CACHE_TTL_SEC);
  return actor;
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
