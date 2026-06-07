// Added by resilience agent — 2026-06-05
//
// Retry wrapper with exponential backoff + jitter for transient Postgres errors.
// Designed for postgres-js which throws errors (not the supabase-js { data, error } pattern).

/**
 * Postgres error codes considered safe to retry.
 *
 * - 08006 / 08001: connection failure / inability to establish
 * - 57P01: admin shutdown (e.g. PgBouncer recycling)
 * - 40001: serialization failure (concurrent transactions)
 * - 40P01: deadlock detected
 * - 53300: too many connections
 */
const RETRYABLE_CODES = new Set([
  '08006',
  '08001',
  '57P01',
  '40001',
  '40P01',
  '53300',
]);

/**
 * @template T
 * @param {() => Promise<T>} fn — async function to execute
 * @param {{ retries?: number, baseDelay?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const { retries = 3, baseDelay = 300, label = 'query' } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code ?? '';
      const isRetryable = RETRYABLE_CODES.has(code);

      if (!isRetryable || attempt === retries) {
        console.error(
          `[withRetry] ${label} failed after ${attempt} attempt(s):`,
          { code, message: /** @type {Error} */ (err).message }
        );
        throw err;
      }

      const delay = baseDelay * 2 ** (attempt - 1) + Math.random() * 100;
      console.warn(
        `[withRetry] ${label} attempt ${attempt} failed (code=${code}), retrying in ${Math.round(delay)}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable, but satisfies type-checkers
  throw new Error(`[withRetry] ${label}: max retries exceeded`);
}
