import type { GpuProbeStatus, SwarmNodeCapabilities } from '@flaxia/sdk';

const COMPUTE_SAMPLES = 3;
const COMPUTE_TIMEOUT_MS = 750;
const GPU_SETUP_TIMEOUT_MS = 1_500;
const GPU_RESOURCE_TTL_MS = 10 * 60 * 1000;

interface GpuAdapterInfo {
  vendor?: string;
  architecture?: string;
}

interface GpuAdapterLimits {
  maxStorageBufferBindingSize?: number;
}

interface GpuQueue {
  submit(commands: unknown[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface GpuCommandEncoder {
  beginComputePass(): {
    setPipeline(pipeline: unknown): void;
    dispatchWorkgroups(count?: number): void;
    end(): void;
  };
  finish(): unknown;
}

interface GpuDevice {
  queue: GpuQueue;
  lost: Promise<unknown>;
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipeline(descriptor: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): unknown;
  createCommandEncoder(): GpuCommandEncoder;
  destroy(): void;
}

interface GpuAdapter {
  info?: GpuAdapterInfo;
  limits?: GpuAdapterLimits;
  requestDevice(): Promise<GpuDevice>;
}

interface Gpu {
  requestAdapter(options?: unknown): Promise<GpuAdapter | null>;
}

type TimedResult<T> = { value: T; timedOut: false } | { value: null; timedOut: true };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedResult<T>>((resolve) => {
    timeoutId = setTimeout(() => resolve({ value: null, timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value): TimedResult<T> => ({ value, timedOut: false })),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export interface WebGpuProbeResult {
  capabilities: SwarmNodeCapabilities;
  status: GpuProbeStatus;
  sampledAt: number;
  expiresAt: number;
  architecture: string | null;
  maxStorageBufferBindingSize: number | null;
  computeCompletionMs: number | null;
  sampleCount: number;
}

function unknownResult(status: GpuProbeStatus, now = Date.now()): WebGpuProbeResult {
  return {
    capabilities: { webgpu: false },
    status,
    sampledAt: now,
    expiresAt: now + GPU_RESOURCE_TTL_MS,
    architecture: null,
    maxStorageBufferBindingSize: null,
    computeCompletionMs: null,
    sampleCount: 0,
  };
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

async function waitForGpuWork(device: GpuDevice): Promise<'complete' | 'timeout' | 'lost'> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), COMPUTE_TIMEOUT_MS);
  });
  const work = device.queue.onSubmittedWorkDone().then(() => 'complete' as const);
  const lost = device.lost.then(() => 'lost' as const, () => 'lost' as const);
  try {
    return await Promise.race([work, lost, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Request a device and time three tiny no-buffer compute submissions. This is
 * a scheduling hint, not a benchmark: it allocates no model-sized resources,
 * has a per-sample timeout, and destroys the temporary device in all cases.
 */
export async function probeWebGpuDetailed(): Promise<WebGpuProbeResult> {
  const now = Date.now();
  const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return unknownResult('unsupported', now);

  let device: GpuDevice | null = null;
  try {
    const adapterResult = await withTimeout(
      gpu.requestAdapter({ powerPreference: 'high-performance' }),
      GPU_SETUP_TIMEOUT_MS,
    );
    if (adapterResult.timedOut) return unknownResult('unavailable', Date.now());
    const adapter = adapterResult.value;
    if (!adapter) return unknownResult('unsupported', now);

    const maxBuffer = adapter.limits?.maxStorageBufferBindingSize;
    const rawArchitecture = [adapter.info?.vendor, adapter.info?.architecture]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' ')
      .trim()
      .slice(0, 64);
    const maxStorageBufferBindingSize =
      typeof maxBuffer === 'number' && Number.isFinite(maxBuffer) && maxBuffer > 0
        ? Math.min(Math.floor(maxBuffer), 16 * 1024 ** 3)
        : null;
    const deviceRequest = adapter.requestDevice();
    const deviceResult = await withTimeout(deviceRequest, GPU_SETUP_TIMEOUT_MS);
    if (deviceResult.timedOut) {
      // If the browser completes the allocation after our deadline, release
      // the late device instead of leaving an unobserved GPU resource alive.
      void deviceRequest.then((lateDevice) => lateDevice.destroy()).catch(() => {});
      return unknownResult('unavailable', Date.now());
    }
    device = deviceResult.value;
    const activeDevice = device;
    const pipeline = activeDevice.createComputePipeline({
      layout: 'auto',
      compute: {
        module: activeDevice.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' }),
        entryPoint: 'main',
      },
    });

    const durations: number[] = [];
    for (let i = 0; i < COMPUTE_SAMPLES; i++) {
      const encoder = activeDevice.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.dispatchWorkgroups(1);
      pass.end();
      const commands = encoder.finish();
      const startedAt = nowMs();
      activeDevice.queue.submit([commands]);
      const completion = await waitForGpuWork(activeDevice);
      if (completion === 'lost') {
        return unknownResult('device-lost', Date.now());
      }
      if (completion === 'timeout') {
        return unknownResult('unavailable', Date.now());
      }
      durations.push(Math.max(0, nowMs() - startedAt));
    }

    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const capabilities: SwarmNodeCapabilities = { webgpu: true };
    if (rawArchitecture) capabilities.gpuArchitecture = rawArchitecture;
    if (maxStorageBufferBindingSize !== null) {
      capabilities.maxStorageBufferBindingSize = maxStorageBufferBindingSize;
    }
    return {
      capabilities,
      status: 'available',
      sampledAt: Date.now(),
      expiresAt: Date.now() + GPU_RESOURCE_TTL_MS,
      architecture: rawArchitecture || null,
      maxStorageBufferBindingSize,
      computeCompletionMs: median,
      sampleCount: durations.length,
    };
  } catch {
    return unknownResult('unavailable', Date.now());
  } finally {
    try { device?.destroy(); } catch {}
  }
}

/** Backwards-compatible capability probe; eligibility requires a working device. */
export async function probeWebGpu(): Promise<SwarmNodeCapabilities> {
  return (await probeWebGpuDetailed()).capabilities;
}
