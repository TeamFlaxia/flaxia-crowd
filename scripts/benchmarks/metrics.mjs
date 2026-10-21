export const BENCHMARK_METRICS = [
  'coldLoadMs',
  'warmPrepareMs',
  'ttftMs',
  'prefillMs',
  'decodeMs',
  'tokensPerSecond',
  'totalMs',
  'networkBytes',
  'peakMemoryBytes',
];

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(p) || p < 0 || p > 1) return null;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function isBenchmarkSample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1 || typeof value.runId !== 'string' || !value.runId ||
      !['completed', 'failed', 'unavailable'].includes(value.status) ||
      !['single', 'split'].includes(value.mode) ||
      typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) ||
      !value.scenario || typeof value.scenario.id !== 'string' ||
      !value.model || typeof value.model.id !== 'string' || typeof value.model.revision !== 'string' ||
      typeof value.model.quantization !== 'string' ||
      !value.environment || typeof value.environment.runtime !== 'string' ||
      typeof value.environment.runtimeVersion !== 'string' || typeof value.environment.os !== 'string' ||
      typeof value.environment.architecture !== 'string' || !value.environment.gpu ||
      !value.conditions || !Number.isInteger(value.conditions.warmups) || value.conditions.warmups < 0 ||
      !Number.isInteger(value.conditions.repeats) || value.conditions.repeats < 1 ||
      !Number.isInteger(value.conditions.inputTokens) || value.conditions.inputTokens < 0 ||
      !Number.isInteger(value.conditions.requestedOutputTokens) || value.conditions.requestedOutputTokens < 1 ||
      !value.metrics || typeof value.metrics !== 'object' || !value.metricSources ||
      typeof value.metricSources !== 'object' || !value.unavailableReasons ||
      typeof value.unavailableReasons !== 'object') return false;
  return BENCHMARK_METRICS.every((key) =>
    (value.metrics[key] === null || (typeof value.metrics[key] === 'number' && Number.isFinite(value.metrics[key]))) &&
    ['measured', 'estimated', 'unknown'].includes(value.metricSources[key])
  );
}

/** Linear interpolation over sorted observations; non-finite and null values are ignored. */
export function summarizeSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    if (!isBenchmarkSample(sample)) continue;
    const key = `${sample.mode}\u0000${sample.scenario.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  return [...groups.entries()].map(([key, rows]) => {
    const [mode, scenario] = key.split('\u0000');
    const failed = rows.filter((row) => row.status === 'failed').length;
    const unavailable = rows.filter((row) => row.status === 'unavailable').length;
    const metrics = {};
    for (const name of BENCHMARK_METRICS) {
      const values = rows.map((row) => row.metrics[name]).filter((value) => typeof value === 'number' && Number.isFinite(value));
      metrics[name] = {
        sampleCount: values.length,
        unavailableCount: rows.length - values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
      };
    }
    return {
      mode,
      scenario,
      sampleCount: rows.length,
      completedCount: rows.length - failed - unavailable,
      failureCount: failed,
      unavailableCount: unavailable,
      failureRate: rows.length === 0 ? null : failed / rows.length,
      metrics,
    };
  });
}

export function parseJsonLines(text) {
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isBenchmarkSample(row)) throw new Error(`invalid benchmark sample on line ${index + 1}`);
    rows.push(row);
  }
  return rows;
}
