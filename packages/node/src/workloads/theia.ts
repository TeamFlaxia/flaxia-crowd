import type { TheiaInferencePayload, TheiaInferenceResult } from '@flaxia/sdk';
import { isTheiaInferencePayload } from '@flaxia/sdk';
import { THEIA_MAX_CANVAS_CHARS } from './friedflaxia/theia';
import type { DllmModel } from '../vendor/friedflaxia/types';
import { runTheiaInference } from './friedflaxia/theia';
import { DLLM_MODEL_ID, loadFriedFlaxiaDllm } from './friedflaxia/dllm';

/**
 * `theia-inference` node entry point.
 *
 * The payload arrives from the worker, so it is validated with the same SDK
 * guard the host/worker uses. The executor is pure over an injected model, so
 * tests do not need the wasm build.
 */
export async function handleTheiaInference(
  payload: unknown,
  onStep?: () => void | Promise<void>,
  model?: DllmModel,
): Promise<TheiaInferenceResult> {
  if (!isTheiaInferencePayload(payload)) {
    throw new Error('theia-inference: invalid payload');
  }
  // Reject an oversized canvas before downloading the 342 MB model.
  const candidate = payload as { canvas?: { text?: unknown } };
  if (typeof candidate.canvas?.text === 'string' && candidate.canvas.text.length > THEIA_MAX_CANVAS_CHARS) {
    throw new Error(`theia-inference: canvas text exceeds ${THEIA_MAX_CANVAS_CHARS} characters`);
  }
  const loaded = model ?? (await loadFriedFlaxiaDllm());
  return runTheiaInference(loaded, payload as TheiaInferencePayload, { onStep, modelId: DLLM_MODEL_ID });
}

export {
  releaseCache,
  getDllmCacheSnapshot as getModelCacheSnapshot,
} from './friedflaxia/dllm';
