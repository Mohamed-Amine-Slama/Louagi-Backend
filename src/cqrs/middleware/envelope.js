// Error envelope middleware. Converts thrown errors into the `{ ok, error }`
// shape commands return. Queries throw upward so the GraphQL layer can map them
// to GraphQL `errors` payloads.
//
// Why two behaviors? Commands historically return business-result envelopes
// (validation errors are `{ ok: false, errors }`, not exceptions). Queries
// return data directly; errors are exceptional and should bubble.

import { HttpError } from '../../graphql/helpers.js';

export function commandEnvelope() {
  return async ({ name, payload, ctx }, next) => {
    try {
      const result = await next();
      // Handler already returned an envelope — pass through.
      if (result && typeof result === 'object' && 'ok' in result) return result;
      // Handler returned a bare value — wrap.
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        // 401 must reach the transport layer so the client triggers refresh.
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error(`[command:${name}]`, err?.message || err);
      return { ok: false, error: err?.publicMessage || err?.message || 'Internal error' };
    }
  };
}

export function queryEnvelope() {
  return async ({ name }, next) => {
    try {
      return await next();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // eslint-disable-next-line no-console
      console.error(`[query:${name}]`, err?.message || err);
      throw err;
    }
  };
}
