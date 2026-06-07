// Added by resilience agent — 2026-06-05
//
// Generic promise timeout wrapper. Rejects with a descriptive error if the
// wrapped promise does not settle within the given deadline.

/**
 * @template T
 * @param {Promise<T>} promise — the async operation to bound
 * @param {number} [ms=8000] — maximum allowed time in milliseconds
 * @param {string} [label='operation'] — human-readable label for error messages
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms = 8000, label = 'operation') {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timerId;

  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`)),
      ms
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
  });
}
