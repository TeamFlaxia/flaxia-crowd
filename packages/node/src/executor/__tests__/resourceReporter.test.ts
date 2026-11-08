import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_GPU_TTL_MS, validateNodeResourceReport } from '@flaxia/sdk';
import {
  resetWasmMemoryProbeCache,
  getWasmMemoryProbeRuns,
  probeMaxWasmMemoryBytes,
} from '../memoryProbe';
import { collectNodeResourceReport, resetNodeResourceReportCache } from '../resourceReporter';

describe('resourceReporter', () => {
  const gpuHost = navigator as unknown as { gpu?: unknown };
  const originalGpu = gpuHost.gpu;

  afterEach(() => {
    vi.useRealTimers();
    gpuHost.gpu = originalGpu;
    resetNodeResourceReportCache();
    resetWasmMemoryProbeCache();
  });

  it('labels device estimates, one-shot WASM measurements, and inaccessible VRAM distinctly', async () => {
    probeMaxWasmMemoryBytes(64 * 1024);
    const runs = getWasmMemoryProbeRuns();
    const report = await collectNodeResourceReport({ cpuLoad: 0.4, deviceMemory: 8, probeGpu: false });
    const next = await collectNodeResourceReport({ cpuLoad: null, deviceMemory: undefined, probeGpu: false });

    expect(report.cpuLoad).toMatchObject({ value: 0.4, source: 'estimated', unit: 'ratio' });
    expect(report.wasmMemoryLowerBound.source).toBe('measured');
    expect(report.deviceMemory).toMatchObject({ value: 8, source: 'estimated', unit: 'GiB' });
    expect(next.deviceMemory).toMatchObject({ value: null, source: 'unknown' });
    expect(next.cpuLoad).toMatchObject({ value: null, source: 'unknown' });
    expect(report.gpu).toMatchObject({ status: 'unknown', memoryBytes: { value: null, source: 'unknown' } });
    expect(validateNodeResourceReport(report)).not.toBeNull();
    expect(getWasmMemoryProbeRuns()).toBe(runs);
  });

  it('reuses the short-lived GPU sample across heartbeats', async () => {
    vi.useFakeTimers();
    const firstSampleAt = 1_800_000_000_000;
    vi.setSystemTime(firstSampleAt);
    const submit = vi.fn();
    const requestAdapter = vi.fn(async () => ({
      info: { vendor: 'test', architecture: 'tiny-gpu' },
      limits: { maxStorageBufferBindingSize: 1024 },
      requestDevice: async () => ({
        queue: { submit, onSubmittedWorkDone: async () => {} },
        lost: new Promise(() => {}),
        createShaderModule: () => ({}),
        createComputePipeline: () => ({}),
        createCommandEncoder: () => ({
          beginComputePass: () => ({ setPipeline: () => {}, dispatchWorkgroups: () => {}, end: () => {} }),
          finish: () => ({}),
        }),
        destroy: () => {},
      }),
    }));
    gpuHost.gpu = { requestAdapter };

    const first = await collectNodeResourceReport({ cpuLoad: 0, probeGpu: true });
    const second = await collectNodeResourceReport({ cpuLoad: 0, probeGpu: true });
    expect(first.gpu.status).toBe('available');
    expect(first.gpu.computeCompletionMs.source).toBe('measured');
    expect(first.gpu.memoryBytes).toMatchObject({ value: null, source: 'unknown' });
    expect(second.gpu.sampledAt).toBe(first.gpu.sampledAt);
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledTimes(3);

    vi.setSystemTime(firstSampleAt + RESOURCE_GPU_TTL_MS + 1);
    const refreshed = await collectNodeResourceReport({ cpuLoad: 0, probeGpu: true });
    expect(refreshed.gpu.sampledAt).toBeGreaterThan(first.gpu.sampledAt);
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(6);
  });
});
