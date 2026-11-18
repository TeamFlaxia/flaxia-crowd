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
import { FRIEDFLAXIA_D1, downloadPinnedModel } from './model-registry';

/** Minimal surface of the vendored wasm d1-omni model. */
export interface D1Model {
  encode(text: string, addSpecialTokens: boolean): Uint32Array;
  decision(tokenIds: Uint32Array, markerPositions: Uint32Array, qtype: number): Float32Array;
  token_id(token: string): number | undefined;
  bos_token_id(): number | undefined;
  metadata_f32(key: string): number | undefined;
  free(): void;
}

const DEFAULT_MAX_LENGTH = 16_384;

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
  model = null;
  modelLoad = null;
  try {
    current?.free();
  } catch {}
};

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

export async function handleFriedFlaxiaDecision(
  payload: AiInferencePayload,
): Promise<AiInferenceResult> {
  if (payload.options?.ondeviceOnly && !model) {
    throw new OndeviceUnavailableError(
      'ondeviceOnly: the d1-omni FriedFlaxia model is not preloaded on this device',
      'preloading',
    );
  }
  const d1 = await loadFriedFlaxiaD1();
  return decideWithModel(d1, payload);
}
