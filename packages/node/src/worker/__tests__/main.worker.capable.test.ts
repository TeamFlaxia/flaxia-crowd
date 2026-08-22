import { describe, it, expect, vi } from 'vitest';

const { probeMockFactory } = vi.hoisted(() => ({
  probeMockFactory: () => ({
    HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
    probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
    hasEnoughWasmMemoryForHeavy: () => true,
  }),
}));

vi.mock('../../executor/memoryProbe', () => probeMockFactory());

// Stub the heavy workload so the capable path gets past the capability gate
// without pulling in transformers/onnxruntime.
vi.mock('../../workloads/ai-inference', () => ({
  handleAiInference: vi.fn().mockResolvedValue({ output: 'ok' }),
  releaseCache: vi.fn(),
}));

describe('main.worker (capable device)', () => {
  it('does not reject a heavy workload when the device is capable', async () => {
    const posts: any[] = [];
    const selfObj: any = { postMessage: (m: any) => posts.push(m) };
    Object.defineProperty(globalThis, 'self', { value: selfObj, configurable: true });

    await import('../main.worker');

    await selfObj.onmessage({
      data: { id: 't2', workload: 'ai-inference', payload: {} },
    });

    const incapable = posts
      .filter((p) => p.type === 'error')
      .find((e) => /incapable/i.test(String(e.error)));
    expect(incapable).toBeUndefined();

    const done = posts.find((p) => p.type === 'done');
    expect(done).toBeDefined();
    expect(done.id).toBe('t2');
  });
});
