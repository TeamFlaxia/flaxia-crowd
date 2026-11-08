import { describe, expect, it } from 'vitest';
import {
  evaluateMemoryBudget,
  MAX_RESOURCE_CAPACITY_BYTES,
  RESOURCE_GPU_TTL_MS,
  RESOURCE_REPORT_TTL_MS,
  validateNodeResourceReport,
} from '../resources';

const now = 1_800_000_000_000;

function metric(value: number | string | null, unit: string, source: string, ttl: number) {
  return {
    value,
    unit,
    source,
    sampledAt: now,
    expiresAt: now + ttl,
    sampleCount: value === null ? 0 : 1,
  };
}

function report() {
  return {
    version: 1,
    sampledAt: now,
    expiresAt: now + RESOURCE_REPORT_TTL_MS,
    cpuLoad: metric(0.25, 'ratio', 'estimated', RESOURCE_REPORT_TTL_MS),
    wasmMemoryLowerBound: metric(2 * 1024 ** 3, 'bytes', 'measured', 24 * 60 * 60 * 1000),
    deviceMemory: metric(8, 'GiB', 'estimated', 24 * 60 * 60 * 1000),
    gpu: {
      status: 'available',
      sampledAt: now,
      expiresAt: now + RESOURCE_GPU_TTL_MS,
      architecture: metric('test-gpu', 'text', 'measured', RESOURCE_GPU_TTL_MS),
      maxStorageBufferBindingSize: metric(128 * 1024 ** 2, 'bytes', 'measured', RESOURCE_GPU_TTL_MS),
      computeCompletionMs: metric(2.4, 'ms', 'measured', RESOURCE_GPU_TTL_MS),
      // The browser does not expose total VRAM; don't turn that absence into 0.
      memoryBytes: metric(null, 'bytes', 'unknown', RESOURCE_GPU_TTL_MS),
    },
  };
}

describe('node resource telemetry', () => {
  it('keeps measured, estimated and unknown metrics distinct', () => {
    const parsed = validateNodeResourceReport(report(), now);
    expect(parsed?.cpuLoad.source).toBe('estimated');
    expect(parsed?.wasmMemoryLowerBound.source).toBe('measured');
    expect(parsed?.gpu.memoryBytes).toMatchObject({ value: null, source: 'unknown', sampleCount: 0 });
  });

  it('rejects expired, oversized, malformed and falsely known metrics', () => {
    const stale = report();
    stale.expiresAt = now;
    expect(validateNodeResourceReport(stale, now)).toBeNull();

    const oversized = report();
    oversized.wasmMemoryLowerBound.value = MAX_RESOURCE_CAPACITY_BYTES + 1;
    expect(validateNodeResourceReport(oversized, now)).toBeNull();

    const falseZero = report();
    falseZero.gpu.memoryBytes = metric(0, 'bytes', 'measured', RESOURCE_GPU_TTL_MS);
    expect(validateNodeResourceReport(falseZero, now)).toBeNull();
  });
});

describe('memory budget', () => {
  it('includes model, activation, KV, reserved and safety margin bytes', () => {
    expect(evaluateMemoryBudget({
      availableBytes: 1_000,
      modelBytes: 400,
      activationBytes: 100,
      kvCacheBytes: 200,
      reservedBytes: 100,
      safetyMarginBytes: 200,
    })).toEqual({
      fits: true,
      requiredBytes: 1_000,
      availableBytes: 1_000,
      missing: [],
    });
  });

  it('rejects a budget that does not fit and returns unknown when any input is unknown', () => {
    expect(evaluateMemoryBudget({
      availableBytes: 999,
      modelBytes: 400,
      activationBytes: 100,
      kvCacheBytes: 200,
      reservedBytes: 100,
      safetyMarginBytes: 200,
    }).fits).toBe(false);

    const unknown = evaluateMemoryBudget({
      availableBytes: null,
      modelBytes: 400,
      activationBytes: 100,
      kvCacheBytes: 200,
      reservedBytes: 100,
      safetyMarginBytes: 0,
    });
    expect(unknown.fits).toBeNull();
    expect(unknown.missing).toContain('availableBytes');
  });
});
