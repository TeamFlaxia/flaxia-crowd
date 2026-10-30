import test from 'node:test';
import assert from 'node:assert/strict';
import { generationMetrics, parseJsonLines, percentile, summarizeSamples } from './metrics.mjs';

function sample(id, mode, status, ttft, scenario = 'baseline', expectedOutcome = status, repeatIndex = 0) {
  const cluster = mode === 'single'
    ? { transport: 'in-process-simulation', nodeCount: 1, nodes: [{ role: 'host', layerStart: 0, layerEnd: 8 }] }
    : { transport: 'in-process-simulation', nodeCount: 2, nodes: [
      { role: 'host', layerStart: 0, layerEnd: 4 },
      { role: 'worker', layerStart: 4, layerEnd: 8 },
    ] };
  return {
    schemaVersion: 2,
    runId: 'run-1',
    sampleId: id,
    timestamp: '2026-10-21T00:00:00.000Z',
    status,
    expectedOutcome,
    mode,
    scenario: {
      id: scenario,
      latencyMs: 0,
      bandwidthMbps: null,
      dropAfterTokens: scenario === 'node-loss' ? 4 : null,
      memoryBudgetMiB: scenario === 'low-memory' ? 1 : null,
      estimatedMinimumBytes: 2048,
    },
    model: { id: 'synthetic', revision: 'r1', quantization: 'synthetic' },
    cluster,
    environment: {
      runtime: 'node', runtimeVersion: 'v22', os: 'linux', architecture: 'x64',
      browser: null, browserVersion: null, codeRevision: 'test-sha',
      gpu: { vendor: null, architecture: null, device: null },
    },
    conditions: {
      warmups: 1, repeats: 3, repeatIndex, inputTokens: 8, requestedOutputTokens: 4,
      actualOutputTokens: status === 'completed' ? 4 : null, promptId: 'fixture-v1', sampling: 'greedy',
      topology: mode === 'single' ? 'one-node' : 'two-node-layer-split',
    },
    metrics: {
      coldLoadMs: null,
      warmPrepareMs: null,
      ttftMs: ttft,
      prefillMs: ttft === null ? null : ttft * 0.8,
      decodeMs: 100,
      tokensPerSecond: 20,
      totalMs: 250,
      networkBytes: 32,
      peakMemoryBytes: null,
    },
    metricSources: {
      coldLoadMs: 'unknown', warmPrepareMs: 'unknown', ttftMs: 'measured', prefillMs: 'measured',
      decodeMs: 'measured', tokensPerSecond: 'measured', totalMs: 'measured', networkBytes: 'estimated',
      peakMemoryBytes: 'unknown',
    },
    unavailableReasons: { peakMemoryBytes: 'runtime does not expose GPU memory' },
  };
}

test('percentile uses linear interpolation and ignores non-finite observations', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, Number.NaN, 3], 0.5), 2);
  assert.equal(percentile([], 0.5), null);
});

test('generation timing separates prefill, first-token latency, decode and total time', () => {
  assert.deepEqual(generationMetrics({
    startedAt: 100,
    prefillDoneAt: 180,
    firstTokenAt: 200,
    finishedAt: 350,
    actualOutputTokens: 4,
  }), {
    ttftMs: 100,
    prefillMs: 80,
    decodeMs: 150,
    tokensPerSecond: 20,
    totalMs: 250,
  });
  assert.equal(generationMetrics({
    startedAt: 0, prefillDoneAt: 5, firstTokenAt: 5, finishedAt: 5, actualOutputTokens: 1,
  }).tokensPerSecond, null);
  assert.throws(() => generationMetrics({
    startedAt: 2, prefillDoneAt: 1, firstTokenAt: 3, finishedAt: 4, actualOutputTokens: 1,
  }), /timestamps must be finite and ordered/);
});

test('summary groups by topology and scenario and reports failures/unavailable metrics', () => {
  const groups = summarizeSamples([
    sample('a', 'single', 'completed', 100),
    sample('b', 'single', 'completed', 300),
    sample('c', 'single', 'failed', null, 'baseline', 'completed'),
    sample('d', 'split', 'unavailable', null, 'low-memory'),
  ]);
  const baseline = groups.find((group) => group.mode === 'single' && group.scenario === 'baseline');
  assert.equal(baseline.sampleCount, 3);
  assert.equal(baseline.failureCount, 1);
  assert.equal(baseline.expectedFailureCount, 0);
  assert.equal(baseline.unexpectedFailureCount, 1);
  assert.equal(baseline.failureRate, 1 / 3);
  assert.equal(baseline.unexpectedFailureRate, 1 / 3);
  assert.equal(baseline.metrics.ttftMs.p50, 200);
  assert.equal(baseline.metrics.ttftMs.p95, 290);
  assert.equal(baseline.metrics.peakMemoryBytes.unavailableCount, 3);
  const lowMemory = groups.find((group) => group.scenario === 'low-memory');
  assert.equal(lowMemory.unavailableCount, 1);
  assert.equal(lowMemory.unavailableRate, 1);
});

test('summary separates expected injected node loss from unexpected failures', () => {
  const groups = summarizeSamples([
    sample('loss-0', 'split', 'failed', null, 'node-loss', 'failed'),
    sample('loss-1', 'split', 'failed', null, 'node-loss', 'failed', 1),
    sample('loss-2', 'split', 'failed', null, 'node-loss', 'completed', 2),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].failureCount, 3);
  assert.equal(groups[0].expectedFailureCount, 2);
  assert.equal(groups[0].unexpectedFailureCount, 1);
  assert.equal(groups[0].outcomeMismatchCount, 1);
});

test('JSONL parser rejects malformed JSON and samples outside the result contract', () => {
  const valid = sample('valid', 'single', 'completed', 100);
  assert.equal(parseJsonLines(JSON.stringify(valid)).length, 1);
  const legacy = sample('legacy', 'single', 'failed', null, 'baseline', 'completed');
  legacy.schemaVersion = 1;
  delete legacy.sampleId;
  delete legacy.expectedOutcome;
  delete legacy.cluster;
  delete legacy.environment.browserVersion;
  delete legacy.environment.codeRevision;
  delete legacy.environment.gpu.device;
  delete legacy.conditions.repeatIndex;
  delete legacy.conditions.actualOutputTokens;
  delete legacy.conditions.promptId;
  delete legacy.conditions.sampling;
  assert.equal(parseJsonLines(JSON.stringify(legacy)).length, 1);
  assert.throws(() => parseJsonLines('{bad json}'), /invalid JSON on line 1/);
  assert.throws(() => parseJsonLines(JSON.stringify({ schemaVersion: 99 })), /invalid benchmark sample/);
  const invalidCluster = structuredClone(valid);
  invalidCluster.cluster.nodeCount = 2;
  assert.throws(() => parseJsonLines(JSON.stringify(invalidCluster)), /invalid benchmark sample/);
});


test('summary separates model, device, requested token count and scenario but combines repeat samples', () => {
  const original = sample('a', 'single', 'completed', 100);
  const rows = [original];
  for (const mutate of [
    (row) => { row.model.revision = 'r2'; },
    (row) => { row.environment.gpu.vendor = 'other'; },
    (row) => { row.conditions.requestedOutputTokens = 24; },
    (row) => { row.scenario.latencyMs = 80; },
    (row) => { row.cluster.transport = 'webrtc'; },
    (row) => { row.conditions.repeatIndex = 1; row.conditions.actualOutputTokens = 3; },
  ]) {
    const row = structuredClone(original);
    mutate(row);
    rows.push(row);
  }
  assert.equal(summarizeSamples(rows).length, 6);
});
