// Infrastructure read paths — Health (LB probe), Me (actor snapshot).

import { ping as pingDb } from '../../db.js';
import { isRedisReady, getRedis } from '../../cache/redis.js';

// Public probe shares one DB ping per second: a ping per request (~80/s at 500
// users) queued real queries behind it on the 10-connection pool.
let lastPing = null;
let lastPingAt = 0;
function pingDbShared() {
  if (Date.now() - lastPingAt > 1000) {
    lastPingAt = Date.now();
    lastPing = pingDb().catch(() => false);
  }
  return lastPing;
}

async function Health() {
  let dbOk = false;
  let redisOk = false;
  try { dbOk = await pingDbShared(); } catch {}
  if (isRedisReady()) {
    try { redisOk = (await getRedis().ping()) === 'PONG'; } catch {}
  }
  return { ok: dbOk, db: dbOk, redis: redisOk, time: new Date().toISOString() };
}

async function Me(_input, ctx) {
  return { ok: true, actor: ctx.actor };
}

export const queries = { Health, Me };

export const meta = {
  Health: { public: true },
};
