import type { NodeResourceReport, ResourceMetric } from '@flaxia/sdk';
import { RESOURCE_GPU_TTL_MS, RESOURCE_REPORT_TTL_MS, RESOURCE_WASM_TTL_MS } from '@flaxia/sdk';
import { getWasmMemoryProbeObservation } from './memoryProbe';
import { probeWebGpuDetailed, type WebGpuProbeResult } from './webgpuProbe';

let cachedGpuProbe: WebGpuProbeResult | null = null;
let pendingGpuProbe: Promise<WebGpuProbeResult> | null = null;

function metric<T extends number | string>(
  value: T | null,
  unit: ResourceMetric<T>['unit'],
  source: ResourceMetric<T>['source'],
  sampledAt: number,
  expiresAt: number,
  sampleCount: number,
): ResourceMetric<T> {
  return { value, unit, source, sampledAt, expiresAt, sampleCount };
}

function unknownMetric<T extends number | string>(unit: ResourceMetric<T>['unit'], now: number, ttl: number) {
  return metric<T>(null, unit, 'unknown', now, now + ttl, 0);
}

async function getGpuProbe(includeGpuProbe: boolean, now: number): Promise<WebGpuProbeResult | null> {
  if (!includeGpuProbe) return null;
  if (!cachedGpuProbe || cachedGpuProbe.expiresAt <= now) {
    if (!pendingGpuProbe) {
      pendingGpuProbe = probeWebGpuDetailed().then((result) => {
        cachedGpuProbe = result;
        return result;
      }).finally(() => {
        pendingGpuProbe = null;
      });
    }
    cachedGpuProbe = await pendingGpuProbe;
  }
  return cachedGpuProbe;
}

/**
 * Collect current resource telemetry for an already-consented signaling
 * session. The 2 GiB WASM lower-bound probe remains one-shot; the tiny GPU
 * compute sample refreshes only after its ten minute TTL.
 */
export async function collectNodeResourceReport(options: {
  cpuLoad?: number | null;
  deviceMemory?: number;
  probeGpu?: boolean;
  now?: number;
}): Promise<NodeResourceReport> {
  const now = options.now ?? Date.now();
  const expiresAt = now + RESOURCE_REPORT_TTL_MS;
  const wasmObservation = getWasmMemoryProbeObservation();
  const wasmIsFresh = wasmObservation.bytes !== null && wasmObservation.sampledAt !== null &&
    now - wasmObservation.sampledAt <= RESOURCE_WASM_TTL_MS;
  const deviceMemoryIsUsable = Number.isFinite(options.deviceMemory) &&
    (options.deviceMemory as number) > 0 && (options.deviceMemory as number) <= 1024;

  const gpu = await getGpuProbe(options.probeGpu === true, now);
  const gpuSampledAt = gpu?.sampledAt ?? now;
  const gpuExpiresAt = gpu?.expiresAt ?? now + RESOURCE_GPU_TTL_MS;

  return {
    version: 1,
    sampledAt: now,
    expiresAt,
    cpuLoad: typeof options.cpuLoad === 'number' && Number.isFinite(options.cpuLoad) && options.cpuLoad >= 0 && options.cpuLoad <= 1
      ? metric(options.cpuLoad, 'ratio', 'estimated', now, expiresAt, 1)
      : unknownMetric('ratio', now, RESOURCE_REPORT_TTL_MS),
    wasmMemoryLowerBound: wasmIsFresh
      ? metric(wasmObservation.bytes, 'bytes', 'measured', wasmObservation.sampledAt!,
        wasmObservation.sampledAt! + RESOURCE_WASM_TTL_MS, 1)
      : unknownMetric('bytes', now, RESOURCE_WASM_TTL_MS),
    deviceMemory: deviceMemoryIsUsable
      ? metric(options.deviceMemory!, 'GiB', 'estimated', now, now + RESOURCE_WASM_TTL_MS, 1)
      : unknownMetric('GiB', now, RESOURCE_WASM_TTL_MS),
    gpu: {
      status: gpu?.status ?? 'unknown',
      sampledAt: gpuSampledAt,
      expiresAt: gpuExpiresAt,
      architecture: gpu?.architecture
        ? metric(gpu.architecture, 'text', 'measured', gpuSampledAt, gpuExpiresAt, 1)
        : unknownMetric('text', gpuSampledAt, RESOURCE_GPU_TTL_MS),
      maxStorageBufferBindingSize: gpu?.maxStorageBufferBindingSize !== null && gpu?.maxStorageBufferBindingSize !== undefined
        ? metric(gpu.maxStorageBufferBindingSize, 'bytes', 'measured', gpuSampledAt, gpuExpiresAt, 1)
        : unknownMetric('bytes', gpuSampledAt, RESOURCE_GPU_TTL_MS),
      computeCompletionMs: gpu?.computeCompletionMs !== null && gpu?.computeCompletionMs !== undefined
        ? metric(gpu.computeCompletionMs, 'ms', 'measured', gpuSampledAt, gpuExpiresAt, gpu.sampleCount)
        : unknownMetric('ms', gpuSampledAt, RESOURCE_GPU_TTL_MS),
      memoryBytes: unknownMetric('bytes', gpuSampledAt, RESOURCE_GPU_TTL_MS),
    },
  };
}

/** Clear the GPU result cache in isolated probe tests. */
export function resetNodeResourceReportCache(): void {
  cachedGpuProbe = null;
  pendingGpuProbe = null;
}
