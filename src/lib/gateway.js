import { timingSafeEqual } from 'node:crypto';

// Did this request come through the admin API gateway Worker? It stamps
// x-louagi-gateway with the shared secret (infra/modules/api_gateway/worker.mjs).
// No secret configured = no gateway deployed (local dev), so everything passes.
export function viaAdminGateway(headerValue, secret) {
  if (!secret) return true;
  const got = Buffer.from(String(headerValue ?? ''));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}
