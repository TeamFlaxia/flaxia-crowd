import type { NudeNetDetection, NudeNetPayload, NudeNetResult } from '@flaxia/sdk';
import * as ort from 'onnxruntime-web';
import { fetchGuarded } from '../executor/egress-guard';

const IMG_SIZE = 320;
const ORT_WASM_VERSION = '1.26.0';

const MODEL_URL = 'https://huggingface.co/deepghs/nudenet_onnx/resolve/main/320n.onnx';
const NMS_MODEL_URL = 'https://huggingface.co/deepghs/nudenet_onnx/resolve/main/nms-yolov8.onnx';

/** Hard caps for the inputs this workload accepts. */
export const MAX_NUDENET_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_NUDENET_MODEL_BYTES = 512 * 1024 * 1024;
/** Content types accepted for a customer-supplied image URL. */
export const NUDENET_IMAGE_CONTENT_TYPES = ['image/*', 'application/octet-stream'] as const;
/** Content types the fixed model registry is served with. */
const MODEL_CONTENT_TYPES = ['application/octet-stream', 'application/wasm'] as const;

/**
 * NudeNet class labels, in the exact order used by the 320n YOLOv8 export
 * (deepghs/nudenet_onnx / official NudeNet v3.4.2).
 */
const LABELS = [
  'FEMALE_GENITALIA_COVERED',
  'FACE_FEMALE',
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'ANUS_EXPOSED',
  'FEET_EXPOSED',
  'BELLY_COVERED',
  'FEET_COVERED',
  'ARMPITS_COVERED',
  'ARMPITS_EXPOSED',
  'FACE_MALE',
  'BELLY_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_COVERED',
  'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
] as const;

let ortConfigured = false;

