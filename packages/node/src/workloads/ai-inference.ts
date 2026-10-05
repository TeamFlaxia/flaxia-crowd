import { env, pipeline, TextStreamer } from '@huggingface/transformers';
import type { AiInferencePayload, AiInferenceResult, AiInferenceOptions } from '@flaxia/sdk';
import {
  MAX_AI_MODEL_MAX_BYTES,
  applyGenerationOptions,
  assertAiInput,
  resolveAiDevice,
  resolveAiDtype,
  resolveAiModel,
  type AiModelDefinition,
} from './ai-model-registry';

// Re-exported so hosts configure the allowlist through the workload module they
// already import (`@flaxia/node`'s public entry point stays untouched).
export {
  DEFAULT_AI_MODEL_MAX_BYTES,
  MAX_AI_MODEL_MAX_BYTES,
  MAX_AI_INPUT_CHARS,
  MAX_AI_INPUT_ITEMS,
  ALLOWED_AI_DEVICES,
  ALLOWED_AI_DTYPES,
  listAiModels,
  registerAiModels,
  unregisterAiModel,
  type AiModelDefinition,
} from './ai-model-registry';

const SUPPORTED_TASKS = [
  'text-classification', 'token-classification', 'question-answering', 'fill-mask',
  'summarization', 'translation', 'text2text-generation', 'text-generation',
  'zero-shot-classification', 'audio-classification', 'zero-shot-audio-classification',
  'automatic-speech-recognition', 'text-to-audio', 'image-to-text', 'image-classification',
  'image-segmentation', 'background-removal', 'zero-shot-image-classification',
  'object-detection', 'zero-shot-object-detection', 'document-question-answering',
  'image-to-image', 'depth-estimation', 'feature-extraction', 'image-feature-extraction'
] as const;

const pipelineCache = new Map<string, any>();
const MAX_CACHED_PIPELINES = 2;

/**
 * Drops all cached model pipelines so the (potentially hundreds of MB of)
 * transformers/onnxruntime memory can be garbage-collected. Called by the
 * worker after an idle period so a node does not pin every model it ever saw.
 */
export const releaseCache = (): void => {
  pipelineCache.clear();
};

const createBufferedTokenCallback = (
  onToken: (token: string) => void | Promise<void>,
  options: AiInferenceOptions,
): { callback: (text: string) => void; finish: () => Promise<void>; cancel: () => Promise<void> } => {
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> = Promise.resolve();
  let failure: unknown;
  let failed = false;
  let closed = false;

  const dispatch = (text: string): void => {
    // TextStreamer invokes callbacks synchronously. Queue each async sink call
    // in order, retaining failures for the inference promise instead of leaving
    // a rejected promise behind in a timer callback.
    pending = pending.then(() => {
      if (!failed) return onToken(text);
    }).then(
      () => undefined,
      (error: unknown) => { failed = true; failure = error; },
    );
  };
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const text = buffer;
    buffer = '';
    if (text && !failed) dispatch(text);
  };
  const callback = (text: string): void => {
    if (closed) return;
    if (failed) throw failure;
    if (!options.tokenBuffer) {
      dispatch(text);
      return;
    }
    buffer += text;
    if (timer === null) timer = setTimeout(flush, options.tokenBufferIntervalMs ?? 50);
  };
  const settle = async (emitTail: boolean): Promise<void> => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (emitTail && !failed) flush();
    else buffer = '';
    await pending;
    if (failed) throw failure;
  };
  return { callback, finish: () => settle(true), cancel: () => settle(false) };
};

/**
 * Hosts on the download path of a registered model are the only ones the node
 * will talk to, and a single file may never exceed the registry's `maxBytes`.
 * transformers.js honours `env.fetch`, so this wrapper bounds what a load can
 * pull even if a repository grows after it was allowlisted.
 */
function installModelFetchGuard(): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  env.fetch = async (input: string | URL, init?: any): Promise<Response> => {
    const url = new URL(String(input));
    if (!/(^|\.)huggingface\.co$/.test(url.hostname) && !/(^|\.)hf\.co$/.test(url.hostname)) {
      throw new Error(`ai-inference: model download blocked from ${url.hostname}`);
    }
    const response = await nativeFetch(url, init);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_AI_MODEL_MAX_BYTES) {
      throw new Error(
        `ai-inference: model file too large (${declared} bytes > ${MAX_AI_MODEL_MAX_BYTES})`,
      );
    }
    return response;
  };
}

