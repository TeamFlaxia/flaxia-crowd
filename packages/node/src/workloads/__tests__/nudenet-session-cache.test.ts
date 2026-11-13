import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  release: vi.fn(),
  fetchGuarded: vi.fn(),
}));

vi.mock('onnxruntime-web', () => ({
  env: { wasm: { numThreads: 0, proxy: false, wasmPaths: '' } },
  InferenceSession: { create: state.create },
  Tensor: class Tensor {
    constructor(
      public readonly type: string,
      public readonly data: Float32Array,
      public readonly dims: number[],
    ) {}
  },
}));

vi.mock('../../executor/egress-guard', () => ({
  fetchGuarded: state.fetchGuarded,
}));

import { handleNudeNet, releaseCache } from '../nudenet';

/** Minimal 2D canvas stub so preprocessing reaches the session load. */
class FakeContext {
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low' as const;
  fillStyle = '';
  fillRect(): void {}
  drawImage(): void {}
  getImageData(): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(320 * 320 * 4) };
  }
}

class FakeCanvas {
  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {}
  getContext(): FakeContext {
    return new FakeContext();
  }
}

function payload() {
  return { imageBase64: 'AA==', mimeType: 'image/jpeg' } as any;
}

function stubImageDecode(): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
  }) as any;
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({
    width: 8,
    height: 8,
    close: vi.fn(),
  }) as any;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
}

describe('nudenet session cache', () => {
  beforeEach(() => {
    releaseCache();
    state.create.mockReset();
    state.release.mockReset();
    state.fetchGuarded.mockReset();
    stubImageDecode();
  });

  it('evicts a failed load so the rejected promise cannot pin the downloaded buffer', async () => {
    state.create.mockRejectedValue(new Error('wasm OOM'));
    state.fetchGuarded.mockResolvedValue({
      ok: true,
      status: 200,
      bytes: new Uint8Array([1, 2, 3]),
      byteLength: 3,
    });

    await expect(handleNudeNet(payload())).rejects.toThrow(/wasm OOM/);
    // Both the detector and the NMS session were attempted.
    expect(state.create).toHaveBeenCalledTimes(2);

    // The cache entries are gone: a retry must attempt the load again instead
    // of rethrowing the same rejected promise forever.
    await expect(handleNudeNet(payload())).rejects.toThrow(/wasm OOM/);
    expect(state.create).toHaveBeenCalledTimes(4);
  });

  it('releases cached sessions on releaseCache instead of leaving them to GC', async () => {
    state.release.mockResolvedValue(undefined);
    const tensor = { dims: [1, 10, 22], data: new Float32Array(10 * 22) };
    state.create.mockResolvedValue({
      release: state.release,
      run: vi.fn().mockResolvedValue({ output0: tensor, selected: tensor }),
    });
    state.fetchGuarded.mockResolvedValue({
      ok: true,
      status: 200,
      bytes: new Uint8Array([1, 2, 3]),
      byteLength: 3,
    });

    await handleNudeNet(payload());
    expect(state.create).toHaveBeenCalledTimes(2);

    releaseCache();
    // releaseCache fires the session release without blocking; let the
    // microtask queue drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.release).toHaveBeenCalledTimes(2);
  });
});
