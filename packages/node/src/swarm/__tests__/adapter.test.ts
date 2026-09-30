import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadPooledEngineModule,
  wrapPooledEngine,
  SwarmEngineUnavailableError,
} from '../adapter';
import { probeWebGpu } from '../../executor/webgpuProbe';

vi.mock('../../executor/webgpuProbe', () => ({
  probeWebGpu: vi.fn(),
}));

const probeWebGpuMock = vi.mocked(probeWebGpu);

function fakeEngine() {
  const calls: string[] = [];
  const engine = {
    dims: { dim: 8 },
    NC: 4,
    reset: () => calls.push('reset'),
    embedRun: async (_t: number, _p: number) => { calls.push('embed'); return new Float32Array(8); },
    runHidden: async (_h: Float32Array, _p: number) => { calls.push('run'); return new Float32Array(8); },
    headFromHidden: async (_h: Float32Array) => { calls.push('head'); return new Float32Array(4); },
    setHidden: (_h: Float32Array) => calls.push('setHidden'),
    dispose: () => calls.push('dispose'),
  };
  return { engine, calls };
}

describe('loadPooledEngineModule', () => {
  beforeEach(() => {
    probeWebGpuMock.mockReset();
  });

  it('refuses to load when the context has no WebGPU adapter', async () => {
    probeWebGpuMock.mockResolvedValue({ webgpu: false });
    const importer = vi.fn();
    await expect(loadPooledEngineModule('/engine.js', importer)).rejects.toBeInstanceOf(SwarmEngineUnavailableError);
    expect(importer).not.toHaveBeenCalled();
  });

  it('rejects a module that does not export Qwen35Engine.create', async () => {
    probeWebGpuMock.mockResolvedValue({ webgpu: true });
    const importer = vi.fn(async () => ({ DenseEngine: class {} }));
    await expect(loadPooledEngineModule('/engine.js', importer)).rejects.toThrow(/Qwen35Engine\.create/);
  });

  it('reports an import failure as an unavailable engine', async () => {
    probeWebGpuMock.mockResolvedValue({ webgpu: true });
    const importer = vi.fn(async () => {
      throw new Error('404');
    });
    await expect(loadPooledEngineModule('/engine.js', importer)).rejects.toThrow(/failed to load swarm engine/);
  });

  it('returns the module when WebGPU and the export are present', async () => {
    probeWebGpuMock.mockResolvedValue({ webgpu: true });
    const mod = { Qwen35Engine: { create: vi.fn() } };
    const importer = vi.fn(async () => mod);
    await expect(loadPooledEngineModule('/engine.js', importer)).resolves.toBe(mod);
  });
});

describe('wrapPooledEngine', () => {
  it('delegates to the raw engine and exposes dim/NC', async () => {
    const { engine, calls } = fakeEngine();
    const adapter = wrapPooledEngine(engine);

    expect(adapter.dim).toBe(8);
    expect(adapter.nc).toBe(4);

    adapter.reset();
    await adapter.embedRun(1, 0);
    await adapter.runHidden(new Float32Array(8), 1);
    await adapter.headFromHidden(new Float32Array(8));
    adapter.setHidden(new Float32Array(8));
    adapter.dispose();

    expect(calls).toEqual(['reset', 'embed', 'run', 'head', 'setHidden', 'dispose']);
  });

  it('tolerates an engine without dispose', () => {
    const { engine } = fakeEngine();
    delete (engine as { dispose?: unknown }).dispose;
    expect(() => wrapPooledEngine(engine).dispose()).not.toThrow();
  });
});
