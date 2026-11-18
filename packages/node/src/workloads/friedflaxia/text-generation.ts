import type { AiInferencePayload, AiInferenceResult } from '@flaxia/sdk';
import { OndeviceUnavailableError } from '@flaxia/sdk';
import { MAX_AI_INPUT_CHARS } from '../ai-model-registry';
import { FRIEDFLAXIA_PLAMO, downloadPinnedModel } from './model-registry';

/** Minimal surface of the vendored wasm PLaMO model. */
export interface PlamoModel {
  encode(text: string, addSpecialTokens: boolean): Uint32Array;
  decode(ids: Uint32Array | number[]): string;
  generate(promptIds: Uint32Array, maxTokens: number): Uint32Array;
  free(): void;
}

const ALLOWED_MODELS = new Set([
  FRIEDFLAXIA_PLAMO.modelId,
  'pfnet/plamo-3-translate-0.8b',
]);

let wasmReady: Promise<void> | null = null;
let model: PlamoModel | null = null;
let modelLoad: Promise<PlamoModel> | null = null;

export const isPlamoLoaded = (): boolean => model !== null;

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

export async function loadFriedFlaxiaPlamo(): Promise<PlamoModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  modelLoad = (async () => {
    await initWasm();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_PLAMO);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new Model(bytes) as unknown as PlamoModel;
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

export function assertPlamoPayload(payload: AiInferencePayload): { input: string; maxNewTokens: number } {
  if (payload.task !== 'text-generation') {
    throw new Error('friedflaxia: PLaMO supports text-generation only');
  }
  if (!ALLOWED_MODELS.has(payload.model)) {
    throw new Error(`friedflaxia: model ${payload.model} is not the pinned PLaMO translation model`);
  }
  if (typeof payload.input !== 'string' || payload.input.length === 0) {
    throw new Error('friedflaxia: text-generation input must be a non-empty string');
  }
  if (payload.input.length > MAX_AI_INPUT_CHARS) {
    throw new Error(`friedflaxia: input exceeds ${MAX_AI_INPUT_CHARS} characters`);
  }
  if (payload.options?.do_sample === true) {
    throw new Error('friedflaxia: PLaMO generation currently supports greedy decoding only');
  }
  const requested = payload.options?.max_new_tokens;
  const maxNewTokens = requested === undefined ? 512 : requested;
  if (typeof maxNewTokens !== 'number' || !Number.isInteger(maxNewTokens) || maxNewTokens < 1 || maxNewTokens > 1024) {
    throw new Error('friedflaxia: max_new_tokens must be an integer within 1..1024');
  }
  return { input: payload.input, maxNewTokens };
}

export async function generateWithModel(
  plamo: PlamoModel,
  payload: AiInferencePayload,
): Promise<AiInferenceResult> {
  const { input, maxNewTokens } = assertPlamoPayload(payload);
  const prompt = plamo.encode(input, true);
  const generated = plamo.generate(prompt, maxNewTokens);
  const text = plamo.decode(generated);
  return { output: [{ generated_text: text }] };
}

export async function handleFriedFlaxiaTextGeneration(
  payload: AiInferencePayload,
): Promise<AiInferenceResult> {
  const { input, maxNewTokens } = assertPlamoPayload(payload);
  if (payload.options?.ondeviceOnly && !model) {
    throw new OndeviceUnavailableError(
      'ondeviceOnly: the PLaMO FriedFlaxia model is not preloaded on this device',
      'preloading',
    );
  }
  const plamo = await loadFriedFlaxiaPlamo();
  const startedAt = performance.now();
  const result = await generateWithModel(plamo, {
    ...payload,
    input,
    options: { ...payload.options, max_new_tokens: maxNewTokens },
  });
  console.log(
    `[flaxia-node] friedflaxia: PLaMO done execMs=${Math.round(performance.now() - startedAt)} maxNewTokens=${maxNewTokens}`,
  );
  return result;
}
