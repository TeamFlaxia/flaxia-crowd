import { describe, it, expect, afterEach } from 'vitest';
import { probeWebGpu } from '../webgpuProbe';

describe('probeWebGpu', () => {
  const gpuHost = navigator as unknown as { gpu?: unknown };
  const originalGpu = gpuHost.gpu;

  afterEach(() => {
    gpuHost.gpu = originalGpu;
  });

  it('reports no WebGPU when navigator.gpu is absent', async () => {
    delete gpuHost.gpu;
    expect(await probeWebGpu()).toEqual({ webgpu: false });
  });

  it('reports no WebGPU when no adapter is returned', async () => {
    gpuHost.gpu = { requestAdapter: async () => null };
    expect(await probeWebGpu()).toEqual({ webgpu: false });
  });

  it('reads architecture and buffer limits from the adapter', async () => {
    gpuHost.gpu = {
      requestAdapter: async () => ({
        info: { vendor: 'apple', architecture: 'm1' },
        limits: { maxStorageBufferBindingSize: 134217728 },
      }),
    };

    expect(await probeWebGpu()).toEqual({
      webgpu: true,
      gpuArchitecture: 'apple m1',
      maxStorageBufferBindingSize: 134217728,
    });
  });

  it('reports webgpu true even when adapter details are missing', async () => {
    gpuHost.gpu = { requestAdapter: async () => ({}) };
    expect(await probeWebGpu()).toEqual({ webgpu: true });
  });

  it('swallows requestAdapter failures', async () => {
    gpuHost.gpu = {
      requestAdapter: async () => {
        throw new Error('blocked by permissions policy');
      },
    };
    expect(await probeWebGpu()).toEqual({ webgpu: false });
  });
});