installModelFetchGuard();

// Always run single-threaded. Multithreaded wasm (only active when the page is
// crossOriginIsolated, via SharedArrayBuffer) spawns one internal Web Worker
// per CPU core, which OOMs / crashes low-memory mobile devices and balloons the
// worker count. Heavy workloads are still executed — just on a single thread —
// to stay safe on phones. Applied once at module load so the config is always
// in effect regardless of which entry point runs first.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

export const handleAiInference = async (
  payload: AiInferencePayload,
  onToken?: (token: string) => void | Promise<void>,
): Promise<AiInferenceResult> => {
  const { task, model, input, options = {} } = payload;

  if (!SUPPORTED_TASKS.includes(task as any)) {
    throw new Error(`Invalid or unsupported task: ${task}. Supported tasks are: ${SUPPORTED_TASKS.join(', ')}`);
  }

  // Fail closed before any download: the payload's model id must resolve to a
  // node-side registry entry, and its options must be safe combinations.
  const definition: AiModelDefinition = resolveAiModel(model);
  const device = resolveAiDevice(options.device);
  const dtype = resolveAiDtype(options.dtype);
  const safeInput = assertAiInput(input);
  const generationOptions: Record<string, unknown> = {};
  applyGenerationOptions(generationOptions, options as Record<string, unknown>);

  const cacheKey = `${task}:${definition.repo}:${dtype ?? 'q4f16'}:${device ?? 'wasm'}`;
  let generator = pipelineCache.get(cacheKey);
  if (!generator) {
    // Bound the cache so a stream of distinct models cannot grow without limit.
    if (pipelineCache.size >= MAX_CACHED_PIPELINES) {
      const oldestKey = pipelineCache.keys().next().value as string;
      pipelineCache.delete(oldestKey);
    }
    const pipelineOpts: Record<string, unknown> = {
      dtype: dtype ?? 'q4f16',
      device,
    };
    const loadStartedAt = performance.now();
    console.log(`[flaxia-node] ai-inference: loading pipeline task=${task} model=${definition.repo} revision=${definition.revision} dtype=${pipelineOpts.dtype} device=${device ?? 'wasm'}`);
    try {
      generator = await pipeline(task as any, definition.repo, pipelineOpts);
    } catch (err) {
      if (device && device !== 'wasm') {
        console.warn(`[AiInference] ${device} failed, falling back to wasm:`, err);
        pipelineOpts.device = 'wasm';
        generator = await pipeline(task as any, definition.repo, pipelineOpts);
      } else {
        console.error(
          `[flaxia-node] ai-inference: pipeline load FAILED task=${task} model=${definition.repo} error=${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }
    console.log(
      `[flaxia-node] ai-inference: pipeline ready task=${task} model=${definition.repo} loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    pipelineCache.set(cacheKey, generator);
  }

  const genOptions: Record<string, unknown> = {
    max_new_tokens: (generationOptions.max_new_tokens as number | undefined) ?? 128,
    do_sample: (generationOptions.do_sample as boolean | undefined) ?? false,
  };
  for (const [key, value] of Object.entries(generationOptions)) {
    if (key === 'max_new_tokens' || key === 'do_sample') continue;
    genOptions[key] = value;
  }

  const tokens = onToken && generator.tokenizer
    ? createBufferedTokenCallback(onToken, options)
    : null;
  if (tokens) {
    genOptions.streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: tokens.callback,
    });
  }

  const inputStart = performance.now();
  let output: any;
  try {
    output = await generator(safeInput, genOptions);
  } catch (error) {
    // Drain in-flight sink calls, but do not emit a partial tail after a failed
    // generation. A sink failure takes precedence over a generator failure.
    if (tokens) await tokens.cancel();
    throw error;
  }
  await tokens?.finish();
  console.log(
    `[flaxia-node] ai-inference: done task=${task} model=${definition.repo} execMs=${Math.round(performance.now() - inputStart)} inputLen=${String(safeInput).length}`,
  );
  return { output };
};