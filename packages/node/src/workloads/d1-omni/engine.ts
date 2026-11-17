import type { DecisionAnswer, DecisionQuestion, DecisionQuestions } from '@flaxia/sdk';
import { resolveAiModel } from '../ai-model-registry';
import {
  D1_YES_NO,
  answerQuestion,
  encodePrompt,
  questionEntries,
  questionTypes,
  resolvePromptTokens,
  temperatureKey,
  type D1PromptTokens,
} from './prompt';

/**
 * Browser driver for d1-omni-600M on ONNX Runtime Web.
 *
 * The public model id stays `LiquidAI/d1-omni-600M` (wire compatibility with
 * the coordinator and Flaxia), but the registry points it at the ONNX
 * conversion `onnx-community/d1-omni-600M-ONNX`. The upstream repository only
 * ships PyTorch weights and Python remote code, which Transformers.js cannot
 * execute; the ONNX repo ships the split graphs and tokenizer this module
 * needs.
 *
 * Graph choice is deliberately WASM-safe: `model_*.onnx` and
 * `embed_tokens_quantized.onnx` contain `com.microsoft::GatherBlockQuantized`,
 * which onnxruntime-web only implements for WebGPU/WebNN. WASM therefore uses
 * `embed_tokens_fp16` + `decision_quantized` for every request (the q8
 * decision graph has no block-quantized node). WebGPU uses the same split
 * graphs so both devices share one code path.
 */

export const DECISION_ONNX_REPO = 'onnx-community/d1-omni-600M-ONNX';

const DECISION_AUDIO_SAMPLE_RATE = 16_000;
const DECISION_AUDIO_MIN_SAMPLES = 8_000;
const DECISION_AUDIO_MAX_SAMPLES = 30 * DECISION_AUDIO_SAMPLE_RATE;

/** Same batch budget as prompt.py (rows are packed so `count * longest` fits). */
const DECISION_BATCH_TOKEN_BUDGET = 32_768;

const DEFAULT_MAX_LENGTH = 16_384;
const DEFAULT_IMAGE_TEXT_LENGTH = 896;
const DEFAULT_AUDIO_TEXT_LENGTH = 15_360;

type DecisionDevice = 'webgpu' | 'wasm';

interface DecisionPrefix {
  data: Float32Array;
  length: number;
  dimensions: number;
}

interface DecisionEngine {
  device: DecisionDevice;
  repo: string;
  revision: string;
  maxLength: number;
  imageTextLength: number;
  audioTextLength: number;
  temperatures: Record<string, number>;
  tokenizer: any;
  tokens: D1PromptTokens;
  processor: any | null;
  vision: any | null;
  audio: any | null;
  embed: any;
  decision: any;
}

let engine: DecisionEngine | null = null;
let engineLoadPromise: Promise<DecisionEngine> | null = null;

function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

let downloadGuardInstalled = false;

