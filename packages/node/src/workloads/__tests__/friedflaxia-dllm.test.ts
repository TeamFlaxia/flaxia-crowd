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
    releaseCache();
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

  it('frees the base and every expert when the cache is released', async () => {
    const base = await loadFriedFlaxiaDllm();
    const code = await loadFriedFlaxiaDllm('code');
    const math = await loadFriedFlaxiaDllm('math');

    releaseCache();

    expect(base.free).toHaveBeenCalledTimes(1);
    expect(code.free).toHaveBeenCalledTimes(1);
    expect(math.free).toHaveBeenCalledTimes(1);
    expect(isDllmLoaded()).toBe(false);
    expect(isDllmExpertLoaded('code')).toBe(false);
    expect(getDllmCacheSnapshot().entries).toEqual([]);
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
