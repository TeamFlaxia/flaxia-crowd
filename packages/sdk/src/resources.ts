import type {
  MemoryBudgetInput,
  MemoryBudgetResult,
  NodeResourceReport,
  ResourceMetric,
} from './types';

export const RESOURCE_REPORT_TTL_MS = 90_000;
export const RESOURCE_REPORT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const RESOURCE_GPU_TTL_MS = 10 * 60 * 1000;
export const RESOURCE_WASM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RESOURCE_CAPACITY_BYTES = 16 * 1024 ** 3;

type MetricKey = 'cpuLoad' | 'wasmMemoryLowerBound' | 'deviceMemory' |
  'architecture' | 'maxStorageBufferBindingSize' | 'computeCompletionMs' | 'memoryBytes';

const METRIC_LIMITS: Record<MetricKey, { unit: string; max: number; ttl: number; text?: boolean }> = {
  cpuLoad: { unit: 'ratio', max: 1, ttl: RESOURCE_REPORT_TTL_MS },
  wasmMemoryLowerBound: { unit: 'bytes', max: MAX_RESOURCE_CAPACITY_BYTES, ttl: RESOURCE_WASM_TTL_MS },
  deviceMemory: { unit: 'GiB', max: 1024, ttl: RESOURCE_WASM_TTL_MS },
  architecture: { unit: 'text', max: 64, ttl: RESOURCE_GPU_TTL_MS, text: true },
  maxStorageBufferBindingSize: { unit: 'bytes', max: MAX_RESOURCE_CAPACITY_BYTES, ttl: RESOURCE_GPU_TTL_MS },
  computeCompletionMs: { unit: 'ms', max: 60_000, ttl: RESOURCE_GPU_TTL_MS },
  memoryBytes: { unit: 'bytes', max: MAX_RESOURCE_CAPACITY_BYTES, ttl: RESOURCE_GPU_TTL_MS },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateMetric<T extends number | string>(
  raw: unknown,
  key: MetricKey,
  now: number,
): ResourceMetric<T> | null {
  if (!isRecord(raw)) return null;
  const spec = METRIC_LIMITS[key];
  if (raw.unit !== spec.unit ||
      !['measured', 'estimated', 'unknown'].includes(String(raw.source)) ||
      typeof raw.sampledAt !== 'number' || !Number.isFinite(raw.sampledAt) ||
      typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) ||
      typeof raw.sampleCount !== 'number' || !Number.isInteger(raw.sampleCount) ||
      raw.sampleCount < 0 || raw.sampleCount > 5 ||
      raw.sampledAt > now + 60_000 || now - raw.sampledAt > RESOURCE_REPORT_MAX_TTL_MS ||
      raw.expiresAt <= now || raw.expiresAt <= raw.sampledAt ||
      raw.expiresAt - raw.sampledAt > spec.ttl) return null;

  const source = raw.source as ResourceMetric<T>['source'];
  const value = raw.value;
  if (value === null) {
    if (source !== 'unknown' || raw.sampleCount !== 0) return null;
    return raw as unknown as ResourceMetric<T>;
  }
  if (source === 'unknown' || raw.sampleCount < 1) return null;
  if (spec.text) {
    if (typeof value !== 'string' || !value.trim() || value.length > spec.max) return null;
  } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > spec.max) {
    return null;
  }
  return raw as unknown as ResourceMetric<T>;
}

/** Validate untrusted resource telemetry and reject expired or unbounded values. */
export function validateNodeResourceReport(value: unknown, now = Date.now()): NodeResourceReport | null {
  if (!isRecord(value) || value.version !== 1 ||
      typeof value.sampledAt !== 'number' || !Number.isFinite(value.sampledAt) ||
      typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) ||
      value.sampledAt > now + 60_000 || now - value.sampledAt > RESOURCE_REPORT_MAX_TTL_MS ||
      value.expiresAt <= now || value.expiresAt <= value.sampledAt ||
      value.expiresAt - value.sampledAt > RESOURCE_REPORT_TTL_MS ||
      !isRecord(value.gpu) ||
      !['available', 'unsupported', 'unavailable', 'device-lost', 'unknown'].includes(String(value.gpu.status)) ||
      typeof value.gpu.sampledAt !== 'number' || !Number.isFinite(value.gpu.sampledAt) ||
      typeof value.gpu.expiresAt !== 'number' || !Number.isFinite(value.gpu.expiresAt) ||
      value.gpu.sampledAt > now + 60_000 || now - value.gpu.sampledAt > RESOURCE_REPORT_MAX_TTL_MS ||
      value.gpu.expiresAt <= now || value.gpu.expiresAt <= value.gpu.sampledAt ||
      value.gpu.expiresAt - value.gpu.sampledAt > RESOURCE_GPU_TTL_MS) return null;

  const cpuLoad = validateMetric<number>(value.cpuLoad, 'cpuLoad', now);
  const wasmMemoryLowerBound = validateMetric<number>(value.wasmMemoryLowerBound, 'wasmMemoryLowerBound', now);
  const deviceMemory = validateMetric<number>(value.deviceMemory, 'deviceMemory', now);
  const architecture = validateMetric<string>(value.gpu.architecture, 'architecture', now);
  const maxStorageBufferBindingSize = validateMetric<number>(value.gpu.maxStorageBufferBindingSize, 'maxStorageBufferBindingSize', now);
  const computeCompletionMs = validateMetric<number>(value.gpu.computeCompletionMs, 'computeCompletionMs', now);
  const memoryBytes = validateMetric<number>(value.gpu.memoryBytes, 'memoryBytes', now);
  if (!cpuLoad || !wasmMemoryLowerBound || !deviceMemory || !architecture ||
      !maxStorageBufferBindingSize || !computeCompletionMs || !memoryBytes ||
      memoryBytes.value !== null) return null;

  return {
    version: 1,
    sampledAt: value.sampledAt,
    expiresAt: value.expiresAt,
    cpuLoad,
    wasmMemoryLowerBound,
    deviceMemory,
    gpu: {
      status: value.gpu.status as NodeResourceReport['gpu']['status'],
      sampledAt: value.gpu.sampledAt,
      expiresAt: value.gpu.expiresAt,
      architecture,
      maxStorageBufferBindingSize,
      computeCompletionMs,
      memoryBytes,
    },
  };
}

/** Return unknown (`fits: null`) unless every byte component is known. */
export function evaluateMemoryBudget(input: MemoryBudgetInput): MemoryBudgetResult {
  const keys = ['availableBytes', 'modelBytes', 'activationBytes', 'kvCacheBytes', 'reservedBytes', 'safetyMarginBytes'] as const;
  const missing = keys.filter((key) => {
    const value = input[key];
    return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
  });
  if (missing.length) {
    return { fits: null, requiredBytes: null, availableBytes: null, missing: [...missing] };
  }

  const safetyMargin = input.safetyMarginBytes!;
  if (!Number.isFinite(safetyMargin) || safetyMargin < 0) {
    return { fits: null, requiredBytes: null, availableBytes: input.availableBytes, missing: [] };
  }
  const requiredBytes = input.modelBytes! + input.activationBytes! + input.kvCacheBytes! +
    input.reservedBytes! + safetyMargin;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > Number.MAX_SAFE_INTEGER) {
    return { fits: null, requiredBytes: null, availableBytes: input.availableBytes, missing: [] };
  }
  return {
    fits: requiredBytes <= input.availableBytes!,
    requiredBytes,
    availableBytes: input.availableBytes,
    missing: [],
  };
}
