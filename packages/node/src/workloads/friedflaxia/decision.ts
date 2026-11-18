import type { AiInferencePayload, AiInferenceResult, DecisionQuestions } from '@flaxia/sdk';
import { OndeviceUnavailableError } from '@flaxia/sdk';
import {
  answerQuestion,
  encodePrompt,
  questionEntries,
  questionTypes,
  resolvePromptTokens,
  serializeState,
  temperatureKey,
  type D1PromptTokenizer,
} from '../d1-omni/prompt';
import { assertDecisionModelId, assertDecisionPayload } from '../decision';
import { FRIEDFLAXIA_D1, FRIEDFLAXIA_D1_MMPROJ, downloadPinnedModel } from './model-registry';
import { D1_YES_NO } from '../d1-omni/prompt';
import { fetchD1Audio, fetchD1Image } from './d1-preprocess';

/** Minimal surface of the vendored wasm d1-omni model. */
export interface D1Model {
  encode(text: string, addSpecialTokens: boolean): Uint32Array;
  decision(tokenIds: Uint32Array, markerPositions: Uint32Array, qtype: number): Float32Array;
  token_id(token: string): number | undefined;
  bos_token_id(): number | undefined;
  metadata_f32(key: string): number | undefined;
  free(): void;
}

export interface D1MultimodalWasmModel {
  encode(text: string, addSpecialTokens: boolean): Uint32Array;
  token_id(token: string): number | undefined;
  bos_token_id(): number | undefined;
  metadata_f32(key: string): number | undefined;
  encode_image(patches: Float32Array, grid: number, grid2: number): Float32Array;
  encode_audio(samples: Float32Array): Float32Array;
  decision(
    tokenIds: Uint32Array,
    markerPositions: Uint32Array,
    qtype: number,
    prefix: Float32Array,
    prefixRows: number,
  ): Float32Array;
  free(): void;
}

const DEFAULT_MAX_LENGTH = 16_384;
const DEFAULT_IMAGE_TEXT_LENGTH = 896;
const DEFAULT_AUDIO_TEXT_LENGTH = 15_360;
const MEDIA_WIDTH = 1024;

let wasmReady: Promise<void> | null = null;
let model: D1Model | null = null;
let modelLoad: Promise<D1Model> | null = null;

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

export async function loadFriedFlaxiaD1(): Promise<D1Model> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  modelLoad = (async () => {
    await initWasm();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_D1);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new Model(bytes) as unknown as D1Model;
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
  const currentMultimodal = multimodal;
  model = null;
  modelLoad = null;
  multimodal = null;
  multimodalLoad = null;
  try {
    current?.free();
  } catch {}
  try {
    currentMultimodal?.free();
  } catch {}
};

let multimodal: D1MultimodalWasmModel | null = null;
let multimodalLoad: Promise<D1MultimodalWasmModel> | null = null;

export const isD1Loaded = (): boolean => model !== null || multimodal !== null;

export async function loadFriedFlaxiaD1Multimodal(): Promise<D1MultimodalWasmModel> {
  if (multimodal) return multimodal;
  if (multimodalLoad) return multimodalLoad;
  multimodalLoad = (async () => {
    await initWasm();
    const [textBytes, mmprojBytes] = await Promise.all([
      downloadPinnedModel(FRIEDFLAXIA_D1),
      downloadPinnedModel(FRIEDFLAXIA_D1_MMPROJ),
    ]);
    const { D1MultimodalModel } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new D1MultimodalModel(textBytes, mmprojBytes) as unknown as D1MultimodalWasmModel;
    multimodal = loaded;
    return loaded;
  })().catch((error) => {
    multimodalLoad = null;
    throw error;
  });
  return multimodalLoad;
}

class WasmPromptTokenizer implements D1PromptTokenizer {
  constructor(private readonly d1: D1Model) {}

  get bos_token_id(): number {
    return this.d1.bos_token_id() ?? 0;
  }

  encode(text: string, options: { add_special_tokens: boolean }): number[] {
    return Array.from(this.d1.encode(text, options.add_special_tokens));
  }

  convert_tokens_to_ids(token: string): number | number[] {
    return this.d1.token_id(token) ?? -1;
  }
}

function temperatureFor(d1: D1Model, question: DecisionQuestions[string]): number {
  const key = temperatureKey(question).replace(':', '.').replace(/-/g, '_');
  return (
    d1.metadata_f32(`lfm2.decision.temperature.${key}`) ??
    d1.metadata_f32(`lfm2.decision.temperature.${question.type}`) ??
    1
  );
}

