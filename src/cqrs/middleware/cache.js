// Cache-first middleware for queries.
//
// A query handler can opt into caching by attaching a `.cache` descriptor:
//   handler.cache = { key: (payload, ctx) => 'profile:' + ctx.actor.id, ttl: 60 };
//
// This middleware intercepts before the handler runs, checks Redis, returns the
// hit if present, otherwise runs the handler and writes the result.
//
// We keep `cached(key, ttl, fn)` available for handlers that need it inline
// (e.g. queries whose key depends on data computed inside the handler).

import { getCache, setCache, isRedisReady } from '../../cache/redis.js';

export function cacheMiddleware() {
  return async ({ name, payload, ctx, metadata }, next) => {
    const cache = metadata?.cache;
    if (!cache || !isRedisReady()) return next();

    let key;
    try {
      key = typeof cache.key === 'function' ? await cache.key(payload, ctx) : cache.key;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[cache:${name}] key builder threw, bypassing cache:`, err?.message);
      return next();
    }
    if (!key) return next();

    const hit = await getCache(key);
    if (hit !== null && hit !== undefined) return hit;

    const value = await next();
    if (value !== null && value !== undefined) {
      await setCache(key, value, cache.ttl ?? 60);
    }
    return value;
  };
}
