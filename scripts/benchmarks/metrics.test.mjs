import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLines, percentile, summarizeSamples } from './metrics.mjs';

function sample(id, mode, status, ttft, scenario = 'baseline') {
  return {
    schemaVersion: 1,
    runId: id,
    timestamp: '2026-10-21T00:00:00.000Z',
    status,
    mode,
    scenario: { id: scenario },
    model: { id: 'synthetic', revision: 'r1', quantization: 'synthetic' },
    environment: {
      runtime: 'node', runtimeVersion: 'v22', os: 'linux', architecture: 'x64',
      browser: null, gpu: { vendor: null, architecture: null },
    },
    conditions: {
      warmups: 1, repeats: 3, inputTokens: 8, requestedOutputTokens: 4,
      topology: mode === 'single' ? 'one-node' : 'two-node-layer-split',
    },
    metrics: {
      coldLoadMs: null,
      warmPrepareMs: null,
      ttftMs: ttft,
      prefillMs: ttft,
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

test('summary groups by topology and scenario and reports failures/unavailable metrics', () => {
  const groups = summarizeSamples([
    sample('a', 'single', 'completed', 100),
    sample('b', 'single', 'completed', 300),
    sample('c', 'single', 'failed', null),
    sample('d', 'split', 'unavailable', null, 'low-memory'),
  ]);
  const baseline = groups.find((group) => group.mode === 'single' && group.scenario === 'baseline');
  assert.equal(baseline.sampleCount, 3);
  assert.equal(baseline.failureCount, 1);
  assert.equal(baseline.failureRate, 1 / 3);
  assert.equal(baseline.metrics.ttftMs.p50, 200);
  assert.equal(baseline.metrics.ttftMs.p95, 290);
  assert.equal(baseline.metrics.peakMemoryBytes.unavailableCount, 3);
  const lowMemory = groups.find((group) => group.scenario === 'low-memory');
  assert.equal(lowMemory.unavailableCount, 1);
});

test('JSONL parser rejects malformed JSON and samples outside the result contract', () => {
  assert.throws(() => parseJsonLines('{bad json}'), /invalid JSON on line 1/);
  assert.throws(() => parseJsonLines(JSON.stringify({ schemaVersion: 99 })), /invalid benchmark sample/);
});
