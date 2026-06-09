// Infrastructure read paths — Health (LB probe), Me (actor snapshot).

import { ping as pingDb } from '../../db.js';
import { isRedisReady, getRedis } from '../../cache/redis.js';

async function Health() {
  let dbOk = false;
  let redisOk = false;
  try { dbOk = await pingDb(); } catch {}
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
