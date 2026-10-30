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

export const BENCHMARK_SCHEMA_VERSION = 2;

/** Derive generation timings from monotonic timestamps shared by every runner. */
export function generationMetrics({ startedAt, prefillDoneAt, firstTokenAt, finishedAt, actualOutputTokens }) {
  const times = [startedAt, prefillDoneAt, firstTokenAt, finishedAt];
  if (!times.every(Number.isFinite) || times.some((time, index) => index > 0 && time < times[index - 1])) {
    throw new RangeError('benchmark timestamps must be finite and ordered');
  }
  if (!Number.isInteger(actualOutputTokens) || actualOutputTokens < 0) {
    throw new RangeError('actualOutputTokens must be a non-negative integer');
  }
  const ttftMs = firstTokenAt - startedAt;
  const prefillMs = prefillDoneAt - startedAt;
  const decodeMs = finishedAt - firstTokenAt;
  return {
    ttftMs,
    prefillMs,
    decodeMs,
    tokensPerSecond: decodeMs > 0 && actualOutputTokens > 1
      ? (actualOutputTokens - 1) * 1000 / decodeMs
      : null,
    totalMs: finishedAt - startedAt,
  };
}

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

function isLegacyBenchmarkSample(value) {
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

export function isBenchmarkSample(value) {
  if (value?.schemaVersion === 1) return isLegacyBenchmarkSample(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== BENCHMARK_SCHEMA_VERSION || typeof value.runId !== 'string' || !value.runId ||
      typeof value.sampleId !== 'string' || !value.sampleId ||
      !['completed', 'failed', 'unavailable'].includes(value.status) ||
      !['completed', 'failed', 'unavailable'].includes(value.expectedOutcome) ||
      !['single', 'split'].includes(value.mode) ||
      typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) ||
      !value.scenario || typeof value.scenario.id !== 'string' ||
      !value.model || typeof value.model.id !== 'string' || typeof value.model.revision !== 'string' ||
      typeof value.model.quantization !== 'string' ||
      !value.cluster || !['in-process-simulation', 'webworker', 'webrtc', 'unknown'].includes(value.cluster.transport) ||
      !Number.isInteger(value.cluster.nodeCount) || value.cluster.nodeCount < 1 ||
      !Array.isArray(value.cluster.nodes) || value.cluster.nodes.length !== value.cluster.nodeCount ||
      !value.environment || typeof value.environment.runtime !== 'string' ||
      typeof value.environment.runtimeVersion !== 'string' || typeof value.environment.os !== 'string' ||
      typeof value.environment.architecture !== 'string' ||
      !(typeof value.environment.browser === 'string' || value.environment.browser === null) ||
      !(typeof value.environment.browserVersion === 'string' || value.environment.browserVersion === null) ||
      !(typeof value.environment.codeRevision === 'string' || value.environment.codeRevision === null) ||
      !value.environment.gpu ||
      !(typeof value.environment.gpu.vendor === 'string' || value.environment.gpu.vendor === null) ||
      !(typeof value.environment.gpu.architecture === 'string' || value.environment.gpu.architecture === null) ||
      !(typeof value.environment.gpu.device === 'string' || value.environment.gpu.device === null) ||
      !value.conditions || !Number.isInteger(value.conditions.warmups) || value.conditions.warmups < 0 ||
      !Number.isInteger(value.conditions.repeats) || value.conditions.repeats < 1 ||
      !Number.isInteger(value.conditions.repeatIndex) || value.conditions.repeatIndex < 0 || value.conditions.repeatIndex >= value.conditions.repeats ||
      !Number.isInteger(value.conditions.inputTokens) || value.conditions.inputTokens < 0 ||
      !Number.isInteger(value.conditions.requestedOutputTokens) || value.conditions.requestedOutputTokens < 1 ||
      !(value.conditions.actualOutputTokens === null ||
        (Number.isInteger(value.conditions.actualOutputTokens) && value.conditions.actualOutputTokens >= 0)) ||
      typeof value.conditions.promptId !== 'string' || !value.conditions.promptId ||
      !['greedy', 'other'].includes(value.conditions.sampling) ||
      !['one-node', 'two-node-layer-split'].includes(value.conditions.topology) ||
      !value.metrics || typeof value.metrics !== 'object' || !value.metricSources ||
      typeof value.metricSources !== 'object' || !value.unavailableReasons ||
      typeof value.unavailableReasons !== 'object') return false;
  if (!value.cluster.nodes.every((node) => node && ['host', 'worker'].includes(node.role) &&
      Number.isInteger(node.layerStart) && node.layerStart >= 0 &&
      Number.isInteger(node.layerEnd) && node.layerEnd > node.layerStart)) return false;
  return BENCHMARK_METRICS.every((key) =>
    (value.metrics[key] === null || (typeof value.metrics[key] === 'number' && Number.isFinite(value.metrics[key]))) &&
    ['measured', 'estimated', 'unknown'].includes(value.metricSources[key])
  );
}

/** Linear interpolation over sorted observations; non-finite and null values are ignored. */
export function summarizeSamples(samples) {
  const groups = new Map();
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
    return value;
  };
  for (const sample of samples) {
    if (!isBenchmarkSample(sample)) continue;
    const { repeatIndex: _repeatIndex, actualOutputTokens: _actualOutputTokens, ...conditions } = sample.conditions;
    const key = JSON.stringify(stable([sample.mode, sample.model, sample.environment, conditions, sample.cluster ?? null, sample.scenario]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  return [...groups.values()].map((rows) => {
    const { mode, model, environment } = rows[0];
    const cluster = rows[0].cluster ?? null;
    const { repeatIndex: _repeatIndex, actualOutputTokens: _actualOutputTokens, ...conditions } = rows[0].conditions;
    const scenario = rows[0].scenario.id;
    const failed = rows.filter((row) => row.status === 'failed').length;
    const unavailable = rows.filter((row) => row.status === 'unavailable').length;
    const expectedOutcome = (row) => row.expectedOutcome ?? (row.status === 'failed' ? 'completed' : row.status);
    const expectedFailures = rows.filter((row) => row.status === 'failed' && expectedOutcome(row) === 'failed').length;
    const unexpectedFailures = failed - expectedFailures;
    const outcomeMismatches = rows.filter((row) => row.status !== expectedOutcome(row)).length;
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
      scenarioSettings: rows[0].scenario,
      model,
      environment,
      conditions,
      cluster,
      sampleCount: rows.length,
      completedCount: rows.length - failed - unavailable,
      failureCount: failed,
      expectedFailureCount: expectedFailures,
      unexpectedFailureCount: unexpectedFailures,
      outcomeMismatchCount: outcomeMismatches,
      unavailableCount: unavailable,
      failureRate: rows.length === 0 ? null : failed / rows.length,
      unexpectedFailureRate: rows.length === unavailable ? null : unexpectedFailures / (rows.length - unavailable),
      unavailableRate: rows.length === 0 ? null : unavailable / rows.length,
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
