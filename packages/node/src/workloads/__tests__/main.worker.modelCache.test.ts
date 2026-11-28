import { describe, expect, it, vi } from 'vitest';

// main.worker snapshot behavior for the LoRA expert workload: the base and the
// adapter share a manifest id, so only the adapter id distinguishes them.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    snapshotEntries: [] as any[],
    handleTheiaInference: vi.fn(),
  },
}));

vi.mock('../../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
  hasEnoughWasmMemoryForHeavy: () => true,
}));

vi.mock('../theia', () => ({
  handleTheiaInference: (...args: unknown[]) => mocks.handleTheiaInference(...args),
  releaseCache: vi.fn(),
  getModelCacheSnapshot: () => ({
    version: 1,
    sampledAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    entries: mocks.snapshotEntries,
  }),
}));

async function bootWorker(posts: any[]) {
  const selfObj: any = { postMessage: (message: any) => posts.push(message) };
  Object.defineProperty(globalThis, 'self', { value: selfObj, configurable: true });
  vi.resetModules();
  await import('../../worker/main.worker');
  return selfObj;
}

describe('main.worker theia model cache', () => {
  it('keeps an adapter entry distinct from the base entry when deduping', async () => {
    const entries = [
      {
        modelId: 'test-dllm',
        revision: 'base',
        dtype: 'q4_0',
        backend: 'wasm',
        state: 'ready',
        referenceCount: 1,
      },
      {
        modelId: 'test-dllm',
        revision: 'adapter',
        dtype: 'q4_0',
        backend: 'wasm',
        state: 'ready',
        referenceCount: 1,
        adapterId: 'code',
      },
    ];
    mocks.snapshotEntries = entries;
    mocks.handleTheiaInference.mockReset().mockResolvedValue({ output: 'ok' });

    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    await selfObj.onmessage({
      data: { id: 'theia-1', workload: 'theia-inference', payload: { messages: [], model: 'm' } },
    });

    const done = posts.find((message) => message.type === 'done');
    expect(done).toBeDefined();
    expect(done.modelCache.entries).toEqual(entries);
  });

  it('reports an unconfigured expert as a permanent task failure', async () => {
    mocks.snapshotEntries = [];
    mocks.handleTheiaInference
      .mockReset()
      .mockRejectedValue(new Error("theia-inference: no adapter pin for expert 'code'"));

    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    await selfObj.onmessage({
      data: { id: 'theia-2', workload: 'theia-inference', payload: { messages: [], model: 'm' } },
    });

    const error = posts.find((message) => message.type === 'error');
    expect(error).toBeDefined();
    expect(String(error.error)).toMatch(/no adapter pin for expert/);
    expect(error.permanent).toBe(true);
  });
});
