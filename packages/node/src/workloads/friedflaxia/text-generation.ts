import type { AiInferencePayload, AiInferenceResult } from '@flaxia/sdk';
import { OndeviceUnavailableError } from '@flaxia/sdk';
import { MAX_AI_INPUT_CHARS } from '../ai-model-registry';
import { FRIEDFLAXIA_PLAMO, downloadPinnedModel } from './model-registry';
import { initFriedFlaxiaWasm } from '../../vendor/friedflaxia/init';
import type { PlamoModel } from '../../vendor/friedflaxia/types';

export type { PlamoModel } from '../../vendor/friedflaxia/types';

const ALLOWED_MODELS = new Set([
  FRIEDFLAXIA_PLAMO.modelId,
  'pfnet/plamo-3-translate-0.8b',
]);

let model: PlamoModel | null = null;
let modelLoad: Promise<PlamoModel> | null = null;

export const isPlamoLoaded = (): boolean => model !== null;

export async function loadFriedFlaxiaPlamo(): Promise<PlamoModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  const loadStartedAt = performance.now();
  modelLoad = (async () => {
    const wasmStartedAt = performance.now();
    await initFriedFlaxiaWasm();
    const wasmMs = performance.now() - wasmStartedAt;
    const downloadStartedAt = performance.now();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_PLAMO);
    const downloadMs = performance.now() - downloadStartedAt;
    const constructStartedAt = performance.now();
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded: PlamoModel = new Model(bytes);
    const constructMs = performance.now() - constructStartedAt;
    console.log(
      `[flaxia-node:worker] model load modelId=${FRIEDFLAXIA_PLAMO.modelId} bytes=${bytes.byteLength} ` +
        `wasmMs=${Math.round(wasmMs)} downloadMs=${Math.round(downloadMs)} constructMs=${Math.round(constructMs)} ` +
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
  onToken?: (token: string) => void | Promise<void>,
): Promise<AiInferenceResult> {
  const { input, maxNewTokens } = assertPlamoPayload(payload);
  const prompt = plamo.encode(input, true);
  let generated: Uint32Array;
  if (plamo.generate_stream && onToken) {
    // The vendored wasm export is `generate_stream`. It awaits the callback
    // between tokens, so the worker can throttle, abort and send heartbeats.
    generated = await plamo.generate_stream(prompt, maxNewTokens, async (token) => {
      const text = plamo.decode(Uint32Array.from([token]));
      if (text) await onToken(text);
    });
  } else {
    generated = plamo.generate(prompt, maxNewTokens);
    // Older vendored wasm builds have no streaming entry point; still deliver
    // the text once so subscribers are not left without any token event.
    if (onToken) {
      const text = plamo.decode(generated);
      if (text) await onToken(text);
    }
  }
  const text = plamo.decode(generated);
  return { output: [{ generated_text: text }] };
}

export async function handleFriedFlaxiaTextGeneration(
  payload: AiInferencePayload,
  onToken?: (token: string) => void | Promise<void>,
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
  const result = await generateWithModel(
    plamo,
    {
      ...payload,
      input,
      options: { ...payload.options, max_new_tokens: maxNewTokens },
    },
    onToken,
  );
  console.log(
    `[flaxia-node] friedflaxia: PLaMO done execMs=${Math.round(performance.now() - startedAt)} maxNewTokens=${maxNewTokens}`,
  );
  return result;
}
