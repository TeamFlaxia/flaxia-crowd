import type { ImageProcessPayload, ImageProcessResult } from '@flaxia/sdk';

/**
 * Hard canvas limits for customer-supplied resize requests.
 *
 * `options.width`/`options.height` come straight from the task payload, so
 * without caps `{ width: 100000, height: 100000 }` asks the volunteer's renderer
 * for a terabyte-scale allocation. Each side is capped at 8192px and the total
 * at 32M pixels (a 8192x4096 canvas, ~128MB of RGBA backing store).
 */
export const MAX_CANVAS_SIDE = 8192;
export const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
/** Maximum encoded input before data-URL decoding or image bitmap allocation. */
export const MAX_IMAGE_PROCESS_INPUT_BYTES = 16 * 1024 * 1024;

type ImageFormat = 'png' | 'jpeg' | 'webp';
type ImageDimensions = { width: number; height: number; format: ImageFormat };

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] + bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000) >>> 0;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 256 + bytes[offset + 1];
}

function matches(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  return offset + signature.length <= bytes.length &&
    signature.every((value, index) => bytes[offset + index] === value);
}

function imageHeaderError(): never {
  throw new Error('image-process: unknown, truncated or inconsistent image header');
}

/** Inspect bounded encoded input before handing it to a potentially allocating decoder. */
function parseImageDimensions(bytes: Uint8Array): ImageDimensions {
  if (matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    // IHDR must be the first PNG chunk, exactly 13 bytes long.
    if (bytes.length < 33 || readU32BE(bytes, 8) !== 13 ||
        !matches(bytes, 12, [73, 72, 68, 82]) ||
        !((bytes[25] === 0 && [1, 2, 4, 8, 16].includes(bytes[24])) ||
          (bytes[25] === 2 && [8, 16].includes(bytes[24])) ||
          (bytes[25] === 3 && [1, 2, 4, 8].includes(bytes[24])) ||
          ([4, 6].includes(bytes[25]) && [8, 16].includes(bytes[24]))) ||
        bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) imageHeaderError();
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20), format: 'png' };
  }

  if (matches(bytes, 0, [255, 216])) {
    let position = 2;
    while (position < bytes.length) {
      if (bytes[position++] !== 255) imageHeaderError();
      while (position < bytes.length && bytes[position] === 255) position++;
      if (position >= bytes.length) imageHeaderError();
      const marker = bytes[position++];
      if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) imageHeaderError();
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > bytes.length) imageHeaderError();
      const length = readU16BE(bytes, position);
      if (length < 2 || position + length > bytes.length) imageHeaderError();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || bytes[position + 2] === 0 || bytes[position + 7] === 0 ||
            length !== 8 + bytes[position + 7] * 3) imageHeaderError();
        return { width: readU16BE(bytes, position + 5), height: readU16BE(bytes, position + 3), format: 'jpeg' };
      }
      position += length;
    }
    imageHeaderError();
  }

  if (matches(bytes, 0, [82, 73, 70, 70]) && matches(bytes, 8, [87, 69, 66, 80])) {
    if (bytes.length < 20 || readU32LE(bytes, 4) !== bytes.length - 8) imageHeaderError();
    const chunkSize = readU32LE(bytes, 16);
    if (chunkSize > bytes.length - 20 || chunkSize % 2 + chunkSize + 20 > bytes.length) imageHeaderError();
    if (matches(bytes, 12, [86, 80, 56, 88])) {
      if (chunkSize !== 10 || (bytes[20] & 0xc1) !== 0 || bytes[21] !== 0 || bytes[22] !== 0 || bytes[23] !== 0) imageHeaderError();
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        format: 'webp',
      };
    }
    if (matches(bytes, 12, [86, 80, 56, 76])) {
      if (chunkSize < 5 || bytes[20] !== 0x2f || (bytes[24] & 0xf0) !== 0) imageHeaderError();
      const bits = readU32LE(bytes, 21);
      return { width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1, format: 'webp' };
    }
    if (matches(bytes, 12, [86, 80, 56, 32])) {
      if (chunkSize < 10 || (bytes[20] & 1) !== 0 || !matches(bytes, 23, [157, 1, 42])) imageHeaderError();
      // The VP8 frame header stores the dimensions little-endian.
      return { width: ((bytes[27] << 8) | bytes[26]) & 0x3fff,
        height: ((bytes[29] << 8) | bytes[28]) & 0x3fff, format: 'webp' };
    }
    imageHeaderError();
  }
  imageHeaderError();
}

