// In-memory per-operation latency histogram. Shared by the GraphQL dispatcher
// (which records samples) and the AdminMetrics resolver (which reads them).
// Lives outside routes/ to avoid a circular import between resolvers and the
// route module.

const latencyBuckets = new Map();
const MAX_SAMPLES = 5000;

export function recordLatency(operationName, ms) {
  if (!latencyBuckets.has(operationName)) latencyBuckets.set(operationName, []);
  const bucket = latencyBuckets.get(operationName);
  bucket.push(ms);
  if (bucket.length > MAX_SAMPLES) bucket.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getLatencyReport() {
  const report = {};
  for (const [op, samples] of latencyBuckets) {
    if (!samples.length) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    report[op] = {
      count: samples.length,
      min: sorted[0],
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
      avg: samples.reduce((a, b) => a + b, 0) / samples.length,
    };
  }
  return report;
}
