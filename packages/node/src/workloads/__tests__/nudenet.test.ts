import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleNudeNet,
  MAX_NUDENET_IMAGE_BYTES,
  MAX_NUDENET_IMAGE_PIXELS,
  MAX_NUDENET_IMAGE_SIDE,
} from '../nudenet';

const bitmapClose = vi.fn();
const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalFetch = globalThis.fetch;

function payload() {
  return {
    // Small base64 input; the decoder stub provides the dimensions under test.
    imageBase64: 'AA==',
    mimeType: 'image/jpeg',
  } as any;
}

describe('NudeNet input caps', () => {
  it('rejects oversized or malformed base64 before decoding/fetching', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    await expect(handleNudeNet({ imageBase64: 'A'.repeat(Math.ceil(MAX_NUDENET_IMAGE_BYTES * 4 / 3) + 8) } as any))
      .rejects.toThrow(/limit/);
    await expect(handleNudeNet({ imageBase64: '!!!' } as any)).rejects.toThrow(/base64/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('NudeNet decoded image limits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    bitmapClose.mockClear();
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.fetch = originalFetch;
  });

  it.each([
    ['oversized side', MAX_NUDENET_IMAGE_SIDE + 1, 1],
    ['oversized pixel allocation', MAX_NUDENET_IMAGE_SIDE, MAX_NUDENET_IMAGE_SIDE],
  ])('rejects %s and closes the decoded bitmap before canvas allocation', async (_name, width, height) => {
    globalThis.fetch = vi.fn().mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }) as any;
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width, height, close: bitmapClose }) as any;
    const offscreenSpy = vi.fn();
    vi.stubGlobal('OffscreenCanvas', offscreenSpy);

    await expect(handleNudeNet(payload())).rejects.toThrow(/dimensions .* exceed image limits/);
    expect(bitmapClose).toHaveBeenCalledTimes(1);
    expect(offscreenSpy).not.toHaveBeenCalled();
  });

  it('allows a decoded image at the bounded pixel area', async () => {
    const width = MAX_NUDENET_IMAGE_SIDE;
    const height = Math.floor(MAX_NUDENET_IMAGE_PIXELS / MAX_NUDENET_IMAGE_SIDE);
    globalThis.fetch = vi.fn().mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }) as any;
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width, height, close: bitmapClose }) as any;
    // The accepted max-pixel image reaches preprocessing; no functional canvas
    // stub is provided here, so preprocessing fails and still closes the bitmap.
    await expect(handleNudeNet(payload())).rejects.toThrow(/getContext/);
    expect(bitmapClose).toHaveBeenCalledTimes(1);
  });
});
