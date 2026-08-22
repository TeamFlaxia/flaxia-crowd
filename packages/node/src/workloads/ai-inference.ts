import { env, pipeline, TextStreamer } from '@huggingface/transformers';
import type { AiInferencePayload, AiInferenceResult, AiInferenceOptions } from '@flaxia/sdk';

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
  onToken: (token: string) => void,
  options: AiInferenceOptions,
): ((text: string) => void) => {
  if (!options.tokenBuffer) return onToken;

  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const interval = options.tokenBufferIntervalMs ?? 50;

  const flush = () => {
    if (buffer) {
      onToken(buffer);
      buffer = '';
    }
    timer = null;
  };

  return (text: string) => {
    buffer += text;
    if (!timer) {
      timer = setTimeout(flush, interval);
    }
  };
};

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
  onToken?: (token: string) => void,
): Promise<AiInferenceResult> => {
  const { task, model, input, options = {} } = payload;

  if (!SUPPORTED_TASKS.includes(task as any)) {
    throw new Error(`Invalid or unsupported task: ${task}. Supported tasks are: ${SUPPORTED_TASKS.join(', ')}`);
  }

  const cacheKey = `${task}:${model}`;
  let generator = pipelineCache.get(cacheKey);
  if (!generator) {
    // Bound the cache so a stream of distinct models cannot grow without limit.
    if (pipelineCache.size >= MAX_CACHED_PIPELINES) {
      const oldestKey = pipelineCache.keys().next().value as string;
      pipelineCache.delete(oldestKey);
    }
    const pipelineOpts: Record<string, unknown> = {
      dtype: options.dtype ?? 'q4f16',
      device: options.device,
    };
    const loadStartedAt = performance.now();
    console.log(`[flaxia-node] ai-inference: loading pipeline task=${task} model=${model} dtype=${pipelineOpts.dtype} device=${pipelineOpts.device ?? 'wasm'}`);
    try {
      generator = await pipeline(task as any, model, pipelineOpts);
    } catch (err) {
      if (options.device && options.device !== 'wasm') {
        console.warn(`[AiInference] ${options.device} failed, falling back to wasm:`, err);
        pipelineOpts.device = 'wasm';
        generator = await pipeline(task as any, model, pipelineOpts);
      } else {
        console.error(
          `[flaxia-node] ai-inference: pipeline load FAILED task=${task} model=${model} error=${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }
    console.log(
      `[flaxia-node] ai-inference: pipeline ready task=${task} model=${model} loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    pipelineCache.set(cacheKey, generator);
  }

  const genOptions: Record<string, unknown> = {
    max_new_tokens: options.max_new_tokens ?? 128,
    do_sample: options.do_sample ?? false,
  };

  if (options.temperature != null) genOptions.temperature = options.temperature;
  if (options.top_p != null) genOptions.top_p = options.top_p;
  if (options.top_k != null) genOptions.top_k = options.top_k;
  if (options.repetition_penalty != null) genOptions.repetition_penalty = options.repetition_penalty;
  if (options.src_lang != null) genOptions.src_lang = options.src_lang;
  if (options.tgt_lang != null) genOptions.tgt_lang = options.tgt_lang;

  if (onToken && generator.tokenizer) {
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: createBufferedTokenCallback(onToken, options),
    });
    genOptions.streamer = streamer;
  }

  const inputStart = performance.now();
  const output = await generator(input, genOptions);
  console.log(
    `[flaxia-node] ai-inference: done task=${task} model=${model} execMs=${Math.round(performance.now() - inputStart)} inputLen=${String(input).length}`,
  );
  return { output };
};