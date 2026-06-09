import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { getRedis, isRedisReady } from '../cache/redis.js';
import { config } from '../config.js';

const rateLimitResponse = {
  ok: false,
  error: 'Too many requests. Try again later.',
};

let limiterRedis = null;
let limiterMemory = null;

function initLimiters() {
  const points = config.graphqlRateLimitMax || 100;
  const duration = (config.rateLimitWindowMs || 60000) / 1000;
  
  limiterMemory = new RateLimiterMemory({
    keyPrefix: 'rl_mem',
    points,
    duration,
  });

  const redisClient = getRedis();
  if (redisClient) {
    limiterRedis = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rl_redis',
      points,
      duration,
      inmemoryBlockOnConsumed: points + 1,
    });
  }
}

export const graphqlRateLimit = async (req, res, next) => {
  if (!limiterMemory) initLimiters();
  const key = req.actor ? req.actor.id : req.ip;
  const limiter = isRedisReady() && limiterRedis ? limiterRedis : limiterMemory;
  try {
    await limiter.consume(key, 1);
    next();
  } catch {
    res.status(429).json(rateLimitResponse);
  }
};

export const apiRateLimit = async (req, res, next) => {
  if (req.path === '/health') return next();
  if (!limiterMemory) initLimiters();
  const key = req.ip;
  const limiter = isRedisReady() && limiterRedis ? limiterRedis : limiterMemory;
  try {
    await limiter.consume(key, 1);
    next();
  } catch {
    res.status(429).json(rateLimitResponse);
  }
};
