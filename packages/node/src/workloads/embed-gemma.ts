import {
  EMBED_GEMMA_HF_MODEL,
  EMBED_GEMMA_MODEL,
  EMBED_GEMMA_NATIVE_DIMENSIONS,
  MAX_EMBED_GEMMA_TEXT_CHARS,
  MAX_EMBED_GEMMA_TEXTS,
  MAX_EMBED_GEMMA_TOTAL_CHARS,
  isEmbedGemmaDimensions,
  type EmbedGemmaPayload,
  type EmbedGemmaResult,
} from '@flaxia/sdk';

/** Texts passed to one model call. Four ~500-token texts stay under the 2,700-token WebGPU dispatch limit. */
export const EMBED_GEMMA_BATCH_SIZE = 4;

interface LoadedModel {
  processor: any;
  model: any;
  device: 'webgpu' | 'wasm';
  dtype: 'q8' | 'fp16';
}

let loaded: LoadedModel | null = null;

export const releaseCache = (): void => {
  loaded = null;
};

function fail(message: string): never {
  throw new Error(`embed-gemma: ${message}`);
}

function validatePayload(payload: EmbedGemmaPayload): { texts: string[]; dimensions: number } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('payload must be an object');
  const texts = payload.texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBED_GEMMA_TEXTS) {
    fail(`texts must contain 1..${MAX_EMBED_GEMMA_TEXTS} strings`);
  }
  let totalChars = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) fail('each text must be a non-empty string');
    if (text.length > MAX_EMBED_GEMMA_TEXT_CHARS) {
      fail(`each text must be at most ${MAX_EMBED_GEMMA_TEXT_CHARS} characters`);
    }
    totalChars += text.length;
  }
  if (totalChars > MAX_EMBED_GEMMA_TOTAL_CHARS) fail(`texts exceed ${MAX_EMBED_GEMMA_TOTAL_CHARS} characters in total`);
  const dimensions = payload.dimensions ?? EMBED_GEMMA_NATIVE_DIMENSIONS;
  if (!isEmbedGemmaDimensions(dimensions)) fail(`dimensions must be one of 768, 512, 256, 128`);
  return { texts, dimensions };
}

function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

async function loadModel(device: 'webgpu' | 'wasm'): Promise<LoadedModel> {
  const loadStartedAt = performance.now();
  const dtype: 'q8' | 'fp16' = device === 'webgpu' ? 'q8' : 'fp16';
  console.log(`[flaxia-node] embed-gemma: loading model=${EMBED_GEMMA_MODEL} device=${device} dtype=${dtype}`);
  const { AutoConfig, AutoModel, AutoProcessor, env } = await import('@huggingface/transformers');
  if (env?.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }

  const config = await AutoConfig.from_pretrained(EMBED_GEMMA_MODEL);
  // Text-only: skip the 170M vision and 300M audio encoders entirely.
  (config as any).vision_config = null;
  (config as any).audio_config = null;

  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(EMBED_GEMMA_MODEL),
    AutoModel.from_pretrained(EMBED_GEMMA_MODEL, { config, device, dtype } as any),
  ]);
  console.log(
    `[flaxia-node] embed-gemma: model ready device=${device} dtype=${dtype} loadMs=${Math.round(performance.now() - loadStartedAt)}`,
  );
  return { processor, model, device, dtype };
}

async function getModel(): Promise<LoadedModel> {
  if (loaded) return loaded;
  if (hasWebGpu()) {
    try {
      loaded = await loadModel('webgpu');
      return loaded;
    } catch (error) {
      console.warn(
        `[flaxia-node] embed-gemma: WebGPU load failed, falling back to WASM fp16: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  loaded = await loadModel('wasm');
  return loaded;
}

/** Matryoshka truncation requires re-normalising the prefix. */
function truncateAndNormalize(vector: number[], dimensions: number): number[] {
  const out = vector.slice(0, dimensions);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  return out.map((value) => value / norm);
}

async function embedBatch(model: LoadedModel, texts: string[], dimensions: number): Promise<number[][]> {
  const processed = await model.processor(texts);
  const output = await model.model(processed);
  const embedding = output?.sentence_embedding;
  if (!embedding || !embedding.data) {
    throw new Error('embed-gemma: model did not return sentence_embedding');
  }
  const data = Array.from(embedding.data as Float32Array) as number[];
  const expected = texts.length * EMBED_GEMMA_NATIVE_DIMENSIONS;
  if (data.length !== expected) {
    throw new Error(`embed-gemma: expected ${expected} embedding values, received ${data.length}`);
  }
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const start = index * EMBED_GEMMA_NATIVE_DIMENSIONS;
    const native = data.slice(start, start + EMBED_GEMMA_NATIVE_DIMENSIONS);
    vectors.push(truncateAndNormalize(native, dimensions));
  }
  return vectors;
}

export async function handleEmbedGemma(payload: EmbedGemmaPayload): Promise<EmbedGemmaResult> {
  const startedAt = performance.now();
  const { texts, dimensions } = validatePayload(payload);
  const model = await getModel();

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_GEMMA_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_GEMMA_BATCH_SIZE);
    vectors.push(...(await embedBatch(model, batch, dimensions)));
  }

  return {
    vectors,
    model: EMBED_GEMMA_HF_MODEL,
    dimensions,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
