import type { NudeNetDetection, NudeNetPayload, NudeNetResult } from '@flaxia/sdk';
import { fetchGuarded } from '../executor/egress-guard';
import {
  handleFriedFlaxiaNudeNet,
  releaseCache as releaseFriedFlaxiaNudeNet,
} from './friedflaxia/nudenet';

const IMG_SIZE = 320;

/** Hard caps for the inputs this workload accepts. */
export const MAX_NUDENET_IMAGE_BYTES = 16 * 1024 * 1024;
/** Bound decoded pixels before allocating preprocessing canvases (RGBA ~4 bytes/pixel). */
export const MAX_NUDENET_IMAGE_PIXELS = 32 * 1024 * 1024;
export const MAX_NUDENET_IMAGE_SIDE = 8192;
/** Content types accepted for a customer-supplied image URL. */
export const NUDENET_IMAGE_CONTENT_TYPES = ['image/*', 'application/octet-stream'] as const;


async function loadImage(payload: NudeNetPayload): Promise<ImageBitmap> {
  let blob: Blob;
  if (payload.imageBase64) {
    const imageBase64 = payload.imageBase64;
    const maxEncodedChars = Math.floor((MAX_NUDENET_IMAGE_BYTES + 2) / 3) * 4;
    if (
      typeof imageBase64 !== 'string' ||
      imageBase64.length > maxEncodedChars ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64) ||
      imageBase64.length % 4 !== 0
    ) {
      throw new Error(`NudeNet image has invalid base64 or exceeds ${MAX_NUDENET_IMAGE_BYTES} byte limit`);
    }
    const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
    const decodedBytes = imageBase64.length / 4 * 3 - padding;
    if (decodedBytes > MAX_NUDENET_IMAGE_BYTES) {
      throw new Error(`NudeNet image exceeds ${MAX_NUDENET_IMAGE_BYTES} byte limit`);
    }
    const mimeType = payload.mimeType || 'image/jpeg';
    const res = await fetch(`data:${mimeType};base64,${imageBase64}`);
    blob = await res.blob();
    if (blob.size > MAX_NUDENET_IMAGE_BYTES) {
      throw new Error(`NudeNet image exceeds ${MAX_NUDENET_IMAGE_BYTES} byte limit`);
    }
  } else if (payload.imageUrl) {
    // Customer-supplied URL: only https, public hosts, default port, a real
    // image content type and a bounded body may be fetched (SSRF guard).
    const res = await fetchGuarded({
      url: payload.imageUrl,
      allowContentTypes: NUDENET_IMAGE_CONTENT_TYPES,
      maxBytes: MAX_NUDENET_IMAGE_BYTES,
    });
    if (!res.ok) throw new Error(`Failed to fetch image: ${payload.imageUrl} (HTTP ${res.status})`);
    blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
  } else {
    throw new Error('NudeNet payload requires either imageUrl or imageBase64');
  }
  const bitmap = await createImageBitmap(blob);
  if (
    !Number.isSafeInteger(bitmap.width) ||
    !Number.isSafeInteger(bitmap.height) ||
    bitmap.width < 1 ||
    bitmap.height < 1 ||
    bitmap.width > MAX_NUDENET_IMAGE_SIDE ||
    bitmap.height > MAX_NUDENET_IMAGE_SIDE ||
    bitmap.width * bitmap.height > MAX_NUDENET_IMAGE_PIXELS
  ) {
    bitmap.close();
    throw new Error(
      `NudeNet image dimensions ${bitmap.width}x${bitmap.height} exceed image limits (${MAX_NUDENET_IMAGE_SIDE}px side, ${MAX_NUDENET_IMAGE_PIXELS} pixels)`,
    );
  }
  return bitmap;
}

/**
 * Mirrors the reference python preprocessing (deepghs/imgutils `_nn_preprocessing`):
 *  1. load RGB, flattening transparency over white,
 *  2. pad to a square of max(w, h) with black (image at top-left),
 *  3. resize to 320x320 (BILINEAR),
 *  4. normalize to [0, 1] as CHW float32 in shape [1, 3, 320, 320].
 *
 * Returns the input tensor and the global scale ratio (max_size / 320).
 */
function preprocess(bitmap: ImageBitmap): { data: Float32Array; ratio: number } {
  const { width, height } = bitmap;
  const maxSize = Math.max(width, height);
  const scale = IMG_SIZE / maxSize;
  const drawWidth = Math.max(1, Math.round(width * scale));
  const drawHeight = Math.max(1, Math.round(height * scale));

  // Draw straight into the 320x320 destination. The reference preprocessing
  // flattens transparency over white, pads to a square with black, then
  // resizes; materializing the white and padded canvases allocates up to
  // ~384 MB for an 8192x4096 input. Compositing in the destination keeps the
  // peak at one 320x320 canvas plus the decoded bitmap.
  const resized = new OffscreenCanvas(IMG_SIZE, IMG_SIZE);
  const resizedCtx = resized.getContext('2d', { willReadFrequently: true });
  if (!resizedCtx) throw new Error('Failed to get OffscreenCanvas 2D context');
  resizedCtx.imageSmoothingEnabled = true;
  resizedCtx.imageSmoothingQuality = 'high';
  resizedCtx.fillStyle = '#000000';
  resizedCtx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  resizedCtx.fillStyle = '#ffffff';
  resizedCtx.fillRect(0, 0, drawWidth, drawHeight);
  resizedCtx.drawImage(bitmap, 0, 0, drawWidth, drawHeight);

  const imageData = resizedCtx.getImageData(0, 0, IMG_SIZE, IMG_SIZE).data;
  const pixels = IMG_SIZE * IMG_SIZE;
  const data = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    data[i] = imageData[i * 4] / 255;
    data[pixels + i] = imageData[i * 4 + 1] / 255;
    data[2 * pixels + i] = imageData[i * 4 + 2] / 255;
  }

  return {
    data,
    ratio: maxSize / IMG_SIZE,
  };
}

export const handleNudeNet = async (payload: NudeNetPayload): Promise<NudeNetResult> => {
  const startedAt = Date.now();
  if (payload.model !== undefined && payload.model !== '320n') {
    throw new Error('NudeNet supports the 320n model only');
  }

  const topK = payload.topK ?? 100;
  const iouThreshold = payload.iouThreshold ?? 0.45;
  const scoreThreshold = payload.scoreThreshold ?? 0.25;
  if (!Number.isInteger(topK) || topK < 1 || topK > 1000) {
    throw new Error(`NudeNet topK must be an integer within 1..1000, got ${JSON.stringify(payload.topK)}`);
  }
  if (typeof iouThreshold !== 'number' || !Number.isFinite(iouThreshold) || iouThreshold < 0 || iouThreshold > 1) {
    throw new Error(`NudeNet iouThreshold must be a number within 0..1, got ${JSON.stringify(payload.iouThreshold)}`);
  }
  if (typeof scoreThreshold !== 'number' || !Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
    throw new Error(`NudeNet scoreThreshold must be a number within 0..1, got ${JSON.stringify(payload.scoreThreshold)}`);
  }

  const bitmap = await loadImage(payload);
  try {
    const { data, ratio } = preprocess(bitmap);
    return await handleFriedFlaxiaNudeNet(data, ratio, {
      ...payload,
      topK,
      iouThreshold,
      scoreThreshold,
    });
  } finally {
    bitmap.close();
  }
};

export function releaseCache(): void {
  releaseFriedFlaxiaNudeNet();
}
