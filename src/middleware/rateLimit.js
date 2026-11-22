import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { getRedis, isRedisReady } from '../cache/redis.js';
import { config } from '../config.js';

const rateLimitResponse = {
  ok: false,
  error: 'Too many requests. Try again later.',
};

// Per-client-IP limiter middleware with its own budget. Each one needs a distinct
// keyPrefix: limiters that share a prefix share Redis keys, and so share one budget.
// Keyed on IP because these run before any route sets req.actor.
function ipRateLimit(keyPrefix, points) {
  const duration = config.rateLimitWindowMs / 1000;
  let memory = null;
  let redis = null;
  return async (req, res, next) => {
    if (req.path === '/health') return next();
    if (!memory) {
      memory = new RateLimiterMemory({ keyPrefix: `${keyPrefix}_mem`, points, duration });
      const storeClient = getRedis();
      if (storeClient) {
        redis = new RateLimiterRedis({
          storeClient,
          keyPrefix,
          points,
          duration,
          inmemoryBlockOnConsumed: points + 1,
        });
      }
    }
    const limiter = isRedisReady() && redis ? redis : memory;
    try {
      await limiter.consume(req.ip, 1);
      next();
    } catch {
      res.status(429).json(rateLimitResponse);
    }
  };
}

export const apiRateLimit = ipRateLimit('rl_api', config.rateLimitMax);
export const graphqlRateLimit = ipRateLimit('rl_graphql', config.graphqlRateLimitMax);

// ─── Auth attempt limiter ───────────────────────────────────────────────────
// Per-identifier brute-force guard for credential and OTP checks: 5 failed
// attempts per identifier per 15 minutes. Distinct from the per-IP limiters
// above — credential stuffing rotates IPs but targets one account.
//
// Call recordAuthFailure(key) after a FAILED attempt and authAttemptsExceeded
// (key) BEFORE processing; successful attempts cost nothing, so legitimate
// users are never locked out by their own activity.

const AUTH_MAX_FAILURES = 5;
const AUTH_WINDOW_SEC = 15 * 60;

let authLimiterRedis = null;
let authLimiterMemory = null;

function initAuthLimiters() {
  authLimiterMemory = new RateLimiterMemory({
    keyPrefix: 'rl_auth_mem',
    points: AUTH_MAX_FAILURES,
    duration: AUTH_WINDOW_SEC,
  });
  const redisClient = getRedis();
  if (redisClient) {
    authLimiterRedis = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rl_auth',
      points: AUTH_MAX_FAILURES,
      duration: AUTH_WINDOW_SEC,
    });
  }
}

function authLimiter() {
  if (!authLimiterMemory) initAuthLimiters();
  return isRedisReady() && authLimiterRedis ? authLimiterRedis : authLimiterMemory;
}

export async function authAttemptsExceeded(key) {
  try {
    const state = await authLimiter().get(key);
    return state !== null && state.consumedPoints >= AUTH_MAX_FAILURES;
  } catch {
    return false;
  }
}

export async function recordAuthFailure(key) {
  try {
    await authLimiter().consume(key, 1);
  } catch {
    // Already over the limit — nothing more to record.
  }
}
