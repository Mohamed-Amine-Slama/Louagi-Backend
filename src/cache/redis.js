import Redis from 'ioredis';
import { config } from '../config.js';

// The redis connection instance
let redis = null;

// Is redis currently connected and ready to accept commands?
let isReady = false;

export function initRedis() {
  if (process.env.USE_REDIS === 'false') {
    console.log('[redis] Redis is disabled via USE_REDIS environment variable.');
    return null;
  }

  if (redis) return redis;

  redis = new Redis(config.redisUrl, {
    // Retry strategy with exponential backoff
    retryStrategy(times) {
      const delay = Math.min(times * 100, 3000);
      // Try reconnecting up to 10 times. After that, we just run without Redis.
      if (times > 10) {
        console.error('[redis] Reached max retries. Giving up. App will fallback to DB.');
        return null; 
      }
      return delay;
    },
    // Optional TLS config if needed for AWS ElastiCache
    ...(config.redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
  });

  redis.on('connect', () => {
    console.log('[redis] Connected to Redis');
  });

  redis.on('ready', () => {
    console.log('[redis] Redis is ready');
    isReady = true;
  });

  redis.on('error', (err) => {
    console.error('[redis] Connection error:', err.message);
    isReady = false;
  });

  redis.on('close', () => {
    console.warn('[redis] Connection closed');
    isReady = false;
  });

  return redis;
}

export function getRedis() {
  if (!redis) {
    initRedis();
  }
  return redis;
}

export function isRedisReady() {
  return isReady;
}

export async function closeRedis() {
  if (redis) {
    await redis.quit();
    redis = null;
    isReady = false;
  }
}

// ─── Session Helpers ────────────────────────────────────────────────────────

const SESSION_PREFIX = 'session:';

export async function getSession(userId) {
  if (!isReady || !redis) return null;
  try {
    const data = await redis.get(SESSION_PREFIX + userId);
    if (!data) return null;
    return JSON.parse(data);
  } catch (err) {
    console.error(`[redis] getSession failed for ${userId}:`, err.message);
    return null; // Fallback to DB
  }
}

export async function setSession(userId, actorData) {
  if (!isReady || !redis) return;
  try {
    const str = JSON.stringify(actorData);
    await redis.set(SESSION_PREFIX + userId, str, 'EX', config.redisSessionTtl);
  } catch (err) {
    console.error(`[redis] setSession failed for ${userId}:`, err.message);
  }
}

export async function delSession(userId) {
  if (!isReady || !redis) return;
  try {
    await redis.del(SESSION_PREFIX + userId);
  } catch (err) {
    console.error(`[redis] delSession failed for ${userId}:`, err.message);
  }
}

export async function getCache(key) {
  if (!isReady || !redis) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export async function setCache(key, value, ttlSec = 3600) {
  if (!isReady || !redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch {}
}
