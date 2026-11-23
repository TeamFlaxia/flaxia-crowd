import type { NodeModelCacheSnapshot } from '@flaxia/sdk';
import { THEIA_DLLM_MODEL_ID } from '@flaxia/sdk';
import { FRIEDFLAXIA_DLLM, downloadPinnedModel } from './model-registry';
import { initFriedFlaxiaWasm } from '../../vendor/friedflaxia/init';
import type { DllmModel } from '../../vendor/friedflaxia/types';

/**
 * Base masked-diffusion model used by `theia-inference`.
 *
 * Theia's v1 experts are LoRA adapters over this one base; until the adapters
 * are distributed (T5) the executor serves the base model only. The model is
 * pinned by URL and SHA-256 in `model-manifest.json`.
 */

let model: DllmModel | null = null;
let modelLoad: Promise<DllmModel> | null = null;

export async function loadFriedFlaxiaDllm(): Promise<DllmModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  const loadStartedAt = performance.now();
  modelLoad = (async () => {
    await initFriedFlaxiaWasm();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_DLLM);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new Model(bytes) as DllmModel;
    console.log(
      `[flaxia-node:worker] model load modelId=${FRIEDFLAXIA_DLLM.modelId} bytes=${bytes.byteLength} ` +
        `totalMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
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

export const isDllmLoaded = (): boolean => model !== null;

/** Cache snapshot entry for the resident base dLLM (empty when cold). */
export function getDllmCacheSnapshot(): NodeModelCacheSnapshot {
  const sampledAt = Date.now();
  return {
    version: 1,
    sampledAt,
    expiresAt: sampledAt + 60_000,
    entries: isDllmLoaded()
      ? [
          {
            modelId: THEIA_DLLM_MODEL_ID,
            revision: FRIEDFLAXIA_DLLM.revision,
            dtype: 'q4_0',
            backend: 'wasm',
            state: 'ready',
            referenceCount: 1,
          },
        ]
      : [],
  };
}
