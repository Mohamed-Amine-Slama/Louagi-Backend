// Added by resilience agent — 2026-06-05
//
// Structured error logging for all Supabase / Postgres interactions.
// Outputs newline-delimited JSON so any log aggregator (Datadog, ELK,
// CloudWatch Logs Insights, etc.) can parse and alert on these events.

/**
 * @typedef {{ table?: string, operation?: string, userId?: string, durationMs?: number }} QueryMeta
 */

/**
 * Log a Supabase / Postgres error as structured JSON.
 *
 * @param {unknown} error
 * @param {QueryMeta} [meta]
 */
export function logSupabaseError(error, meta = {}) {
  const payload = {
    level: 'error',
    source: 'supabase',
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : JSON.stringify(error),
    code: /** @type {{ code?: string }} */ (error)?.code ?? undefined,
    ...meta,
  };

  console.error(JSON.stringify(payload));

  // Hook into your monitoring platform here:
  // Sentry.captureException(error, { extra: meta });
  // datadogLogs.logger.error('supabase_error', payload);
}

/**
 * Execute a query function with automatic error logging and duration tracking.
 *
 * Works with postgres-js (which throws on error) — the caller wraps their
 * tagged-template query in an arrow function.
 *
 * @template T
 * @param {() => Promise<T>} queryFn
 * @param {QueryMeta} [meta]
 * @returns {Promise<{ data: T, durationMs: number }>}
 */
export async function safeQuery(queryFn, meta = {}) {
  const start = Date.now();
  try {
    const data = await queryFn();
    const durationMs = Date.now() - start;
    return { data, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;
    logSupabaseError(error, { ...meta, durationMs });
    throw error;
  }
}
