import { describe, it, expect, vi } from 'vitest';

const { probeMockFactory } = vi.hoisted(() => ({
  probeMockFactory: () => ({
    HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
    probeMaxWasmMemoryBytes: () => 0,
    hasEnoughWasmMemoryForHeavy: () => false,
  }),
}));

vi.mock('../../executor/memoryProbe', () => probeMockFactory());

describe('main.worker (incapable device)', () => {
  it('rejects every task when the device cannot commit enough WASM memory', async () => {
    const posts: any[] = [];
    const selfObj: any = { postMessage: (m: any) => posts.push(m) };
    Object.defineProperty(globalThis, 'self', { value: selfObj, configurable: true });

    await import('../main.worker');

    await selfObj.onmessage({
      data: { id: 't1', workload: 'ai-inference', payload: {} },
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe('t1');
    expect(posts[0].type).toBe('error');
    expect(String(posts[0].error)).toMatch(/incapable/i);
  });
});
