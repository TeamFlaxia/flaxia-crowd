import type { NudeNetDetection, NudeNetPayload, NudeNetResult } from '@flaxia/sdk';
import { FRIEDFLAXIA_NUDENET, downloadPinnedModel } from './model-registry';
import { NUDENET_LABELS } from '../nudenet-labels';

interface NudeNetModel {
  detect(input: Float32Array, topK: number, iouThreshold: number, scoreThreshold: number): Float32Array;
  free(): void;
}

let wasmReady: Promise<void> | null = null;
let model: NudeNetModel | null = null;
let modelLoad: Promise<NudeNetModel> | null = null;

async function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const [glue, wasmUrl] = await Promise.all([
        import('../../vendor/friedflaxia/friedflaxia_wasm.js'),
        import('../../vendor/friedflaxia/friedflaxia_wasm_bg.wasm?url'),
      ]);
      await glue.default(wasmUrl.default);
    })();
  }
  return wasmReady;
}

export async function loadFriedFlaxiaNudeNet(): Promise<NudeNetModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  modelLoad = (async () => {
    await initWasm();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_NUDENET);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new Model(bytes) as unknown as NudeNetModel;
    model = loaded;
    return loaded;
  })().catch((error) => {
    modelLoad = null;
    throw error;
  });
  return modelLoad;
}

export const releaseCache = (): void => {
  const current = model;
  model = null;
  modelLoad = null;
  try {
    current?.free();
  } catch {}
};

/**
 * Convert the wasm flat rows `[x1, y1, x2, y2, score, labelIndex]` to the
 * public detection shape, scaling from the 320px model grid to the input image.
 */
export function detectionsFromFlat(flat: ArrayLike<number>, ratio: number): NudeNetDetection[] {
  const detections: NudeNetDetection[] = [];
  for (let offset = 0; offset + 6 <= flat.length; offset += 6) {
    const labelIndex = Math.round(flat[offset + 5]);
    const label = NUDENET_LABELS[labelIndex];
    if (!label) continue;
    detections.push({
      label,
      score: flat[offset + 4],
      box: [
        Math.round(flat[offset] * ratio),
        Math.round(flat[offset + 1] * ratio),
        Math.round(flat[offset + 2] * ratio),
        Math.round(flat[offset + 3] * ratio),
      ],
    });
  }
  return detections;
}

export async function handleFriedFlaxiaNudeNet(
  input: Float32Array,
  ratio: number,
  payload: NudeNetPayload,
): Promise<NudeNetResult> {
  const startedAt = performance.now();
  const net = await loadFriedFlaxiaNudeNet();
  const flat = net.detect(input, payload.topK ?? 100, payload.iouThreshold ?? 0.45, payload.scoreThreshold ?? 0.25);
  return {
    detections: detectionsFromFlat(flat, ratio),
    durationMs: Math.round(performance.now() - startedAt),
  };
}
