import type {
  AiInferencePayload,
  AiInferenceResult,
  ModelCacheBackend,
  NodeModelCacheSnapshot,
} from '@flaxia/sdk';
import {
  handleFriedFlaxiaDecision,
  loadFriedFlaxiaD1,
  releaseCache as releaseFriedFlaxiaDecision,
} from './friedflaxia/decision';
import {
  handleFriedFlaxiaTextGeneration,
  loadFriedFlaxiaPlamo,
  releaseCache as releaseFriedFlaxiaTextGeneration,
} from './friedflaxia/text-generation';

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

/** Supported tasks after moving inference to FriedFlaxia. */
export const SUPPORTED_TASKS = ['text-generation', 'decision'] as const;

/** Bound work queued behind the token sink. */
export const MAX_PENDING_TOKEN_CALLBACKS = 64;
export const MAX_PENDING_TOKEN_CHARS = 256 * 1024;

export interface AiModelCacheIdentity {
  modelId: string;
  revision: string;
  dtype: string;
  backend: ModelCacheBackend;
}

/**
 * FriedFlaxia models are downloaded lazily and stay resident until the idle
 * eviction pass. There is no separate executable pipeline cache anymore.
 */
export const isAiModelPreloaded = (_model: string | AiModelCacheIdentity): boolean => false;

export const getModelCacheSnapshot = (): NodeModelCacheSnapshot => {
  const sampledAt = Date.now();
  return {
    version: 1,
    sampledAt,
    expiresAt: sampledAt + 60_000,
    entries: [],
  };
};

export const LIGHT_INFERENCE_PLAMO_TRANSLATE_MODEL = 'TeamFlaxia/plamo-3-translate-0.8b-onnx';
export const LIGHT_INFERENCE_PLAMO_TRANSLATE_TASK = 'text-generation';
export const LIGHT_INFERENCE_PLAMO_TRANSLATE_DTYPE = 'q4f16';
export const LIGHT_INFERENCE_TRANSLATE_MODEL = LIGHT_INFERENCE_PLAMO_TRANSLATE_MODEL;
export const LIGHT_INFERENCE_TRANSLATE_TASK = LIGHT_INFERENCE_PLAMO_TRANSLATE_TASK;
export const LIGHT_INFERENCE_TRANSLATE_DTYPE = LIGHT_INFERENCE_PLAMO_TRANSLATE_DTYPE;

export const releaseCache = (): void => {
  releaseFriedFlaxiaDecision();
  releaseFriedFlaxiaTextGeneration();
};

export const handleAiInference = async (
  payload: AiInferencePayload,
  _onToken?: (token: string) => void | Promise<void>,
): Promise<AiInferenceResult> => {
  if (payload.decision) return handleFriedFlaxiaDecision(payload);
  if (payload.task === 'text-generation') return handleFriedFlaxiaTextGeneration(payload);
  throw new Error(
    `Invalid or unsupported task: ${payload.task}. Supported tasks are: ${SUPPORTED_TASKS.join(', ')}`,
  );
};

/** Preload one of the FriedFlaxia models used by a supported task. */
export const preloadAiModel = async (request: {
  task: string;
  model: string;
  dtype?: string;
  device?: string;
}): Promise<void> => {
  if (request.task === 'text-generation') {
    await loadFriedFlaxiaPlamo();
    return;
  }
  if (request.task === 'decision') {
    await loadFriedFlaxiaD1();
    return;
  }
  throw new Error(`ai-preload: unsupported task ${request.task}`);
};
