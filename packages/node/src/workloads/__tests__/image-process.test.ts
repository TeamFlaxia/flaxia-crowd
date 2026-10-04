import { describe, it, expect, vi } from 'vitest';
import {
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  handleImageProcess,
  resolveCanvasSize,
} from '../image-process';

const mockConvertToBlob = vi.fn();
/** Canvas sizes requested during the test (OffscreenCanvas is a stub here). */
const canvasSizes: Array<{ width: number; height: number }> = [];

if (typeof OffscreenCanvas === 'undefined') {
  global.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      canvasSizes.push({ width, height });
    }
    getContext() {
      return {
        drawImage: vi.fn(),
        filter: ''
      };
    }
    convertToBlob(...args: any[]) {
      mockConvertToBlob(...args);
      return Promise.resolve(new Blob(['mock-data'], { type: 'image/jpeg' }));
    }
  } as any;
}

if (typeof createImageBitmap === 'undefined') {
  global.createImageBitmap = vi.fn().mockResolvedValue({ width: 100, height: 100 });
}

const sampleBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Image Processing Workload', () => {
  beforeEach(() => {
    mockConvertToBlob.mockClear();
  });

  it('should process resize operation', async () => {
    const result = await handleImageProcess({
      operation: 'resize',
      imageBase64: sampleBase64,
      mimeType: 'image/png',
      options: { width: 50, height: 50, outputFormat: 'webp' }
    });

    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe('image/webp');
    expect(result.originalSizeBytes).toBeGreaterThan(0);
    expect(result.resultSizeBytes).toBeGreaterThan(0);
  });

  it('should process grayscale operation', async () => {
    const result = await handleImageProcess({
      operation: 'grayscale',
      imageBase64: sampleBase64,
      mimeType: 'image/jpeg',
      options: { outputFormat: 'jpeg' }
    });

    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('should process compress operation', async () => {
    const result = await handleImageProcess({
      operation: 'compress',
      imageBase64: sampleBase64,
      mimeType: 'image/png',
      options: { quality: 0.5 }
    });

    expect(result.imageBase64).toBeDefined();
  });

  it('should process thumbnail operation', async () => {
    const result = await handleImageProcess({
      operation: 'thumbnail',
      imageBase64: sampleBase64,
      mimeType: 'image/jpeg',
      options: { width: 150, height: 150, outputFormat: 'jpeg' }
    });

    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('should default to input mimeType when outputFormat not specified', async () => {
    const result = await handleImageProcess({
      operation: 'resize',
      imageBase64: sampleBase64,
      mimeType: 'image/png',
      options: { width: 50, height: 50 }
    });

    expect(result.mimeType).toBe('image/png');
  });

  it('should pass quality option to convertToBlob', async () => {
    await handleImageProcess({
      operation: 'compress',
      imageBase64: sampleBase64,
      mimeType: 'image/jpeg',
      options: { quality: 0.3 }
    });

    expect(mockConvertToBlob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/jpeg', quality: 0.3 })
    );
  });
});

describe('Image Processing canvas limits (#10-5)', () => {
  beforeEach(() => {
    mockConvertToBlob.mockClear();
    canvasSizes.length = 0;
  });

  it('rejects a side above the hard cap before allocating', () => {
    expect(() => resolveCanvasSize({ width: 100000, height: 100000 }, { width: 100, height: 100 })).toThrow(
      /exceeds the 8192px limit/,
    );
    expect(() => resolveCanvasSize({ height: MAX_CANVAS_SIDE + 1 }, { width: 100, height: 100 })).toThrow(
      /exceeds the 8192px limit/,
    );
  });

  it('rejects non-integer, zero and negative sides', () => {
    for (const value of [0, -10, 12.5, Number.NaN, Number.POSITIVE_INFINITY, '100' as any]) {
      expect(() => resolveCanvasSize({ width: value }, { width: 100, height: 100 })).toThrow(
        /must be a positive integer/,
      );
    }
  });

  it('rejects a request whose pixel count exceeds the cap', () => {
    // 8192 x 8192 = 67M pixels > 32M cap, even though both sides are legal.
    expect(() => resolveCanvasSize({ width: 8192, height: 8192 }, { width: 10000, height: 10000 })).toThrow(
      new RegExp(`exceeds the ${MAX_CANVAS_PIXELS} pixel limit`),
    );
  });

  it('clamps the request to the source bitmap so it can never upscale', () => {
    expect(resolveCanvasSize({ width: 4000, height: 4000 }, { width: 100, height: 100 })).toEqual({
      width: 100,
      height: 100,
    });
    expect(resolveCanvasSize({ width: 50 }, { width: 100, height: 80 })).toEqual({ width: 50, height: 80 });
    expect(resolveCanvasSize({}, { width: 100, height: 80 })).toEqual({ width: 100, height: 80 });
  });

  it('never constructs an oversized OffscreenCanvas for a hostile payload', async () => {
    await expect(
      handleImageProcess({
        operation: 'resize',
        imageBase64: sampleBase64,
        mimeType: 'image/png',
        options: { width: 100000, height: 100000 },
      }),
    ).rejects.toThrow(/exceeds the 8192px limit/);
    expect(canvasSizes).toHaveLength(0);

    // A legal-but-huge request is clamped to the 100x100 source bitmap.
    await handleImageProcess({
      operation: 'resize',
      imageBase64: sampleBase64,
      mimeType: 'image/png',
      options: { width: 8000, height: 8000 },
    });
    expect(canvasSizes).toEqual([{ width: 100, height: 100 }]);
  });
});