function validateImageDimensions({ width, height }: ImageDimensions): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_PIXELS) {
    throw new Error(`image-process: source dimensions ${width}x${height} exceed image limits (${MAX_CANVAS_SIDE}px side, ${MAX_CANVAS_PIXELS} pixels)`);
  }
}

function parseRequestedSide(value: unknown, name: 'width' | 'height'): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`image-process: options.${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  if (value > MAX_CANVAS_SIDE) {
    throw new Error(
      `image-process: options.${name} ${value} exceeds the ${MAX_CANVAS_SIDE}px limit`,
    );
  }
  return value;
}

/**
 * Resolve the output canvas size: validate the requested size against the hard
 * caps, then clamp it to the source bitmap so a payload can never upscale (and
 * therefore never allocate more than the decoded source needs).
 */
export function resolveCanvasSize(
  requested: { width?: unknown; height?: unknown },
  source: { width: number; height: number },
): { width: number; height: number } {
  const width = parseRequestedSide(requested.width, 'width') ?? source.width;
  const height = parseRequestedSide(requested.height, 'height') ?? source.height;

  const clamped = {
    width: Math.max(1, Math.min(width, source.width)),
    height: Math.max(1, Math.min(height, source.height)),
  };

  if (clamped.width * clamped.height > MAX_CANVAS_PIXELS) {
    throw new Error(
      `image-process: canvas ${clamped.width}x${clamped.height} exceeds the ${MAX_CANVAS_PIXELS} pixel limit`,
    );
  }
  return clamped;
}

export const handleImageProcess = async (payload: ImageProcessPayload): Promise<ImageProcessResult> => {
  const { operation, imageBase64, mimeType, options } = payload;
  const startedAt = performance.now();
  if (typeof imageBase64 !== 'string' ||
      imageBase64.length > Math.ceil(MAX_IMAGE_PROCESS_INPUT_BYTES * 4 / 3) + 2 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64) || imageBase64.length % 4 !== 0) {
    throw new Error(`image-process: invalid base64 or image exceeds ${MAX_IMAGE_PROCESS_INPUT_BYTES} byte limit`);
  }
  const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
  const inputBytes = imageBase64.length / 4 * 3 - padding;
  if (inputBytes > MAX_IMAGE_PROCESS_INPUT_BYTES) {
    throw new Error(`image-process: image exceeds ${MAX_IMAGE_PROCESS_INPUT_BYTES} byte limit`);
  }
  const response = await fetch(`data:${mimeType};base64,${imageBase64}`);
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_PROCESS_INPUT_BYTES) {
    throw new Error(`image-process: image exceeds ${MAX_IMAGE_PROCESS_INPUT_BYTES} byte limit`);
  }
  const header = parseImageDimensions(new Uint8Array(await blob.arrayBuffer()));
  validateImageDimensions(header);
  if (mimeType !== `image/${header.format}`) {
    throw new Error(`image-process: declared MIME ${mimeType} does not match ${header.format} image`);
  }
  const bitmap = await createImageBitmap(blob);
  try {
    // The decoder must agree with the checked header; never use unchecked bitmap dimensions.
    if (bitmap.width !== header.width || bitmap.height !== header.height) {
      throw new Error('image-process: decoded image dimensions differ from image header');
    }
    const size = resolveCanvasSize(options, bitmap);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get OffscreenCanvas context');
    }

    // Handle operations
    if (operation === 'grayscale') {
      ctx.filter = 'grayscale(100%)';
    }

    // Draw image (handles resize if canvas size differs from bitmap)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // Convert back to Base64
    const outputFormat = options.outputFormat || (mimeType.split('/')[1] as any);
    const outputMimeType = `image/${outputFormat}`;

    const outputBlob = await canvas.convertToBlob({
      type: outputMimeType,
      quality: options.quality || 0.8
    });

    const reader = new FileReader();
    const resultBase64 = await new Promise<string>((resolve, reject) => {
      reader.onloadend = () => {
        const base64data = (reader.result as string).split(',')[1];
        resolve(base64data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(outputBlob);
    });

    console.log(
      `[flaxia-node] image-process: done operation=${operation} output=${outputFormat} size=${size.width}x${size.height} inputBytes=${inputBytes} resultBytes=${outputBlob.size} durationMs=${Math.round(performance.now() - startedAt)}`,
    );

    return {
      imageBase64: resultBase64,
      mimeType: outputMimeType,
      originalSizeBytes: blob.size,
      resultSizeBytes: outputBlob.size
    };
  } finally {
    bitmap.close();
  }
};