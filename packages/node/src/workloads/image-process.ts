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
  const inputBytes = Math.round(imageBase64.length * 0.75);

  const response = await fetch(`data:${mimeType};base64,${imageBase64}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // Reject/clamp before allocating the canvas: an unbounded request would
  // otherwise crash the volunteer's renderer process.
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
};