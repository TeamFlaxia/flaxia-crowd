import { describe, it, expect, afterEach, vi } from 'vitest';
import { probeWebGpu, probeWebGpuDetailed } from '../webgpuProbe';

describe('probeWebGpu', () => {
  const gpuHost = navigator as unknown as { gpu?: unknown };
  const originalGpu = gpuHost.gpu;

  afterEach(() => {
    gpuHost.gpu = originalGpu;
    vi.restoreAllMocks();
  });

  function createDevice(options: { onSubmittedWorkDone?: () => Promise<void>; lost?: Promise<unknown> } = {}) {
    const submit = vi.fn();
    const destroy = vi.fn();
    const device = {
      queue: {
        submit,
        onSubmittedWorkDone: options.onSubmittedWorkDone ?? (async () => {}),
      },
      lost: options.lost ?? new Promise(() => {}),
      createShaderModule: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginComputePass: () => ({
          setPipeline: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn(),
        }),
        finish: () => ({}),
      })),
      destroy,
    };
    return { device, submit, destroy };
  }

  it('reports unsupported when navigator.gpu is absent', async () => {
    delete gpuHost.gpu;
    expect(await probeWebGpu()).toEqual({ webgpu: false });
    expect((await probeWebGpuDetailed()).status).toBe('unsupported');
  });

  it('reports unsupported when no adapter is returned', async () => {
    gpuHost.gpu = { requestAdapter: async () => null };
    expect((await probeWebGpuDetailed()).status).toBe('unsupported');
  });

  it('measures a bounded compute submission and reports adapter limits separately from VRAM', async () => {
    const { device, submit, destroy } = createDevice();
    gpuHost.gpu = {
      requestAdapter: async () => ({
        info: { vendor: 'apple', architecture: 'm1' },
        limits: { maxStorageBufferBindingSize: 134217728 },
        requestDevice: async () => device,
      }),
    };

    const result = await probeWebGpuDetailed();
    expect(result).toMatchObject({
      capabilities: {
        webgpu: true,
        gpuArchitecture: 'apple m1',
        maxStorageBufferBindingSize: 134217728,
      },
      status: 'available',
      architecture: 'apple m1',
      maxStorageBufferBindingSize: 134217728,
      sampleCount: 3,
    });
    expect(result.computeCompletionMs).toEqual(expect.any(Number));
    expect(submit).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not claim WebGPU capability when device creation fails', async () => {
    gpuHost.gpu = {
      requestAdapter: async () => ({ requestDevice: async () => { throw new Error('device denied'); } }),
    };
    expect(await probeWebGpu()).toEqual({ webgpu: false });
    expect((await probeWebGpuDetailed()).status).toBe('unavailable');
  });

  it('reports a GPU device loss during the probe distinctly', async () => {
    const { device, destroy } = createDevice({
      onSubmittedWorkDone: () => new Promise(() => {}),
      lost: Promise.resolve({ reason: 'unknown' }),
    });
    gpuHost.gpu = { requestAdapter: async () => ({ requestDevice: async () => device }) };
    const result = await probeWebGpuDetailed();
    expect(result.status).toBe('device-lost');
    expect(result.capabilities.webgpu).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('times out a stuck GPU queue and releases its temporary device', async () => {
    const { device, destroy } = createDevice({ onSubmittedWorkDone: () => new Promise(() => {}) });
    gpuHost.gpu = { requestAdapter: async () => ({ requestDevice: async () => device }) };
    const result = await probeWebGpuDetailed();
    expect(result.status).toBe('unavailable');
    expect(destroy).toHaveBeenCalledOnce();
  }, 2_000);

  it('swallows adapter request failures as unavailable telemetry', async () => {
    gpuHost.gpu = {
      requestAdapter: async () => { throw new Error('blocked by permissions policy'); },
    };
    expect((await probeWebGpuDetailed()).status).toBe('unavailable');
  });
});