export function configureOrt(): void {
  if (ortConfigured) return;
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WASM_VERSION}/dist/`;
  // Force single-threaded wasm. Multithreaded mode (only active when the page
  // is crossOriginIsolated, via SharedArrayBuffer) spawns one internal Web
  // Worker per CPU core. On low-memory mobile devices this both OOMs / crashes
  // the renderer and balloons the Web Worker count. Single-threaded is safe.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ortConfigured = true;
}

const sessionCache = new Map<string, Promise<ort.InferenceSession>>();

function getSession(url: string): Promise<ort.InferenceSession> {
  let cached = sessionCache.get(url);
  if (!cached) {
    cached = (async () => {
      const modelName = url.split('/').pop() ?? url;
      const startedAt = performance.now();
      console.log(`[flaxia-node] nudenet: downloading model ${modelName}`);
      // The model URLs are fixed constants, but they are still fetched through
      // the egress guard so protocol/host/redirect/type/size stay enforced.
      const res = await fetchGuarded({
        url,
        allowContentTypes: MODEL_CONTENT_TYPES,
        maxBytes: MAX_NUDENET_MODEL_BYTES,
      });
      if (!res.ok) throw new Error(`Failed to download ONNX model: ${url} (HTTP ${res.status})`);
      const buffer = res.bytes;
      console.log(
        `[flaxia-node] nudenet: model loaded ${modelName} bytes=${buffer.byteLength} downloadMs=${Math.round(performance.now() - startedAt)}`,
      );
      const sessionStartedAt = performance.now();
      const session = await ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
      console.log(
        `[flaxia-node] nudenet: session ready ${modelName} sessionMs=${Math.round(performance.now() - sessionStartedAt)}`,
      );
      return session;
    })();
    sessionCache.set(url, cached);
  }
  return cached;
}

async function loadImage(payload: NudeNetPayload): Promise<ImageBitmap> {
  let blob: Blob;
  if (payload.imageBase64) {
    const mimeType = payload.mimeType || 'image/jpeg';
    const res = await fetch(`data:${mimeType};base64,${payload.imageBase64}`);
    blob = await res.blob();
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
  return createImageBitmap(blob);
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
function preprocess(bitmap: ImageBitmap): { tensor: ort.Tensor; ratio: number } {
  const { width, height } = bitmap;
  const maxSize = Math.max(width, height);

  const whiteBg = new OffscreenCanvas(width, height);
  const whiteCtx = whiteBg.getContext('2d');
  if (!whiteCtx) throw new Error('Failed to get OffscreenCanvas 2D context');
  whiteCtx.fillStyle = '#ffffff';
  whiteCtx.fillRect(0, 0, width, height);
  whiteCtx.drawImage(bitmap, 0, 0);

  const padded = new OffscreenCanvas(maxSize, maxSize);
  const padCtx = padded.getContext('2d');
  if (!padCtx) throw new Error('Failed to get OffscreenCanvas 2D context');
  padCtx.fillStyle = '#000000';
  padCtx.fillRect(0, 0, maxSize, maxSize);
  padCtx.drawImage(whiteBg, 0, 0);

  const resized = new OffscreenCanvas(IMG_SIZE, IMG_SIZE);
  const resizedCtx = resized.getContext('2d', { willReadFrequently: true });
  if (!resizedCtx) throw new Error('Failed to get OffscreenCanvas 2D context');
  resizedCtx.imageSmoothingEnabled = true;
  resizedCtx.imageSmoothingQuality = 'high';
  resizedCtx.drawImage(padded, 0, 0, IMG_SIZE, IMG_SIZE);

  const imageData = resizedCtx.getImageData(0, 0, IMG_SIZE, IMG_SIZE).data;
  const pixels = IMG_SIZE * IMG_SIZE;
  const data = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    data[i] = imageData[i * 4] / 255;
    data[pixels + i] = imageData[i * 4 + 1] / 255;
    data[2 * pixels + i] = imageData[i * 4 + 2] / 255;
  }

  return {
    tensor: new ort.Tensor('float32', data, [1, 3, IMG_SIZE, IMG_SIZE]),
    ratio: maxSize / IMG_SIZE,
  };
}

/**
 * Mirrors `_nn_postprocess`: for each NMS row, box is xywh normalized to the
 * 320px grid (scaled by ratio), score is the max across classes, label the argmax.
 */
function decode(selected: ort.Tensor, ratio: number): NudeNetDetection[] {
  const dims = selected.dims;
  if (dims.length < 2) return [];
  const numBoxes = dims[1];
  const rowSize = dims.length >= 3 ? dims[2] : 22;
  const data = selected.data as Float32Array;

  const detections: NudeNetDetection[] = [];
  for (let i = 0; i < numBoxes; i++) {
    const offset = i * rowSize;
    if (offset + 22 > data.length) continue;

    let label = 0;
    let score = -Infinity;
    for (let c = 0; c < LABELS.length; c++) {
      const s = data[offset + 4 + c];
      if (s > score) {
        score = s;
        label = c;
      }
    }
    if (score <= 0 || !isFinite(score)) continue;

    const cx = data[offset] * ratio;
    const cy = data[offset + 1] * ratio;
    const w = data[offset + 2] * ratio;
    const h = data[offset + 3] * ratio;

    detections.push({
      label: LABELS[label],
      score,
      box: [Math.round(cx - 0.5 * w), Math.round(cy - 0.5 * h), Math.round(cx + 0.5 * w), Math.round(cy + 0.5 * h)],
    });
  }
  return detections;
}

export const handleNudeNet = async (payload: NudeNetPayload): Promise<NudeNetResult> => {
  const startedAt = Date.now();
  configureOrt();

  const topK = payload.topK ?? 100;
  const iouThreshold = payload.iouThreshold ?? 0.45;
  const scoreThreshold = payload.scoreThreshold ?? 0.25;

  const bitmap = await loadImage(payload);
  try {
    const { tensor, ratio } = preprocess(bitmap);

    const startedAtMs = performance.now();
    const [yoloSession, nmsSession] = await Promise.all([getSession(MODEL_URL), getSession(NMS_MODEL_URL)]);
    console.log(`[flaxia-node] nudenet: sessions ready loadMs=${Math.round(performance.now() - startedAtMs)}`);

    const runStartedAt = performance.now();
    const { output0 } = await yoloSession.run({ images: tensor });
    const config = new ort.Tensor('float32', new Float32Array([topK, iouThreshold, scoreThreshold]), [3]);
    const { selected } = await nmsSession.run({ detection: output0, config });

    const detections = decode(selected as ort.Tensor, ratio);
    console.log(
      `[flaxia-node] nudenet: done detections=${detections.length} inferMs=${Math.round(performance.now() - runStartedAt)} totalMs=${Math.round(performance.now() - startedAt)}`,
    );
    return { detections, durationMs: Date.now() - startedAt };
  } finally {
    bitmap.close();
  }
};

export function releaseCache(): void {
  sessionCache.clear();
}