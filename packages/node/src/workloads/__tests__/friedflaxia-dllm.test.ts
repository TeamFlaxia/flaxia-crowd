import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DllmModel } from '../../vendor/friedflaxia/types';
import {
  getDllmCacheSnapshot,
  isDllmExpertLoaded,
  isDllmLoaded,
  loadFriedFlaxiaDllm,
  releaseCache,
  supportedTheiaExperts,
} from '../friedflaxia/dllm';

const h = vi.hoisted(() => ({
  BASE: {
    url: 'https://models.example/dllm-base.bin',
    sha256: 'a'.repeat(64),
    maxBytes: 4096,
    modelId: 'test-dllm',
    revision: 'b'.repeat(40),
  },
  PINS: {
    code: {
      url: 'https://models.example/lora-code.bin',
      sha256: 'c'.repeat(64),
      maxBytes: 1024,
      revision: 'd'.repeat(40),
    },
    math: {
      url: 'https://models.example/lora-math.bin',
      sha256: 'e'.repeat(64),
      maxBytes: 1024,
    },
  },
  downloadPinnedModel: vi.fn(),
  initFriedFlaxiaWasm: vi.fn(),
  ModelCtor: vi.fn(),
  withLora: vi.fn(),
}));

const { BASE, PINS, downloadPinnedModel, initFriedFlaxiaWasm, ModelCtor, withLora } = h;

vi.mock('../friedflaxia/model-registry', () => ({
  FRIEDFLAXIA_DLLM: h.BASE,
  downloadPinnedModel: h.downloadPinnedModel,
}));

vi.mock('../../vendor/friedflaxia/init', () => ({ initFriedFlaxiaWasm: h.initFriedFlaxiaWasm }));

// The loader imports the generated glue dynamically; stub it so no wasm is
// compiled and `Model.withLora` can be observed directly.
vi.mock('../../vendor/friedflaxia/friedflaxia_wasm.js', () => ({
  Model: Object.assign(h.ModelCtor, { withLora: h.withLora }),
}));

const originalPinEnv = process.env.THEIA_LORA_ADAPTERS;
const baseBytes = new Uint8Array([1, 2, 3]);
const adapterModels = new Map<Uint8Array, { expert: string; model: DllmModel }>();

