// Centralized Redis caching for read resolvers.
//
// Design:
//   - cached(key, ttl, fn): wraps a resolver; returns cached value or runs fn
//     and caches the result. Transparent fallback when Redis is unavailable.
//   - invalidate(...keys) / invalidatePattern(glob): used by write resolvers
//     to nuke stale entries.
//   - cacheKey: every key built by the app lives here. If it isn't in this
//     object, it shouldn't be cached. Centralizing prevents key collisions
//     and makes invalidation auditable.
//
// TTL guidance:
//   * Reference data (routes, cities): hours — they almost never change.
//   * Per-user profile / status: 60s — long enough for back-to-back screens,
//     short enough to feel snappy after a write that misses invalidation.
//   * Per-user lists (reservations, payments, deliveries, chats, rides):
//     30s — same intent, slightly shorter because the data is more volatile.
//   * Admin dashboards: 120s — heavy aggregates, less critical freshness.
//   * Search results: 30s — high volume, freshness matters but stampedes hurt.
//   * Earnings / analytics: 300s — heavy aggregation, slower to change.

import { getCache, setCache, getRedis, isRedisReady } from '../cache/redis.js';

// ─── cached() ───────────────────────────────────────────────────────────────
// Read-through cache. fn is the resolver body. Returns parsed JSON or runs fn,
// caches its return, and returns it. When the cache is unreachable, fn runs.

export async function cached(key, ttlSec, fn) {
  if (!key || !ttlSec || !fn) throw new Error('cached(): key, ttl, fn required');
  if (!isRedisReady()) return fn();
  const hit = await getCache(key);
  if (hit !== null && hit !== undefined) return hit;
  const value = await fn();
  if (value !== null && value !== undefined) {
    await setCache(key, value, ttlSec);
  }
  return value;
}

// ─── invalidate() ───────────────────────────────────────────────────────────
// Best-effort DEL of specific keys. Accepts strings or arrays.

export async function invalidate(...keys) {
  if (!isRedisReady()) return;
  const flat = keys.flat().filter(Boolean);
  if (!flat.length) return;
  try {
    await getRedis().del(...flat);
  } catch {
    // Cache invalidation is best-effort; TTLs are the safety net.
  }
}

// ─── invalidatePattern() ────────────────────────────────────────────────────
// SCAN-based wildcard delete. Use when a write affects an unknown set of keys
// (e.g. all paginated variants of ListPayments for a user).
//
// Keep patterns specific — `actor:*` would scan everything. `actor:${id}:*` is
// scoped to one user's keys and cheap.

export async function invalidatePattern(pattern) {
  if (!isRedisReady() || !pattern) return;
  try {
    const redis = getRedis();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {}
}

// ─── Key registry ───────────────────────────────────────────────────────────
// Every cache key in the app. Functions take the variables that vary per call;
// constants are functions returning strings for consistency.

export const cacheKey = {
  // Reference data — long-lived, low volatility.
  routes:        () => 'ref:routes:v1',
  cities:        () => 'ref:cities:v1',

  // Per-user — invalidate on UpdateProfile / AdminSetUserActive.
  profile:       (userId) => `profile:${userId}`,
  driverProfile: (userId) => `driver:profile:${userId}`,
  driverStatus:  (userId) => `driver:status:${userId}`,
  twoFAStatus:   (userId) => `2fa:status:${userId}`,

  // Per-user lists — invalidate on the relevant write.
  listChats:        (userId, lim, off) => `chats:list:${userId}:${lim}:${off}`,
  listChatsAll:     (userId) => `chats:list:${userId}:*`,
  listReservations: (userId, status) => `res:list:${userId}:${status || 'all'}`,
  listReservationsAll: (userId) => `res:list:${userId}:*`,
  reservation:      (id) => `res:detail:${id}`,
  listPayments:     (userId, lim, off) => `pay:list:${userId}:${lim}:${off}`,
  listPaymentsAll:  (userId) => `pay:list:${userId}:*`,
  driverRides:      (userId, status) => `driver:rides:${userId}:${status || 'all'}`,
  driverRidesAll:   (userId) => `driver:rides:${userId}:*`,
  myDeliveries:     (userId) => `deliveries:my:${userId}`,
  rideDeliveries:   (rideId) => `deliveries:ride:${rideId}`,
  ridePassengers:   (rideId) => `ride:passengers:${rideId}`,

  // Search / detail — high volume, short TTL.
  searchRides:     (key) => `search:rides:${key}`,
  rideDetail:      (rideId) => `ride:detail:${rideId}`,
  availableDeliveryRides: (origin, dest) => `deliveries:avail:${origin || '_'}:${dest || '_'}`,

  // Admin dashboards.
  adminStats:      () => 'admin:stats:v1',
  adminAlerts:     () => 'admin:alerts:v1',
  adminSeries:     (days) => `admin:series:${days}`,
  adminPaySummary: () => 'admin:paysummary:v1',
  adminPayouts:    (lim) => `admin:payouts:${lim}`,
  adminRides:       (hash) => `admin:rides:${hash}`,
  adminUsersSearch: (hash) => `admin:users:${hash}`,
  adminAudit:       (hash) => `admin:audit:${hash}`,
  adminAuditCount:  () => 'admin:audit:count:v1',

  // Driver sessions (per-actor key).
  driverSessions: (userId) => `driver:sessions:${userId}`,

  // Earnings.
  driverEarnings: (driverUserId, period) => `driver:earnings:${driverUserId}:${period}`,

  // Reviews.
  reviewForRide: (rideId, userId) => `review:ride:${rideId}:${userId}`,
};

// ─── Hash helper ────────────────────────────────────────────────────────────
// SearchRides has a lot of variants (origin, destination, date, seats, filters,
// sort). Build a stable key from the input object.

import crypto from 'crypto';

export function hashInput(input) {
  const stable = JSON.stringify(input ?? {}, Object.keys(input ?? {}).sort());
  return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 16);
}
