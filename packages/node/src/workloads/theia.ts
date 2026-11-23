import type { TheiaInferencePayload, TheiaInferenceResult } from '@flaxia/sdk';
import { isTheiaInferencePayload } from '@flaxia/sdk';
import type { DllmModel } from '../vendor/friedflaxia/types';
import { runTheiaInference } from './friedflaxia/theia';
import { loadFriedFlaxiaDllm } from './friedflaxia/dllm';

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
  const loaded = model ?? (await loadFriedFlaxiaDllm());
  return runTheiaInference(loaded, payload as TheiaInferencePayload, { onStep });
}

export {
  releaseCache,
  getDllmCacheSnapshot as getModelCacheSnapshot,
} from './friedflaxia/dllm';
