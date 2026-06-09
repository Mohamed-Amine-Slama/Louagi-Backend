// Latency middleware. Records per-operation timings into the shared latency
// histogram so AdminMetrics keeps working post-refactor.

import { performance } from 'node:perf_hooks';
import { recordLatency } from '../../lib/latency.js';

export function latencyMiddleware() {
  return async ({ name }, next) => {
    const start = performance.now();
    try {
      return await next();
    } finally {
      recordLatency(name, performance.now() - start);
    }
  };
}
