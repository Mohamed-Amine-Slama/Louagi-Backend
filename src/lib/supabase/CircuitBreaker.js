// Added by resilience agent — 2026-06-05
//
// Circuit breaker pattern (CLOSED → OPEN → HALF_OPEN → CLOSED).
// Stops cascading failures when Supabase / Postgres is degraded by short-
// circuiting calls rather than letting them pile up and timeout.

/** @typedef {'CLOSED' | 'OPEN' | 'HALF_OPEN'} State */

export class CircuitBreaker {
  /** @type {number} */
  #failures = 0;

  /** @type {State} */
  #state = 'CLOSED';

  /** @type {number} */
  #nextAttempt = Date.now();

  /**
   * @param {number} [threshold=5] — consecutive failures before opening
   * @param {number} [recoveryMs=60_000] — ms to wait before a half-open probe
   */
  constructor(threshold = 5, recoveryMs = 60_000) {
    this.threshold = threshold;
    this.recoveryMs = recoveryMs;
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {string} [label='call']
   * @returns {Promise<T>}
   */
  async call(fn, label = 'call') {
    if (this.#state === 'OPEN') {
      if (Date.now() < this.#nextAttempt) {
        throw new Error(`[CircuitBreaker] Circuit OPEN — ${label} blocked`);
      }
      this.#state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (err) {
      this.#onFailure(label);
      throw err;
    }
  }

  #onSuccess() {
    this.#failures = 0;
    this.#state = 'CLOSED';
  }

  /** @param {string} label */
  #onFailure(label) {
    this.#failures++;
    console.error(`[CircuitBreaker] Failure #${this.#failures} on ${label}`);
    if (this.#failures >= this.threshold) {
      this.#state = 'OPEN';
      this.#nextAttempt = Date.now() + this.recoveryMs;
      console.error(
        `[CircuitBreaker] Circuit OPEN — will retry after ${this.recoveryMs}ms`
      );
    }
  }

  /** @returns {State} */
  getState() {
    return this.#state;
  }
}

// Singleton for the Supabase / Postgres connection
export const dbBreaker = new CircuitBreaker(5, 60_000);
