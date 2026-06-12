// Louagi backend entry point.
//
// Single protocol: POST /graphql. Health checks, account ops, and admin
// metrics are GraphQL operations (Health, Me, ExportMyData, DeleteMyAccount,
// AdminMetrics). Supabase Postgres is the durable store.

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';

import { config } from './config.js';
import { graphqlRouter } from './routes/graphql.js';
import { notFound, errorHandler } from './middleware/error.js';
import { apiRateLimit, graphqlRateLimit } from './middleware/rateLimit.js';
import { initRedis, closeRedis } from './cache/redis.js';
import { sql } from './db.js';
import { queries as infraQueries } from './cqrs/queries/infra.js';

const app = express();

// Required for correct IP resolution when running behind AWS ALB / CloudFront
app.set('trust proxy', 1);

// Security headers. CSP is disabled (JSON-only API, no HTML to protect);
// HSTS tells clients to pin HTTPS for a year once they've seen it.
app.use(
  helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  })
);

// Behind the TLS-terminating proxy, refuse any request that arrived over
// plain HTTP in production — tokens must never transit unencrypted.
if (config.env === 'production') {
  app.use((req, res, next) => {
    if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
    return res.status(403).json({ ok: false, error: 'HTTPS required' });
  });
}

app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  })
);
// Gzip responses above 1 KB — GraphQL list payloads (rides, payments, audit)
// compress 5-10x, which dominates round-trip time on mobile networks.
app.use(compression({ threshold: 1024 }));
app.use(apiRateLimit);
app.use('/graphql', graphqlRateLimit);
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (req, res) => {
  try {
    const status = await infraQueries.Health();
    res.status(status.ok ? 200 : 500).json(status);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(graphqlRouter);

app.use(notFound);
app.use(errorHandler);

initRedis();

// Periodically expire stale seat_locks rows (10-min TTL inside the table; this
// is the housekeeping that actually deletes them). Uses the SECURITY DEFINER
// function added in 20260609000000_latency_and_correctness_fixes.sql.
const SEAT_LOCK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const seatLockCleanup = setInterval(async () => {
  try {
    await sql`select public.cleanup_expired_seat_locks()`;
  } catch (err) {
    console.error('[seat-locks] cleanup failed:', err.message);
  }
}, SEAT_LOCK_CLEANUP_INTERVAL_MS);
seatLockCleanup.unref();

const server = app.listen(config.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://0.0.0.0:${config.port} (${config.env})`);
});

async function shutdown() {
  console.log('[server] Shutting down gracefully...');
  clearInterval(seatLockCleanup);
  server.close(async () => {
    await closeRedis();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
