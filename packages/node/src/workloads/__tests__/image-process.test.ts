import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  MAX_IMAGE_PROCESS_INPUT_BYTES,
  handleImageProcess,
  resolveCanvasSize,
} from '../image-process';

const mockConvertToBlob = vi.fn();
const mockClose = vi.fn();
const mockCreateImageBitmap = vi.fn().mockResolvedValue({ width: 1, height: 1, close: mockClose });
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

vi.stubGlobal('createImageBitmap', mockCreateImageBitmap);

if (typeof FileReader === 'undefined') {
  globalThis.FileReader = class {
    result: string | null = null;
    onloadend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    async readAsDataURL(blob: Blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onloadend?.();
    }
  } as any;
}

const sampleBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(sampleBase64, 'base64'));
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0,
    0, 11, 8, height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0]);
}

function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80,
    86, 80, 56, 88, 10, 0, 0, 0]);
  bytes[24] = (width - 1) & 255;
  bytes[25] = (width - 1) >>> 8 & 255;
  bytes[26] = (width - 1) >>> 16;
  bytes[27] = (height - 1) & 255;
  bytes[28] = (height - 1) >>> 8 & 255;
  bytes[29] = (height - 1) >>> 16;
  return bytes;
}

function encoded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('Image Processing Workload', () => {
  beforeEach(() => {
    mockConvertToBlob.mockClear();
    mockCreateImageBitmap.mockClear();
    mockClose.mockClear();
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
      mimeType: 'image/png',
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
      mimeType: 'image/png',
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
      mimeType: 'image/png',
      options: { quality: 0.3, outputFormat: 'jpeg' }
    });

    expect(mockConvertToBlob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/jpeg', quality: 0.3 })
    );
  });
});

describe('Image Processing base64 input cap', () => {
  it('rejects oversized and malformed base64 before decoding', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      for (const imageBase64 of ['A'.repeat(Math.ceil(MAX_IMAGE_PROCESS_INPUT_BYTES * 4 / 3) + 4), '!!!']) {
        await expect(handleImageProcess({ operation: 'resize', imageBase64, mimeType: 'image/png', options: {} }))
          .rejects.toThrow(/base64|limit/);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});

describe('Image Processing predecode header limits', () => {
  beforeEach(() => {
    mockCreateImageBitmap.mockClear();
    mockClose.mockClear();
  });

  it.each([
    ['PNG oversized side', pngHeader(MAX_CANVAS_SIDE + 1, 1), 'image/png'],
    ['PNG oversized pixels', pngHeader(8192, 8192), 'image/png'],
    ['JPEG oversized side', jpegHeader(MAX_CANVAS_SIDE + 1, 1), 'image/jpeg'],
    ['WebP oversized pixels', webpHeader(8192, 8192), 'image/webp'],
  ] as Array<[string, Uint8Array, 'image/png' | 'image/jpeg' | 'image/webp']>)('rejects %s before createImageBitmap', async (_name, bytes, mimeType) => {
    await expect(handleImageProcess({ operation: 'resize', imageBase64: encoded(bytes), mimeType, options: {} }))
      .rejects.toThrow(/source dimensions.*exceed image limits/);
    expect(mockCreateImageBitmap).not.toHaveBeenCalled();
  });

  it('rejects unknown, truncated, malformed, and MIME-mismatched headers before decoding', async () => {
    for (const [bytes, mimeType] of [
      [Uint8Array.from([1, 2, 3]), 'image/png'],
      [pngHeader(1, 1).slice(0, 20), 'image/png'],
      [jpegHeader(1, 1).slice(0, 13), 'image/jpeg'],
      [webpHeader(1, 1).slice(0, 27), 'image/webp'],
      [Uint8Array.from(Buffer.from(sampleBase64, 'base64')), 'image/jpeg'],
    ] as const) {
      await expect(handleImageProcess({ operation: 'resize', imageBase64: encoded(bytes), mimeType, options: {} }))
        .rejects.toThrow(/image header|MIME/);
    }
    expect(mockCreateImageBitmap).not.toHaveBeenCalled();
  });

  it('accepts matching JPEG and WebP headers and closes bitmaps', async () => {
    for (const [bytes, mimeType] of [
      [jpegHeader(1, 1), 'image/jpeg'],
      [webpHeader(1, 1), 'image/webp'],
    ] as const) {
      await handleImageProcess({ operation: 'resize', imageBase64: encoded(bytes), mimeType, options: {} });
    }
    expect(mockCreateImageBitmap).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it('closes the bitmap on invalid options and mismatched decoded dimensions', async () => {
    await expect(handleImageProcess({ operation: 'resize', imageBase64: sampleBase64,
      mimeType: 'image/png', options: { width: MAX_CANVAS_SIDE + 1 } }))
      .rejects.toThrow(/8192px limit/);
    expect(mockClose).toHaveBeenCalledTimes(1);
    mockCreateImageBitmap.mockResolvedValueOnce({ width: 100000, height: 1, close: mockClose });
    await expect(handleImageProcess({ operation: 'resize', imageBase64: sampleBase64,
      mimeType: 'image/png', options: {} })).rejects.toThrow(/differ from image header/);
    expect(mockClose).toHaveBeenCalledTimes(2);
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

    // A legal-but-huge request is clamped to the 1x1 source bitmap.
    await handleImageProcess({
      operation: 'resize',
      imageBase64: sampleBase64,
      mimeType: 'image/png',
      options: { width: 8000, height: 8000 },
    });
    expect(canvasSizes).toEqual([{ width: 1, height: 1 }]);
  });
});
