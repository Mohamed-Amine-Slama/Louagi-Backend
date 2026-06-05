// Louagi backend entry point.
//
// Speaks the envelope documented in docs/backend-contract.md. Auth and
// business logic are served through POST /graphql; Supabase Postgres is the
// durable store.

import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { graphqlRouter } from './routes/graphql.js';
import { notFound, errorHandler } from './middleware/error.js';
import { apiRateLimit, graphqlRateLimit } from './middleware/rateLimit.js';
import { initRedis, closeRedis } from './cache/redis.js';

const app = express();

// Required for correct IP resolution when running behind AWS ALB / CloudFront
app.set('trust proxy', 1);

app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  })
);
app.use(apiRateLimit);
app.use('/graphql', graphqlRateLimit);
app.use(express.json({ limit: '1mb' }));

app.use(healthRouter);
app.use(meRouter);
app.use(graphqlRouter);

app.use(notFound);
app.use(errorHandler);

initRedis();

const server = app.listen(config.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://0.0.0.0:${config.port} (${config.env})`);
});

async function shutdown() {
  console.log('[server] Shutting down gracefully...');
  server.close(async () => {
    await closeRedis();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
