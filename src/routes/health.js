import { Router } from 'express';
import { ping } from '../db.js';
import { getRedis, isRedisReady } from '../cache/redis.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  try {
    const dbOk = await ping();
    let redisOk = false;
    if (isRedisReady()) {
      const p = await getRedis().ping();
      redisOk = p === 'PONG';
    }
    res.json({ ok: true, db: dbOk, redis: redisOk, time: new Date().toISOString() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[health] dependency check failed:', err);
    res.status(500).json({ ok: false, error: 'Service dependency unavailable' });
  }
});