/** Keep model downloads on Hugging Face and bound a single file by the registry's `maxBytes`. */
function installDownloadGuard(env: any, maxBytes: number): void {
  if (downloadGuardInstalled) return;
  downloadGuardInstalled = true;
  const inner = typeof env.fetch === 'function' ? env.fetch.bind(env) : globalThis.fetch.bind(globalThis);
  env.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const allowed = /(^|\.)huggingface\.co$/.test(url.hostname) || /(^|\.)hf\.co$/.test(url.hostname);
    if (!allowed) {
      throw new Error(`decision: model download blocked from ${url.hostname}`);
    }
    const response = await inner(url, init);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`decision: model file too large (${declared} bytes > ${maxBytes})`);
    }
    return response;
  };
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function loadEngine(device: DecisionDevice): Promise<DecisionEngine> {
  const loadStartedAt = performance.now();
  const definition = resolveAiModel('LiquidAI/d1-omni-600M');
  if (definition.repo !== DECISION_ONNX_REPO) {
    throw new Error(`decision: registry does not point at ${DECISION_ONNX_REPO}`);
  }
  const { AutoConfig, AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers');
  if (env?.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }
  installDownloadGuard(env, definition.maxBytes);

  const common = {
    revision: definition.revision,
    device,
    use_external_data_format: true,
  } as const;
  const created: any[] = [];
  try {
    console.log(
      `[flaxia-node] decision: loading model=${definition.repo} revision=${definition.revision} device=${device}`,
    );
    const config = await AutoConfig.from_pretrained(definition.repo, {
      revision: definition.revision,
    });
    const tokenizer = await AutoTokenizer.from_pretrained(definition.repo, {
      revision: definition.revision,
    });
    const tokens = resolvePromptTokens(tokenizer as any);
    const embed = await AutoModel.from_pretrained(definition.repo, {
      ...common,
      model_file_name: 'embed_tokens',
      dtype: 'fp16',
    } as any);
    created.push(embed);
    const decision = await AutoModel.from_pretrained(definition.repo, {
      ...common,
      model_file_name: 'decision',
      dtype: 'q8',
    } as any);
    created.push(decision);

    const d1 = (config as any)?.d1_omni ?? {};
    const loaded: DecisionEngine = {
      device,
      repo: definition.repo,
      revision: definition.revision,
      maxLength: readPositiveInt((config as any)?.max_length ?? d1.max_length, DEFAULT_MAX_LENGTH),
      imageTextLength: readPositiveInt(
        (config as any)?.image_text_length ?? d1.image_text_length,
        DEFAULT_IMAGE_TEXT_LENGTH,
      ),
      audioTextLength: readPositiveInt(
        (config as any)?.audio_text_length ?? d1.audio_text_length,
        DEFAULT_AUDIO_TEXT_LENGTH,
      ),
      temperatures: ((config as any)?.temperatures ?? d1.temperatures ?? {}) as Record<string, number>,
      tokenizer,
      tokens,
      processor: null,
      vision: null,
      audio: null,
      embed,
      decision,
    };
    console.log(
      `[flaxia-node] decision: model ready device=${device} loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    return loaded;
  } catch (error) {
    await Promise.all(
      created.map(async (session) => {
        try {
          await session?.dispose?.();
        } catch {}
      }),
    );
    throw error;
  }
}

async function getEngine(): Promise<DecisionEngine> {
  if (engine) return engine;
  if (engineLoadPromise) return engineLoadPromise;
  engineLoadPromise = (async () => {
    if (hasWebGpu()) {
      try {
        const loaded = await loadEngine('webgpu');
        engine = loaded;
        return loaded;
      } catch (error) {
        console.warn(
          `[flaxia-node] decision: WebGPU load failed, falling back to WASM: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const loaded = await loadEngine('wasm');
    engine = loaded;
    return loaded;
  })().catch((error) => {
    engineLoadPromise = null;
    console.error(
      `[flaxia-node] decision: model load FAILED error=${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  });
  return engineLoadPromise;
}

export function releaseCache(): void {
  const current = engine;
  engine = null;
  engineLoadPromise = null;
  if (!current) return;
  void (async () => {
    for (const session of [current.vision, current.audio, current.decision, current.embed, current.processor]) {
      try {
        await session?.dispose?.();
      } catch {}
    }
  })();
}

async function ensureProcessor(current: DecisionEngine): Promise<any> {
  if (current.processor) return current.processor;
  const { AutoProcessor } = await import('@huggingface/transformers');
  current.processor = await AutoProcessor.from_pretrained(current.repo, {
    revision: current.revision,
  });
  return current.processor;
}

async function ensureVision(current: DecisionEngine): Promise<any> {
  if (current.vision) return current.vision;
  const { AutoModel } = await import('@huggingface/transformers');
  console.log(`[flaxia-node] decision: loading vision encoder device=${current.device}`);
  current.vision = await AutoModel.from_pretrained(current.repo, {
    device: current.device,
    revision: current.revision,
    use_external_data_format: true,
    model_file_name: 'vision_encoder',
    dtype: 'fp16',
  } as any);
  return current.vision;
}

async function ensureAudioEncoder(current: DecisionEngine): Promise<any> {
  if (current.audio) return current.audio;
  const { AutoModel } = await import('@huggingface/transformers');
  console.log(`[flaxia-node] decision: loading audio encoder device=${current.device}`);
  current.audio = await AutoModel.from_pretrained(current.repo, {
    device: current.device,
    revision: current.revision,
    use_external_data_format: true,
    model_file_name: 'audio_encoder',
    dtype: 'q8',
  } as any);
  return current.audio;
}

async function tensorFrom(data: ArrayBufferView, type: string, dims: number[]) {
  const { Tensor } = await import('@huggingface/transformers');
  return new Tensor(type as any, data as any, dims);
}

async function encodeImages(current: DecisionEngine, images: unknown[]): Promise<DecisionPrefix> {
  const processor = await ensureProcessor(current);
  const vision = await ensureVision(current);
  const inputs = await processor(images);
  const output = await vision({
    pixel_values: inputs.pixel_values,
    pixel_attention_mask: inputs.pixel_attention_mask,
    spatial_shapes: inputs.spatial_shapes,
  });
  const features = output.image_features.to('float32');
  // The vision graph returns [patches, 1024] (no batch dim); flatten to a
  // single prefix of `patches` positions.
  return {
    data: features.data as Float32Array,
    length: features.dims.length === 3 ? features.dims[1] : features.dims[0],
    dimensions: features.dims[features.dims.length - 1],
  };
}

async function encodeAudio(
  current: DecisionEngine,
  audio: Float32Array | Int16Array,
): Promise<DecisionPrefix> {
  const encoder = await ensureAudioEncoder(current);
  const samples =
    audio instanceof Int16Array
      ? Float32Array.from(audio, (sample) => sample / 32768)
      : audio;
  const length = Math.min(samples.length, DECISION_AUDIO_MAX_SAMPLES);
  const padded = Math.max(DECISION_AUDIO_MIN_SAMPLES, length);
  const values = new Float32Array(padded);
  values.set(samples.subarray(0, length));
  const tensor = await tensorFrom(values, 'float32', [1, padded]);
  const output = await encoder({ input_values: tensor });
  const features = output.audio_embeds.to('float32');
  return {
    data: features.data as Float32Array,
    length: features.dims[1],
    dimensions: features.dims[2],
  };
}

interface DecisionRow {
  name: string;
  question: DecisionQuestion;
  ids: number[];
  markers: number[];
}

async function embedRows(
  current: DecisionEngine,
  rows: DecisionRow[],
): Promise<{ data: Float32Array; length: number; dimensions: number }> {
  const maxLength = Math.max(...rows.map((row) => row.ids.length));
  const batch = rows.length;
  const ids = new BigInt64Array(batch * maxLength);
  rows.forEach((row, index) => {
    const offset = index * maxLength;
    for (let i = 0; i < row.ids.length; i++) ids[offset + i] = BigInt(row.ids[i]);
  });
  const input = await tensorFrom(ids, 'int64', [batch, maxLength]);
  const output = await current.embed({ input_ids: input });
  const embeddings = output.inputs_embeds.to('float32');
  return {
    data: embeddings.data as Float32Array,
    length: maxLength,
    dimensions: embeddings.dims[2],
  };
}

async function runBatch(
  current: DecisionEngine,
  rows: DecisionRow[],
  prefix: DecisionPrefix | null,
): Promise<Float32Array[]> {
  const embedded = await embedRows(current, rows);
  const batch = rows.length;
  const prefixLength = prefix?.length ?? 0;
  const dimensions = embedded.dimensions;
  const totalLength = prefixLength + embedded.length;
  const values = new Float32Array(batch * totalLength * dimensions);
  const attention = new BigInt64Array(batch * totalLength);
  const markerCount = Math.max(...rows.map((row) => row.markers.length));
  const markerPositions = new BigInt64Array(batch * markerCount);
  const markerMask = new BigInt64Array(batch * markerCount);
  const qtypes = new BigInt64Array(batch);

  rows.forEach((row, index) => {
    const rowOffset = index * totalLength;
    if (prefix) values.set(prefix.data, rowOffset * dimensions);
    const textOffset = (rowOffset + prefixLength) * dimensions;
    values.set(
      embedded.data.subarray(index * embedded.length * dimensions, (index + 1) * embedded.length * dimensions),
      textOffset,
    );
    for (let i = 0; i < prefixLength + row.ids.length; i++) attention[rowOffset + i] = 1n;
    const markerOffset = index * markerCount;
    row.markers.forEach((marker, markerIndex) => {
      markerPositions[markerOffset + markerIndex] = BigInt(marker);
      markerMask[markerOffset + markerIndex] = 1n;
    });
    qtypes[index] = BigInt(questionTypes(row.question));
  });

  const inputs = {
    inputs_embeds: await tensorFrom(values, 'float32', [batch, totalLength, dimensions]),
    attention_mask: await tensorFrom(attention, 'int64', [batch, totalLength]),
    prefix_len: await tensorFrom(BigInt64Array.from({ length: batch }, () => BigInt(prefixLength)), 'int64', [batch]),
    marker_pos: await tensorFrom(markerPositions, 'int64', [batch, markerCount]),
    marker_mask: await tensorFrom(markerMask, 'int64', [batch, markerCount]),
    qtype: await tensorFrom(qtypes, 'int64', [batch]),
  };
  const output = await current.decision(inputs);
  const logits = output.logits.to('float32');
  const logitsPerRow = logits.dims[1];
  return rows.map((_, index) =>
    (logits.data as Float32Array).slice(index * logitsPerRow, (index + 1) * logitsPerRow),
  );
}

export interface D1DecisionRequest {
  state: string | null;
  questions: DecisionQuestions;
  images?: unknown[];
  audio?: Float32Array | Int16Array;
}

export interface D1DecisionResult {
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
}

/**
 * Answers every question for one state/media pair. Text rows are calibrated with
 * the model's per-type temperatures; image/audio rows are the raw softmax, as
 * in the upstream `probabilities_batch`.
 */
export async function runDecisionModel(request: D1DecisionRequest): Promise<D1DecisionResult> {
  const current = await getEngine();
  const entries = questionEntries(request.questions);
  if (entries.length === 0) {
    throw new Error('decision: questions must not be empty');
  }

  let prefix: DecisionPrefix | null = null;
  let audioMode = false;
  if (request.images && request.images.length > 0) {
    prefix = await encodeImages(current, request.images);
  } else if (request.audio) {
    prefix = await encodeAudio(current, request.audio);
    audioMode = true;
  }

  let maxLength = current.maxLength;
  if (prefix) {
    const mediaBudget = audioMode ? current.audioTextLength : current.imageTextLength;
    maxLength = Math.min(mediaBudget, current.maxLength - prefix.length);
  }
  if (maxLength < 64) {
    throw new Error(
      `decision: media occupy ${prefix?.length ?? 0} of ${current.maxLength} positions; send fewer images`,
    );
  }

  const promptState = audioMode && request.state === null ? '{}' : (request.state ?? '');
  const noulDefault = prefix ? D1_YES_NO : null;
  const rows: DecisionRow[] = entries.map(([name, question]) => {
    const { ids, markers } = encodePrompt(
      current.tokenizer,
      current.tokens,
      promptState,
      question,
      maxLength,
      noulDefault,
      audioMode,
    );
    return { name, question, ids, markers };
  });

  const calibrated = !prefix;
  const answers: Record<string, DecisionAnswer> = {};
  const ordered = [...rows].sort((a, b) => b.ids.length - a.ids.length);
  let index = 0;
  while (index < ordered.length) {
    const longest = prefix ? prefix.length + ordered[index].ids.length : ordered[index].ids.length;
    let size = 1;
    while (index + size < ordered.length && (size + 1) * longest <= DECISION_BATCH_TOKEN_BUDGET) size++;
    const batch = ordered.slice(index, index + size);
    index += size;
    const logits = await runBatch(current, batch, prefix);
    batch.forEach((row, rowIndex) => {
      const temperature =
        current.temperatures[temperatureKey(row.question)] ??
        current.temperatures[row.question.type] ??
        1;
      answers[row.name] = answerQuestion(row.question, logits[rowIndex], temperature, calibrated);
    });
  }

  let inputTokens = 0;
  for (const row of rows) inputTokens += (prefix?.length ?? 0) + row.ids.length;
  console.log(
    `[flaxia-node] decision: done questions=${rows.length} device=${current.device} prefix=${prefix?.length ?? 0} inputTokens=${inputTokens}`,
  );
  return { answers, inputTokens };
}
