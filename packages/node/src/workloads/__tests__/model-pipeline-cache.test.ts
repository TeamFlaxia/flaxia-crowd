import { describe, expect, it, vi } from 'vitest';
import { ModelPipelineCache, modelPipelineKey } from '../model-pipeline-cache';

const descriptor = (modelId: string) => ({ modelId, revision: 'rev1', dtype: 'q4f16', backend: 'wasm' as const });

describe('ModelPipelineCache', () => {
  it('deduplicates concurrent loads and defers eviction until every lease is released', async () => {
    let now = 1000;
    const cache = new ModelPipelineCache<{ id: string }>({ capacity: 1, ttlMs: 100, now: () => now });
    const dispose = vi.fn();
    const load = vi.fn(async () => ({ value: { id: 'model-a' } }));

    const [first, second] = await Promise.all([
      cache.acquire('a', descriptor('a'), load, dispose),
      cache.acquire('a', descriptor('a'), load, dispose),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(now).entries[0]).toMatchObject({ state: 'ready', referenceCount: 2 });

    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await cache.releaseAll();
    expect(cache.getSnapshot(now).entries[0]).toMatchObject({ state: 'evicting', referenceCount: 1 });
    await second.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(now).entries).toHaveLength(0);
  });

  it('uses LRU for idle entries and refuses to evict an active pipeline', async () => {
    let now = 0;
    const cache = new ModelPipelineCache<{ id: string }>({ capacity: 1, ttlMs: 100, now: () => now });
    const dispose = vi.fn();
    const load = (id: string) => async () => ({ value: { id } });
    const first = await cache.acquire('a', descriptor('a'), load('a'), dispose);
    await first.release();

    now = 10;
    const second = await cache.acquire('b', descriptor('b'), load('b'), dispose);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith({ id: 'a' });
    await expect(cache.acquire('c', descriptor('c'), load('c'), dispose)).rejects.toThrow(/capacity is occupied/);
    await second.release();
  });

  it('expires idle entries and reports a failed load without retaining it forever', async () => {
    let now = 0;
    const cache = new ModelPipelineCache<{ id: string }>({ capacity: 1, ttlMs: 100, now: () => now });
    const dispose = vi.fn();
    const lease = await cache.acquire('a', descriptor('a'), async () => ({ value: { id: 'a' } }), dispose);
    await lease.release();
    now = 101;
    await expect(cache.acquire('bad', descriptor('bad'), async () => { throw new Error('load failed'); }, dispose)).rejects.toThrow('load failed');
    expect(cache.getSnapshot(now).entries[0]).toMatchObject({ modelId: 'bad', state: 'failed' });
    now += 61_000;
    await expect(cache.acquire('good', descriptor('good'), async () => ({ value: { id: 'good' } }), dispose)).resolves.toBeDefined();
    expect(cache.getSnapshot(now).entries.map((entry) => entry.modelId)).toEqual(['good']);
  });

  it('invalidates failed OOM entries and keys identity by revision, dtype and backend', async () => {
    const cache = new ModelPipelineCache<{ id: string }>({ capacity: 2 });
    const dispose = vi.fn();
    const lease = await cache.acquire('a', descriptor('a'), async () => ({ value: { id: 'a' } }), dispose);
    lease.invalidate();
    await lease.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(modelPipelineKey({ task: 'generate', modelId: 'm', revision: 'r1', dtype: 'q4', backend: 'wasm' }))
      .not.toBe(modelPipelineKey({ task: 'generate', modelId: 'm', revision: 'r2', dtype: 'q4', backend: 'wasm' }));
  });
});