export async function decideWithModel(
  d1: D1Model,
  payload: AiInferencePayload,
): Promise<AiInferenceResult> {
  assertDecisionModelId(payload.model);
  const decision = assertDecisionPayload(payload);
  if (decision.imageUrls.length > 0 || decision.audioUrl) {
    throw new Error('friedflaxia: d1 decision currently supports text-only state');
  }

  const tokenizer = new WasmPromptTokenizer(d1);
  const tokens = resolvePromptTokens(tokenizer);
  const startedAt = performance.now();
  let inputTokens = 0;

  const answers: NonNullable<AiInferenceResult['answers']> = {};
  for (const [name, question] of questionEntries(decision.questions)) {
    const { ids, markers } = encodePrompt(
      tokenizer,
      tokens,
      serializeState(decision.state),
      question,
      DEFAULT_MAX_LENGTH,
      null,
      false,
    );
    const logits = d1.decision(
      Uint32Array.from(ids),
      Uint32Array.from(markers),
      questionTypes(question),
    );
    answers[name] = answerQuestion(question, logits, temperatureFor(d1, question), true);
    inputTokens += ids.length;
  }

  return {
    output: {
      answers,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
    answers,
    inputTokens,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export async function decideWithMedia(
  d1: D1MultimodalWasmModel,
  payload: AiInferencePayload,
): Promise<AiInferenceResult> {
  const decision = assertDecisionPayload(payload);
  const startedAt = performance.now();
  const parts: Float32Array[] = [];
  let prefixRows = 0;
  let audioMode = false;
  if (decision.audioUrl) {
    audioMode = true;
    const features = d1.encode_audio(await fetchD1Audio(decision.audioUrl));
    if (features.length % MEDIA_WIDTH !== 0) {
      throw new Error('friedflaxia: d1 audio encoder returned a malformed prefix');
    }
    prefixRows += features.length / MEDIA_WIDTH;
    parts.push(features);
  } else {
    for (const url of decision.imageUrls) {
      const { image, rows } = await fetchD1Image(url);
      const features = d1.encode_image(image.patches, image.grid, image.grid);
      prefixRows += rows;
      parts.push(features);
    }
  }
  if (prefixRows < 1) {
    throw new Error('friedflaxia: d1 media prefix is empty');
  }
  const budget = audioMode ? DEFAULT_AUDIO_TEXT_LENGTH : DEFAULT_IMAGE_TEXT_LENGTH;
  const maxLength = Math.min(budget, DEFAULT_MAX_LENGTH - prefixRows);
  if (maxLength < 64) {
    throw new Error(`decision: media occupy ${prefixRows} positions; send fewer images`);
  }
  const prefix = concatFloats(parts);
  const tokenizer = new WasmPromptTokenizer(d1 as unknown as D1Model);
  const tokens = resolvePromptTokens(tokenizer);
  const state = decision.state ?? '';
  const answers: NonNullable<AiInferenceResult['answers']> = {};
  let inputTokens = 0;
  for (const [name, question] of questionEntries(decision.questions)) {
    const { ids, markers } = encodePrompt(
      tokenizer,
      tokens,
      state,
      question,
      maxLength,
      D1_YES_NO,
      audioMode,
    );
    const logits = d1.decision(
      Uint32Array.from(ids),
      Uint32Array.from(markers),
      questionTypes(question),
      prefix,
      prefixRows,
    );
    answers[name] = answerQuestion(question, logits, 1, false);
    inputTokens += prefixRows + ids.length;
  }
  return {
    output: {
      answers,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
    answers,
    inputTokens,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function concatFloats(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function handleFriedFlaxiaDecision(
  payload: AiInferencePayload,
): Promise<AiInferenceResult> {
  const media = Boolean(
    payload.decision && (payload.decision.imageUrls?.length || payload.decision.audioUrl),
  );
  if (payload.options?.ondeviceOnly && (media ? !multimodal : !model)) {
    throw new OndeviceUnavailableError(
      'ondeviceOnly: the d1-omni FriedFlaxia model is not preloaded on this device',
      'preloading',
    );
  }
  if (media) {
    const d1 = await loadFriedFlaxiaD1Multimodal();
    return decideWithMedia(d1, payload);
  }
  const d1 = await loadFriedFlaxiaD1();
  return decideWithModel(d1, payload);
}
