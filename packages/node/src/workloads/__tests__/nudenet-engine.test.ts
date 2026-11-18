import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaNudeNet = vi.fn();
const releaseFriedFlaxiaNudeNet = vi.fn();

vi.mock('../friedflaxia/nudenet', () => ({
  handleFriedFlaxiaNudeNet: (...args: unknown[]) => handleFriedFlaxiaNudeNet(...args),
  releaseCache: () => releaseFriedFlaxiaNudeNet(),
}));

import { handleNudeNet, releaseCache } from '../nudenet';

const bitmapClose = vi.fn();

function stubCanvas() {
  class TrackingCanvas {
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low' as const,
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: () => ({ data: new Uint8ClampedArray(320 * 320 * 4) }),
      };
    }
  }
  vi.stubGlobal('OffscreenCanvas', TrackingCanvas);
}

describe('NudeNet FriedFlaxia selection', () => {
  beforeEach(() => {
    handleFriedFlaxiaNudeNet.mockReset();
    releaseFriedFlaxiaNudeNet.mockReset();
    globalThis.fetch = vi.fn().mockResolvedValue({
      blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
    }) as any;
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width: 640, height: 480, close: bitmapClose }) as any;
    stubCanvas();
  });

  it('routes engine=friedflaxia through the wasm backend', async () => {
    const expected = { detections: [{ label: 'FACE_FEMALE', score: 0.9, box: [1, 2, 3, 4] }], durationMs: 1 };
    handleFriedFlaxiaNudeNet.mockResolvedValue(expected);

    const result = await handleNudeNet({
      imageBase64: 'AA==',
      mimeType: 'image/jpeg',
      engine: 'friedflaxia',
    });

    expect(handleFriedFlaxiaNudeNet).toHaveBeenCalledTimes(1);
    const [data, ratio] = handleFriedFlaxiaNudeNet.mock.calls[0];
    expect(data).toBeInstanceOf(Float32Array);
    expect(data).toHaveLength(3 * 320 * 320);
    expect(ratio).toBe(2);
    expect(result).toBe(expected);
  });

  it('rejects unsupported models', async () => {
    await expect(
      handleNudeNet({ imageBase64: 'AA==', model: '640m' }),
    ).rejects.toThrow(/320n/);
  });

  it('releases the FriedFlaxia cache', () => {
    releaseCache();
    expect(releaseFriedFlaxiaNudeNet).toHaveBeenCalledTimes(1);
  });
});
