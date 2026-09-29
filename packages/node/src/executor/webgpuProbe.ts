import type { SwarmNodeCapabilities } from '@flaxia/sdk';

interface GpuAdapterInfo {
  vendor?: string;
  architecture?: string;
}

interface GpuAdapterLimits {
  maxStorageBufferBindingSize?: number;
}

interface GpuAdapter {
  info?: GpuAdapterInfo;
  limits?: GpuAdapterLimits;
}

interface Gpu {
  requestAdapter(options?: unknown): Promise<GpuAdapter | null>;
}

/**
 * Probe WebGPU support so the orchestrator can decide whether a node may take
 * part in `swarm-inference`. Never throws: any failure (no `navigator.gpu`,
 * adapter request rejected, blocked by permissions policy) is reported as
 * `{ webgpu: false }`.
 */
export async function probeWebGpu(): Promise<SwarmNodeCapabilities> {
  const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return { webgpu: false };
  }

  try {
    // `high-performance` prefers the discrete GPU on dual-GPU laptops, which is
    // the one worth routing multi-GB layer slices to.
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { webgpu: false };

    const capabilities: SwarmNodeCapabilities = { webgpu: true };

    const info = adapter.info;
    if (info) {
      const architecture = [info.vendor, info.architecture].filter(Boolean).join(' ').trim();
      if (architecture) capabilities.gpuArchitecture = architecture;
    }

    const maxBuffer = adapter.limits?.maxStorageBufferBindingSize;
    if (typeof maxBuffer === 'number' && Number.isFinite(maxBuffer)) {
      capabilities.maxStorageBufferBindingSize = maxBuffer;
    }

    return capabilities;
  } catch {
    return { webgpu: false };
  }
}
