import { test } from 'node:test';
import assert from 'node:assert';

// dotenv never overrides vars that are already set, so these win over server/.env.
process.env.RATE_LIMIT_MAX = '3';
process.env.GRAPHQL_RATE_LIMIT_MAX = '2';
process.env.RATE_LIMIT_WINDOW_MS = '1000';
process.env.DATABASE_URL ||= 'postgres://test';
process.env.APP_JWT_SECRET ||= 'test';

const { apiRateLimit, graphqlRateLimit } = await import('./rateLimit.js');

// Runs the middlewares in order like Express; returns the status (200 if all pass).
async function hit(ip, path, ...middlewares) {
  let status = 0;
  const res = { status: (s) => ((status = s), res), json: () => res };
  for (const mw of middlewares) {
    let passed = false;
    await mw({ ip, path }, res, () => (passed = true));
    if (!passed) return status;
  }
  return 200;
}

test('a /graphql request costs one point from each budget, not two from one', async () => {
  const gql = () => hit('10.0.0.1', '/', apiRateLimit, graphqlRateLimit);
  assert.strictEqual(await gql(), 200);
  assert.strictEqual(await gql(), 200);
  assert.strictEqual(await gql(), 429); // GRAPHQL_RATE_LIMIT_MAX = 2
});

test('non-GraphQL routes use RATE_LIMIT_MAX; /health is never limited', async () => {
  const api = () => hit('10.0.0.2', '/other', apiRateLimit);
  for (let i = 0; i < 3; i++) assert.strictEqual(await api(), 200);
  assert.strictEqual(await api(), 429); // RATE_LIMIT_MAX = 3
  assert.strictEqual(await hit('10.0.0.2', '/health', apiRateLimit), 200);
});
