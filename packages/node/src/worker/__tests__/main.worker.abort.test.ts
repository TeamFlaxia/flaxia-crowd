import { describe, it, expect, vi } from 'vitest';

const { probeMockFactory } = vi.hoisted(() => ({
  probeMockFactory: () => ({
    HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
    probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
    hasEnoughWasmMemoryForHeavy: () => true,
  }),
}));

vi.mock('../../executor/memoryProbe', () => probeMockFactory());

// A streaming workload stub: it emits, yields, then emits again. The second
// emit is where an abort has to bite — non-streaming workloads have no
// cancellation point and simply run to completion.
const { handleAiInference } = vi.hoisted(() => ({ handleAiInference: vi.fn() }));
vi.mock('../../workloads/ai-inference', () => ({
  handleAiInference,
  releaseCache: vi.fn(),
}));

describe('main.worker abort', () => {
  it('cancels a streaming task the coordinator aborted', async () => {
    const posts: any[] = [];
    const selfObj: any = { postMessage: (m: any) => posts.push(m) };
    Object.defineProperty(globalThis, 'self', { value: selfObj, configurable: true });

    handleAiInference.mockImplementation(
      async (_payload: unknown, emitToken: (token: string) => void | Promise<void>) => {
        // The worker's token sink is async (it yields for CPU throttling), so a
        // real streaming workload awaits it: that is what makes the abort
        // surface as a rejected token emit instead of an unhandled rejection.
        await emitToken('before');
        await new Promise((resolve) => setTimeout(resolve, 20));
        await emitToken('after');
        return { output: 'should not be reached' };
      },
    );

    await import('../main.worker');

    // An abort for a task this worker is not running changes nothing.
    selfObj.onmessage({ data: { id: 'ghost', type: 'abort', reason: 'not ours' } });
    expect(posts).toHaveLength(0);

    const task = selfObj.onmessage({ data: { id: 't-abort', workload: 'ai-inference', payload: {} } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    selfObj.onmessage({ data: { id: 't-abort', type: 'abort', reason: 'peer failed' } });
    await task;

    expect(posts).toContainEqual(
      expect.objectContaining({ type: 'error', id: 't-abort', error: 'peer failed' }),
    );
    expect(posts.find((post) => post.type === 'done')).toBeUndefined();
    expect(posts.filter((post) => post.type === 'token').map((post) => post.token)).not.toContain(
      'after',
    );
  });
});