function fakeModel(expert?: string): DllmModel {
  return {
    encode: vi.fn(),
    decode: vi.fn(),
    token_id: vi.fn(),
    eos_token_id: vi.fn(),
    free: vi.fn(),
    loraRank: vi.fn(() => (expert ? 8 : undefined)),
    loraExpert: vi.fn(() => expert),
    denoise_topk: vi.fn(),
  } as unknown as DllmModel;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('friedflaxia dLLM LoRA loader', () => {
  let baseModel: DllmModel;

  beforeEach(() => {
    process.env.THEIA_LORA_ADAPTERS = JSON.stringify(PINS);
    baseModel = fakeModel();
    adapterModels.clear();

    initFriedFlaxiaWasm.mockReset().mockResolvedValue(undefined);
    downloadPinnedModel.mockReset().mockImplementation(async (pin: { url: string }) => {
      if (pin.url === BASE.url) return baseBytes;
      const expert = (Object.keys(PINS) as Array<keyof typeof PINS>).find(
        (id) => PINS[id].url === pin.url,
      );
      if (!expert) throw new Error(`unexpected pin ${pin.url}`);
      const bytes = new Uint8Array([expert.charCodeAt(0)]);
      adapterModels.set(bytes, { expert, model: fakeModel(expert) });
      return bytes;
    });
    // A regular function is required so `new Model(bytes)` returns the fake.
    ModelCtor.mockReset().mockImplementation(function () { return baseModel; });
    withLora.mockReset().mockImplementation((_base: Uint8Array, lora: Uint8Array) => {
      const entry = adapterModels.get(lora);
      if (!entry) throw new Error('unexpected adapter bytes');
      return entry.model;
    });
    // Full reset between tests; the default release deliberately keeps the base.
    releaseCache({ includeBase: true });
  });

  afterEach(() => {
    if (originalPinEnv === undefined) delete process.env.THEIA_LORA_ADAPTERS;
    else process.env.THEIA_LORA_ADAPTERS = originalPinEnv;
  });

  it('lists only valid pinned experts', () => {
    expect(supportedTheiaExperts()).toEqual(['code', 'math']);
  });

  it('downloads the pinned base once, even with several experts resident', async () => {
    const base = await loadFriedFlaxiaDllm();
    const code = await loadFriedFlaxiaDllm('code');
    const otherCode = await loadFriedFlaxiaDllm('code');
    const math = await loadFriedFlaxiaDllm('math');
    await loadFriedFlaxiaDllm();

    expect(downloadPinnedModel.mock.calls.filter(([pin]) => pin.url === BASE.url)).toHaveLength(1);
    expect(downloadPinnedModel).toHaveBeenCalledTimes(3); // base + two adapters
    expect(otherCode).toBe(code);
    expect(base).not.toBe(code);
    expect(code).not.toBe(math);
  });

  it('builds a separate withLora instance per expert over the shared base bytes', async () => {
    const base = await loadFriedFlaxiaDllm();
    const code = await loadFriedFlaxiaDllm('code');
    const math = await loadFriedFlaxiaDllm('math');

    expect(ModelCtor).toHaveBeenCalledTimes(1);
    expect(withLora).toHaveBeenCalledTimes(2);
    expect(downloadPinnedModel).toHaveBeenNthCalledWith(2, PINS.code);
    expect(downloadPinnedModel).toHaveBeenNthCalledWith(3, PINS.math);
    for (const [baseArg] of withLora.mock.calls) expect(baseArg).toBe(baseBytes);
    expect(withLora.mock.calls[0][1]).not.toBe(withLora.mock.calls[1][1]);

    expect(base.loraExpert?.()).toBeUndefined();
    expect(code.loraExpert?.()).toBe('code');
    expect(math.loraExpert?.()).toBe('math');
    expect(isDllmLoaded()).toBe(true);
    expect(isDllmExpertLoaded('code')).toBe(true);
    expect(isDllmExpertLoaded('math')).toBe(true);
    expect(isDllmExpertLoaded('unknown')).toBe(false);
  });

  it('keeps the base resident across a default release without re-downloading it', async () => {
    const base = await loadFriedFlaxiaDllm();

    releaseCache();

    expect(isDllmLoaded()).toBe(true);
    expect(base.free).not.toHaveBeenCalled();
    expect(downloadPinnedModel.mock.calls.filter(([pin]) => pin.url === BASE.url)).toHaveLength(1);

    const reloaded = await loadFriedFlaxiaDllm();
    expect(reloaded).toBe(base);
    expect(ModelCtor).toHaveBeenCalledTimes(1);
    expect(downloadPinnedModel).toHaveBeenCalledTimes(1);
  });

  it('frees only experts on a default release and rebuilds them on the next load', async () => {
    const base = await loadFriedFlaxiaDllm();
    const code = await loadFriedFlaxiaDllm('code');
    const math = await loadFriedFlaxiaDllm('math');
    const loraCalls = withLora.mock.calls.length;

    releaseCache();

    expect(code.free).toHaveBeenCalledTimes(1);
    expect(math.free).toHaveBeenCalledTimes(1);
    expect(base.free).not.toHaveBeenCalled();
    expect(isDllmLoaded()).toBe(true);
    expect(isDllmExpertLoaded('code')).toBe(false);
    expect(isDllmExpertLoaded('math')).toBe(false);
    expect(withLora).toHaveBeenCalledTimes(loraCalls);

    const codeAgain = await loadFriedFlaxiaDllm('code');
    expect(codeAgain).not.toBe(code);
    expect(withLora).toHaveBeenCalledTimes(loraCalls + 1);
    expect(withLora.mock.calls[loraCalls][0]).toBe(baseBytes);
    expect(downloadPinnedModel.mock.calls.filter(([pin]) => pin.url === BASE.url)).toHaveLength(1);
  });

  it('keeps the base entry in the snapshot after a default release', async () => {
    await loadFriedFlaxiaDllm();
    await loadFriedFlaxiaDllm('code');

    releaseCache();

    const entries = getDllmCacheSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      modelId: BASE.modelId,
      revision: BASE.revision,
      state: 'ready',
    });
    expect(entries[0].adapterId).toBeUndefined();
  });

  it('frees the base and every expert on an explicit full reset', async () => {
    const base = await loadFriedFlaxiaDllm();
    const code = await loadFriedFlaxiaDllm('code');
    const math = await loadFriedFlaxiaDllm('math');

    releaseCache({ includeBase: true });

    expect(base.free).toHaveBeenCalledTimes(1);
    expect(code.free).toHaveBeenCalledTimes(1);
    expect(math.free).toHaveBeenCalledTimes(1);
    expect(isDllmLoaded()).toBe(false);
    expect(isDllmExpertLoaded('code')).toBe(false);
    expect(getDllmCacheSnapshot().entries).toEqual([]);
  });

  it('keeps an in-flight base load alive across a default release', async () => {
    const pending = deferred<Uint8Array>();
    downloadPinnedModel.mockImplementationOnce(() => pending.promise);
    const load = loadFriedFlaxiaDllm();
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalled());

    releaseCache();
    pending.resolve(baseBytes);

    const base = await load;
    expect(isDllmLoaded()).toBe(true);
    expect(await loadFriedFlaxiaDllm()).toBe(base);
    expect(downloadPinnedModel).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight base load on an explicit full reset', async () => {
    const pending = deferred<Uint8Array>();
    downloadPinnedModel.mockImplementationOnce(() => pending.promise);
    const load = loadFriedFlaxiaDllm();
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalled());

    releaseCache({ includeBase: true });
    pending.resolve(baseBytes);

    await expect(load).rejects.toThrow(/stale base load/);
    expect(isDllmLoaded()).toBe(false);
  });

  it('rejects an in-flight expert load on a default release while keeping the base', async () => {
    await loadFriedFlaxiaDllm();
    const pending = deferred<Uint8Array>();
    const original = downloadPinnedModel.getMockImplementation()!;
    downloadPinnedModel.mockImplementationOnce((pin: { url: string }) => {
      if (pin.url === BASE.url) return original(pin);
      return pending.promise.then((bytes) => {
        adapterModels.set(bytes, { expert: 'code', model: fakeModel('code') });
        return bytes;
      });
    });

    const load = loadFriedFlaxiaDllm('code');
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalledTimes(2));

    releaseCache();
    pending.resolve(new Uint8Array(['c'.charCodeAt(0)]));

    await expect(load).rejects.toThrow(/stale expert load/);
    expect(isDllmLoaded()).toBe(true);
    expect(isDllmExpertLoaded('code')).toBe(false);
  });

  it('does not drop a newer base load when a stale base load settles', async () => {
    const staleBytes = deferred<Uint8Array>();
    const freshBytes = deferred<Uint8Array>();
    // A third download would signal that the stale failure cleared the newer load.
    const strayBytes = deferred<Uint8Array>();
    downloadPinnedModel
      .mockImplementationOnce(() => staleBytes.promise)
      .mockImplementationOnce(() => freshBytes.promise)
      .mockImplementationOnce(() => strayBytes.promise);

    const stale = loadFriedFlaxiaDllm();
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalledTimes(1));
    releaseCache({ includeBase: true });

    const fresh = loadFriedFlaxiaDllm();
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalledTimes(2));
    staleBytes.resolve(baseBytes);
    await expect(stale).rejects.toThrow(/stale base load/);

    const duplicate = loadFriedFlaxiaDllm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloadPinnedModel).toHaveBeenCalledTimes(2);
    freshBytes.resolve(baseBytes);
    expect(await duplicate).toBe(await fresh);
  });

  it('does not drop a newer expert load when a stale expert load settles', async () => {
    await loadFriedFlaxiaDllm();
    const staleBytes = deferred<Uint8Array>();
    const freshBytes = deferred<Uint8Array>();
    const strayBytes = deferred<Uint8Array>();
    const original = downloadPinnedModel.getMockImplementation()!;
    const register = (bytes: Uint8Array) => {
      adapterModels.set(bytes, { expert: 'code', model: fakeModel('code') });
      return bytes;
    };
    downloadPinnedModel
      .mockImplementationOnce((pin: { url: string }) =>
        pin.url === BASE.url ? original(pin) : staleBytes.promise.then(register),
      )
      .mockImplementationOnce((pin: { url: string }) =>
        pin.url === BASE.url ? original(pin) : freshBytes.promise.then(register),
      )
      .mockImplementationOnce((pin: { url: string }) =>
        pin.url === BASE.url ? original(pin) : strayBytes.promise.then(register),
      );

    const stale = loadFriedFlaxiaDllm('code');
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalledTimes(2));
    releaseCache();

    const fresh = loadFriedFlaxiaDllm('code');
    await vi.waitFor(() => expect(downloadPinnedModel).toHaveBeenCalledTimes(3));
    staleBytes.resolve(new Uint8Array(['c'.charCodeAt(0)]));
    await expect(stale).rejects.toThrow(/stale expert load/);

    const duplicate = loadFriedFlaxiaDllm('code');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloadPinnedModel).toHaveBeenCalledTimes(3);
    freshBytes.resolve(new Uint8Array(['c'.charCodeAt(0)]));
    expect(await duplicate).toBe(await fresh);
    expect(isDllmExpertLoaded('code')).toBe(true);
  });

  it('reports the adapter id on expert cache snapshot entries', async () => {
    await loadFriedFlaxiaDllm();
    await loadFriedFlaxiaDllm('code');
    await loadFriedFlaxiaDllm('math');

    const entries = getDllmCacheSnapshot().entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      modelId: BASE.modelId,
      revision: BASE.revision,
      state: 'ready',
    });
    expect(entries[0].adapterId).toBeUndefined();
    expect(entries[1]).toMatchObject({
      modelId: BASE.modelId,
      revision: PINS.code.revision,
      adapterId: 'code',
      state: 'ready',
    });
    expect(entries[2]).toMatchObject({
      modelId: BASE.modelId,
      revision: 'adapter',
      adapterId: 'math',
      state: 'ready',
    });
  });

  it('refuses an expert that has no pin without downloading anything', async () => {
    await expect(loadFriedFlaxiaDllm('unpinned')).rejects.toThrow(/no adapter pin for expert 'unpinned'/);
    expect(downloadPinnedModel).not.toHaveBeenCalled();
  });
});
